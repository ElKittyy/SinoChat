# Validación local del 9 de septiembre de 2026

Este registro describe el cierre de la gestión de passkeys administrativas.
No constituye una aprobación de producción. La estimación orientativa sigue
en 85% de implementación y 70% de preparación para producción; no es una
métrica obtenida del número de pruebas.

## Cambios cerrados

- Inventario administrativo de hasta diez passkeys, con metadatos y sin material
  criptográfico. La última passkey no se puede revocar desde este inventario.
- Revocación propia con confirmación en la interfaz, MFA reciente y evento
  `ADMIN_PASSKEY_REVOKED`; no se solicita un motivo libre.
- El alta de una passkey adicional exige una confirmación anterior de menos de
  cinco minutos, comprobada al pedir opciones y nuevamente dentro de la
  transacción. Se corrigió la posibilidad de que una sesión con MFA antiguo
  añadiera una credencial y renovara su autorización. El primer enrolamiento
  conserva su excepción, porque aún no existe una passkey.
- La interfaz reautentica y reintenta una sola vez las acciones que requieren
  MFA reciente, incluidas las altas, las revocaciones y el cierre de sesiones.
- El verificador de recuperación de cajeros usa un único instante por sentencia
  y conserva los microsegundos de PostgreSQL. Se eliminó un fallo intermitente
  de los fixtures sin modificar las restricciones de la base.
- La configuración CI incorpora comprobaciones secuenciales de Matrix,
  recuperación de cajeros y WebAuthn sobre PostgreSQL. No se ejecutó GitHub
  Actions desde este entorno.

## Dependencias

Se fijaron `multer@2.3.0` y `qs@6.16.0` mediante overrides, de acuerdo con los
avisos de sus mantenedores: [Multer](https://github.com/expressjs/multer/security/advisories/GHSA-wc9g-mqfw-jrwm),
[qs](https://github.com/ljharb/qs/security/advisories/GHSA-4mjr-xmp4-gh2g).

La instalación y resolución de dependencias requieren npm 11.19.1. npm 11.16.0
ignoraba el override transitivo de Multer al atravesar el enlace del workspace;
la [corrección del mantenedor](https://github.com/npm/cli/pull/9673) está incluida
en la versión fijada. Se utilizó mediante `npx`, sin modificar npm global.
El runbook y CI recogen este requisito.

## Resultados

| Comprobación | Resultado |
| --- | --- |
| `npm.cmd run typecheck` | Correcto |
| `npm.cmd test` | 330 pruebas API, 3 de contratos y todos los verificadores web/Matrix correctos |
| `npm.cmd run build` | Correcto; React de producción y Matrix/WASM fuera de la carga inicial |
| Auditoría con npm 11.19.1 | Cero vulnerabilidades conocidas en el árbol instalado |
| `npm ci --dry-run --ignore-scripts` con npm 11.19.1 | Lockfile aceptado; no equivale a una instalación limpia completa |
| Migraciones | 29 aplicadas, sin pendientes |
| `check:webauthn-db` | Correcto; fixtures revertidos |
| `check:matrix-db` | Correcto; fixtures revertidos |
| `check:recovery-db` | Correcto en tres ejecuciones consecutivas después de corregir el reloj del fixture |
| `check:storage` | MinIO local: carga privada, rechazo de reutilización, descarga y purga con cero versiones y HTTP 404 |
| `check:webauthn-browser` | Chrome con autenticadores virtuales: alta inicial, step-up con passkey previa, respaldo USB, revocación, rechazo de última/inexistente, sesiones, recuperación real e invalidación de códigos anteriores |
| Limpieza del navegador | Identidad reservada `DELETED`, cero sesiones, passkeys y códigos activos; se conserva el ledger de auditoría |
| `/api/e2ee/status` | `BLOCKED`, `E2EE_INTEGRATION_INCOMPLETE` |

## Trabajo pendiente relevante

El chat todavía no está habilitado por el gate E2EE: faltan confianza entre
dispositivos/cross-signing, recuperación criptográfica, pruebas completas entre
navegadores y revisión independiente. También faltan dominio/HTTPS definitivo,
certificación con autenticadores reales, borrado de archivos en el proveedor
productivo, tratamiento de backups/WAL y documentación legal final.

## Cierre posterior: concurrencia administrativa

Se añadió `check:webauthn-concurrency` y pasó con servicios y transacciones reales
en una base temporal vacía, manteniendo todos sus triggers. Un bloqueo externo
comprueba que las dos transacciones están esperando simultáneamente antes de
liberarlas; una ejecución secuencial no puede dar un falso positivo.

- Dos revocaciones partiendo de dos credenciales conservan una passkey activa.
- Dos altas partiendo de nueve conservan diez; el desafío perdedor no se consume.
- Cada carrera genera exactamente una auditoría y una respuesta de conflicto.
- Una passkey de otro administrador no puede revocarse.
- Se verificó y eliminó la base temporal creada, sin modificar la habitual.

Las transacciones MFA comparten orden de bloqueo (usuario primero) y traducen
conflictos `P2034` o SQLSTATE `40001`/`40P01` envueltos en `P2010` a HTTP 409
`ADMIN_MFA_CONCURRENT_CHANGE`, sin detalles internos ni reintentos automáticos.
Los errores de infraestructura no se convierten en conflictos de usuario.

El cierre pasó las **335 pruebas de API**. Chrome verificó que un conflicto
conserva inventario y confirmación, muestra el mensaje, libera el botón y no
repite el DELETE ni inicia una autenticación automática; después completó la
revocación real, la recuperación y la limpieza. CI quedó configurado para
ejecutar también la prueba de concurrencia; no se ejecutó GitHub Actions aquí.

La verificación criptográfica se sustituye exclusivamente en la prueba de
concurrencia de base de datos. La ceremonia WebAuthn se valida por separado con
autenticadores virtuales en Chrome y aún requiere certificación con dispositivos
reales. Como ampliación de seguridad queda comprobar peticiones que ya
superaron el guard cuando otra sesión revoca su autorización, y revalidar esa
autorización dentro de las operaciones sensibles que aún dependen del principal
capturado al iniciar la petición.
