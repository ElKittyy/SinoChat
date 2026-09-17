# Arquitectura inicial

## Componentes

1. La PWA autentica al usuario mediante HTTPS.
2. El backend autoriza la conexión WebSocket y permite unir únicamente las salas
   asociadas a la identidad autenticada.
3. Los dispositivos cifran cada mensaje ordinario una vez con Matrix Megolm. El
   exterior de cada `MessageEnvelope` es `m.room.encrypted` y el
   contenido autenticado interior usa el codec cerrado
   `com.sinochat.message.v1`; conversación, mensaje, remitente, tipo y metadatos
   de foto se contrastan con el transporte antes de mostrarse. Todos los
   dispositivos activos de ambos participantes, incluido el emisor actual,
   reciben una copia byte por byte idéntica del evento. La room key de esa
   sesión se distribuye a cada dispositivo mediante Olm.
4. PostgreSQL conserva `Message`/`MessageEnvelope`, sobres cifrados, metadatos de
   entrega y vencimiento. La cola `to-device` separada conserva solo control y
   señalización criptográfica, nunca el texto o la foto del chat.
5. El almacenamiento de objetos conserva adjuntos cifrados y privados. Las
   fotos usan el formato Matrix v2 con `A256CTR`; clave, IV y hash autenticados
   viajan únicamente dentro del plaintext protegido por Megolm.
6. Un trabajador elimina datos vencidos y emite métricas operativas.
7. Otro trabajador completa cierres de reportes desde jobs persistentes con
   lease y backoff; ninguna instancia conserva el estado de la saga solo en
   memoria.
8. La identidad administrativa usa contraseña más WebAuthn. La contraseña abre
   una sesión limitada; una passkey verificada habilita el panel y una assertion
   de menos de cinco minutos habilita la lectura excepcional de evidencia y las
   revocaciones de sesiones o passkeys.

## Escalado

La primera instalación puede operar con una instancia de API y PostgreSQL. Cuando
se necesiten varias instancias, Redis coordinará presencia, salas WebSocket y
trabajos. El diseño no redistribuye relaciones existentes al escalar.

## Entidades principales

- `User`
- `CashierProfile`
- `ClientProfile`
- `Invitation`
- `Assignment`
- `Conversation`
- `Message`
- `MessageEnvelope`
- `Attachment`
- `Device`
- `MatrixDeviceRegistration`
- `MatrixDeviceKey`
- `MatrixOneTimeKey`
- `MatrixFallbackKey`
- `MatrixKeyClaimRequest`
- `MatrixDeviceListChange`
- `MatrixToDeviceTransaction`
- `MatrixToDeviceEvent`
- `MatrixToDeviceSyncBatch`
- `EncryptedKeyBundle`
- `AuthSession`
- `AdminWebAuthnCredential`
- `AdminWebAuthnChallenge`
- `AdminRecoveryCode`
- `Block`
- `Report`
- `ReportEvidence`
- `ReportClosureJob`
- `SubscriptionStatus`
- `AdminAuditEvent`

## Frontera de identidad administrativa

El login con contraseña de un `ADMIN` no entrega por sí solo autorización de
panel. Crea una `AuthSession` con `adminMfaVerifiedAt = NULL`; `/api/auth/me` y
las rutas de ceremonia MFA siguen disponibles, mientras `RolesGuard` rechaza
cualquier endpoint anotado para `ADMIN` con `ADMIN_MFA_REQUIRED`. El navegador
monta `AdminMfaGate` antes de solicitar los datos del panel.

El primer enrolamiento genera una credencial residente con verificación de
usuario obligatoria y entrega diez códigos de recuperación una sola vez. Los
desafíos de registro y autenticación duran cinco minutos, se almacenan solo como
SHA-256 y están ligados a usuario, sesión y propósito. Verificación y consumo
ocurren transaccionalmente; la autenticación compara RP ID/origen exactos,
actualiza el contador de la credencial y fija `adminMfaVerifiedAt` con el reloj
de PostgreSQL. El servidor conserva únicamente clave pública y metadatos del
autenticador, nunca la clave privada.

Abrir evidencia está detrás de `AdminMfaRecentGuard`: incluso una sesión ya
verificada debe presentar una assertion WebAuthn cuya antigüedad sea
estrictamente menor a cinco minutos. La PWA solicita el step-up y reintenta la
operación una sola vez. Un código de recuperación válido revoca atómicamente
todas las passkeys, códigos restantes, desafíos abiertos y las demás sesiones;
la sesión que ejecutó la recuperación queda limitada y debe enrolar una nueva
passkey.

El inventario administrativo limita a diez las passkeys activas y devuelve solo
metadatos seguros, nunca el identificador WebAuthn real ni la clave pública. Una
passkey adicional exige MFA reciente al emitir opciones y otra comprobación
transaccional al verificarla; el primer enrolamiento es la única excepción porque
todavía no existe una credencial con la que hacer el step-up. Una
revocación autoservicio reutiliza el step-up reciente, conserva como mínimo una
passkey y bloquea la fila del usuario durante la transacción para impedir que dos
solicitudes concurrentes eliminen la última credencial. El ledger distingue esta
operación mediante `ADMIN_PASSKEY_REVOKED`.

Esta frontera está implementada y probada localmente, pero todavía no es una
certificación operativa. Antes de producción se debe fijar un dominio estable y
HTTPS, configurar `WEBAUTHN_RP_ID`/origen sin cambios posteriores, completar el
primer enrolamiento en una ceremonia confiable, probar los navegadores y
autenticadores soportados y ensayar la custodia/recuperación fuera de banda.

## Perfil criptográfico elegido, aún bloqueado

[ADR-001](ADR-001-E2EE_PROTOCOL.md) selecciona Matrix Rust Crypto 18.6.0 y
[ADR-002](ADR-002-MEGOLM_APPLICATION_MESSAGES.md) fija Megolm para mensajes
ordinarios, con Olm reservado a room keys y control. La misma biblioteca cifra
las fotos en formato Matrix v2. El timeline, los medios
y el ciphertext efímero permanecen en los almacenes propios; no se delegan a un
homeserver Matrix.

Es un **perfil privado de SinoChat**, no un homeserver o cliente Matrix general:
no hay federación ni garantía de interoperabilidad con otros productos Matrix.
`MATRIX_SERVER_NAME` solo fija el namespace estable usado para derivar IDs; no
designa un servicio al que se envíe el chat.

La migración aditiva `20260827000000_matrix_e2ee_transport` ya separa reservas,
claves de dispositivo, preclaves/fallback, reclamos, cambios de lista y
señalización `to-device`. Las correcciones forward `01000`, `02000` y `03000`
endurecen las referencias a dispositivos propios, la validación polimórfica de
preclaves y el orden OTK/fallback. Las siguientes completan la persistencia de
sincronización:

- `20260827004000_matrix_sync_chain_hardening` fija rangos inmutables y un único
  sucesor por token.
- `20260827005000_matrix_device_idempotency_and_sync_lineage` lleva la
  idempotencia de `sendToDevice` al dispositivo y conserva el linaje lógico aun
  después de purgar un predecesor físico.
- `20260827006000_matrix_sync_replay_window` limita la repetición del token a 48
  horas y nunca más allá del primer evento que venza en su rango.
- `20260827007000_matrix_sync_crypto_snapshot` inmoviliza en cada lote el conteo
  OTK y el estado del fallback necesarios para repetir la misma respuesta.
- `20260828000000_matrix_registration_replay` conserva el hash canónico y el
  conteo OTK público de la confirmación inicial para repetir una respuesta
  perdida sin guardar el bearer de vinculación.
- `20260830000000_message_olm_envelope_hardening` rechaza expresamente filas
  heredadas incompatibles y fija el perfil Olm de transición.
- `20260831000000_attachment_purge_ledger_hardening` impide eliminar el registro
  de un adjunto antes de borrar permanentemente su objeto externo.
- `20260831001000_message_megolm_envelope_profile` bloquea cualquier sobre Olm
  existente y fija por `CHECK` `matrix-megolm-v1`,
  `m.megolm.v1.aes-sha2`; los adjuntos permanecen en `A256CTR`.

La base Matrix y sus once forward forman una unidad dentro de las 29
migraciones versionadas. Mantienen las tablas genéricas sin convertir sus blobs
en objetos Matrix. El contenido ordinario continúa en `Message` y
`MessageEnvelope`; `to-device` queda limitado a establecimiento de sesión,
peticiones de claves, verificación, cross-signing y recuperación.

### Transporte privado `to-device` y sincronización

`PUT /api/e2ee/matrix/sendToDevice/:eventType/:transactionId` exige sesión
cliente/cajero vinculada a un dispositivo activo. Solo admite el tipo exterior
`m.room.encrypted` y el algoritmo `m.olm.v1.curve25519-aes-sha2`; el
`sender_key`, la única clave Curve25519 del ciphertext y cada destinatario se
contrastan con el directorio. El objeto exige exactamente `algorithm`,
`ciphertext`, `org.matrix.msgid` y `sender_key`; `org.matrix.msgid` debe ser el
hexadecimal minúsculo de 32 caracteres que emite Rust Crypto 18.6.0. No hay
wildcard. Una solicitud admite hasta 10
usuarios, 20 dispositivos exactos, 60 KiB por contenido y 256 KiB totales. El
`transactionId` es idempotente por dispositivo y endpoint: repetir bytes
equivalentes conserva el resultado y cambiar el contenido produce conflicto.
Cada evento vence exactamente a las 48 horas y una cola rechaza nuevas entradas
al llegar a 2000 eventos no vencidos por dispositivo.

`GET /api/e2ee/matrix/sync` entrega como máximo 100 eventos y 100 cambios de
lista por lote. Los tokens `sct1.<batch UUID>.<MAC>` autentican con HMAC-SHA-256
el dispositivo, linaje, rangos y snapshot criptográfico; PostgreSQL conserva
además el SHA-256 del token. Un mismo `since` produce o reconstruye un único
sucesor determinista. Crear ese sucesor hace ACK del predecesor y elimina
físicamente los eventos cubiertos por él; los eventos y lotes vencidos también
los retira el worker de retención. Ningún token vive más de 48 horas ni del
evento más próximo a vencer de su rango.

La respuesta incremental expone `device_lists.changed` y `device_lists.left`.
`MatrixDeviceListPublisher` serializa cada publicación mediante la fila global
del stream y la fila versionada del usuario dentro de la misma transacción que
cambia el dominio. El alta inicial publica la lista propia y las listas de las
contrapartes ya existentes; revocación, reasignación, eliminación, suspensión y
las transiciones del reset administrativo publican `CHANGED`/`LEFT` sin incluir
contenido del chat. Las pruebas de servicio fijan además el orden `LEFT` del
cajero anterior antes de `CHANGED` del nuevo.

En web, `MatrixTransportCoordinator` consume tokens `sct1` ligados al
dispositivo, entrega primero los eventos a `OlmMachine.receiveSyncChanges` y
persiste `next_batch` solo si el procesamiento termina. También divide
`keys/query` en lotes de 20, separa `keys/claim` por identidad y llama
`markRequestAsSent` únicamente después de una respuesta HTTP validada.
`MatrixSessionLifecycle` ya está montado en React para cliente/cajero: consulta
el gate antes de tocar IndexedDB o las rutas Matrix, conserva credenciales
locales bajo AES-GCM, reanuda el alta inicial mediante un journal cifrado y
ejecuta `runMatrixSyncLoop` con aborto, backoff y una recuperación acotada de
`M_UNKNOWN_POS`. Una Web Lock exclusiva por usuario impide abrir dos
`OlmMachine` en pestañas distintas; al cerrar, el coordinador drena su operación
serializada antes de cerrar WASM y liberar el lock.

Los paneles autenticados sí consultan `GET /api/conversations` aunque el gate
E2EE continúe bloqueado. Ese endpoint es deliberadamente de metadatos: muestra
la contraparte asignada, no leídos y tipo/fecha/secuencia del último mensaje,
pero nunca texto, foto, sobre o adjunto. El cliente exige como máximo una
conversación y el cajero pagina explícitamente su clientela. El parser web usa
una lista cerrada de campos y falla si aparece contenido inesperado. El bloqueo
de cliente por cajero también está conectado porque solo modifica la relación y
dispara la reasignación; enviar, descargar historial y reportar con evidencia no
se habilitan hasta completar el flujo criptográfico correspondiente.

El navegador ya incorpora un codec que acepta únicamente `TEXT` o `IMAGE` bajo
`com.sinochat.message.v1`, valida Unicode/tamaños/UUID y enlaza cada campo
autenticado con los metadatos de `MessageEnvelope`; y un helper de adjuntos que
comprueba la firma binaria JPEG/PNG/WebP, limita el plaintext a 5 MiB, cifra y
descifra con `Attachment`/`EncryptedAttachment`, valida el formato Matrix v2
`A256CTR`, tamaños y SHA-256, y consume el secreto de descifrado una sola vez.
También existe el adaptador Megolm aislado: actualiza dispositivos, completa
sesiones Olm faltantes, comparte una room key, rota conservadoramente por
mensaje y como máximo a una hora, genera el único ciphertext y replica los
mismos bytes para cada dispositivo activo. `MatrixMegolmMessageCrypto` y el
controlador seguro ya conectan estas piezas con listado, texto, foto y limpieza
de caché/Blob URL en los paneles React; el lifecycle solo los entrega cuando el
gate es `READY`, por lo que permanecen inaccesibles en esta etapa.

La caracterización Olm histórica confirmó el rechazo de replay y motivó la
revisión. La caracterización Megolm posterior, ejecutada con dos `OlmMachine`,
Chrome e IndexedDB reales, confirmó que receptor y emisor pueden descifrar el
mismo evento repetidamente incluso tras reabrir el store. También demostró que
`sender`, `device_id`, `sender_key`, ID y timestamp exteriores no forman por sí
solos un binding suficiente; el adaptador debe comparar remitente, dispositivo,
sala, conversación y mensaje incluidos dentro del plaintext autenticado.

El gate compilado continúa en `BLOCKED` y dispositivos, rutas Matrix, contenido
y WebSocket responden 503. La persistencia, los endpoints y la integración
montada no completan E2EE: faltan certificar el flujo completo de texto/foto,
rotación y reasignación entre navegadores reales, autorización multidispositivo, cross-signing,
recuperación, interoperabilidad entre navegadores SinoChat, retención de 48
horas en infraestructura real, revisión criptográfica externa y pentest.
