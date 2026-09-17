# Validación local — admisión SAS, 16 de septiembre de 2026

Trabajo iniciado el 13 y retomado el 16 de septiembre. Continúa exclusivamente
el punto 1, identidad y autorización de dispositivos. No cierra ese punto ni
habilita el chat para producción.

## Resultado

Se implementó la admisión persistente de un request SAS iniciado por el
dispositivo bootstrap y dirigido al candidato propio. Fija la reserva, el
flujo real propuesto por el SDK, ambas sesiones y el plazo original. No entrega
eventos al otro navegador ni prueba todavía una ceremonia completa.

Archivos principales:

- [Servicio de admisión](../apps/api/src/e2ee/matrix-device-verification.service.ts).
- [Único controlador PUT](../apps/api/src/e2ee/matrix-device-verification.controller.ts).
- [Migración 32](../apps/api/prisma/migrations/20260913000000_matrix_device_verification_flow/migration.sql).
- [106 pruebas de servicio](../apps/api/src/e2ee/matrix-device-verification.service.test.ts).
- [29 pruebas HTTP](../apps/api/src/e2ee/matrix-device-verification.controller.http.test.ts).
- [Verificador PostgreSQL](../apps/api/src/cli/check-matrix-device-verification.ts).
- [Contrato y límites](MATRIX_SAS_TRANSPORT.md).

El request queda en una tabla separada de `Device`. Un reintento exacto no
renueva fechas; otra sesión del mismo bootstrap no hereda el flujo. Se rechaza
reutilizar un candidato, flow o ID de envío histórico del propietario. Cancelar
la reserva terminaliza el flujo de manera atómica, sin pedir motivos.

La admisión comprueba sesiones reales, versiones, cuenta, bootstrap certificado,
pin y autofirma original del candidato bajo locks. El vencimiento es el mínimo
de todos los límites de servidor y del timestamp original. La aplicación calcula
el hash; SQL verifica forma pública y relaciones, no firmas criptográficas.

## Evidencia separada por frontera

- SDK real: el perfil tiene 118 pruebas. Se añadieron tres recorridos en que
  el bootstrap inicia: finalización local, cancelación por usuario y SAS
  discrepante. Cada paquete pasa el parser antes del relay sintético. El
  candidato sigue sin secretos privados de cross-signing; no se publican firmas.
- Servicio: 106 pruebas con transacciones simuladas, parser y autofirmas reales.
  Cubren contexto, TTL, reloj, rollback, replay, roles, entradas malformadas y
  ausencia de escrituras operativas. La simulación de cancelación fue alineada
  con SQL: un flujo vencido es EXPIRED aunque su candidato termine CANCELLED.
- HTTP: 29 casos sobre loopback con Nest, routing, parsers y guards reales,
  sin sustituir el gate. El almacén de sesiones y el servicio inalcanzable son
  dobles; throttling en memoria. Comprueban 401/403/415/429, y 503 para sesiones
  válidas con cero invocaciones de admisión. No prueban Redis distribuido ni
  un recorrido SDK→HTTP→SDK con acceso habilitado.
- PostgreSQL: servicios reales, triggers y 32 migraciones en una base local
  exclusiva. Prueba SQL directo inválido, inmutabilidad, replay histórico,
  expiración real y cancelación en cascada. Dos sesiones competidoras son
  observadas esperando el lock: una gana. Dos reintentos iguales obtienen una
  sola fila y las mismas fechas. La revocación mientras esperan impide admisión.
  Una cancelación espera el lock del flujo hasta vencer y el trigger usa el
  reloj posterior; un request envejecido durante la espera no obtiene otro TTL.

Ninguna prueba confunde admisión con consentimiento o posesión de claves. Un
`PENDING` persistido no implica que el candidato haya recibido el request.

## Comandos y estado de validación

| Comprobación | Resultado |
| --- | --- |
| `npm.cmd run typecheck` | Correcto en contratos, API y web |
| `npm.cmd run build` | Correcto; artefacto web sin fixtures/hooks de pruebas |
| API dentro de `npm.cmd test` | 989 pruebas correctas |
| Contratos dentro de `npm.cmd test` | 3 pruebas correctas |
| `npm.cmd run test --workspace @sinochat/web` | Suite completa correcta tras corregir prueba temporal frágil |
| `npm.cmd run check:cross-signing-db` | Correcto; 32 migraciones, pruebas previas y nuevas |
| `npm.cmd run db:validate --workspace @sinochat/api` | Esquema Prisma válido |
| `npm.cmd run check:e2ee-browser` | Correcto en Chrome, con cliente real y relay HTTP sintético |

La primera ejecución completa encontró fragilidad preexistente en
`checkExpiryDuringDecrypt`: concedía solo 35 ms reales antes de caducar. Bajo
carga el controlador podía rechazar correctamente la imagen antes de entrar
al hook de descifrado, dejando sin inicializar una variable de la prueba. La
corrección se limita a la fixture, con reloj controlado y barreras; no relaja
el código productivo ni las comprobaciones de limpieza. Pasaron ocho ejecuciones
focalizadas, incluidas seis simultáneas, y posteriormente la suite web completa.
La ejecución inicial de `npm.cmd test` no se presenta como exitosa: pasaron
contratos y API, falló en esa prueba web y se reejecutó el workspace web completo
después de corregirla. Los errores de Redis/almacenamiento impresos por las
pruebas API corresponden a escenarios negativos controlados. El ajuste está en
[la prueba del controlador de mensajes](../apps/web/scripts/check-secure-message-controller.mjs).

La comprobación adicional en Chrome pasó texto bidireccional, imágenes,
manipulación, recarga, aislamiento de pestañas y retiro del contenido a las
48 horas simuladas. Su relay sigue siendo sintético: no certifica la nueva
admisión SAS de extremo a extremo ni modifica el gate de producción.

Docker Desktop estaba detenido y se inició para comprobar PostgreSQL. Los
contenedores locales existentes quedaron activos. El verificador eliminó solo
su base temporal tras verificar nombre, OID y propietario; esos datos eran
fixtures sintéticas desechables. No se aplicaron migraciones ni se modificaron
usuarios, asignaciones o evidencia en la base habitual. Una consulta de solo
lectura confirmó que conserva sus 29 migraciones aplicadas. No se cambiaron secretos,
dependencias, logotipos ni la configuración del gate.

## Siguiente trabajo del punto 1

1. Recepción y entrega del request y de los eventos SAS exclusivamente entre
   las dos sesiones fijadas, con cuotas, orden, negociación, reintentos y
   cancelación seguros. Revalidar siempre candidato, flujo, sesiones y plazos.
2. Integrar el transporte con ambos SDK y sus pantallas, ACK HTTP real,
   reanudación, varias pestañas y pérdida de conectividad.
3. Diseñar/probar el resultado autorizante de la ceremonia y su promoción
   atómica, sin confiar en un `done`, cookie o certificado aislados.
4. Completar la confianza del interlocutor y la revisión independiente.

Siguen intactos el índice de un único dispositivo histórico y la restricción
de certificados bootstrap. El gate compilado permanece
`BLOCKED` / `E2EE_INTEGRATION_INCOMPLETE`. La recuperación E2EE continúa fuera
de esta tanda, en el punto 2.
