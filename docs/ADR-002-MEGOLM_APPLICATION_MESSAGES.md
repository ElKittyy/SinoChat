# ADR-002: Megolm para mensajes ordinarios de aplicación

- Estado: **aceptado para implementación; gate E2EE en `BLOCKED`**
- Decisión: 2026-08-31
- Alcance: textos, fotos, historial de 48 horas y distribución a dispositivos
- Revisa: ADR-001 en lo relativo al cifrado de mensajes ordinarios

## Contexto

ADR-001 eligió un sobre Olm independiente por dispositivo para cada mensaje.
La caracterización con `@matrix-org/matrix-sdk-crypto-wasm` 18.6.0 confirmó
autenticación y protección antirreplay, pero también una incompatibilidad con el
historial: después de que `receiveSyncChanges` consume un sobre Olm, el mismo
ciphertext no puede descifrarse otra vez. Una recarga o reintento exige entonces
una caché local de plaintext y deja un intervalo de caída entre avanzar el
ratchet y confirmar esa caché.

La caracterización Megolm aislada confirmó tres propiedades necesarias para
SinoChat:

- un receptor puede descifrar varias veces el mismo evento;
- la room key sobrevive al cierre y reapertura del store IndexedDB cifrado;
- el emisor puede descifrar su propio evento sin crear una sesión Olm consigo
  mismo.

También confirmó que los metadatos exteriores no son todos autenticados por sí
solos. En particular, alterar `sender`, `device_id`, `sender_key`, `event_id` o
`origin_server_ts` no siempre impide descifrar. La identidad y el contexto
deben estar incluidos en el plaintext cifrado y contrastarse después del
descifrado.

## Decisión

### División de responsabilidades

1. Los textos y mensajes de foto ordinarios usarán eventos Megolm creados con
   `OlmMachine.encryptRoomEvent`. El perfil exterior será exactamente
   `m.megolm.v1.aes-sha2`, con los campos `algorithm`, `ciphertext`,
   `device_id`, `sender_key` y `session_id`. El protocolo persistido se
   identificará como `matrix-megolm-v1`.
2. Olm se reservará para distribuir room keys con `shareRoomKey` y para eventos
   criptográficos de control: publicación/consulta/reclamo de claves,
   verificación, cross-signing, solicitudes de claves, recuperación y
   revocación. Los textos, fotos y claves de adjuntos no viajarán como contenido
   ordinario en la cola `to-device`.
3. SinoChat seguirá usando su API y almacenamiento efímero privados. Esta
   decisión reutiliza Matrix Rust Crypto; no crea un homeserver, timeline o
   federación Matrix y no envía el chat a Synapse.
4. Cada conversación tendrá un `roomId` determinista ligado a su UUID y al
   namespace configurado. Una reasignación crea una conversación y sala nuevas.
   El cajero anterior no recibe sesiones ni ciphertext posteriores y el nuevo
   cajero no recibe claves del historial anterior.

### Sesiones y rotación

5. La configuración Megolm será `MegolmV1AesSha2`,
   `HistoryVisibility.Joined` y distribución a todos los dispositivos
   criptográficos activos de ambos participantes.
6. La sesión rotará **por mensaje** mediante
   `rotationPeriodMessages = 1`. Además tendrá un máximo temporal de una hora,
   `rotationPeriod = 60 * 60 * 1_000_000` microsegundos. Se aplica el primer
   límite alcanzado; el límite temporal es defensa adicional, no permiso para
   reutilizar una sesión en un segundo mensaje.
7. Antes de cifrar se actualizará el directorio de dispositivos, se reclamarán
   las sesiones Olm faltantes y se distribuirá la nueva room key. Todas las
   solicitudes de distribución deben confirmarse por HTTP antes de persistir el
   mensaje. Falta, revocación o cambio concurrente de un dispositivo obliga a
   fallar cerrado y reconstruir el snapshot; nunca a omitir silenciosamente al
   destinatario.
8. La máquina criptográfica y cada sala tendrán ejecución serializada. No se
   compartirán dos room keys ni se cifrarán dos mensajes concurrentemente sobre
   el mismo estado sin el coordinador exclusivo.

La rotación por mensaje conserva la ventaja de historial de Megolm y reduce el
alcance de una room key a un único evento. Su costo aceptado es distribuir una
room key por Olm antes de cada mensaje.

### Un ciphertext, cobertura de todos los dispositivos

9. `encryptRoomEvent` producirá una sola representación canónica del evento.
   Cada `MessageEnvelope` de ese mensaje contendrá **el mismo Base64 byte por
   byte** para todos los dispositivos activos: el dispositivo emisor actual,
   sus otros dispositivos y todos los dispositivos de la contraparte.
10. `recipientDeviceId` identifica la copia de entrega, no un ciphertext
    Megolm diferente. La API exigirá una y solo una copia para cada dispositivo
    del snapshot, una contraparte con al menos un dispositivo seguro, Base64
    canónico y absoluta igualdad entre todas las copias. También ligará
    `device_id` y `sender_key` exteriores al dispositivo emisor registrado.
11. La duplicación por dispositivo se conserva para autorización, cobertura,
    entrega y auditoría de revocaciones. No debe interpretarse como cifrado
    individual del mensaje: todos reciben el mismo evento y la room key se les
    distribuye separadamente mediante Olm.

### Bindings interiores obligatorios

12. El contenido autenticado `com.sinochat.message.v1` incluirá como mínimo:

    - `protocolVersion`;
    - `conversationId` y su `roomId` determinista;
    - `clientMessageId`;
    - `senderUserId` y `senderDeviceId`;
    - `kind`, seguido del texto o de la metadata cerrada de la foto.

13. Después de `decryptRoomEvent`, el receptor contrastará esos campos con la
    conversación solicitada, el mensaje transportado, el participante vigente,
    el dispositivo Matrix derivado, el remitente y la sesión devueltos por Rust
    Crypto. También rechazará claves reenviadas, forwarders inesperados,
    algoritmos alternativos, campos adicionales y metadata de transporte que no
    coincida. Cualquier mismatch invalida todo el mensaje.
14. `sender`, `event_id`, `origin_server_ts`, `createdAt`, `expiresAt` y
    `serverSequence` exteriores son datos de transporte. Pueden validarse para
    orden, paginación y retención, pero no se presentarán como autenticados de
    extremo a extremo salvo que una versión futura los incluya expresamente en
    el contenido cifrado.

### Fotos

15. Las fotos admitidas continúan siendo JPEG/JPG, PNG y WebP, con máximo de
    5 MiB de plaintext. El navegador comprobará la firma binaria y cifrará los
    bytes antes de solicitar la carga.
16. Los adjuntos usarán el formato Matrix v2 producido por
    `Attachment.encrypt`, con `A256CTR`, clave de 256 bits, IV y SHA-256. La
    clave, el IV y la información de descifrado vivirán únicamente dentro del
    mensaje Megolm; nunca junto al objeto ni en metadata legible por la API.
17. El contenido interior ligará MIME declarado, tamaños exactos de plaintext y
    ciphertext y SHA-256 del ciphertext con el grant y el objeto almacenado. El
    receptor comprobará esas igualdades antes de descifrar o mostrar la imagen.

### Historial y eliminación a las 48 horas

18. Texto, evento Megolm, sobres por dispositivo y objeto de foto vencerán
    exactamente a las 48 horas desde el commit del mensaje. Los listados no
    devolverán filas vencidas y el worker purgará permanentemente base de
    datos, versiones del objeto, multipart incompletos y cachés dentro del SLO
    operativo definido.
19. La fila de adjunto es el ledger durable de eliminación. Un mensaje no puede
    borrarse en cascada antes de que desaparezca el objeto externo; después se
    eliminan adjunto, sobres y mensaje. Backups, WAL, réplicas, logs y métricas
    no pueden prolongar el payload ordinario.
20. Una room key que permanezca en IndexedDB no vuelve recuperable un mensaje
    cuyo ciphertext fue purgado. Aun así, el cliente debe eliminar ciphertext,
    previews, URLs, blobs y cachés locales al vencer; no puede usar la
    persistencia de la clave para ampliar el historial visible.
21. La evidencia creada por un reporte es un artefacto criptográfico separado,
    sujeto al flujo y retención de investigación. No concede al administrador
    room keys ni acceso al chat ordinario.

## Migraciones de transición

La transición se implementa de forma forward-only:

- `20260831000000_attachment_purge_ledger_hardening` cambia la relación de
  adjuntos a `ON DELETE RESTRICT`. Así la fila conserva `object_key` hasta que el
  worker haya eliminado permanentemente todas las versiones del objeto; es el
  endurecimiento del ledger de retención.
- `20260831001000_message_megolm_envelope_profile` rechaza el despliegue si
  existen `message_envelopes` Olm y luego fija en PostgreSQL
  `matrix-megolm-v1` y `m.megolm.v1.aes-sha2`.

No existe una conversión válida de ciphertext Olm a Megolm en el servidor. Una
base con sobres anteriores exige una decisión operativa explícita; nunca se
renombrarán filas heredadas ni se simulará que fueron recifradas. Ambas
migraciones mantienen el gate cerrado.

## Relación con ADR-001

Este ADR sustituye las partes de ADR-001 que exigen Olm para el mensaje
ordinario, orden por par Olm, protección Olm de la metadata del adjunto y la
prohibición de Megolm para mensajes de aplicación. Permanecen vigentes, salvo
conflicto explícito:

- las identidades Matrix derivadas y el namespace estable;
- el store IndexedDB local cifrado;
- la cola privada de control, autorización y límites;
- el bucket privado y la ausencia de plaintext en servidor;
- conversaciones nuevas al reasignar;
- evidencia de reportes separada;
- privacidad administrativa y todos los criterios de auditoría.

Si ambos ADR difieren respecto del algoritmo de mensajes ordinarios, prevalece
ADR-002 por ser la decisión posterior y específica.

## Consecuencias

### Positivas

- El historial vigente puede volver a descifrarse después de recargas,
  reintentos y reapertura del store sin persistir plaintext.
- El emisor recupera sus propios mensajes mediante la sesión Megolm y deja de
  existir la excepción imposible de cifrar Olm para el dispositivo actual.
- Un único ciphertext canónico simplifica la detección de sustitución entre
  copias y el binding por mensaje.
- La rotación por mensaje limita el material compartido por cada room key.

### Costos y riesgos aceptados

- Cada mensaje requiere distribución Olm de una nueva room key a todos los
  dispositivos activos; el envío tiene costo lineal y más puntos de fallo.
- El snapshot de dispositivos puede cambiar entre consulta, key-share y commit;
  debe resolverse con serialización, versionado y reintento cerrado.
- Megolm no autentica por sí solo toda la metadata exterior. Omitir el codec y
  sus comparaciones interiores permitiría sustitución de identidad o contexto.
- Una clave entregada no puede revocarse retroactivamente. Rotación,
  autorización del listado y purga impiden entregas futuras, pero no borran una
  copia que un extremo ya recibió legítimamente.
- La recuperación, incorporación tardía de dispositivos y cross-signing
  requieren una política explícita para no compartir historial o claves con un
  dispositivo no autorizado.

## Gate y criterios pendientes

El estado continúa en `BLOCKED`. Ninguna variable de entorno, migración o
resultado aislado puede abrirlo. Antes de cambiar a `READY` deben existir, como
mínimo, estas evidencias:

1. Pruebas entre dos navegadores reales y múltiples dispositivos para
   publicación/consulta/reclamo Olm, `shareRoomKey`, texto, foto, lectura
   repetida, recarga y reapertura de IndexedDB.
2. Pruebas de rotación efectiva tras cada mensaje y como máximo a una hora,
   incluyendo concurrencia, fallo parcial de key-share, reintento idempotente y
   ausencia de reutilización accidental de sesión.
3. Cobertura P0 que demuestre un ciphertext idéntico para todo el snapshot,
   inclusión del emisor actual, ausencia o duplicación de destinatarios,
   cambios concurrentes y rechazo de Base64 o forma exterior no canónicos.
4. Validación P0 de bindings interiores y exteriores: remitente, dispositivo,
   sala, conversación, mensaje, tipo, adjunto y metadata de sesión; mutación de
   cada campo debe fallar cerrado.
5. Autorización de dispositivos nuevos, verificación visible, cross-signing,
   recuperación sin intervención legible del administrador y revocación
   linealizable ante logout, suspensión, bloqueo y reasignación.
6. Flujo completo A256CTR de carga y descarga: MIME real, límite de 5 MiB,
   hash/tamaños, grant de un uso, objeto privado, expiración y purga de todas las
   versiones.
7. Demostración de retención de 48 horas en PostgreSQL, bucket, multipart,
   cachés, réplicas, WAL, backups y restauraciones, con el ledger resistente a
   caídas y sin ventanas de reaparición.
8. Empaquetado y firma de evidencia de reportes sin entregar room keys ni
   habilitar lectura administrativa del chat ordinario.
9. Certificación de Chrome, Edge, Firefox y Safari en escritorio/móvil,
   incluyendo varias pestañas, modo privado, cuota agotada, desconexión y
   actualización de aplicación.
10. Revisión independiente del protocolo privado, threat model actualizado,
    runbooks operativos, respuesta a incidentes y auditoría criptográfica antes
    de cualquier uso en producción.

Hasta completar todos esos puntos, las rutas de mensajes, adjuntos y WebSocket
de chat deben seguir respondiendo con el bloqueo E2EE; sólo pueden exponerse
metadatos administrativos que nunca incluyan contenido ni ciphertext.
