# SinoChat

SinoChat es una PWA de chat privado entre clientes y cajeros, con administración
de cuentas, asignación de clientela, reportes y eliminación de mensajes y fotos
a las 48 horas.

## Estado real del proyecto

Último cierre de cambios y resultados: [validación de bandeja SAS del 16 de septiembre](docs/VALIDATION_2026-09-16_SAS_INBOX.md).

El repositorio contiene la base funcional de la PWA, la API HTTP/WebSocket, el
modelo PostgreSQL, la coordinación en tiempo real mediante Redis, las
migraciones y las herramientas operativas. También existen controles para
sesiones, dispositivos, asignaciones, retención, reportes y administración.

El proyecto **todavía no está autorizado para producción**. ADR-001 seleccionó
Matrix Rust Crypto y [ADR-002](docs/ADR-002-MEGOLM_APPLICATION_MESSAGES.md)
actualizó el perfil de mensajes ordinarios a Megolm, reservando Olm para
distribuir room keys y transportar control criptográfico. La API contiene registro,
publicación, consulta y reclamo de claves, el transporte privado
`to-device`/`sync` y publicaciones transaccionales `CHANGED`/`LEFT` para los
cambios de dispositivo y relación implementados. El navegador ya dispone de un
coordinador probado para consumir `/sync` y despachar solicitudes salientes de
Rust Crypto. `MatrixSessionLifecycle` ya está montado para cliente/cajero:
consulta el gate antes de tocar IndexedDB, registra o vincula el dispositivo,
mantiene una exclusión segura entre pestañas y ejecuta el bucle `/sync`. Aún no
está autorizado para abrir el chat: el controlador Megolm ya conecta listado,
envío de texto, fotos, descifrado y limpieza local con los paneles React, pero
solo se construye cuando el gate responde `READY`. Existen el codec interior
estricto `com.sinochat.message.v1`, el cifrado/descifrado de fotos Matrix v2 con
`A256CTR`, el exterior Olm real de control y el exterior Megolm estricto. La
caracterización Megolm confirmó descifrado repetible, persistencia
tras reabrir IndexedDB y lectura del propio mensaje por el emisor. La política
conservadora rota la sesión por mensaje y, adicionalmente, como máximo cada
hora. La prueba del cliente real en contextos Chrome aislados comprueba texto,
fotos, rotación, recarga, rechazo de alteraciones y caducidad local en React sin
depender de la red. Su relay HTTP es sintético: no certifica el backend ni
multidispositivo autorizado. El [bootstrap público de cross-signing](docs/CROSS_SIGNING_BOOTSTRAP.md)
ya valida firmas, publica atómicamente la identidad del primer dispositivo y
distribuye sus claves públicas con permisos acotados. El inicializador web
comprueba el pin y la confianza del SDK en el dispositivo propio antes de avanzar.
No autoriza dispositivos adicionales. Ya existen un validador público de su
certificado, un controlador de comparación SAS y un panel React probado de forma
aislada, junto con la caracterización de dos instancias reales del SDK.
La reserva pública en cuarentena ya tiene almacenamiento, rutas protegidas,
cancelación y vencimiento. El dispositivo confiable propio puede consultar la
solicitud vigente y descartarla sin motivo, con pruebas en PostgreSQL aislado.
Consultar no aprueba ni vincula dispositivos. El
[validador estricto de eventos SAS](docs/MATRIX_SAS_TRANSPORT.md), probado con
dos máquinas reales del SDK, ya se usa para admitir únicamente el `request`
iniciado por el bootstrap hacia el candidato. La admisión conserva ambas
sesiones exactas, la identidad del flujo y su plazo sin renovarlos en un
reintento; cancelar la reserva invalida el flujo atómicamente. La bandeja inicial
permite a la sesión solicitante original, todavía sin dispositivo vinculado,
consultar ese `request`: revalida ambas sesiones y entrega una copia pública
con hash comprobado y el evento `{ sender, type, content }` del SDK. No consume
ni confirma su entrega, no transporta los eventos siguientes y aún no está
conectada al navegador. Faltan el canal SAS
autenticado completo, la promoción transaccional y la conexión con el alta real. El alcance está en
[Autorización de dispositivos](docs/DEVICE_APPROVAL.md).
Siguen pendientes completar la ceremonia de aprobación y la confianza del
interlocutor, recuperación E2EE multidispositivo, pruebas completas
entre navegadores y una auditoría criptográfica externa. La API bloquea
deliberadamente dispositivos, mensajes, adjuntos,
rutas Matrix y WebSocket hasta completar esos gates. El panel administrativo ya
exige MFA WebAuthn/passkeys, emite recuperación de un solo uso y requiere un
step-up reciente para evidencia y revocaciones sensibles. La sección Seguridad
permite inventariar hasta diez passkeys mediante metadatos no secretos, agregar
una de respaldo y revocar cualquiera salvo la última. Salvo el primer
enrolamiento, tanto el alta como la revocación exigen MFA reciente; cada baja
genera `ADMIN_PASSKEY_REVOKED`. También identifica la sesión actual y
cierra una o todas las demás sin exponer secretos. Aún faltan fijar el dominio/RP ID definitivo,
realizar el primer enrolamiento en una ceremonia confiable, ensayar la custodia
y recuperación fuera de banda y certificar los navegadores objetivo. Esta es
una implementación técnica validada localmente, no una certificación operativa.
Tampoco se
completaron la política legal definitiva ni la validación de un proveedor S3 de producción con
una prueba real de borrado permanente. Los bloqueos están
enumerados en [Bloqueos para producción](docs/RUNBOOK_WINDOWS.md#bloqueos-para-producción).
También falta resolver cómo excluir los sobres efímeros de backups físicos/WAL
y certificar los controles distribuidos con Redis en un despliegue multinodo.

| Área | Estado |
| --- | --- |
| API NestJS, PWA React y contratos TypeScript | Implementados como base de desarrollo |
| PostgreSQL 17, 32 migraciones versionadas y Redis/Socket.IO | Configurados para desarrollo local con Docker; migraciones de identidad, cuarentena y admisión SAS probadas en base aislada, todavía no aplicadas a la base habitual |
| Roles, invitaciones, asignaciones y administración | Implementados; suite automatizada y fixtures transaccionales validados en PostgreSQL local |
| Paneles de cliente y cajero | Conectados al listado real de conversaciones: consumen solo metadatos, el cajero pagina su clientela y puede bloquear/reasignar con motivo; historial, texto, fotos y reportes permanecen cerrados por el gate E2EE |
| Caducidad de mensajes/fotos y worker de purga | Implementados; MinIO local permite probar la purga de versiones, pero falta certificar el proveedor de producción |
| Cifrado de extremo a extremo en el navegador | Matrix Rust Crypto 18.6.0, Megolm para mensajes, Olm para room keys/control, codec estricto, adjuntos Matrix v2 `A256CTR`, directorio/transporte, lifecycle y coordinador web; faltan interoperabilidad completa, confianza multidispositivo y auditoría externa, por lo que el gate sigue compilado `BLOCKED` por [ADR-001](docs/ADR-001-E2EE_PROTOCOL.md) y [ADR-002](docs/ADR-002-MEGOLM_APPLICATION_MESSAGES.md) |
| MFA del administrador | WebAuthn/passkeys obligatorio antes del panel, diez códigos de recuperación de un uso, inventario seguro de hasta diez passkeys, revocación autoservicio auditada sin permitir eliminar la última, gestión de sesiones y step-up para acciones sensibles; falta certificar dominio/HTTPS, recuperación y navegadores de producción |
| Documentos legales finales | Pendientes de definición y revisión profesional |

## Estructura

- `apps/web`: PWA en React 19, Vite y TypeScript.
- `apps/api`: API HTTP y WebSocket en NestJS 11.
- `packages/contracts`: contratos compartidos.
- `compose.yaml`: PostgreSQL 17, Redis 7.4 y almacenamiento MinIO para desarrollo local.
- `docs`: producto, arquitectura, seguridad y operación.

## Inicio rápido en Windows

Requisitos: Node.js 24 LTS, npm 11.19.1 y Docker Desktop con Compose v2. En este equipo
debe invocarse `npm.cmd`, porque la política de PowerShell bloquea el wrapper
`npm.ps1`; no hace falta modificar esa política.

```powershell
Set-Location "C:\Users\camil\OneDrive\Escritorio\Camilo\Uni\HTMLCSSJS\SinoChat"
if (Test-Path -LiteralPath .\.env) {
  throw ".env ya existe; no se sobrescribió. Continúa con el runbook."
}
Copy-Item -LiteralPath .\.env.example -Destination .\.env -ErrorAction Stop
npm.cmd run local:storage:configure
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-local.ps1
npx.cmd --yes --package npm@11.19.1 npm ci
```

Después hay que completar los demás secretos de `.env`, iniciar PostgreSQL,
Redis y MinIO, aplicar las migraciones y publicar los términos. El procedimiento
completo y seguro está en [Runbook de Windows](docs/RUNBOOK_WINDOWS.md).

El comando de instalación usa npm 11.19.1 sin cambiar la instalación global.
Esta versión respeta los `overrides` de seguridad entre workspaces; npm 11.16.0
puede ignorarlos. Para instalar o actualizar dependencias, conserva el prefijo
`npx.cmd --yes --package npm@11.19.1 npm`.

Con PostgreSQL local activo, `npm.cmd run check:matrix-db` comprueba las
restricciones Matrix sobre datos temporales dentro de una transacción y termina
con `ROLLBACK`, por lo que no conserva sus fixtures. El comando rechaza bases
remotas y entornos de producción; no sustituye las pruebas ni la auditoría de
producción.

`npm.cmd run check:cross-signing-db` crea una base PostgreSQL local exclusiva,
aplica las 32 migraciones y comprueba publicación, reintento, consultas propias,
inmutabilidad SQL y competencia entre dos raíces válidas. También prueba una
sesión revocada mientras espera el bloqueo. Requiere `CREATEDB` y elimina solo
la base creada, tras verificar nombre, OID y propietario. No modifica la base
habitual ni habilita el chat; usa firmas reales del SDK y los servicios reales.
También verifica candidatos en cuarentena: sesión exclusiva, vencimiento real,
cancelación, invariantes SQL, dos reservas simultáneas y revocación mientras
esperan el bloqueo. Incluye admisión SAS: dos sesiones inmutables, replay exacto,
unicidad histórica de flujo y transacción HTTP, caducidad real, cancelación
atómica y competencia entre sesiones revisoras. El alcance de las comprobaciones
de bandeja inicial y sus resultados se documenta en la
[validación de bandeja SAS](docs/VALIDATION_2026-09-16_SAS_INBOX.md).
No certifica una ceremonia completa entre navegadores ni convierte esos
candidatos en dispositivos activos.

`npm.cmd run check:recovery-db` comprueba dentro de una transacción los códigos
de recuperación de cajero: verifica en PostgreSQL real la solicitud única de 24 horas, el
vínculo código-cajero, el consumo único y la ausencia de plaintext, y revierte
todos sus fixtures.

`npm.cmd run check:webauthn-db` valida en PostgreSQL real que solo ADMIN pueda
poseer passkeys/MFA, que cada desafío quede ligado a su sesión, que exista uno
solo abierto por ceremonia, que exista el evento de revocación y que los códigos
se almacenen únicamente como hash. También termina con `ROLLBACK`. El workflow
de CI está configurado para ejecutar, después del build y en ese orden,
`check:matrix-db`, `check:cross-signing-db`, `check:recovery-db` y
`check:webauthn-db` sobre PostgreSQL; esa
configuración no sustituye la ejecución ni la certificación de producción.

`npm.cmd run check:webauthn-concurrency` comprueba altas y revocaciones
simultáneas mediante los servicios reales en una base PostgreSQL temporal.
Requiere `CREATEDB` local, aplica todas las migraciones, verifica mínimo de una
passkey, máximo de diez y auditoría única, y elimina exclusivamente la base
creada después de comprobar su nombre, OID y propietario. No usa datos de la
base habitual. Sustituye solo la verificación criptográfica del registro; el
recorrido WebAuthn real se prueba por separado en Chrome. CI ejecuta esta
comprobación después de los otros verificadores de PostgreSQL.

Con la API y la PWA locales activas, `npm.cmd run check:webauthn-browser` está
diseñado para conducir una ceremonia real en Chrome o Edge mediante un
autenticador virtual: login limitado, primer enrolamiento, emisión de diez
códigos, step-up para una passkey de respaldo, recuperación real, segundo login,
inventario, revocación de respaldo, step-up vencido, revocación de otra sesión y
sus auditorías. Nunca imprime la contraseña ni los códigos.
Usa una identidad ADMIN reservada que queda `DELETED`, sin sesión, passkey ni
código activo al terminar; conserva los eventos del ledger porque la auditoría
es deliberadamente inmutable. Esta prueba no reemplaza la certificación con
autenticadores físicos y navegadores de producción.

`npm.cmd run check:e2ee-browser` no requiere levantar API, PWA ni Docker.
Utiliza Chrome/Chromium/Edge instalado (o `CHROME_PATH`), un servidor loopback
exclusivo, claves y usuarios sintéticos y contextos temporales. Comprueba las
clases criptográficas y el timeline/retención React sin alterar el gate
`BLOCKED`; el build impide incluir su relay de prueba en producción. El alcance
y sus límites figuran en la [validación del cliente](docs/VALIDATION_2026-09-10.md).

`npm.cmd run check:sas-comparison`, `npm.cmd run check:device-approval-sdk` y
`npm.cmd run check:sas-panel` prueban respectivamente el controlador de
comparación, el SDK real en memoria y el panel React en Chrome aislado. También
forman parte de `npm.cmd test`. No necesitan API/Docker, no leen `.env` ni
activan dispositivos; el panel todavía no está montado en la aplicación.

No se guardan credenciales, claves privadas ni secretos en Git. `.env` está
ignorado y `.env.example` solo contiene nombres y valores públicos de ejemplo.

## Alcance Matrix

SinoChat usa las primitivas Olm/Megolm y determinados objetos de Matrix dentro de un
**perfil privado de SinoChat**. No ejecuta un homeserver, no publica el timeline
ni los medios en Synapse y no promete interoperabilidad con clientes o
homeservers Matrix.

Los mensajes ordinarios siguen el transporte propio `Message` /
`MessageEnvelope`: el exterior Megolm es `m.room.encrypted` con
`m.megolm.v1.aes-sha2` y, una vez
descifrado, el tipo interior es `com.sinochat.message.v1`. La cola Matrix
`to-device` queda reservada a control y señalización criptográfica; no transporta
textos ni fotos del chat.

`MATRIX_SERVER_NAME` forma parte de los identificadores Matrix derivados. En
desarrollo puede conservarse `sinochat.invalid`; en producción es obligatorio y
debe fijarse antes de registrar el primer dispositivo, porque cambiarlo crea
identidades distintas. No es la dirección de un homeserver.

El esquema cuenta con 32 migraciones versionadas. La migración Matrix base
`20260827000000_matrix_e2ee_transport` se complementa con once migraciones
forward: `20260827001000_owned_device_reference_record_fix`,
`20260827002000_matrix_pre_key_record_fix`,
`20260827003000_matrix_claim_selection_hardening`,
`20260827004000_matrix_sync_chain_hardening`,
`20260827005000_matrix_device_idempotency_and_sync_lineage`,
`20260827006000_matrix_sync_replay_window`,
`20260827007000_matrix_sync_crypto_snapshot`,
`20260828000000_matrix_registration_replay`,
`20260830000000_message_olm_envelope_hardening`,
`20260831000000_attachment_purge_ledger_hardening` y
`20260831001000_message_megolm_envelope_profile`. Las últimas etapas hacen
reintentable la confirmación inicial, endurecen el perfil de transición,
impiden borrar el ledger del adjunto antes del objeto y fijan finalmente
`matrix-megolm-v1`, `m.megolm.v1.aes-sha2` y `A256CTR`. La migración
`20260901000000_cashier_recovery_codes` añade ocho códigos de recuperación
de cajero almacenados solo como hashes y solicitudes administrativas de 24
horas, sin permitir que el administrador elija o conozca una contraseña.
`20260901010000_admin_webauthn_mfa` añade passkeys administrativas, desafíos
hasheados de cinco minutos, contador anti-replay, recovery codes de un solo uso
y estado MFA de sesión. `20260902000000_admin_passkey_management` incorpora el
evento append-only `ADMIN_PASSKEY_REVOKED` para distinguir una revocación
autoservicio de una recuperación total. La aplicación limita el inventario a
diez passkeys activas, exige MFA reciente para revocar y conserva siempre al
menos una. `WEBAUTHN_RP_ID` debe fijarse al dominio estable antes
del despliegue productivo. La migración de perfil Megolm falla
si encuentra sobres Olm: el servidor no puede recifrarlos ni renombrarlos como
Megolm. Son parte
inseparable del estado actual; una instalación no debe aplicar solo la migración
base. `20260910000000_matrix_cross_signing_identity` añade el triplete público
inmutable y su certificado de dispositivo con referencias que impiden confirmar
solo una mitad. Conserva el límite de un único dispositivo histórico.
`20260912000000_matrix_device_candidate_quarantine` añade reservas públicas
separadas, ligadas a la sesión solicitante, sin estados de aprobación ni acceso
al chat. `20260913000000_matrix_device_verification_flow` fija la admisión de
un único `request` SAS por candidato a sus dos sesiones, preserva los IDs de
flujo/transacción frente a replay y propaga la cancelación del candidato sin
habilitar dispositivos. Las tres se validaron únicamente en bases temporales;
una instalación existente debe aplicarlas mediante el procedimiento de
migraciones del runbook.

Detrás del gate existen rutas privadas de reserva/alta de dispositivo,
`POST /api/e2ee/matrix/keys/upload`,
`POST /api/e2ee/matrix/keys/query`,
`POST /api/e2ee/matrix/keys/claim/:requestId`,
`GET /api/e2ee/matrix/cross-signing`,
`POST /api/e2ee/matrix/cross-signing/bootstrap`,
`PUT /api/e2ee/matrix/device-verification-flows/:candidateId/:flowId/:transactionId`,
`GET /api/e2ee/matrix/device-verification-inbox/:candidateId`,
`PUT /api/e2ee/matrix/sendToDevice/:eventType/:transactionId` y
`GET /api/e2ee/matrix/sync`. Consulta y reclamo aceptan lotes generados por Rust
Crypto, pero el servidor vuelve a autorizar individualmente cada identidad
contra la sesión y sus relaciones vigentes. `sendToDevice` acepta únicamente un
exterior Olm `m.room.encrypted` con el campo real `org.matrix.msgid` validado,
nunca comodines, y como máximo 20 dispositivos exactos; cada
evento caduca a las 48 horas y cada dispositivo admite hasta 2000 eventos
pendientes. `/sync` encadena tokens opacos `sct1` autenticados con HMAC y
contrastados con su hash persistido. La ruta `device-verification-flows` solo
admite el `request` público inicial en cuarentena; la ruta
`device-verification-inbox` devuelve únicamente ese evento público y sus IDs y
fechas a la sesión original del candidato. Solo admite CLIENT/CASHIER sin
dispositivo vinculado, declara `no-store` y limita la consulta a 30 por minuto.
Comprueba nuevamente sesiones/versiones, bootstrap y pin, autofirma del candidato,
hash del request y reloj final de PostgreSQL. No tiene ACK, consumo ni efectos
de autorización: la expiración observada terminaliza la reserva y su flujo,
sin escribir dispositivos, claves, certificados ni transporte operativo.
No es un relay SAS completo ni una aprobación. El token sucesor de `/sync` confirma el lote anterior
y permite purgar sus eventos ya entregados. Mientras el gate compilado siga en
`BLOCKED`, todas estas rutas responden 503 y no constituyen una API habilitada.

## Documentación principal

- [Especificación del producto](docs/PRODUCT_SPEC.md)
- [Arquitectura](docs/ARCHITECTURE.md)
- [Seguridad](docs/SECURITY.md)
- [ADR del protocolo E2EE](docs/ADR-001-E2EE_PROTOCOL.md)
- [ADR de mensajes ordinarios Megolm](docs/ADR-002-MEGOLM_APPLICATION_MESSAGES.md)
- [Caracterización de Olm para mensajes de aplicación](docs/MATRIX_APPLICATION_OLM_CHARACTERIZATION.md)
- [Caracterización de Megolm para historial](docs/MATRIX_MEGOLM_HISTORY_CHARACTERIZATION.md)
- [Runbook local y de preparación operativa](docs/RUNBOOK_WINDOWS.md)
- [Operaciones sensibles](docs/OPERATIONS.md)
- [Tiempo real y Redis](docs/REALTIME.md)
- [Plan de pruebas](docs/TEST_PLAN.md)
