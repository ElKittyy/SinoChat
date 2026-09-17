# Modelo de datos

Estado: diseño inicial implementado en Prisma y en la migración PostgreSQL.

## Principios

- PostgreSQL conserva identidad, autorización, asignaciones, metadatos mínimos y
  sobres cifrados.
- No existe ninguna columna para texto, pie de foto, nombre original de archivo o
  clave privada sin cifrar.
- Los identificadores públicos de dispositivos y las claves públicas sí pueden
  almacenarse; todo material recuperable o de mensaje se almacena como
  `ciphertext`.
- Las restricciones de la migración son parte del modelo. No deben reemplazarse
  por una migración generada automáticamente sin volver a incluir índices
  parciales, `CHECK` y triggers diferibles.

## Identidad, acceso y mayoría de edad

`User` contiene el rol inmutable, estado de cuenta, nombre normalizado, hash
Argon2id y versión de sesión. Los tokens de `AuthSession` también se guardan
exclusivamente como hash. Cliente y cajero tienen perfiles separados, lo que
permite que las claves foráneas garanticen el rol de los participantes.

Para un usuario `ADMIN`, una contraseña válida crea una sesión limitada con
`AuthSession.adminMfaVerifiedAt = NULL`. Esa sesión puede consultar su estado y
completar la ceremonia WebAuthn, pero no satisface una autorización de rol
administrativo hasta verificar una passkey. El instante de la assertion queda
en `adminMfaVerifiedAt`; abrir evidencia exige además que sea posterior al
límite estricto de cinco minutos calculado con el reloj de PostgreSQL.

La identidad WebAuthn administrativa se separa en tres modelos:

- `AdminWebAuthnCredential` guarda identificador público, clave pública,
  contador anti-replay, transportes, tipo de dispositivo y estado de backup.
  Nunca contiene una clave privada. Una revocación fija `revokedAt` y conserva
  la trazabilidad mínima. El servicio admite como máximo diez credenciales
  activas y el inventario exterior sustituye el identificador WebAuthn por el ID
  interno, junto con fechas, tipo y backup.
- `AdminWebAuthnChallenge` guarda solo el SHA-256 del desafío y lo vincula al
  administrador, sesión y propósito (`REGISTRATION` o `AUTHENTICATION`). Cada
  ceremonia reemplaza el desafío abierto anterior del mismo propósito, vence a
  los cinco minutos y se consume una sola vez dentro de la transacción que
  registra o autentica la credencial.
- `AdminRecoveryCode` guarda solo un hash ligado al ID del administrador. Los
  diez códigos se entregan una única vez durante el primer enrolamiento. Usar
  uno consume ese código, revoca todas las passkeys, los demás códigos, los
  desafíos abiertos y las otras sesiones; la sesión actual queda sin verificar
  y obliga a enrolar una passkey nueva.

`User.adminWebAuthnUserHandle` es aleatorio, único, de 32 bytes y exclusivo del
rol `ADMIN`. Triggers de PostgreSQL impiden que usuarios de otros roles posean
handle, credenciales o estado MFA. El servidor valida además el RP ID y origen
exactos, presencia y verificación del usuario y la actualización atómica del
contador. Salvo el primer enrolamiento, el alta de otra passkey comprueba MFA
reciente al emitir opciones y nuevamente dentro de la transacción de registro.
La revocación autoservicio exige MFA reciente, bloquea la fila `User`
durante la transacción, conserva al menos una passkey activa y registra
`ADMIN_PASSKEY_REVOKED` sin borrar la credencial histórica. Este modelo
implementa la frontera técnica; dominio/HTTPS definitivos,
ceremonias en los navegadores admitidos y el procedimiento humano de
recuperación todavía deben certificarse antes de producción.

`ClientProfile` y `CashierProfile` contienen fecha de nacimiento y fecha de
declaración de mayoría de edad. `TermsDocument` conserva cada versión por su hash
y `TermsAcceptance` conserva la aceptación de un usuario. El servicio debe crear
perfil y aceptación en una misma transacción. Publicación y registro comparten
el advisory lock `sinochat:terms-lifecycle`; el registro usa aislamiento
`SERIALIZABLE` y el documento exacto que el navegador mostró y verificó. Un
trigger exige que `accepted_at` pertenezca a `[effective_at, retired_at)` y
también impide retirar un documento si el cambio invalidaría una aceptación ya
persistida.

La eliminación administrativa de una cuenta debe:

1. revocar sesiones y dispositivos;
2. eliminar bundles cifrados y suscripciones push;
3. reemplazar usuario, correo y teléfono por identificadores anonimizados;
4. establecer `status = DELETED` y `deletedAt`;
5. conservar únicamente relaciones y auditoría administrativa que sean
   necesarias.

Esto mantiene la integridad de asignaciones históricas sin conservar credenciales
o datos de contacto utilizables.

## Dos tipos de invitación

No se reutiliza una credencial para finalidades diferentes:

- `CashierOnboardingInvitation` es un enlace administrativo, de un solo uso y con
  vencimiento, para registrar un cajero. El token se localiza mediante HMAC y su
  valor visible se conserva cifrado con una clave del servidor.
- `CashierInvitation` es el código que un cajero comparte con clientes. Hay uno
  vigente por cajero, no tiene límite de usos y regenerarlo revoca la fila
  anterior. También se almacena como HMAC más ciphertext, nunca en claro.

## Disponibilidad, asignación y reasignación

Un cajero es elegible para una asignación nueva solamente si:

- su cuenta está activa;
- su perfil está aprobado y verificado;
- tiene una `CashierSubscription` activa dentro de su período.

`Assignment` es un historial inmutable. Un índice parcial de PostgreSQL admite una
sola fila con `endedAt IS NULL` por cliente. Cada asignación tiene exactamente una
`Conversation`; al finalizar una asignación también se cierra su conversación.
La clientela existente nunca se redistribuye.

`ReassignmentRequest` representa la transición causada por bloqueo, reporte,
indisponibilidad o acción administrativa. Si no hay cajero elegible, permanece en
`PENDING` y el cliente no tiene conversación activa. Cuando aparece uno, el
worker debe, en una sola transacción:

1. bloquear la solicitud pendiente;
2. calcular el mínimo de asignaciones activas entre cajeros elegibles, excluyendo
   al anterior y todas las parejas presentes en `Block`;
3. elegir aleatoriamente únicamente entre quienes empatan en ese mínimo;
4. crear la asignación y conversación nuevas;
5. marcar la solicitud como `COMPLETED`.

La selección debe usar bloqueo transaccional o un advisory lock para que dos
workers concurrentes no asignen usando el mismo conteo desactualizado.

## Recuperación de acceso del cajero

`CashierRecoveryCode` conserva exclusivamente un SHA-256 separado por ID de
cajero. Ocho valores de 100 bits se muestran una sola vez al registrarse o
rotarlos; `usedAt` garantiza consumo único, `revokedAt` invalida el lote anterior
y `expiresAt` permanece `NULL` bajo la política vigente.

`CashierPasswordReset` representa la solicitud iniciada por el administrador.
Solo puede existir una abierta por cajero, vence 24 horas después de `createdAt`
y, al consumirse, referencia mediante clave foránea compuesta un código del
mismo cajero. El administrador no escribe `passwordHash`: el titular presenta
el código y la nueva contraseña en una transacción serializable. Estos códigos
recuperan autenticación, no claves E2EE ni historial.

## Cifrado multidispositivo

Cada `Device` conserva identidad y prekey públicas. `OneTimePreKey` registra
prekeys consumibles. `EncryptedKeyBundle` almacena material de recuperación
cifrado en el dispositivo mediante el código de recuperación o aprovisionamiento
desde otro dispositivo confiable. El servidor no posee el secreto capaz de
abrirlo.

El modelo de mensaje está separado en:

- `Message`: metadatos mínimos, remitente, conversación, tipo y vencimiento;
- `MessageEnvelope`: copia de entrega por dispositivo; todas las filas de un
  mensaje contienen el mismo ciphertext Megolm canónico;
- `MessageReceipt`: estado agregado por usuario destinatario;
- `Attachment`: referencia privada al objeto ya cifrado y metadatos estrictamente
  necesarios para tamaño, tipo y purga.

El estado “enviando” es local. La base registra `SENT`, `DELIVERED` y `READ`.
Presencia y “escribiendo” son estados efímeros y no pertenecen a PostgreSQL.

La migración usa el reloj de PostgreSQL para fijar:

```text
expires_at = created_at + 48 horas
```

Todas las lecturas deben aplicar `expiresAt > now()` aunque el worker de purga
esté retrasado. El worker elimina el objeto cifrado, elimina luego la fila
`Attachment` que actúa como ledger durable y recién entonces elimina `Message`;
sobres, recibos y notificaciones vinculadas se eliminan por cascada. La clave
foránea `ON DELETE RESTRICT` impide perder `objectKey` antes de completar el
borrado externo. Los campos de intentos del adjunto solo registran código de
error y fecha, nunca contenido.

El límite de 4.000 caracteres se valida antes del cifrado en el cliente. Como el
servidor no puede inspeccionarlo, la base aplica además un límite defensivo de
128 KiB por sobre cifrado. Un adjunto declara JPEG, PNG o WebP, tiene un máximo de
5 MiB antes del cifrado y existe como máximo uno por mensaje.

`20260830000000_message_olm_envelope_hardening` fijó primero un perfil Olm de
transición. `20260831000000_attachment_purge_ledger_hardening` protege el ledger
de borrado externo y `20260831001000_message_megolm_envelope_profile` establece
el perfil vigente: cada `MessageEnvelope` usa
`protocol_version = 'matrix-megolm-v1'` y
`cipher_suite = 'm.megolm.v1.aes-sha2'`; cada `Attachment` usa
`cipher_suite = 'A256CTR'`. La última migración se detiene si ya existen sobres
Olm porque el servidor no puede convertirlos ni declararlos Megolm sin las
claves de los extremos.

El JSON Megolm decodificado contiene exactamente `algorithm`, `ciphertext`,
`device_id`, `sender_key` y `session_id`. La API enlaza dispositivo y clave
Curve25519 con el emisor publicado, exige Base64 canónico, cobertura exacta de
todos los dispositivos activos de ambos participantes y bytes idénticos en
cada copia. El contenido interior liga protocolo, conversación, sala, mensaje,
usuario y dispositivo remitentes. La sesión rota por mensaje y además como
máximo a una hora; Olm solo distribuye la room key y eventos de control.

## Bloqueos, reportes y revisión

`Block` identifica explícitamente cliente, cajero e iniciador. La unicidad por
pareja e iniciador hace que el umbral del cliente cuente cajeros distintos. Al
quinto bloqueo iniciado por cajeros, la aplicación suspende al cliente y crea un
`AccountReview` abierto; un índice parcial impide dos revisiones simultáneas.

Un reporte solo puede originarse en un bloqueo iniciado por el cliente.
`ReportEvidence` referencia un paquete creado en el dispositivo denunciante que
contiene la conversación vigente y adjuntos, todo cifrado para la clave pública
de `InvestigationKey`. La clave privada de investigación no está en esta base ni
en el servidor de la aplicación.

Mientras un reporte está abierto o en `CLOSING` debe existir exactamente un
paquete cifrado. Al aceptar un cierre se fijan resultado, resumen y
`closeRequestedAt`, y se crea exactamente un `ReportClosureJob`. El job conserva
la clave del objeto solo durante la saga, además de lease, cantidad de intentos,
próximo intento y un código de error sin contenido.

El worker elimina primero el objeto y luego, en una transacción, elimina
`ReportEvidence`, marca `evidencePurgedAt` y `CLOSED`, notifica y audita. Por
último elimina el job, de modo que ni el reporte cerrado ni su historial
administrativo conservan `objectKey`; solamente permanecen resultado y resumen.

## Privacidad administrativa y auditoría

`AdminAuditEvent` usa acciones y estados estructurados. Las operaciones
administrativas ordinarias escriben en `reasonCode` un código automático y no
reciben una explicación libre del administrador. La justificación excepcional
para abrir evidencia sí queda en el evento de auditoría correspondiente. Los
motivos de moderación y los resúmenes de resolución pertenecen a sus registros
específicos (`Block.reason` y `Report.resolutionSummary`); los futuros tickets
y devoluciones deberán seguir la misma separación. Ningún registro admite
cuerpo de chat ni referencias a mensajes o conversaciones. El
administrador no tiene una relación de modelo que le entregue chats ordinarios;
los servicios y roles de base de datos de producción deben mantener separados:

- operaciones de cuenta y asignación;
- entrega y purga de ciphertext;
- lectura de evidencia mediante la clave privada externa.

El cifrado de extremo a extremo usa Matrix Rust Crypto 18.6.0 bajo ADR-001 y
ADR-002, pero sigue necesitando una auditoría externa antes de producción. El
modelo soporta copias por dispositivo, distribución Olm de room keys, rotación
Megolm, prekeys y recuperación cifrada; no define criptografía propia y el gate
permanece en `BLOCKED`.

## Invariantes PostgreSQL destacadas

La migración inicial añade, entre otras:

- una asignación activa por cliente;
- una invitación de clientes vigente por cajero;
- una suscripción activa por cajero;
- un bundle de recuperación vigente por usuario;
- un hash único por código de recuperación de cajero y una solicitud abierta
  por cajero;
- un handle WebAuthn de 32 bytes, credenciales, desafíos y estado MFA solamente
  para usuarios `ADMIN`;
- un desafío WebAuthn abierto por sesión y propósito, con hash único, ventana
  acotada y consumo único;
- hashes únicos para códigos de recuperación administrativa, sin plaintext;
- una reasignación pendiente por cliente;
- una revisión abierta por cliente;
- motivos de bloqueo de 20 a 1.000 caracteres;
- expiración de mensajes exactamente a 48 horas;
- tamaño y MIME de adjuntos;
- coherencia entre participantes, asignación, conversación, sobres y recibos;
- evidencia obligatoria durante la investigación y ausente después del cierre;
- validación de rol para perfiles y referencias administrativas.
