# ADR-001: protocolo de cifrado de extremo a extremo

- Estado: **aceptado con revisión por ADR-002; chat bloqueado para producción**
- Decisión: 2026-08-27
- Alcance: texto, fotos, dispositivos, recuperación, reasignación y reportes

[ADR-002](ADR-002-MEGOLM_APPLICATION_MESSAGES.md), aprobado el 2026-08-31,
reemplaza la decisión de usar Olm para contenido ordinario. Este ADR conserva
las identidades, control `to-device`, recuperación, reasignación, privacidad y
gates; ADR-002 prevalece para mensajes, adjuntos y rotación.

## Contexto

SinoChat necesita que la API entregue contenido sin poder descifrarlo, que cada
dispositivo tenga identidad propia y que una reasignación no permita leer el
chat anterior. El contenido ordinario debe dejar de servirse al cumplir 48 horas
y purgarse físicamente con el SLO de retención.

El modelo existente de `Device`, preclaves, `MessageEnvelope` y objetos opacos es
solo transporte. Aceptar Base64 y nombres de algoritmos elegidos por el cliente
no demuestra autenticación, ratcheting, forward secrecy ni E2EE. Esos endpoints
permanecen detrás de un gate que responde 503 hasta completar esta decisión.

## Decisión

La primera versión utiliza **Matrix Rust Crypto**, mediante
`@matrix-org/matrix-sdk-crypto-wasm` 18.6.0 fijado exactamente en el lockfile.
La biblioteca es el binding WebAssembly oficial de `matrix-sdk-crypto`; su
`OlmMachine` mantiene el estado criptográfico sin realizar red por cuenta propia.

El perfil SinoChat será:

1. Cada usuario y dispositivo tendrá un identificador Matrix derivado de su UUID
   opaco de SinoChat. La clave privada y el estado Olm vivirán solo en el almacén
   IndexedDB cifrado del navegador.
2. `MATRIX_SERVER_NAME` completa esos identificadores. Es un namespace estable,
   obligatorio en producción y no la URL de un homeserver. Debe fijarse antes de
   registrar el primer dispositivo; cambiarlo crearía identidades diferentes.
3. La API implementará el subconjunto necesario de la semántica Matrix
   Client-Server v1.18 para publicación, consulta y reclamo de claves, cambios de
   dispositivos, firmas, cross-signing y control `to-device`. No aceptará el
   formato genérico actual como si fuera compatible.
4. Cada mensaje ordinario se cifra una vez con Megolm y se entrega mediante
   `Message` y `MessageEnvelope`, no mediante `to-device`. El exterior contiene
   exactamente `algorithm`, `ciphertext`, `device_id`, `sender_key` y
   `session_id` bajo `m.megolm.v1.aes-sha2`; el interior versionado usa
   `com.sinochat.message.v1`. Todos los dispositivos activos de ambos
   participantes, incluido el emisor actual, reciben el mismo ciphertext.
5. La ruta privada
   `PUT /api/e2ee/matrix/sendToDevice/:eventType/:transactionId` y su cola se
   reservarán a establecimiento de sesiones, peticiones de claves, verificación,
   cross-signing, recuperación y demás señalización criptográfica. No contendrán
   textos, fotos ni otro contenido ordinario de la conversación.
6. Cada sesión Megolm rota por mensaje y además como máximo a una hora. Habrá
   exclusión mutua por máquina/sala y la room key se distribuirá con Olm a todos
   los dispositivos del snapshot antes de confirmar el mensaje.
7. Las fotos se recodificarán en el navegador, se limitarán a 5 MiB de texto
   plano y se cifrarán con `Attachment.encrypt` de la misma biblioteca. Este
   produce el formato de adjunto Matrix v2 con `A256CTR`; la información de
   descifrado viajará dentro del mensaje interior protegido por Megolm, nunca junto
   al objeto.
8. PostgreSQL y el bucket privado de SinoChat conservarán solamente ciphertext,
   hashes, tamaños y vencimientos. Ningún timeline, media ni payload de chat se
   enviará a Synapse o a un homeserver Matrix.
9. Olm se usará exclusivamente para room keys y control criptográfico. La
   rotación Megolm por mensaje limita cada room key a un evento; no se habilita
   backup de claves del lado del servidor.
10. Cada reasignación creará una conversación criptográfica nueva. El cajero
   anterior no recibe sobres posteriores y el nuevo no recibe sobres, sesiones
   ni claves del chat anterior.
11. La evidencia de un reporte seguirá siendo un paquete separado, producido en
   el dispositivo denunciante y cifrado para la clave pública de investigación.
   El rol administrador no obtendrá claves Olm ni acceso al chat ordinario.

Fuentes primarias:

- [README oficial de matrix-sdk-crypto-wasm](https://github.com/matrix-org/matrix-sdk-crypto-wasm/blob/main/README.md)
- [API de OlmMachine](https://matrix-org.github.io/matrix-sdk-crypto-wasm/classes/OlmMachine.html)
- [Tutorial oficial de matrix-sdk-crypto](https://matrix-org.github.io/matrix-rust-sdk/matrix_sdk_crypto/tutorial/index.html)
- [Matrix Client-Server v1.18, E2EE](https://spec.matrix.org/v1.18/client-server-api/#end-to-end-encryption)
- [Release 18.6.0](https://github.com/matrix-org/matrix-sdk-crypto-wasm/releases/tag/v18.6.0)

## Perfil privado, no homeserver Matrix

La referencia a Matrix describe formatos, algoritmos y semánticas criptográficas
reutilizadas. SinoChat no implementa un homeserver ni un cliente Matrix general,
no participa en federación y no promete interoperabilidad con Element, Synapse u
otros clientes/homeservers. Los identificadores con forma Matrix son internos
al namespace configurado y las salas no se publican en la red Matrix.

Esta separación es deliberada: las solicitudes de claves y la señalización usan
el subconjunto Matrix documentado, mientras que el contenido ordinario conserva
el transporte efímero propio para hacer cumplir autorización, reasignación y
retención. Por ello, superar pruebas con el SDK no demuestra por sí solo que el
perfil privado sea seguro ni interoperable entre dos navegadores SinoChat.

El servidor no puede inspeccionar el tipo interior de un evento
`m.room.encrypted`. Por tanto, la separación de `to-device` se aplicará también en
los contratos tipados y clientes oficiales, y el receptor rechazará
`com.sinochat.message.v1` si llega por esa cola. La API sí debe imponer el
allowlist exterior de control, destinatarios exactos, relación vigente, tamaño,
idempotencia y vencimiento. La auditoría debe probar que un cliente hostil no
puede convertir esta cola acotada en una vía alternativa de chat.

## Por qué no se almacenarán mensajes en Synapse

Synapse tiene una política estable de retención predeterminada, pero sus tareas
de purga son periódicas, un evento puede permanecer en base más allá de su
vencimiento, no se purgan eventos de estado y se conserva al menos el último
evento de cada sala. Eso no satisface por sí solo la política de payload efímero
de SinoChat.

Usar el estado criptográfico Matrix no obliga a guardar el timeline ni los
adjuntos en un homeserver: `OlmMachine` es una máquina sin I/O de red y el propio
cliente es responsable de transportar sus solicitudes y respuestas. La capa del
perfil privado se someterá a pruebas de interoperabilidad interna entre
navegadores SinoChat y revisión independiente; no se asumirá que el uso de la
biblioteca vuelve segura automáticamente esa integración ni compatible al
producto con la red Matrix.

Fuente:

- [Synapse: políticas de retención](https://element-hq.github.io/synapse/latest/message_retention_policies.html)

## Alternativas descartadas

### Matrix completo con timeline y media en Synapse

Se descarta para la primera versión por duplicar autenticación, asignaciones,
almacenamiento y operación, y por la incompatibilidad de su purga de eventos con
la retención exigida. Podría reevaluarse si el producto cambia su contrato de
retención.

### MLS y OpenMLS sobre el transporte propio

MLS, definido por RFC 9420 y RFC 9750, separa un servicio de autenticación y uno
de entrega. Sería una buena arquitectura futura, pero no es una biblioteca de
chat completa: SinoChat tendría que diseñar credenciales, consistencia, forks,
persistencia, recuperación y entrega.

OpenMLS 0.8.1 puede compilar a WebAssembly, pero su propia matriz de plataformas
solo lo enumera como construido y no probado en ese destino. Además recibió
correcciones de seguridad de impacto alto/moderado en 2025–2026. Adoptarlo ahora
trasladaría demasiado trabajo criptográfico nuevo al proyecto.

Fuentes:

- [RFC 9420: protocolo MLS](https://www.rfc-editor.org/rfc/rfc9420.html)
- [RFC 9750: arquitectura MLS](https://www.rfc-editor.org/rfc/rfc9750.html)
- [OpenMLS: plataformas soportadas](https://github.com/openmls/openmls)
- [Avisos de seguridad de OpenMLS](https://github.com/openmls/openmls/security/advisories)

### libsignal oficial en la PWA

Se mantiene descartado: el paquete oficial está orientado a binarios nativos y
Node/escritorio, no ofrece una integración de navegador soportada para esta PWA.

Fuente:

- [signalapp/libsignal](https://github.com/signalapp/libsignal)

### Web Crypto o protocolo propio

Se descarta. Primitivas aisladas no resuelven identidad de dispositivos,
ratcheting, recuperación, reordenamiento, replay ni post-compromise security.

## Encaje con el modelo existente

La migración aditiva
`20260827000000_matrix_e2ee_transport` incorpora reservas de dispositivo,
objetos firmados de dispositivo, preclaves de un solo uso, fallback, resultados
idempotentes de reclamo, cambios de lista y una cola `to-device` separada con
cursores/batches de sincronización. Sus restricciones preservan tombstones de
preclaves, impiden reutilizar material público y asignan posiciones mediante
filas bloqueables para respetar el orden de commit.

Nueve migraciones forward completan ese estado sin reescribir una migración ya
aplicada: `20260827001000_owned_device_reference_record_fix` corrige referencias
polimórficas a dispositivos propios;
`20260827002000_matrix_pre_key_record_fix` corrige la lectura común del timestamp
de reclamo de OTK/fallback; y
`20260827003000_matrix_claim_selection_hardening` exige consumir primero el lote
OTK disponible más antiguo.
`20260827004000_matrix_sync_chain_hardening` crea la cadena y los rangos
inmutables de sync;
`20260827005000_matrix_device_idempotency_and_sync_lineage` corrige el alcance
de idempotencia al dispositivo y preserva el linaje lógico;
`20260827006000_matrix_sync_replay_window` acota la repetición al rango todavía
retenido durante un máximo de 48 horas; y
`20260827007000_matrix_sync_crypto_snapshot` fija la disponibilidad OTK/fallback
devuelta por cada lote; y
`20260828000000_matrix_registration_replay` fija el hash canónico y el conteo
OTK de la confirmación inicial para recuperar una respuesta perdida sin guardar
el secreto; y
`20260830000000_message_olm_envelope_hardening` fijó el perfil transitorio;
`20260831000000_attachment_purge_ledger_hardening` protege el ledger de borrado
del objeto; y `20260831001000_message_megolm_envelope_profile` rechaza sobres
Olm existentes y fija `matrix-megolm-v1`, `m.megolm.v1.aes-sha2` y adjuntos
`A256CTR`. El esquema vigente suma 30 migraciones y requiere la base Matrix y
sus once forward en ese orden. La nueva `20260910000000_matrix_cross_signing_identity`
conserva el triplete público y el certificado del primer dispositivo de forma
atómica e inmutable; no habilita dispositivos adicionales.

La migración no convierte blobs antiguos en claves Matrix ni declara válidos los
DTO genéricos. Conserva las tablas anteriores para compatibilidad operativa y
relaja a `NULL` las columnas criptográficas genéricas de `Device`, porque el
nuevo registro guarda el objeto firmado en `MatrixDeviceKey`. Tampoco mueve el
chat a `matrix_to_device_events`: `MessageEnvelope` conserva una copia del
ciphertext Megolm idéntico por dispositivo y esa cola se limita a distribución
Olm de room keys y control/señalización.

El esquema Matrix sigue incompleto: el [bootstrap inicial](CROSS_SIGNING_BOOTSTRAP.md)
ya tiene persistencia, pero faltan la ceremonia de aprobación de dispositivos
adicionales y la confianza visible entre participantes. El respaldo
`EncryptedKeyBundle` no se activará hasta
definir la recuperación y comprobar que el servidor nunca recibe el secreto. No
se migrarán filas de prueba antiguas a mensajes E2EE válidos; antes de abrir el
chat se eliminarán los datos incompatibles mediante una migración operativa
explícita.

## Transporte privado implementado, aún bloqueado

La API implementa, detrás de `E2eeReleaseGuard`, estas rutas para clientes y
cajeros con sesión vinculada a un dispositivo:

- Las rutas de reserva/finalización y `POST /keys/upload` crean una identidad
  Matrix interna y publican exclusivamente claves públicas firmadas.
- `POST /api/e2ee/matrix/keys/query` acepta hasta 20 identidades por solicitud y
  `POST /api/e2ee/matrix/keys/claim/:requestId` reclama una identidad por
  subsolicitud idempotente. Aunque el lote nace en Rust Crypto, el servidor
  resuelve cada Matrix ID a un UUID interno y vuelve a autorizar cada relación;
  también permite reclamos entre dispositivos propios sin una conversación
  ficticia.
- `PUT /api/e2ee/matrix/sendToDevice/:eventType/:transactionId` acepta
  exclusivamente el exterior `m.room.encrypted` con
  `m.olm.v1.curve25519-aes-sha2`, sin wildcard y dirigido a claves Curve25519
  exactas. El contenido debe contener exactamente `algorithm`, `ciphertext`,
  `org.matrix.msgid` y `sender_key`; el identificador es hexadecimal minúsculo
  de 32 caracteres. Limita cada solicitud a 10 usuarios, 20 dispositivos, 60
  KiB por contenido y 256 KiB totales. Cada evento dura 48 horas y cada
  dispositivo puede acumular como máximo 2000 eventos pendientes no vencidos.
- `GET /api/e2ee/matrix/sync` entrega lotes de hasta 100 eventos y 100 cambios de
  lista. Un parámetro `timeout` solo se acepta entre 0 y 30000 ms; esta capa no
  debe asumirse como long polling completo hasta probar su integración real.

Los tokens tienen formato `sct1.<batch UUID>.<MAC>`. El MAC HMAC-SHA-256 cubre
dispositivo, predecesor, rangos y snapshot OTK/fallback, y la base conserva el
SHA-256 del token para una segunda comparación. Repetir un `since` reconstruye
el mismo sucesor. Solo al crear el sucesor se confirma el lote predecesor y se
purgan sus eventos cubiertos; un token o evento vencido se elimina por
retención. La ventana de replay nunca supera 48 horas ni el primer vencimiento
del rango.

La respuesta soporta `device_lists.changed` y `device_lists.left`. Un publicador
transaccional versiona la lista, avanza el stream global y hace fanout inmutable
al usuario y sus contrapartes. El alta inicial publica también pares históricos;
la revocación de dispositivo, cierre/reasignación, eliminación, suspensión y las
transiciones del reset administrativo emiten los cambios correspondientes antes
del commit. Aún se requieren pruebas integrales de concurrencia con navegadores
y el flujo definitivo de rotación/cross-signing antes de `READY`.

## Gate de liberación

El estado compilado está en `BLOCKED` y no existe `E2EE_CHAT_ENABLED` ni otra
variable que pueda evitarlo. Mientras siga así:

- `GET /api/e2ee/status` publica el estado y la versión elegida;
- todas las rutas de dispositivos criptográficos responden 503;
- lectura/envío de mensajes, recibos y permisos de adjuntos responden 503;
- el namespace WebSocket de chat rechaza la conexión;
- el listado administrativo de asignaciones/conversaciones puede seguir
  funcionando porque no entrega contenido.

Cambiar una constante a `READY` sin satisfacer los criterios siguientes sería
un defecto de seguridad y debe ser bloqueado por revisión de código.

## Evidencia técnica completada

- Dependencia oficial 18.6.0 fijada exactamente y `npm audit` sin hallazgos al
  momento de la decisión.
- `npm run check:e2ee-runtime` inicializa el WASM en Node, exige una solicitud
  firmada de publicación de claves, comprueba algoritmos y preclaves públicas y
  rechaza campos con nombres de material privado.
- La misma prueba cifra y descifra un adjunto con el formato Matrix v2 y verifica
  que la información secreta se consume una sola vez al descifrar.
- El codec interior web acepta únicamente los esquemas cerrados `TEXT` e
  `IMAGE` de `com.sinochat.message.v1`, valida tipos, Unicode, UUID, tamaños y
  Matrix v2 `A256CTR`, y contrasta conversación, mensaje, dispositivo, clase de
  contenido y metadatos de adjunto con el transporte antes de devolver
  plaintext.
- El helper específico de fotos inspecciona la firma binaria JPEG/PNG/WebP,
  limita el plaintext a 5 MiB, cifra con `Attachment.encrypt`, valida clave, IV,
  SHA-256 y tamaños exactos del formato v2, protege contra cambios de bytes
  durante la operación y consume `EncryptedAttachment` una sola vez.
- El adaptador web exige contexto seguro, IndexedDB, passphrase local de al menos
  32 bytes y una única máquina abierta por almacén.
- El API prueba que una variable de entorno no puede abrir el gate.
- El validador de publicación inicial procesa una solicitud real emitida por
  `OlmMachine`, reproduce los vectores de JSON canónico de Matrix, verifica las
  firmas Ed25519 del dispositivo y de cada preclave y rechaza alteración,
  downgrade, sustitución de identidad y campos inesperados. También valida
  reposiciones parciales contra la identidad Ed25519 ya confiable.
- `MATRIX_SERVER_NAME` se valida de forma compartida y genera identificadores de
  usuario, dispositivo y conversación deterministas a partir de UUID internos.
- La migración `20260827000000_matrix_e2ee_transport` y sus correcciones forward
  `20260827001000_owned_device_reference_record_fix`,
  `20260827002000_matrix_pre_key_record_fix` y
  `20260827003000_matrix_claim_selection_hardening` crean y endurecen la
  persistencia separada para registro inicial, claves y reclamos.
- Las forward `20260827004000_matrix_sync_chain_hardening`,
  `20260827005000_matrix_device_idempotency_and_sync_lineage`,
  `20260827006000_matrix_sync_replay_window` y
  `20260827007000_matrix_sync_crypto_snapshot` protegen la cadena, idempotencia,
  ventana de replay y snapshot criptográfico de `sendToDevice`/`sync`.
- `20260830000000_message_olm_envelope_hardening` falla ante fixtures heredados
  incompatibles en lugar de renombrarlos como E2EE; las migraciones
  `20260831000000_attachment_purge_ledger_hardening` y
  `20260831001000_message_megolm_envelope_profile` protegen el ledger externo y
  fijan el perfil Megolm vigente sin convertir ciphertext Olm.
- Las rutas privadas de `sendToDevice` y `sync` validan autorización, límites,
  sobre Olm, tokens HMAC/hash, reintento, ACK y purga, pero siguen inaccesibles
  por el gate `BLOCKED`.
- La API usa un parser exterior Megolm estricto al crear `MessageEnvelope`:
  decodifica Base64 canónico y JSON UTF-8, exige los cinco campos exactos,
  contrasta `device_id`/`sender_key` con el emisor y exige el mismo ciphertext
  para cada copia.
- El contrato de destinatarios de `MessageEnvelope` incluye todos los
  dispositivos activos: el emisor actual, sus otros dispositivos y los de la
  contraparte. Omitir, duplicar o agregar cualquiera falla cerrado y cada
  participante debe tener al menos uno.
- El coordinador web valida y divide las solicitudes salientes de
  `OlmMachine`, marca una solicitud como enviada solo tras HTTP exitoso, procesa
  `/sync` antes de guardar el cursor y descarta cualquier intento de transportar
  `com.sinochat.message.v1` por `to-device`. Su checker usa el WASM real para la
  inicialización/adjuntos y una máquina controlada para probar orden y fallos de
  transporte.
- El lifecycle web consulta `BLOCKED` antes del almacenamiento, valida el perfil
  completo, vincula sesiones antes de abrir Rust Crypto y conserva un journal
  cifrado para repetir el alta tras perder una respuesta o caer después de
  `markRequestAsSent`. La exclusión entre pestañas es no bloqueante y el cierre
  drena la cola Matrix antes de liberar `OlmMachine` y la Web Lock.
- Los servicios de asignación, dispositivos, administración y autenticación
  prueban que `LEFT`/`CHANGED` ocurre dentro de la transacción; el arranque real
  de Nest confirma que el publicador global se inyecta en todos esos módulos.
- `npm run check:matrix-db` valida esas restricciones en PostgreSQL local con
  fixtures transitorios y finaliza con `ROLLBACK`; rechaza bases remotas y
  producción. Esta verificación no sustituye las pruebas integrales contra
  navegadores reales ni autoriza abrir el gate.
- La caracterización Olm con tres máquinas documenta el rechazo de replay que
  motivó ADR-002. La caracterización Megolm con dos máquinas, navegador e
  IndexedDB reales confirma lectura repetida, reapertura del store, lectura
  propia y el exterior exacto; también exige bindings interiores porque varios
  metadatos exteriores son mutables.

Esta prueba valida carga y superficie básica; no prueba todavía
interoperabilidad entre dos dispositivos ni autoriza producción.

## Trabajo obligatorio antes de `READY`

1. Validar el lifecycle montado en todos los navegadores objetivo, incluidas
   concurrencia entre pestañas, suspensión/reanudación y fallos durante el
   cierre; cerrar firmas/cross-signing. Las pruebas controladas actuales no
   completan este punto.
2. Probar entre dos navegadores reales: establecimiento Olm, distribución de
   room keys, texto, foto, reintento, lectura repetida, pérdida de paquetes y
   rotación Megolm por mensaje/máximo una hora. Las caracterizaciones aisladas
   no sustituyen esta prueba.
3. Demostrar que el snapshot de dispositivos, `shareRoomKey` y el commit del
   mensaje son consistentes ante altas, revocaciones, caídas y reintentos; nunca
   se omite un dispositivo ni se reutiliza una sesión de otro mensaje.
4. Conectar `Message`/`MessageEnvelope` con el exterior Megolm y el
   codec interior `com.sinochat.message.v1`; demostrar envío, listado y
   descarga de adjuntos sin abrir una ruta genérica o transportar contenido
   ordinario por `to-device`.
5. Implementar autorización de dispositivo nuevo por un dispositivo confiable o
   código de recuperación. Un reset administrativo nunca firma un dispositivo.
6. Implementar verificación visible de huellas/cross-signing y advertencias no
   suprimibles ante cambios de identidad.
7. Completar el empaquetador de evidencia de reportes y su firma en el extremo.
8. Demostrar reasignación, suspensión y revocación linealizables, sin entregas a
   dispositivos excluidos después del commit.
9. Certificar Chrome, Edge, Firefox y Safari en escritorio/móvil, incluyendo
   IndexedDB, almacenamiento lleno, modo privado y actualización del service
   worker.
10. Demostrar inaccesibilidad exacta al vencer y purga de infraestructura p99
   menor a 60 segundos/máximo operativo 5 minutos, sin payload en backups, WAL,
   cachés, service worker ni objetos versionados.
11. Aprobar auditoría criptográfica externa de la integración y pentest
    independientes. El gate permanece `BLOCKED` hasta entonces.

## Política de versión y downgrade

- La versión npm se fija exactamente; las actualizaciones se revisan con
  changelog, avisos, smoke test, interoperabilidad y artefacto reproducible.
- El API no negocia hacia algoritmos desconocidos o anteriores. Un dispositivo
  incompatible debe actualizarse; nunca se degrada a texto plano.
- La versión de protocolo forma parte de cada sobre y del contenido autenticado.
- Una migración de protocolo debe soportar lectura segura durante una ventana
  explícita o invalidar sesiones; no probará algoritmos alternativos después de
  un fallo de autenticación.

## Criterios finales de aceptación

- API, administrador, storage, Redis, logs y push nunca reciben plaintext ni
  claves privadas.
- Agregar un dispositivo requiere autorización criptográfica y produce un cambio
  visible/verificable.
- Revocar, bloquear, suspender o reasignar impide nuevas entregas de forma
  linealizable.
- Un cajero nuevo no descifra el chat anterior y el anterior no descifra el nuevo.
- La recuperación no depende de que el servidor conozca el secreto.
- El reporte cifra un manifiesto firmado para la clave pública de investigación.
- Ningún payload ordinario, thumbnail, caché u objeto recuperable sobrevive al
  ciclo de 48 horas de la infraestructura controlada por SinoChat.
- Downgrade, replay, concurrencia, cambios de dispositivo y clientes maliciosos
  tienen pruebas automatizadas.
- Revisión criptográfica y pentest independientes están aprobados.

SinoChat puede borrar sus propias copias y las de clientes conformes, pero no
puede borrar capturas o exportaciones hechas por un participante ni ejecutar un
borrado en un dispositivo apagado. Al volver, el cliente debe purgar antes de
mostrar o descifrar datos vencidos.
