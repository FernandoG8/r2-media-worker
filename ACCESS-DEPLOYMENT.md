# Activación de Cloudflare Access para la API

El código valida el JWT de Access en todas las rutas `/api/*`. Las rutas
`/file/*` continúan públicas porque sirven los archivos del bucket. No despliegues
esta rama hasta completar la configuración siguiente: sin ella la API falla de
forma segura con `503`.

## 1. Aplicación de Access

En Zero Trust crea o ajusta una aplicación **Self-hosted** que cubra el hostname
del Worker y el path `/api/*`. No protejas `/file/*` si los enlaces públicos deben
seguir funcionando.

- Usa una política `Allow` limitada a las identidades autorizadas; no uses
  `Include Everyone` ni `Include Login Methods: One-time PIN`.
- Si el panel y la API son dominios distintos, inclúyelos en la misma aplicación
  multidominio y activa **Eager redirect cookies**, o visita/autentica primero el
  dominio de la API.
- Para peticiones cross-origin, el cookie de Access debe poder enviarse en ese
  contexto. Verifica el ajuste `SameSite` de la aplicación.

Referencias: [application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/),
[authorization cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/).

## 2. Variables del Worker

Configura estas variables de entorno desde Wrangler/CI o desde el dashboard. El
repositorio usa `keep_vars` para preservar las administradas fuera del archivo.

| Variable | Valor |
| --- | --- |
| `TEAM_DOMAIN` | `https://<equipo>.cloudflareaccess.com` |
| `POLICY_AUD` | Audience (`aud`) de la aplicación Access que protege la API |

`TEAM_DOMAIN` debe ser HTTPS y no llevar paths. No hace falta tratarlas como
secretos, pero tampoco deben sustituirse por valores ficticios en producción.

## 3. CORS y preflight

El navegador no envía cookies en el preflight `OPTIONS`. En la aplicación Access,
elige una de estas opciones:

1. **Bypass OPTIONS requests to origin**: el Worker responde el preflight y
   aplica una lista explícita de orígenes; o
2. configura Access para responder el preflight con los mismos orígenes,
   métodos, headers y `Access-Control-Allow-Credentials: true` del Worker.

El frontend ya usa `credentials: 'include'` y `XMLHttpRequest.withCredentials`
en todas las llamadas privadas. Referencia: [CORS con Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/).

## 4. Despliegue coordinado y comprobación

1. Configura Access y las dos variables.
2. Despliega el Worker de esta rama.
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

## 5. Retiro futuro de `X-API-Key`

El JWT de Access es ahora la frontera de autenticación real. `X-API-Key` queda
temporalmente como defensa adicional para no cambiar dos mecanismos a la vez.
Como `VITE_API_SECRET` se entrega al navegador, no debe considerarse un secreto.
Su retiro debe hacerse en un cambio coordinado de frontend y Worker una vez
confirmada la operación de Access en producción.
