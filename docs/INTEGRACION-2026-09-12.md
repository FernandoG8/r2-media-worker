# Integración auxiliar del Worker — 2026-09-12

Rama local: `aux/integracion-2026-09-12`. Base: `fix/access-jwt-hardening` en `d3977a6`, conservada sin cambios. `main` (`485247f`) es ancestro; se hereda el hardening JWT existente.

| Commit | Cambio |
| --- | --- |
| `9a40687` | Preservar metadatos HTTP y la política de caché del objeto; fallback de una hora cuando no existe |
| `0da78c3` | Eliminar la segunda decodificación de claves en DELETE, preservando caracteres `%` literales |

Los cambios en `src/router.ts` y `test/router-regressions.spec.ts` eran previos al trabajo de integración. Claude los revisó sin editar y ejecutó `npx vitest run` (**11/11** en tres archivos) y `npx tsc -p tsconfig.json` (**PASS**, solo `src`). La separación de commits conserva exactamente el contenido revisado y añade un caso de regresión por fix.

```bash
git log --reverse --oneline d3977a6..aux/integracion-2026-09-12
git show 9a40687
git show 0da78c3
```

El frontend tiene su propia rama `aux/integracion-2026-09-12` en `paneladmin`. Su índice detallado se encuentra en `paneladmin/media-panel/docs/INTEGRACION-2026-09-12.md`, relativo a la carpeta contenedora MediaPanel.

No se cambió autenticación, CORS, configuración de bindings ni dependencias durante esta integración. Tipos generados, tipos de tests y verificación de infraestructura Access/CORS siguen pendientes. No se ejecutó despliegue ni push.
