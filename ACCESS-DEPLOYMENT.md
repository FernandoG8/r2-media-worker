# Activación de Cloudflare Access para la API

El código sabe validar el JWT de Cloudflare Access en todas las rutas `/api/*`,
pero esa validación es **opt-in explícito** mediante la variable
`ACCESS_ENFORCEMENT`. Mientras no valga exactamente `"enabled"` (ausente,
vacía, o cualquier otro valor), la verificación de Access queda **suspendida**
y esta rama se puede desplegar con normalidad.

No se usa el patrón "si faltan `TEAM_DOMAIN`/`POLICY_AUD` entonces no
valides": eso fallaría abierto en silencio ante un typo en el nombre de una
variable. En su lugar, la activación depende únicamente de `ACCESS_ENFORCEMENT`,
y una vez activada, `TEAM_DOMAIN`/`POLICY_AUD` ausentes o inválidas siguen
bloqueando la API con `503` (activada + mal configurada = sigue cerrada).

## Qué protege la API mientras Access está suspendido

Ninguna aplicación de Cloudflare Access existe hoy en la cuenta. Mientras
`ACCESS_ENFORCEMENT` no esté en `"enabled"`, la frontera de autenticación real
de todas las rutas privadas (`/api/*`, excepto `/file/*` que es público) sigue
siendo `X-API-Key`, verificado por `isAuthorized` en `src/router.ts` con
comparación en tiempo constante contra `API_SECRET`. Esto es el mismo modelo
que corre hoy en producción — activar el flag no reemplaza `X-API-Key`, lo
complementa como una segunda capa.

## Cómo queda declarado el estado

`wrangler.jsonc` declara el valor suspendido directamente en `vars`, para que
el estado quede visible en el repositorio y no dependa del dashboard:

```jsonc
"vars": {
  "ACCESS_ENFORCEMENT": "suspended"
  // ...
}
```

`TEAM_DOMAIN` y `POLICY_AUD` no están en `vars` — se gestionan fuera del
control de versiones (dashboard o CI) y `keep_vars: true` evita que un deploy
las borre.

## Pasos exactos para reactivar la exigencia de Access

### 1. Aplicación de Access

En Zero Trust crea una aplicación **Self-hosted** que cubra el hostname del
Worker y el path `/api/*`. No protejas `/file/*` si los enlaces públicos deben
seguir funcionando.

- Usa una política `Allow` limitada a las identidades autorizadas; no uses
  `Include Everyone` ni `Include Login Methods: One-time PIN`.
- Si el panel y la API son dominios distintos, inclúyelos en la misma
  aplicación multidominio y activa **Eager redirect cookies**, o
  visita/autentica primero el dominio de la API.
- Para peticiones cross-origin, el cookie de Access debe poder enviarse en ese
  contexto. Verifica el ajuste `SameSite` de la aplicación.

Referencias: [application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/),
[authorization cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/).

### 2. Variables del Worker

Configura estas variables desde Wrangler/CI o desde el dashboard:

| Variable | Valor |
| --- | --- |
| `TEAM_DOMAIN` | `https://<equipo>.cloudflareaccess.com` |
| `POLICY_AUD` | Audience (`aud`) de la aplicación Access que protege la API |

`TEAM_DOMAIN` debe ser HTTPS y no llevar paths. No hace falta tratarlas como
secretos, pero tampoco deben sustituirse por valores ficticios en producción.

### 3. CORS y preflight

El navegador no envía cookies en el preflight `OPTIONS`. En la aplicación
Access, elige una de estas opciones:

1. **Bypass OPTIONS requests to origin**: el Worker responde el preflight y
   aplica una lista explícita de orígenes; o
2. configura Access para responder el preflight con los mismos orígenes,
   métodos, headers y `Access-Control-Allow-Credentials: true` del Worker.

El frontend ya usa `credentials: 'include'` y `XMLHttpRequest.withCredentials`
en todas las llamadas privadas. Referencia: [CORS con Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/).

### 4. Activar el flag

Una vez creada la aplicación Access y configuradas las dos variables, pon
`ACCESS_ENFORCEMENT` en `"enabled"` (en `wrangler.jsonc` o en el dashboard,
según dónde se gestione en ese momento) y despliega. Antes de ese cambio, la
API sigue respondiendo con normalidad detrás de `X-API-Key` — activar el flag
sin la aplicación Access y sin las dos variables configuradas hace que la API
responda `503` en todas las rutas `/api/*` (falla cerrado, por diseño).

### 5. Despliegue coordinado y comprobación

1. Configura Access y las dos variables.
2. Pon `ACCESS_ENFORCEMENT` en `"enabled"` y despliega el Worker.
3. Despliega el frontend que envía credenciales cross-origin.
4. Prueba en una sesión normal del navegador (no incógnito).
5. Confirma los siguientes casos antes de promover a producción:

```bash
# Debe responder el preflight con el origen exacto y credentials=true.
curl -i -X OPTIONS 'https://<api-host>/api/list' \
  -H 'Origin: https://panel-v2.mizcor.dev' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: X-API-Key,X-Client-ID'

# Una llamada directa sin Access debe quedar bloqueada por Access o por el
# Worker; nunca debe leer datos ni devolver 2xx.
curl -i 'https://<api-host>/api/clients'
```

Después, desde el panel autenticado, valida listado, creación/movimiento de una
carpeta vacía, subida, descarga, renombrado, papelera y respaldo.

## 6. Retiro futuro de `X-API-Key`

Una vez `ACCESS_ENFORCEMENT` esté en `"enabled"` en producción y confirmado su
funcionamiento, el JWT de Access pasa a ser la frontera de autenticación real.
`X-API-Key` puede entonces quedar como defensa adicional en vez de mecanismo
principal. Como `VITE_API_SECRET` se entrega al navegador, no debe
considerarse un secreto. Su retiro debe hacerse en un cambio coordinado de
frontend y Worker una vez confirmada la operación de Access en producción.
