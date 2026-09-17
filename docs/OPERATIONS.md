# Operaciones de publicación

Para preparar por primera vez un equipo Windows con Node 24, PostgreSQL, Redis,
migraciones, términos, administrador y procesos de desarrollo, seguir primero el
[runbook de Windows](RUNBOOK_WINDOWS.md). Este documento profundiza únicamente
en las ceremonias sensibles y sus invariantes.

Estas herramientas son comandos offline. Requieren `DATABASE_URL`, migraciones
desplegadas y acceso directo a PostgreSQL. Cargan `.env` o el archivo indicado
por `SINOCHAT_ENV_FILE`, pero los argumentos y variables no pueden contradecirse.
Ante una entrada ausente, ambigua o inconsistente terminan con código distinto
de cero sin modificar datos.

## Rate limit distribuido

Producción exige `REDIS_URL`, `RATE_LIMIT_REDIS_PREFIX` único por instalación y
`RATE_LIMIT_HMAC_SECRET` aleatorio de al menos 32 bytes. El secreto debe ser el
mismo en todas las réplicas y no puede reutilizar `PASSWORD_PEPPER`, secretos de
metadatos, adjuntos, evidencia o dispositivos. Las claves Redis solo contienen
el namespace y un HMAC; nunca IP, cookie, ID de usuario o ruta en claro.

La API abre una sola conexión Redis dedicada a contadores y ejecuta cada cambio
como un script Lua atómico basado en el reloj del servidor. Si esa conexión no
arranca o falla, la aplicación se comporta de forma cerrada: las solicitudes
HTTP no atraviesan el guard y los sockets se desconectan antes de consultar la
sesión. Alertar sobre errores de rate limit, rechazos anómalos y latencia cercana
al timeout de un segundo sin registrar la clave ni la identidad.

La rotación de `RATE_LIMIT_HMAC_SECRET` cambia todas las claves. Debe realizarse
en un despliegue coordinado, sin versiones con secretos distintos atendiendo a
la vez; de lo contrario cada grupo tendría un cupo independiente. Los contadores
anteriores expiran solos y no deben inspeccionarse ni copiarse a logs.

## Passkeys y recuperación administrativa

En desarrollo, `WEB_ORIGIN=http://localhost:5173` permite derivar
`WEBAUTHN_RP_ID=localhost`. Se debe abrir la PWA exactamente con `localhost`, no
con `127.0.0.1`, porque el origen forma parte de la assertion. En producción:

- `WEB_ORIGIN` debe ser HTTPS;
- `WEBAUTHN_RP_ID` es obligatorio y debe coincidir exactamente con el host de
  ese origen; y
- el RP ID no se cambia después de enrolar passkeys, porque las credenciales
  anteriores dejarían de ser utilizables.

La primera contraseña administrativa correcta crea una sesión limitada. El panel
solo abre después de registrar y verificar una passkey con user verification.
Ese primer enrolamiento es la única alta que no puede exigir una passkey previa.
La PWA muestra diez códigos administrativos una sola vez y exige confirmar que
se guardaron. No deben copiarse a tickets, logs, `.env` ni gestores compartidos;
se recomienda un gestor de contraseñas personal cifrado y una copia offline.

Si se pierde toda passkey, un código de recuperación revoca atómicamente todas
las passkeys, los códigos restantes y las demás sesiones. La sesión actual sigue
limitada y obliga a enrolar una passkey nueva, momento en que se emite un lote
nuevo. Esta ceremonia debe ensayarse en staging y generar una alerta fuera de
banda antes de producción. `npm run check:webauthn-db` prueba los invariantes de
rol, sesión, desafío y hash contra PostgreSQL local y revierte los fixtures.

Desde **Seguridad**, el administrador debe registrar al menos una segunda
passkey en otro autenticador y revisar periódicamente sus passkeys y sesiones
activas. El inventario de passkeys devuelve únicamente ID interno, fecha de alta,
último uso, tipo de dispositivo y estado de backup; nunca devuelve el
`credentialId`, la clave pública ni los transports. Se admiten como máximo diez
passkeys activas por administrador. La revocación individual exige una assertion
de menos de cinco minutos, no permite revocar la última passkey y deja el evento
append-only `ADMIN_PASSKEY_REVOKED` sin pedir texto libre.

Registrar cualquier passkey adicional también exige una assertion de menos de
cinco minutos antes de generar las opciones y se vuelve a comprobar dentro de la
transacción de verificación. Si el step-up venció, la PWA autentica y reintenta
una sola vez; no debe tratar esa comprobación como opcional por haber iniciado la
ceremonia.

La sesión actual se identifica sin mostrar tokens, IP ni user-agent; la interfaz no
permite revocarla accidentalmente y puede cerrar una sesión ajena o todas las
demás. Ambas revocaciones exigen una assertion de menos de cinco minutos, se
reintentan una sola vez después del step-up y dejan auditoría sin texto libre.

Con API y PWA locales levantadas, `npm run check:webauthn-browser` agrega una
prueba integral sobre Chrome/Edge y un autenticador virtual CTAP2. El verificador
rechaza destinos que no sean localhost y está prohibido con `NODE_ENV=production`.
La identidad fija `sinochat_webauthn_check` queda `DELETED` y sin material activo
en `finally`; sus eventos no se borran porque `admin_audit_events` es append-only.
El recorrido esperado fuerza el step-up para una passkey adicional, ejercita la
recuperación de un solo uso, inventaría y revoca el respaldo, envejece de forma
coherente una sesión local, revoca otra sesión y comprueba ambas auditorías.
Confirma la integración navegador-servidor cuando se ejecuta correctamente; no
certifica Windows Hello, llaves físicas ni el conjunto final de navegadores.

## Migración de vinculación de dispositivos

`20260727011000_device_binding_hardening` se detiene si `devices` ya contiene
filas. El secreto plano debe entregarse una sola vez al usuario y no puede
reconstruirse mediante un backfill. En una instalación que ya tenga dispositivos
no se debe omitir ni editar esa protección: hace falta una ceremonia explícita
de migración aprobada por el ADR E2EE. En una instalación nueva, las migraciones
se aplican normalmente.

`DEVICE_BINDING_HMAC_SECRET` es obligatorio al usar altas o vinculaciones y en
producción debe contener al menos 32 bytes, ser distinto de todos los demás
secretos y mantenerse fuera del repositorio y de los logs. Perderlo impide
verificar nuevas vinculaciones de sesiones existentes; rotarlo exige una
ceremonia específica aún no definida.

## Migración de sobres, Megolm y ledger de adjuntos

`20260830000000_message_olm_envelope_hardening` se detiene con
`MESSAGE_ENVELOPE_LEGACY_DATA_REQUIRES_EXPLICIT_PURGE` o
`ATTACHMENT_LEGACY_DATA_REQUIRES_EXPLICIT_PURGE` si encuentra filas de los
formatos genéricos anteriores. No se debe editar la migración, cambiar etiquetas
ni borrar filas para destrabar un despliegue. Hay que inventariar el origen y la
vigencia de esos datos y aprobar una operación explícita que respete retención y
evidencia; no existe un backfill capaz de volverlos ciphertext Matrix válido sin
las claves de los extremos.

Ese perfil Olm es una etapa forward de transición, no el estado final. Después:

- `20260831000000_attachment_purge_ledger_hardening` cambia la FK de adjuntos a
  `ON DELETE RESTRICT`. El worker debe borrar todas las versiones del objeto y
  luego la fila `Attachment` antes de eliminar `Message`; nunca debe quitarse la
  restricción para destrabar una purga.
- `20260831001000_message_megolm_envelope_profile` se detiene con
  `MESSAGE_OLM_DATA_BLOCKS_MEGOLM_PROFILE` si existe cualquier
  `message_envelopes`. No hay backfill del servidor: cada ciphertext tendría que
  ser recifrado en los extremos. Una operación sobre esos datos exige inventario
  y aprobación explícita, no un `DELETE` improvisado.
- Tras aplicar las 30 migraciones, los únicos valores de mensaje admitidos son
  `matrix-megolm-v1` y `m.megolm.v1.aes-sha2`; los adjuntos continúan en
  `A256CTR`.

Megolm cifra el mensaje ordinario y rota por mensaje/máximo una hora. Olm queda
reservado a distribución de room keys y control. Aplicar estas migraciones o
superar checks locales no habilita el chat: el gate E2EE continúa en `BLOCKED`
hasta completar pruebas entre navegadores y auditoría criptográfica externa.

## Publicar términos

El archivo debe contener texto UTF-8 real revisado por quien corresponda. La
herramienta no crea ni agrega texto legal.

Desde la raíz:

```powershell
npm run terms:publish --workspace @sinochat/api -- --file .\legal\terminos-v2.md --version v2.0 --type text/markdown --effective-at 2026-08-15T00:00:00-03:00 --expected-sha256 <sha256-verificado>
```

También pueden configurarse:

- `TERMS_DOCUMENT_FILE`
- `TERMS_DOCUMENT_VERSION`
- `TERMS_DOCUMENT_TYPE`
- `TERMS_DOCUMENT_EFFECTIVE_AT`
- `TERMS_DOCUMENT_EXPECTED_SHA256` (opcional, recomendado)

`TERMS_DOCUMENT_TYPE` admite `text/markdown` y `text/plain`. La fecha exige ISO
8601 con `Z` u offset explícito. La versión admite 1–32 caracteres seguros. El
hash se calcula sobre los bytes exactos: BOM, saltos de línea y espacios cambian
el resultado. No se normaliza el documento.

La publicación usa aislamiento `SERIALIZABLE` y el advisory lock transaccional
compartido `sinochat:terms-lifecycle`. El registro toma el mismo bloqueo antes
de consultar el reloj de PostgreSQL, seleccionar la versión vigente y guardar
la aceptación. En la transacción de publicación:

1. verifica que versión, hash y vigencia sean nuevos y monotónicos;
2. fija `retiredAt` de la versión abierta anterior en la nueva fecha efectiva;
3. inserta el nuevo `TermsDocument`.

La versión anterior continúa vigente hasta esa fecha. Repetir exactamente la
misma publicación es idempotente; reutilizar la versión con otros bytes o fecha,
o publicar el mismo contenido con otra versión, falla.

### Vínculo obligatorio con `/terminos`

La publicación guarda los bytes UTF-8 exactos, tipo, tamaño y SHA-256 junto con
la versión. No se debe reformatear ni convertir finales de línea después de
revisar el archivo.

La API expone:

- `GET /api/legal/terms/current`, con la versión vigente;
- `GET /api/legal/terms/{version}`, con una versión histórica inmutable.

Ambas respuestas conservan los bytes originales, incluyen ETag basado en
SHA-256 y anuncian versión y hash en `X-SinoChat-Terms-Version` y
`X-SinoChat-Terms-SHA256`. El formulario descarga los bytes al abrirse, calcula
el SHA-256 en el navegador, muestra ese contenido y conserva versión/hash solo
en estado React. Envía esa identidad exacta al registrar; no vuelve a consultar
`/current` silenciosamente al enviar. Si la vigencia cambió, el backend responde
`TERMS_DOCUMENT_CHANGED`, la casilla se desmarca y el usuario debe cargar y leer
la nueva versión de forma explícita.

El registro se ejecuta con aislamiento `SERIALIZABLE`, hasta tres intentos ante
`P2034`, el bloqueo legal compartido y un único `clock_timestamp()` para elegir
el documento y fijar `accepted_at`. La migración defensiva impide por trigger
insertar una aceptación fuera de `[effective_at, retired_at)` o retirar un
documento de modo que invalide aceptaciones existentes. Los antiguos registros
que tuvieran únicamente hash se conservan como historial, pero no pueden
habilitar nuevos registros ni ser presentados como texto verificable.

Antes de habilitar registros, el pipeline debe descargar el endpoint vigente,
calcular SHA-256 sobre el cuerpo sin transformarlo y compararlo con el hash
publicado por la CLI.

Estos controles no redactan ni validan el fondo de los términos o de la política
de privacidad. Ambos documentos definitivos todavía requieren revisión legal
profesional para los países donde opere SinoChat.

## Registrar y activar una clave de investigación

El par se genera en la estación externa de investigación. La clave privada no
debe copiarse al servidor, `.env`, CI, logs ni base de datos.

```powershell
npm run investigation-key:register --workspace @sinochat/api -- --public-key-base64 <clave-publica-DER-SPKI-base64> --algorithm <algoritmo-aprobado> --fingerprint <sha256-del-DER-SPKI> --version 2
```

Variables equivalentes:

- `INVESTIGATION_PUBLIC_KEY_BASE64`
- `INVESTIGATION_KEY_ALGORITHM`
- `INVESTIGATION_KEY_FINGERPRINT`
- `INVESTIGATION_KEY_VERSION`

La CLI:

- exige Base64 canónico, formato público DER SPKI y entre 16 y 4096 bytes;
- rechaza PKCS#8, material raw, claves de firma y declaraciones de algoritmo que
  no coincidan con el tipo público SPKI;
- recalcula SHA-256 sobre los bytes decodificados y exige que coincida con el
  fingerprint en hexadecimal minúsculo;
- valida el formato del identificador de algoritmo y una versión entera,
  positiva y creciente;
- rechaza argumentos desconocidos y las variables
  `INVESTIGATION_PRIVATE_KEY`, `INVESTIGATION_PRIVATE_KEY_BASE64` e
  `INVESTIGATION_KEY_PRIVATE`;
- serializa la rotación, retira la clave activa y crea/activa la nueva usando el
  mismo timestamp del reloj de PostgreSQL; y
- nunca imprime la clave pública completa, mucho menos material privado.

El identificador de algoritmo debe provenir del ADR criptográfico aprobado. La
CLI valida formato, tamaño e integridad, pero no pretende demostrar que el
material corresponde matemáticamente al algoritmo declarado. Hasta seleccionar
y auditar el protocolo, la activación no convierte el sistema en apto para
producción.

Una clave retirada nunca se reactiva. Hay que conservar su clave privada externa
mientras existan reportes abiertos cifrados para esa versión; retirarla solo
impide nuevas cargas. Una rotación con historial ambiguo, versión repetida,
fingerprint reutilizado o activación futura preexistente falla sin cambios.

## Almacenamiento efímero y borrado permanente

Para desarrollo, `compose.yaml` levanta MinIO exclusivamente en
`127.0.0.1:9000` y su consola en `127.0.0.1:9001`. El bucket local tiene
versionado, acceso anónimo deshabilitado y una identidad de aplicación separada
de la cuenta administradora. `npm.cmd run check:storage` crea un objeto aleatorio,
comprueba CORS e integridad, rechaza el replay, descarga, purga y verifica cero
versiones/marcadores. La prueba se niega a ejecutarse contra un endpoint que no
sea local o con `NODE_ENV=production`.

Este MinIO fijado por digest es una herramienta de desarrollo, no una elección
de proveedor productivo ni una certificación de borrado a las 48 horas.

El bucket de fotos y evidencias debe ser privado, usar TLS y bloquear todo acceso
público. Cada objeto se carga y descarga con
`Cache-Control: private, no-store, max-age=0`. Las credenciales del servicio
necesitan únicamente lectura, escritura, consulta del estado de versionado,
listado de versiones y eliminación sobre ese bucket.

`OBJECT_STORAGE_VERSIONING_MODE` es obligatorio en producción:

- `disabled`: solo es válido para un bucket que nunca tuvo versionado habilitado.
- `purge-all`: el proveedor debe implementar las operaciones compatibles con S3
  `ListObjectVersions` y `DeleteObjects`; la purga elimina versiones y marcadores
  de borrado de la clave exacta.

`OBJECT_STORAGE_FORCE_PATH_STYLE` acepta únicamente `true` o `false`. MinIO
local usa `true`; en producción debe configurarse según el endpoint del
proveedor y validarse con URLs firmadas desde los navegadores objetivo.

Al iniciar en producción, SinoChat consulta `GetBucketVersioning`: rechaza
`disabled` si el proveedor informa un historial habilitado y prueba la capacidad
de listar versiones cuando se configura `purge-all`. Un error de permisos o una
operación no compatible impide el arranque.

No se permite deshabilitar el worker de retención en producción. Sus errores y
el atraso de purga deben generar alertas: advertencia al superar 60 segundos y
alarma crítica al alcanzar cinco minutos. Las peticiones al proveedor tienen
timeouts y reintentos acotados para que un objeto no detenga todo el lote.

Tampoco se permite deshabilitar `REPORT_CLOSURE_WORKER_ENABLED` en producción.
`REPORT_CLOSURE_WORKER_INTERVAL_MS` admite entre 5000 y 60000 milisegundos y se
recomienda 15000. Los casos `CLOSING` se reclaman con leases de dos minutos y
backoff exponencial de 5 segundos a 5 minutos. Deben alertarse jobs cuyo
`nextAttemptAt` esté vencido, errores repetidos y cualquier caso que permanezca
`CLOSING` más allá del objetivo operativo. El runbook debe corregir primero el
acceso a storage o PostgreSQL y dejar que el worker reintente: no se deben borrar
manualmente la fila de evidencia, el job ni su clave de objeto.

El inicio del cierre puede quedar programado algunos minutos: no es atraso del
worker. `purgeNotBefore` conserva el final de la autorización original del PUT
firmado y la base impide adelantarlo. Los uploads usan `If-None-Match: *`; el
cliente debe enviar exactamente ese header junto con los demás headers firmados.
No se debe eliminar ni alterar esta precondición en un proxy S3 compatible.
La firma admite inicios durante cinco minutos y la autorización persistida dura
diez. El proveedor/proxy elegido debe imponer y certificar una duración máxima
de solicitud estrictamente menor que esos cinco minutos de margen; de otro
modo, un PUT iniciado antes de vencer podría terminar después de la purga. Esta
prueba con una carga lenta y un cierre concurrente es obligatoria en staging.

El `X-Amz-Date` de cada PUT se deriva del mismo `clock_timestamp()` de
PostgreSQL que origina el vencimiento de su grant y el límite persistido de
purga; no se permite volver al reloj implícito del proceso Node. Antes de cada
release de infraestructura, staging debe comprobar el contrato temporal sin
guardar la URL completa: registrar el instante DB de una carga descartable,
compararlo con `X-Amz-Date`, y ejecutar el flujo con desfase controlado del nodo
API en ambas direcciones. PostgreSQL, los nodos API y el proveedor deben estar
sincronizados por NTP y dentro de la tolerancia documentada por el proveedor;
un desfase fuera del SLO operativo bloquea el despliegue.

La prueba lenta debe iniciar un PUT descartable segundos antes de los cinco
minutos, limitar el caudal para mantenerlo abierto y ejecutar en paralelo la
conciliación al alcanzar el límite persistido de diez minutos. El resultado
aceptable es que el proveedor/proxy corte la solicitud dentro del margen, la
purga no se adelante y, después de `purgeNotBefore`/`grantExpiresAt`, no exista
ninguna versión del objeto ni sea posible repetir la firma.

`SUBSCRIPTION_EXPIRY_WORKER_ENABLED` no puede ser `false` en produccion.
`SUBSCRIPTION_EXPIRY_WORKER_INTERVAL_MS` admite de 5000 a 60000 milisegundos y
usa 10000 por defecto. El worker reclama suscripciones vencidas con
`FOR UPDATE SKIP LOCKED`, procesa solo la clientela del cajero vencido en lotes
acotados y mantiene el trabajo reclamable hasta terminar. Cada lote actualiza
`cashier_subscriptions.updated_at` como cursor durable de ultimo servicio; la
seleccion ordena por ese cursor para que un cajero con mucha clientela no impida
que otras suscripciones vencidas progresen, incluso entre reinicios o instancias.
Mientras la fila persiste `ACTIVE` para ser reclamable pero `ends_at` ya alcanzo
el reloj DB, la API administrativa expone `effectiveStatus=EXPIRED_PENDING` y
la UI no la cuenta ni la muestra como activa. Una renovacion devuelve 409 hasta
que el worker termine y cambie el estado persistido a `EXPIRED`. Las conversaciones
se autorizan siempre contra el reloj de PostgreSQL, por lo que quedan
inutilizables al vencer aunque la conciliacion aun no haya cerrado la
asignacion. Las reasignaciones sin destino permanecen pendientes y el mismo
worker las reintenta con backoff; no se crea un actor administrador ficticio ni
un evento de auditoria personal. Los eventos estructurados del proceso deben
enviarse al sistema de observabilidad y alertarse ante fallos repetidos.

Los payloads cifrados efímeros deben quedar excluidos de snapshots, réplicas
históricas, versionado, copias del bucket y cualquier backup restaurable. El
modelo actual todavía guarda sobres en `message_envelopes`: una copia física,
WAL, réplica retrasada o PITR de PostgreSQL incluiría ese ciphertext. Por eso no
se autoriza usar backups físicos de la base principal en producción hasta
separar el payload en infraestructura efímera sin historial o aprobar una
alternativa criptográfica que haga irrecuperable el contenido al vencer.

Una futura copia de PostgreSQL solo podrá conservar metadatos permitidos por la
política legal, nunca ciphertext ni una URL reutilizable. Antes de producción
hay que ejecutar una prueba automatizada de backup/restauración y otra que
cargue, versione si corresponde, purgue y confirme que ninguna versión puede
listarse ni descargarse.

## Ayuda y salida

```powershell
npm run terms:publish --workspace @sinochat/api -- --help
npm run investigation-key:register --workspace @sinochat/api -- --help
```

Los comandos imprimen únicamente metadatos operativos en JSON. No imprimen el
texto legal ni la clave pública completa.
