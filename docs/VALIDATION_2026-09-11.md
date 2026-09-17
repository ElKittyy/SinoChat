# Validación local — 11 de septiembre de 2026

## Alcance: punto 1, identidad y autorización de dispositivos

Se continuó exclusivamente con el primer punto de la lista pendiente. Quedó
implementada la publicación de identidad pública del dispositivo inicial, su
persistencia atómica y la comprobación de confianza propia en el navegador.
El punto 1 todavía no está terminado: falta la ceremonia visible de aprobación
de dispositivos adicionales y la política de confianza del interlocutor.
No se comenzó la recuperación E2EE del punto 2.

## Cambios

- Dos rutas privadas de estado/publicación bajo sesión, roles CLIENT/CASHIER y
  gate E2EE. El servicio revalida elegibilidad, sesión, dispositivo y reloj de
  PostgreSQL dentro de la transacción, antes y después de operar. ADMIN queda
  excluido; solo se permite el primer dispositivo histórico.
- Raíz, certificado del dispositivo y evento `CHANGED` se confirman juntos.
  Reintentos exactos no duplican escrituras; otra identidad válida se rechaza.
  El parser sigue verificando las firmas reales y conserva la autofirma original.
- La migración `20260910000000_matrix_cross_signing_identity` añade las tablas
  públicas inmutables y referencias que impiden confirmar una mitad. No modifica
  la instantánea original ni el índice que bloquea un segundo dispositivo.
  SQL comprueba estructura y vínculos; la aplicación verifica criptografía.
- El directorio distribuye raíces y certificados solo dentro de las consultas
  autorizadas. `user_signing_keys` se devuelve únicamente al propietario que
  la solicitó. La sesión se revalida después de esperar los bloqueos de consulta.
- El inicializador web ejecuta `bootstrapCrossSigning(false)` después del
  registro y su confirmación. Publica solo claves/firmas públicas, consulta el
  certificado y exige confianza del SDK en el dispositivo propio. No exporta
  claves privadas ni inventa confirmaciones del SDK ni regenera identidades ante
  fallos. Los nuevos errores tienen mensajes seguros en español.
- El verificador PostgreSQL aislado se añadió a los comandos y al workflow CI.
  Durante la prueba se corrigió el resultado `void` de los advisory locks usados
  en bootstrap/directorio: el cast a `text` permite leerlos con PrismaPg sin
  cambiar su semántica de bloqueo.

Contrato y límites detallados en [Bootstrap público de cross-signing](CROSS_SIGNING_BOOTSTRAP.md).

## Resultados ejecutados

Entorno: Windows local, Node 24.18.0, SDK Matrix Rust Crypto 18.6.0 y PostgreSQL
del contenedor de desarrollo. No se certificó GitHub Actions ni Linux.

| Comprobación | Resultado |
| --- | --- |
| Validación del esquema y generación Prisma | Correctas |
| `npm.cmd test` | 462 pruebas API, 3 de contratos y suite web correctas |
| Nuevas pruebas API incluidas en ese total | 28 del servicio y 6 de distribución autorizada |
| Nuevo inicializador web, incluido en la suite | 26 casos con SDK real y transporte sintético correctos |
| `npm.cmd run typecheck` | Contratos, API y web correctos |
| `npm.cmd run build` | Correcto; React productivo, WASM diferido y fixtures fuera del artefacto |
| `npm.cmd run check:e2ee-browser` | Correcto en Chrome local aislado; relay HTTP sintético |
| `npm.cmd run check:cross-signing-db` | Publicación, consultas propias, invariantes y concurrencia reales correctas en base exclusiva |
| Gate compilado | Sigue `BLOCKED`, `E2EE_INTEGRATION_INCOMPLETE` |

La prueba PostgreSQL crea una base temporal vacía, aplica las 30 migraciones y
utiliza firmas generadas por el SDK con los servicios reales. Comprueba:

- Primer pin, reintento exacto sin cambios y rechazo de otra raíz válida.
- Consulta propia con certificado/triplete publicados y exclusión de ADMIN.
- Rechazo de modificación/borrado SQL y de raíz o certificado huérfanos.
- Helpers SQL que rechazan campos ausentes/NULL sin admitir formas incompletas.
- Dos trabajadores observados simultáneamente esperando el mismo advisory lock:
  una raíz, un certificado y un único `CHANGED` después de competir.
- Una sesión revocada mientras espera no publica identidad ni eventos.

Cada base temporal creada se eliminó después de verificar nombre, OID y
propietario. No se alteraron cuentas, asignaciones ni auditoría de la base
habitual. La nueva migración está versionada, pero **no se aplicó a esa base**
en esta tanda. Tampoco se reiniciaron servidores persistentes ni se cambiaron
secretos de configuración o dependencias.

## Límites y siguiente trabajo

Las pruebas web del bootstrap usan SDK real y un transporte simulado; las de
PostgreSQL usan los servicios sin atravesar una sesión HTTP del navegador. La
prueba Chrome existente comprueba chat, fotos y retención local con un relay
sintético. No hay todavía una certificación integral entre navegadores y la API.
La caducidad Chrome usa reloj controlado, no prueba borrado físico en backups/WAL.

El siguiente trabajo sigue en el punto 1: aprobación visible de otro dispositivo
desde uno confiable, caducidad y consumo único de esa autorización, rechazo de
replays, revocación y comprobación visible de la identidad del interlocutor.
Una identidad propia fijada no acredita por sí sola al otro participante.

No se habilitó el chat, no hay reset de raíces ni recuperación E2EE administrativa.
Esta validación técnica y la revisión de código no sustituyen una auditoría
criptográfica independiente ni autorizan el despliegue de producción.
