# Validación local — revisión de dispositivos, 12 de septiembre de 2026

## Alcance

Continúa el punto 1, identidad y autorización de dispositivos. Se añadió el
acceso del dispositivo inicial confiable a la cuarentena: consultar la solicitud
propia disponible, obtener sus claves públicas originales y descartarla sin
pedir motivo. No es una aprobación ni una ceremonia SAS.

El gate sigue compilado `BLOCKED` / `E2EE_INTEGRATION_INCOMPLETE`. No se habilitó
el chat ni el registro de dispositivos adicionales; no se conectaron estas rutas
al panel de incorporación. Recuperación E2EE sigue fuera de esta tanda (punto 2).

## Cambios implementados

- `MatrixDeviceCandidateReviewService` y su controlador separado ofrecen
  `GET /api/e2ee/matrix/device-candidate-reviews`,
  `GET /api/e2ee/matrix/device-candidate-reviews/:candidateId` y
  `POST /api/e2ee/matrix/device-candidate-reviews/:candidateId/reject`.
- Solo CLIENT/CASHIER con sesión real vigente vinculada al bootstrap propio
  pueden usarlos. Se exigen cuenta activa, versión vigente, ausencia de reset,
  dispositivo Matrix activo, directorio y certificado existentes, pin propio
  y elegibilidad/suscripción de cajero cuando corresponda.
- Las operaciones comparten el lock de dispositivos, bloquean cuenta y sesión/
  dispositivo revisor, y seleccionan/bloquean la reserva por propietario y
  dispositivo confiable antes de leer sus claves. Para mostrarla se bloquea
  también la sesión solicitante y se comprueba que siga sin vínculo, vigente,
  no revocada y con la versión original de sesión.
- El detalle reconstruye una copia pública congelada y vuelve a verificar la
  autofirma, hash canónico y ambas claves. No retorna IDs de sesión, hash del
  pin, tokens, secretos ni claves de conversación. La lista devuelve solo
  metadatos. Las rutas declaran `Cache-Control: no-store`.
- Una reserva no disponible produce lista vacía o 404 genérico. La expiración
  observada queda confirmada antes de generar ese 404 fuera de la transacción;
  no se revierte accidentalmente a PENDING por lanzar la excepción.
- Descartar no requiere motivo y es idempotente: solo PENDING→CANCELLED/EXPIRED.
  El dispositivo confiable puede descartar una reserva conocida aun cuando su
  solicitante haya cerrado sesión; denegar no concede autoridad. La sesión
  revisora debe seguir vigente y se revalida después de escribir. Una reserva
  cuyo solicitante perdió vigencia puede quedar PENDING, oculta de la lista,
  hasta su vencimiento o descarte; no se amplía su plazo.
- No se registra una sesión aprobadora ni un resultado SAS. Distintas sesiones
  válidas del mismo bootstrap pueden consultar/descartar; fijar la sesión
  autorizante exacta para una ceremonia continúa pendiente.

No se añadieron migraciones ni se modificaron las 31 existentes. Se conservan
el índice de dispositivo histórico único y los certificados limitados al
bootstrap. No se crea ningún Device, vínculo de sesión, clave operativa,
preclave, certificado, cursor o evento CHANGED mediante estas operaciones.
Contrato actualizado en [Autorización de dispositivos](DEVICE_APPROVAL.md).

## Verificación

Entorno: Windows local, Node 24.18.0, PostgreSQL 17 mediante Docker, Chrome y
Matrix Rust Crypto 18.6.0 fijado. No certifica CI/Linux ni despliegue productivo.

| Comprobación | Resultado |
| --- | --- |
| `npm.cmd test` | 736 pruebas API, 3 de contratos y suite web correctas |
| Nuevo servicio y metadatos de rutas | 64 pruebas correctas, incluidas en API |
| Nueva frontera HTTP local | 25 pruebas correctas, incluidas en API |
| `npm.cmd run typecheck` | Contratos, API y web correctos |
| `npm.cmd run build` | Correcto; artefacto web sin fixtures ni hooks de prueba |
| `npm.cmd run check:cross-signing-db` | Correcto, con las 31 migraciones en una base temporal exclusiva |
| `npm.cmd run check:e2ee-browser` | Correcto en contextos Chrome aislados con relay HTTP sintético |

Las 64 pruebas del servicio cubren ámbito propio, principal versus estado real,
revocación/versiones/caducidad, cambios de claves incluso válidamente firmados,
ausencia de secretos, descarte idempotente y rollback cuando vence la autoridad
durante la operación. Usan transacciones simuladas con rollback y claves
Ed25519/X25519 de prueba; no sustituyen la comprobación PostgreSQL.

Las 25 pruebas HTTP levantan Nest en un puerto efímero exclusivamente de
loopback. Ejecutan el controlador real, parsing JSON/cookies, guards de sesión,
roles, CSRF, origen y rate limiting. Verifican 401, 403, 415, 429 y el 503 del
gate real para CLIENT/CASHIER; el servicio nunca debe ser invocado. No existen
rutas approve/activate. El gate no se reemplaza ni se habilita para las pruebas.
El almacén de autenticación y el servicio inalcanzable son dobles de prueba;
el limitador usa memoria, no Redis. No certifica login real, HTTPS, proxy,
configuración completa de producción ni una ceremonia HTTP habilitada.

El verificador PostgreSQL extendido comprueba servicios reales, sin desactivar
triggers, con propietarios y sesiones sintéticos:

- Dos sesiones del bootstrap propio consultan la misma reserva; ADMIN,
  solicitante sin vínculo, otra cuenta y sesión de otro propietario no acceden.
- Dos descartes observados esperando simultáneamente el lock conservan una
  resolución; el solicitante observa CANCELLED y el reintento no cambia la fecha.
- Una reserva breve expira con reloj real; el detalle responde 404 y EXPIRED
  permanece confirmado en PostgreSQL.
- Si el solicitante se revoca durante la espera, no se entregan claves; el
  dispositivo confiable aún puede descartar sin motivo. Si el solicitante se
  vincula posteriormente al dispositivo operativo existente, deja de ser revisable.
- Cancelación confirmada mientras la consulta espera impide devolver un
  snapshot pendiente obsoleto.
- Revocación de sesión revisora durante la espera impide cancelar; revocación
  de su dispositivo impide leer y descartar incluso con otra sesión vigente.
- No cambian los recuentos de dispositivos, directorio, certificados,
  preclaves, cursores, registros iniciales, versiones ni eventos. La sesión
  solicitante principal de la prueba no recibe vínculo.

La base temporal fue eliminada después de verificar nombre, OID y propietario;
contenía solo fixtures sintéticas recreables. No se aplicaron migraciones ni
se cambiaron cuentas, asignaciones o auditoría de la base habitual. No se
cambiaron dependencias, secretos o logotipos ni se reiniciaron la API/PWA
persistentes. Los servidores HTTP de prueba se cerraron al terminar.

Los errores de almacenamiento/Redis impresos por la suite general corresponden
a escenarios negativos de prueba; las comprobaciones terminaron sin fallos.

## Pendiente dentro del mismo punto 1

1. Ligar la reserva al flujo SAS real, las claves exactas, las dos sesiones y
   un resultado autorizante verificable; ni una cookie ni un certificado bastan.
2. Construir su canal de cuarentena autenticado, sin convertir al candidato en
   destinatario de conversaciones ni transmitir secretos de cross-signing.
3. Integrar ambas pantallas y la rama persistente del navegador, probando
   reconexiones, reinicios, varias pestañas y cancelaciones.
4. Implementar y verificar promoción atómica, restricciones SQL y consumo único,
   con revocaciones y vencimientos concurrentes.
5. Completar confianza del interlocutor y revisión de seguridad.

La cobertura unitaria de elegibilidad de cajero no equivale a una prueba real
de toda la matriz de suscripciones: estas nuevas fixtures PostgreSQL usan
CLIENT. Las pruebas HTTP, PostgreSQL y navegador son complementarias pero aún
separadas. El punto 1 y la autorización para producción permanecen abiertos.
