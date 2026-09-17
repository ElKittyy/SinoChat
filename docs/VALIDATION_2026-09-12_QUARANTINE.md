# Validación local — cuarentena de dispositivos, 12 de septiembre de 2026

## Alcance y estado

Continúa exclusivamente el punto 1, identidad y autorización de dispositivos.
Esta tanda implementó la **reserva pública de un candidato** en una tabla
separada, con crear/reintentar, consultar estado y cancelar. No implementa la
aprobación, el transporte SAS ni la promoción a dispositivo activo.

El panel y controlador SAS de la [tanda anterior](VALIDATION_2026-09-12.md)
siguen aislados: no se conectaron a estas rutas. El gate continúa compilado
`BLOCKED` / `E2EE_INTEGRATION_INCOMPLETE`; no hay acceso adicional a chats ni se
comenzó el punto 2 de recuperación E2EE.

## Implementación

- `MatrixDeviceCandidate` vive fuera de `Device`, `MatrixDeviceRegistration` y
  el directorio operativo. Guarda únicamente UUID, propietario y sesión,
  versión de sesión, referencia al bootstrap confiable existente, hash de su
  identidad, claves públicas originales autofirmadas y fechas/estado.
- `parseMatrixDeviceCandidate` acepta exactamente `{ device_keys }`, sin
  preclaves, raíces, secretos o campos de aprobación. Reconstruye objetos y
  arrays por descriptores antes de delegar la firma al validador compartido;
  rechaza getters, proxies, propiedades ocultas, símbolos y arrays dispersos.
  Devuelve una copia congelada y su hash canónico, incluida la autofirma.
- `MatrixDeviceCandidatesService` acepta únicamente CLIENT/CASHIER desde una
  sesión aún sin dispositivo vinculado. No confía en el principal emitido antes
  de esperar: bloquea/relee usuario, elegibilidad de cajero, sesión real y
  dispositivo inicial confiable con certificado y pin ya existentes. Comprueba
  rol, estado ACTIVE, reset, versión, revocación y vencimiento.
- El plazo es el mínimo entre diez minutos desde el reloj PostgreSQL, fin de
  sesión y fin de suscripción. Reintentar el mismo UUID requiere la misma sesión,
  claves, versión y pin; nunca cambia la fecha ni reabre estados terminales.
  Se rechazan IDs usados en dispositivos/registros iniciales y claves públicas
  que reutilizan las del pin o directorio operativo existente.
- Un índice parcial mantiene una sola PENDING por usuario. Bajo el mismo lock
  se terminalizan las anteriores vencidas antes de reservar otra. Este límite
  técnico no cambia los cupos comerciales ni la asignación de clientes.
- Cancelar no pide motivo y es idempotente. La caducidad observada se persiste
  como EXPIRED, incluso al consultar estado, para impedir una reactivación por
  retroceso posterior del reloj. La revalidación final revierte si la sesión,
  suscripción o nueva reserva vencen durante la operación.
- Las rutas PUT/GET/POST de `MatrixDeviceCandidatesController` conservan sesión,
  roles, gate compilado, CSRF global en mutaciones y límites por minuto. El
  estado HTTP entrega solo identificadores, estado y fechas; ni otras sesiones
  propias ni ADMIN pueden consultar o cancelar la reserva.
- La migración `20260912000000_matrix_device_candidate_quarantine` comprueba
  inserción pública y autorizada, namespace, claves/hash codificados, ventana,
  propietario, sesión, pin y dispositivo confiable. Solo permite
  PENDING→CANCELLED/EXPIRED, conservando todo el snapshot y fechas originales.
  Mantenimiento puede terminalizar después de revocación; eso no autoriza al
  antiguo llamante. No se pueden borrar/reabrir los registros antirrepetición.
  La criptografía y los hashes se verifican en la aplicación, no en SQL.

No se crea `Device`, certificado adicional, clave operativa, preclave, cursor,
evento `CHANGED` ni vínculo de sesión. El índice de dispositivo histórico único
y la restricción de certificado solo para bootstrap permanecen intactos.
Contrato y diseño pendiente en [Autorización de dispositivos](DEVICE_APPROVAL.md).

## Resultados ejecutados

Entorno: Windows local, Node 24.18.0, SDK Matrix Rust Crypto 18.6.0, Chrome y
PostgreSQL 17 local mediante Docker. No se certificó CI/Linux ni producción.

| Comprobación | Resultado |
| --- | --- |
| Validar esquema y generar cliente Prisma | Correctos |
| `npm.cmd test` | Correcto: 647 pruebas API, 3 de contratos y suite web |
| Nuevo parser, incluido en el total API | 81 pruebas correctas, con claves/autofirma del SDK real |
| Nuevo servicio/controlador, incluido en el total API | 43 pruebas correctas, transacción simulada con rollback y firmas independientes |
| `npm.cmd run typecheck` | Contratos, API y web correctos |
| `npm.cmd run build` | Correcto; React de producción, WASM diferido y fixtures excluidas |
| `npm.cmd run check:cross-signing-db` | Correcto con las 31 migraciones en una base temporal exclusiva |
| `npm.cmd run check:e2ee-browser` | Correcto en contextos Chrome aislados con relay HTTP sintético |
| Gate compilado y restricciones operativas previas | Sin cambios |

Las pruebas PostgreSQL usan los servicios reales y firmas Ed25519 de prueba,
sin mockear la autorización ni desactivar triggers. Comprueban:

- Reserva y reintento exactos; otra sesión propia o ADMIN no acceden.
- Un cuerpo nuevo válidamente firmado no reemplaza el snapshot de ese UUID.
- Estado HTTP mínimo y ausencia de cambios en dispositivos, claves, preclaves,
  certificados, cursores, registro inicial y lista de dispositivos.
- UPDATE/DELETE no cambian hash, sesión, fechas, contenido ni reabren estado.
  INSERT rechaza sesión vinculada, dueño/versión/pin ajenos, formas incompletas,
  datos privados, estados terminales iniciales y fechas inválidas.
- Vencimiento con reloj PostgreSQL real de una reserva breve de prueba,
  reintento sin extensión, terminalización y nueva reserva independiente.
- Dos conexiones observadas esperando el lock antes de liberarlo: exactamente
  una reserva queda PENDING; el otro resultado es conflicto.
- Sesión revocada durante la espera: no aparece candidato. El mantenimiento
  puede cancelar una reserva existente después de revocar la sesión, mientras
  el endpoint de esa sesión ya rechaza acceso.

La primera ejecución no pudo conectar porque Docker Desktop estaba detenido.
Se inició Docker Desktop y sus contenedores locales existentes volvieron a
estar disponibles. Una ejecución intermedia detectó que la fixture de revocación
debía incluir el código de motivo interno exigido por el esquema; se corrigió
la fixture, sin relajar restricciones del producto. La ejecución final pasó.

Cada base temporal creada se eliminó tras comprobar nombre, OID y propietario;
solo contenía datos sintéticos y es recreable al ejecutar la prueba. No se
aplicaron migraciones a la base habitual ni se cambiaron usuarios, asignaciones
o auditoría habituales. Las migraciones de identidad y cuarentena están
versionadas, pero siguen pendientes de despliegue en esa base. No se cambiaron
secretos, dependencias ni logotipos. No se reiniciaron la API o PWA persistentes.

## Límites y próximo trabajo

La reserva es un paso previo, **no prueba consentimiento humano ni posesión de
las claves del dispositivo aprobador**. Sus rutas siguen cerradas por el gate.
La prueba de PostgreSQL invoca servicios reales, no sesiones HTTP de navegador;
las del panel y SAS siguen siendo recorridos separados.

Falta dentro del mismo punto 1:

1. Definir y revisar la vinculación entre reserva, flujo SAS, claves exactas,
   sesión aprobadora, resultado y consumo único; un certificado aislado no basta.
2. Implementar acceso del aprobador y un canal SAS autenticado limitado a ese
   par/flujo, sin convertir al candidato en destinatario de conversaciones.
3. Integrar la rama del navegador y la comparación visible con persistencia,
   varias pestañas, reinicios, revocaciones y pérdida de conectividad.
4. Implementar promoción atómica y sus invariantes, y probarla en navegadores y
   PostgreSQL con cancelaciones, suspensiones y carreras reales.
5. Completar la confianza del interlocutor y la revisión de seguridad.

La elegibilidad de cajeros y sus límites temporales tienen cobertura unitaria;
esta nueva prueba PostgreSQL de cuarentena usa propietarios CLIENT. Tampoco
certifica toda la matriz de revocación de dispositivos/suscripciones ni HTTP.
La compactación de registros públicos antirrepetición requiere una política
posterior que no permita reutilizar IDs; no se almacenan chats o fotos en ellos.
Nada de esta tanda implementa recuperación de claves privadas, recuperación
administrativa del historial ni autorización para producción.
