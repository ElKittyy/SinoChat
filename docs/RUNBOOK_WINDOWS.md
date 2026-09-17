# Runbook de SinoChat para Windows y Node 24

Este documento permite levantar y verificar el entorno de desarrollo sin
confundirlo con una aprobación de producción. Los comandos parten de la raíz:

```powershell
Set-Location "C:\Users\camil\OneDrive\Escritorio\Camilo\Uni\HTMLCSSJS\SinoChat"
```

## 1. Requisitos y comprobación previa

- Windows 10/11 y PowerShell 7 recomendado.
- Node.js 24 LTS y npm 11.19.1 para instalar o actualizar dependencias.
- Docker Desktop en ejecución, con `docker compose` v2.
- Puertos locales libres: 3000, 5173, 5432, 6379, 9000 y 9001.

En el equipo de desarrollo comprobado el 26 de agosto de 2026, Node 24.18.0,
Docker Desktop, WSL 2 y Docker Compose v5.3.1 están instalados y operativos. La
política de PowerShell impide ejecutar `npm.ps1`; todos los ejemplos usan
`npm.cmd`, por lo que no es necesario reducir esa seguridad.

El chequeo incluido es de solo lectura: no inicia contenedores, no crea `.env` y
no genera ni muestra secretos.

```powershell
pwsh -NoProfile -File .\scripts\check-local.ps1
```

Si `pwsh` no está disponible, se puede ejecutar con Windows PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-local.ps1
```

`-ExecutionPolicy Bypass` se limita a ese proceso y al script local; no modifica
la política global. También se pueden comprobar las herramientas manualmente:

```powershell
node --version
npm.cmd --version
docker compose version
```

Abrir Docker Desktop y esperar a que su motor esté activo antes de continuar con
la base. El esquema contiene 32 migraciones versionadas: incluye la migración
Matrix base, sus siete correcciones forward `20260827001000` a
`20260827007000`, la protección de replay `20260828000000` y el endurecimiento
Olm transitorio `20260830000000`, el ledger de adjuntos `20260831000000` y el
perfil Megolm `20260831001000`, los códigos de recuperación de cajero
`20260901000000`, MFA administrativo `20260901010000` y la auditoría de
revocación de passkeys `20260902000000` y la identidad pública inicial de
cross-signing `20260910000000`, seguida de cuarentena de candidatos
`20260912000000` y la admisión SAS `20260913000000`. Estas tres se probaron
en bases aisladas; no se aplicaron a la base habitual en estas tandas.

## 2. Dependencias y archivo de entorno

La instalación reproducible usa el lockfile existente y npm 11.19.1, sin
modificar la instalación global:

```powershell
npx.cmd --yes --package npm@11.19.1 npm ci
```

npm 11.16.0 puede ignorar los `overrides` al resolver paquetes de un workspace.
La versión fijada incluye la [corrección de npm](https://github.com/npm/cli/pull/9673)
y mantiene los parches de
`multer@2.3.0` y `qs@6.16.0`. Usa también el prefijo
`npx.cmd --yes --package npm@11.19.1 npm` para `install`, `update` y `ls`.
Los comandos `npm.cmd run ...` de este runbook pueden seguir ejecutándose con
el npm incluido con Node. CI prepara la versión fijada antes de `npm ci`.

Crear `.env` una sola vez. El comando falla si ya existe, evitando sobrescribir
configuración local:

```powershell
if (Test-Path -LiteralPath .\.env) {
  throw ".env ya existe; no se sobrescribió."
}
Copy-Item -LiteralPath .\.env.example -Destination .\.env -ErrorAction Stop
```

`.env` está excluido por `.gitignore`. Antes de cualquier commit, comprobar que
no aparece en el estado de Git. Nunca copiar `.env` a una incidencia, chat, log o
captura de pantalla.

Preparar las credenciales independientes de MinIO y la configuración S3 local
sin imprimir los secretos:

```powershell
npm.cmd run local:storage:configure
```

El comando solo acepta una configuración vacía o compatible con el entorno
local; no reemplaza un endpoint externo. Conserva credenciales ya creadas y
genera las ausentes con aleatoriedad criptográfica.

### Generar secretos locales sin escribirlos automáticamente

Cada secreto debe ser independiente. Para
`PASSWORD_PEPPER`, `METADATA_HASH_SECRET`, `ATTACHMENT_GRANT_SECRET`,
`EVIDENCE_UPLOAD_GRANT_SECRET`, `DEVICE_BINDING_HMAC_SECRET` y
`MATRIX_SYNC_TOKEN_SECRET`, ejecutar este comando **una vez distinta por
variable** y pegar el resultado únicamente en el `.env` local:

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Para `INVITATION_ENCRYPTION_KEY` se exige exactamente una clave de 32 bytes en
Base64 estándar:

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
```

Los códigos de invitación guardan la versión con la que fueron cifrados. Al
rotar esta clave hay que incrementar `INVITATION_ENCRYPTION_KEY_VERSION`, poner
la nueva clave en `INVITATION_ENCRYPTION_KEY` y conservar las anteriores en
`INVITATION_ENCRYPTION_PREVIOUS_KEYS` como un objeto JSON `versión: Base64`, por
ejemplo `{"1":"..."}`. La versión actual no se repite allí y cada versión debe
usar material diferente. No retirar una clave anterior mientras exista un
código de cajero activo cifrado con ella; primero se rota ese código y se
verifica que el nuevo puede consultarse. La migración 14500 marca como formato
`0` las filas anteriores sin AAD y usa formato `1` para toda alta nueva. Antes
de retirar una clave también deben rotarse todas las invitaciones activas con
formato `0`; el arranque verifica autenticación, contexto y hash de cada código
revelable y falla cerrado ante una fila corrupta. El default de base permanece
en `0` durante compatibilidad para que un binario antiguo no pueda etiquetar
ciphertext sin AAD como `1`; el binario nuevo siempre escribe `1` explícitamente.

No reutilizar resultados entre variables. Estos comandos no incluyen ni guardan
el secreto en el historial, pero sí lo muestran en la consola; limpiar el buffer
de la terminal al terminar. En producción deben generarse y custodiarse dentro
de un gestor de secretos, con acceso auditado, respaldo seguro y una ceremonia
de rotación. Perder o cambiar un pepper o una clave sin un plan compatible puede
invalidar credenciales o datos existentes.

`MATRIX_SYNC_TOKEN_SECRET` autentica los tokens opacos `sct1` de `/sync`, debe
tener al menos 32 bytes y ser distinto de todos los demás secretos. Es
obligatorio en producción. En desarrollo, omitirlo hace que la API derive
temporalmente su valor de `DEVICE_BINDING_HMAC_SECRET`, pero se recomienda
configurarlo explícitamente para probar la separación real. Rotarlo invalida los
tokens de sync todavía vigentes y requiere una ceremonia operativa que aún no se
ha diseñado; no debe cambiarse con tráfico abierto.

Para desarrollo local conservar:

```dotenv
NODE_ENV=development
WEB_ORIGIN=http://localhost:5173
VITE_API_URL=http://localhost:3000
VITE_CSRF_COOKIE_NAME=sinochat_csrf
MATRIX_SERVER_NAME=sinochat.invalid
DATABASE_URL=postgresql://sinochat:sinochat@localhost:5432/sinochat
REDIS_URL=redis://localhost:6379/0
SESSION_COOKIE_NAME=sinochat_session
CSRF_COOKIE_NAME=sinochat_csrf
```

`MATRIX_SERVER_NAME` forma parte de los identificadores criptográficos
derivados. `sinochat.invalid` es solo el namespace local. En producción la
variable es obligatoria, debe ser un ServerName Matrix sintácticamente válido y
debe permanecer estable desde antes de registrar el primer dispositivo. No es
una URL ni configura un homeserver: el perfil Matrix de SinoChat es privado y
no federa. Cambiar este valor después de publicar claves crea identidades
distintas y exige una migración criptográfica todavía no diseñada.

En producción la PWA y `/api` deben publicarse bajo el **mismo origen**. Se deja
`VITE_API_URL` vacío y el proxy del hosting dirige `/api` a Nest. Tanto la API
como la compilación web deben usar el mismo nombre de cookie:

```dotenv
SESSION_COOKIE_NAME=__Host-sinochat_session
CSRF_COOKIE_NAME=__Host-sinochat_csrf
VITE_CSRF_COOKIE_NAME=__Host-sinochat_csrf
```

Una API en otro subdominio no sirve para este diseño: una cookie `__Host-` no
puede ser leída por JavaScript desde el host de la PWA. La topología same-origin
y una mutación autenticada deben probarse en staging antes de desplegar.

La conexión PostgreSQL de producción debe incluir `sslmode=verify-full` y una
CA confiable para verificar también el hostname. `DATABASE_URL` pertenece al rol
de runtime con privilegios mínimos; el job aislado que ejecuta migraciones usa
`MIGRATION_DATABASE_URL`. Esa credencial privilegiada no se entrega al proceso
de la API ni se conserva después del despliegue.

La contraseña `sinochat` de PostgreSQL en `compose.yaml` es exclusivamente local.
No debe usarse en un servidor. Si `OBJECT_STORAGE_*` queda vacío, la API puede
servir las funciones que no usan adjuntos, pero las fotos y evidencias no estarán
operativas; esto no representa un entorno productivo completo.

## 3. PostgreSQL, Redis y almacenamiento de objetos

Una vez instalado y abierto Docker Desktop:

```powershell
docker compose up -d postgres redis object-storage object-storage-init
docker compose ps
docker compose exec -T postgres pg_isready -U sinochat -d sinochat
docker compose exec -T redis redis-cli ping
npm.cmd run check:storage
```

PostgreSQL debe aceptar conexiones, Redis responder `PONG` y la prueba de
almacenamiento debe confirmar CORS, privacidad, integridad, rechazo de replay,
descarga y purga de todas las versiones. `object-storage-init` termina con código
0 después de crear el bucket privado, habilitar versionado y aplicar una política
limitada a la credencial de la API. Para ver logs sin modificar datos:

```powershell
docker compose logs --tail 100 postgres redis object-storage object-storage-init
```

Detener los servicios sin borrar volúmenes:

```powershell
docker compose stop
```

No usar `docker compose down -v` en un entorno con datos que deban conservarse:
elimina los volúmenes de PostgreSQL y MinIO.

MinIO está fijado por versión y digest para obtener pruebas locales
reproducibles. Su distribución comunitaria usada aquí no se considera el
proveedor de producción de SinoChat.

## 4. Prisma y migraciones

Generar el cliente, validar el esquema y aplicar exactamente las migraciones
versionadas:

```powershell
npm.cmd run db:generate --workspace @sinochat/api
npm.cmd run db:validate --workspace @sinochat/api
npm.cmd run db:deploy --workspace @sinochat/api
```

`db:deploy` es el comando reproducible para una base nueva o compartida. Usar
`db:migrate` solo al desarrollar una migración nueva y revisar antes el SQL
generado; no se usa para desplegar producción.

Las migraciones actuales requieren un despliegue coordinado con ventana de
mantenimiento: detener primero todos los procesos API y workers de la versión
anterior, aplicar `db:deploy`, desplegar una única versión compatible y recién
entonces reabrir tráfico. En particular, las columnas obligatorias de los jobs
de evidencia no están diseñadas para que binarios antiguos sigan escribiendo
durante un esquema expand/contract. No declarar despliegue sin interrupción ni
mezclar versiones hasta diseñar, probar y documentar ese protocolo por separado.

La migración `20260727011000_device_binding_hardening` falla deliberadamente si
encuentra dispositivos históricos. No se debe editar ni saltar: requiere la
ceremonia de migración descrita en [Operaciones](OPERATIONS.md#migración-de-vinculación-de-dispositivos).

La migración `20260827000000_matrix_e2ee_transport` es aditiva: crea reservas y
claves firmadas de dispositivo, preclaves de un solo uso y fallback, reclamos
idempotentes, cambios de lista y una cola `to-device` con cursores/batches. No
convierte los blobs criptográficos genéricos, no migra mensajes a esa cola y no
habilita el chat. Sus restricciones de PostgreSQL son parte de la defensa contra
reutilización de claves y entregas después de una reasignación; deben probarse
con concurrencia real antes de producción.

Las tres migraciones Matrix siguientes son correcciones **forward** y no deben
plegarse dentro de una migración ya aplicada:

- `20260827001000_owned_device_reference_record_fix` corrige la validación
  polimórfica de referencias a dispositivos propios.
- `20260827002000_matrix_pre_key_record_fix` corrige la validación compartida de
  los timestamps de reclamo de OTK y fallback.
- `20260827003000_matrix_claim_selection_hardening` obliga a consumir el lote
  OTK disponible más antiguo antes de utilizar un fallback.

Las cuatro forward posteriores completan las garantías persistentes de
`sendToDevice` y `/sync`:

- `20260827004000_matrix_sync_chain_hardening` encadena rangos inmutables y
  permite un solo sucesor por predecesor.
- `20260827005000_matrix_device_idempotency_and_sync_lineage` hace durable la
  idempotencia por dispositivo/endpoint y conserva el UUID del predecesor aunque
  su fila ya se haya purgado.
- `20260827006000_matrix_sync_replay_window` impide que un token sobreviva a sus
  eventos o a la ventana máxima de 48 horas.
- `20260827007000_matrix_sync_crypto_snapshot` conserva el conteo OTK y el estado
  del fallback usados para reconstruir una respuesta idéntica.
- `20260828000000_matrix_registration_replay` congela el hash canónico y conteo
  OTK de la primera confirmación para recuperarla tras perder la respuesta HTTP,
  sin persistir el secreto de vinculación.
- `20260830000000_message_olm_envelope_hardening` falla si existen sobres o
  adjuntos heredados incompatibles y fija el perfil Olm de transición. No se
  deben borrar ni convertir datos para forzar su aplicación.
- `20260831000000_attachment_purge_ledger_hardening` usa `ON DELETE RESTRICT`
  para conservar `object_key` hasta que el worker elimine todas las versiones
  externas.
- `20260831001000_message_megolm_envelope_profile` falla si existe cualquier
  sobre Olm y fija `matrix-megolm-v1`, `m.megolm.v1.aes-sha2`; `A256CTR` sigue
  siendo el único perfil de adjunto. Cualquier incompatibilidad requiere una
  operación explícita y revisada, nunca renombrar ciphertext.

Una base al día debe registrar las 32 migraciones. Para probar localmente los
triggers Matrix contra PostgreSQL real sin conservar datos de prueba:

```powershell
npm.cmd run check:matrix-db
npm.cmd run check:recovery-db
npm.cmd run check:webauthn-db
```

Los verificadores solo aceptan una base local que no sea de producción, crean sus
fixtures dentro de una transacción, comprueban las restricciones y siempre
termina con `ROLLBACK`. No modifica datos persistentes ni reemplaza las pruebas
de concurrencia, recuperación o seguridad requeridas para producción.

La publicación inicial de identidad tiene un verificador aislado:

```powershell
npm.cmd run check:cross-signing-db
```

Requiere `CREATEDB` local. Crea una base vacía exclusiva y aplica todas las
migraciones; no aplica cambios de esquema a la base habitual. Usa firmas reales
del SDK y los servicios de publicación y consulta. Comprueba raíz/certificado
atómicos, reintento exacto, reemplazo rechazado, inmutabilidad SQL y consultas
propias sin acceso ADMIN. Dos trabajadores esperan simultáneamente el mismo
bloqueo antes de competir; solo uno publica raíz, certificado y evento `CHANGED`.
Otra prueba revoca una sesión durante la espera y exige que no publique nada.
El verificador también comprueba la reserva pública de candidatos con firmas
Ed25519 de prueba: reintento, acceso exclusivo de sesión, vencimiento real,
cancelación, snapshot SQL inmutable, dos reservas simultáneas y una sesión
revocada mientras espera. También comprueba revisión propia, descarte simultáneo,
expiración persistida antes de un 404 y revocación del solicitante, del revisor
o de su dispositivo durante espera. Confirma que no se publican dispositivos, claves,
preclaves, cursores ni eventos y que la sesión sigue sin dispositivo vinculado.
La admisión SAS se comprueba por separado con otro propietario sintético:
fija la reserva, el `request` del bootstrap y las dos sesiones exactas; exige
reintento idéntico sin renovar el plazo y rechaza reutilizar históricamente
el candidato, el ID de flujo por usuario o el ID de transacción HTTP por usuario.
También prueba restricciones SQL independientes, caducidad real, cancelación
en cascada del flujo, competencia entre revisores y revocaciones durante la
espera. El plazo es el mínimo entre diez minutos del servidor, reserva, ambas
sesiones, suscripción si corresponde y timestamp del SDK más diez minutos.
Al terminar verifica nombre, OID y propietario antes de eliminar exclusivamente
la base creada. Rechaza producción y URLs remotas; no habilita dispositivos ni
el gate. Resultados de admisión en la
[validación de admisión SAS del 16 de septiembre](VALIDATION_2026-09-16_SAS_ADMISSION.md);
el alcance y los resultados de las comprobaciones nuevas de bandeja están en la
[validación de bandeja SAS](VALIDATION_2026-09-16_SAS_INBOX.md).

La apertura utiliza únicamente
`PUT /api/e2ee/matrix/device-verification-flows/:candidateId/:flowId/:transactionId`,
con sesión, rol, CSRF, origen, JSON y límite de cinco peticiones por minuto.
La consulta inicial usa
`GET /api/e2ee/matrix/device-verification-inbox/:candidateId`, con `no-store`
y límite de 30 por minuto, compartido aunque cambie el ID consultado. Solo puede
recibirla el CLIENT/CASHIER de la sesión original del candidato, cuyo
`deviceId` sigue siendo `NULL`; no la hereda otra sesión de la misma cuenta.
GET no exige CSRF ni permite abrir, aprobar o consumir la solicitud.

La respuesta contiene `request: null` cuando no hay un request entregable, o los
IDs públicos, fechas y el evento original del SDK `{ sender, type, content }`.
Antes de copiarlo comprueba nuevamente ambas sesiones y sus versiones, usuario
y elegibilidad, dispositivo bootstrap certificado, identidad/pin, autofirma del
candidato, hash del request y reloj fresco de PostgreSQL al final. La lectura
es repetible, sin ACK ni marca de consumo. Observar el vencimiento terminaliza
la reserva y, mediante el trigger existente, su flujo; no registra claves,
dispositivos, certificados, eventos operativos ni vínculos de sesión.
Esta etapa no añade migraciones: se mantienen las 32 existentes.

El gate compilado sigue `BLOCKED`: una solicitud autenticada que supera los
demás guards recibe 503 sin invocar la admisión ni la bandeja. La frontera HTTP
de la bandeja tiene 23 comprobaciones con guards reales; el almacén de sesiones
y el servicio inalcanzable son dobles y el rate limit usa memoria, no Redis.
No hay canal para los demás eventos SAS, conexión al navegador, comparación
aceptada ni promoción de dispositivos. No se debe
desactivar el gate para probar este avance; las comprobaciones de servicio y
PostgreSQL son aisladas y no equivalen a un recorrido HTTP habilitado.

La comprobación de concurrencia MFA también usa una base exclusiva:

```powershell
npm.cmd run check:webauthn-concurrency
```

Requiere un rol local con `CREATEDB` (el contenedor de desarrollo lo permite).
Crea una base vacía exclusiva, aplica todas las migraciones y ejecuta dos
transacciones simultáneas para altas y otras dos para revocaciones de passkeys.
Comprueba sus límites, el desafío de la operación perdedora y la auditoría.
Al terminar elimina solo esa base temporal, verificando nombre, OID y
propietario antes del borrado; no modifica datos ni auditoría de la base usual.
La verificación criptográfica del registro se sustituye en esta prueba de
concurrencia; el recorrido siguiente comprueba WebAuthn en el navegador.

Con `npm.cmd run dev:api` y `npm.cmd run dev:web` activos se puede ejecutar además:

```powershell
npm.cmd run check:webauthn-browser
```

Este último control usa Chrome/Edge instalado y un autenticador virtual CTAP2.
El recorrido esperado inventaría dos passkeys sin revelar material de
credencial, exige step-up para el alta adicional, ejercita la recuperación real,
revoca el respaldo sin permitir eliminar la última, fuerza un step-up vencido,
cierra otra sesión desde el panel y verifica ambos eventos de auditoría.
La cuenta reservada queda deshabilitada y sin sesiones, passkeys o códigos
activos; los eventos de auditoría permanecen por diseño. No debe ejecutarse
contra una base remota ni sustituye pruebas con hardware y navegadores reales.

### Prueba aislada del cliente cifrado

```powershell
npm.cmd run check:e2ee-browser
```

No requiere API, PWA ni Docker encendidos ni lee `.env`. Usa Chrome/Edge local
o `CHROME_PATH`; también detecta Chromium instalado por `playwright-core`.
Abre tres contextos aislados, un relay HTTP en memoria en un puerto loopback
exclusivo y cachés temporales. Comprueba el código criptográfico real, fotos,
recarga, reintentos y caducidad local de React con reloj controlado.
No registra cuentas en tu base ni abre el gate E2EE. El build verifica que
su harness y relay no se incluyan en los artefactos productivos.

En CI se instala Chromium con
`node node_modules/playwright-core/cli.js install --with-deps chromium` antes
de ejecutar las pruebas. La configuración no equivale a una ejecución
certificada en Linux ni a compatibilidad con Firefox/Safari.
Consulta el [alcance y resultados locales](VALIDATION_2026-09-10.md).

### Pruebas aisladas de comparación de dispositivos

```powershell
npm.cmd run check:sas-comparison
npm.cmd run check:device-approval-sdk
npm.cmd run check:sas-panel
```

También forman parte de `npm.cmd test`. El primer comando comprueba el
controlador con estados controlables; el segundo utiliza dos máquinas reales
del SDK y un relay en memoria; el tercero prueba la pantalla React en Chrome
aislado con callbacks sintéticos. Este último necesita el navegador indicado
arriba. Ninguno necesita API/Docker, lee `.env`, exporta secretos o activa
dispositivos. Crean temporales propios y verifican sus rutas antes de
eliminarlos. El build excluye los hooks del panel de prueba del artefacto.

No conectan todavía esa pantalla con un canal autenticado ni certifican el
alta adicional. Detalles en [Autorización de dispositivos](DEVICE_APPROVAL.md)
y [validación del 12 de septiembre](VALIDATION_2026-09-12.md).

## 5. Publicar términos revisados

El código permite versionar y servir los bytes exactos del documento, pero no
redacta asesoramiento legal. Antes de habilitar registros debe existir un texto
real en español revisado jurídicamente. Guardar el borrador en una ruta de
trabajo aprobada, por ejemplo `legal\terminos-v1.md`; no publicar texto de
relleno.

Calcular el hash sobre los bytes definitivos y pedir versión/fecha con offset:

```powershell
$termsPath = (Resolve-Path -LiteralPath .\legal\terminos-v1.md).Path
$termsHash = (Get-FileHash -LiteralPath $termsPath -Algorithm SHA256).Hash.ToLowerInvariant()
$termsVersion = Read-Host "Versión, por ejemplo v1.0"
$effectiveAt = Read-Host "Vigencia ISO 8601 con offset, por ejemplo 2026-08-15T00:00:00-03:00"

npm.cmd run terms:publish --workspace @sinochat/api -- `
  --file $termsPath `
  --version $termsVersion `
  --type text/markdown `
  --effective-at $effectiveAt `
  --expected-sha256 $termsHash
```

La fecha debe usar `Z` u offset explícito. Cambiar espacios, BOM o saltos de
línea después de calcular el hash invalida la revisión. La publicación es
transaccional e idempotente solo si se repiten exactamente versión, contenido y
fecha.

Con la API iniciada, comprobar el documento vigente:

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:3000/api/legal/terms/current
```

La respuesta debe incluir `ETag` y `X-SinoChat-Terms-Version`. Para una
verificación de despliegue se debe descargar el cuerpo sin transformarlo y
comparar nuevamente su SHA-256 con el publicado.

## 6. Crear el primer administrador

Configurar en `.env` un `PASSWORD_PEPPER` estable antes de crear cuentas. El
usuario puede quedar en `ADMIN_BOOTSTRAP_USERNAME`; no guardar la contraseña en
el archivo. Esta secuencia la solicita sin eco, la expone solo al proceso hijo y
la elimina del entorno al finalizar:

```powershell
$adminUsername = Read-Host "Usuario administrador"
$adminSecurePassword = Read-Host "Contraseña (mínimo 14 caracteres)" -AsSecureString
$adminPasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($adminSecurePassword)
try {
  $env:ADMIN_BOOTSTRAP_USERNAME = $adminUsername
  $env:ADMIN_BOOTSTRAP_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($adminPasswordPointer)
  npm.cmd run admin:bootstrap --workspace @sinochat/api
}
finally {
  Remove-Item Env:ADMIN_BOOTSTRAP_USERNAME -ErrorAction SilentlyContinue
  Remove-Item Env:ADMIN_BOOTSTRAP_PASSWORD -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($adminPasswordPointer)
}
```

La contraseña necesita al menos 14 caracteres. La operación es idempotente: si
el administrador ya existe, no cambia su contraseña ni sus datos.

`admin:bootstrap` tampoco es un mecanismo general de recuperación. En el modelo
aprobado, únicamente una cuenta `CASHIER` puede recibir un restablecimiento
administrativo sin perder su clientela. Una cuenta `CLIENT` no tiene recuperación
de contraseña: si pierde la credencial, pierde el acceso. No se debe ampliar esta
regla mediante procedimientos manuales.

## 7. Registrar la clave pública de investigación

Esta operación es necesaria para evidencia de reportes, pero **no debe ejecutarse
para producción hasta aprobar el perfil de evidencia y su auditoría**. ADR-001
selecciona Matrix para chat, pero no convierte una clave de investigación
arbitraria en un algoritmo aprobado. El par se genera
en una estación externa controlada. La clave privada nunca se copia a este
repositorio, API, base, CI ni `.env`.

Después de la ceremonia criptográfica, registrar únicamente un archivo público
DER SPKI:

```powershell
$publicKeyPath = (Resolve-Path -LiteralPath "C:\ruta-segura\investigation-public.der").Path
$publicKeyBytes = [IO.File]::ReadAllBytes($publicKeyPath)
$env:INVESTIGATION_PUBLIC_KEY_BASE64 = [Convert]::ToBase64String($publicKeyBytes)
$env:INVESTIGATION_KEY_FINGERPRINT = (Get-FileHash -LiteralPath $publicKeyPath -Algorithm SHA256).Hash.ToLowerInvariant()
$env:INVESTIGATION_KEY_ALGORITHM = Read-Host "Identificador aprobado por el ADR"
$env:INVESTIGATION_KEY_VERSION = Read-Host "Versión entera creciente"
try {
  npm.cmd run investigation-key:register --workspace @sinochat/api
}
finally {
  Remove-Item Env:INVESTIGATION_PUBLIC_KEY_BASE64 -ErrorAction SilentlyContinue
  Remove-Item Env:INVESTIGATION_KEY_FINGERPRINT -ErrorAction SilentlyContinue
  Remove-Item Env:INVESTIGATION_KEY_ALGORITHM -ErrorAction SilentlyContinue
  Remove-Item Env:INVESTIGATION_KEY_VERSION -ErrorAction SilentlyContinue
}
```

La CLI verifica Base64 canónico, DER SPKI, fingerprint, tipo de clave y versión;
no sustituye la auditoría criptográfica. Consultar la ceremonia y las reglas de
rotación completas en [Operaciones](OPERATIONS.md#registrar-y-activar-una-clave-de-investigación).

## 8. Ejecutar API y PWA

Abrir dos terminales en la raíz. API:

```powershell
npm.cmd run dev:api
```

PWA:

```powershell
npm.cmd run dev:web
```

Abrir `http://localhost:5173`. Comprobar la liveness de la API:

```powershell
Invoke-RestMethod http://localhost:3000/api/health
```

`/api/health` confirma que el proceso HTTP responde; no certifica por sí solo la
base, Redis, S3, retención ni E2EE. Si Redis cae, la API termina de forma
deliberada para no ofrecer tiempo real parcial.

Comprobar también el gate criptográfico:

```powershell
Invoke-RestMethod http://localhost:3000/api/e2ee/status
```

El resultado esperado en esta etapa es `state: BLOCKED`. Las rutas Matrix
iniciales de registro/reposición de claves y todas las rutas de chat deben seguir
respondiendo 503; modificar una variable de entorno no puede abrir el gate.

## 9. Verificación de código

Desde una terminal donde no estén corriendo los procesos de desarrollo:

```powershell
npm.cmd run typecheck
npm.cmd run check:e2ee-runtime
npm.cmd test
npm.cmd run build
npm.cmd audit
```

La compilación web fuerza `NODE_ENV=production` de manera aislada aunque el
`.env` local de la API declare `development`, divide los paneles por rol y falla
si detecta accidentalmente `react-dom.development.js` en el artefacto.

Además, con Docker activo:

```powershell
npm.cmd run db:validate --workspace @sinochat/api
npm.cmd run db:deploy --workspace @sinochat/api
npm.cmd run check:matrix-db
npm.cmd run check:recovery-db
npm.cmd run check:webauthn-db
npm.cmd run check:webauthn-browser
npm.cmd run check:storage
docker compose ps
```

El workflow de GitHub Actions está configurado para ejecutar
`check:matrix-db`, `check:recovery-db` y `check:webauthn-db` secuencialmente
después del build sobre su servicio PostgreSQL. Que los pasos estén declarados no
equivale a una ejecución aprobada; se debe comprobar el resultado del workflow
correspondiente antes de integrar o desplegar.

Una salida limpia no aprueba producción: todavía son obligatorias las pruebas
con el S3 productivo, concurrencia, retención de 48 horas,
navegadores objetivo, carga, recuperación, incidentes y pentest.

## Bloqueos para producción

Los siguientes puntos no son mejoras opcionales; deben cerrarse y quedar con
evidencia antes de recibir usuarios reales:

1. **E2EE:** [ADR-001](ADR-001-E2EE_PROTOCOL.md) selecciona Matrix Rust Crypto
   18.6.0 y [ADR-002](ADR-002-MEGOLM_APPLICATION_MESSAGES.md) fija Megolm para
   mensajes ordinarios, con Olm solo para room keys/control y rotación por
   mensaje/máximo una hora. La migración
   `20260827000000_matrix_e2ee_transport` y sus once forward, el directorio de
   claves, `sendToDevice`/`sync`, los hooks `CHANGED`/`LEFT` y el coordinador web
   ya están implementados. También existen el codec interior estricto, el
   helper Matrix v2 `A256CTR` para fotos y las validaciones exteriores Olm de
   control/Megolm de mensajes. El lifecycle está montado en la sesión React con
   journal cifrado, exclusión entre pestañas y cierre ordenado, pero no completa
   el sistema. Falta conectar y certificar `Message`/`MessageEnvelope`, probar
   distribución de room keys, rotación, texto/foto e historial de 48 horas entre
   navegadores reales, multidispositivo, cross-signing, recuperación y evidencia
   firmada, además de auditoría criptográfica externa y pentest independientes. El
   perfil es privado de SinoChat, no interoperabilidad con un homeserver Matrix,
   y el gate debe permanecer `BLOCKED`.
2. **Identidad administrativa:** WebAuthn/passkeys ya es obligatorio antes del
   panel; los desafíos hasheados duran cinco minutos, la recuperación de un uso
   revoca passkeys/sesiones, el panel permite inventariar hasta diez passkeys,
   agregar respaldo, revocar cualquiera salvo la última y gestionar las sesiones
   propias; salvo el primer enrolamiento, altas, evidencia y revocaciones
   sensibles exigen step-up reciente y la baja
   de una passkey deja `ADMIN_PASSKEY_REVOKED`. Falta elegir y
   fijar el dominio estable, HTTPS y RP ID, certificar navegadores, ensayar la
   recuperación y añadir alertas fuera de banda.
3. **Legal y privacidad:** redactar y revisar términos, política de privacidad,
   tratamiento de reportes/evidencia, retención, cookies, mayoría de edad y
   jurisdicción aplicable. La CLI de publicación existe, pero no reemplaza esos
   documentos ni la revisión profesional.
4. **Almacenamiento:** la integración local ya prueba un bucket privado
   versionado, credenciales limitadas, CORS, replay e inexistencia de versiones
   después de purgar. Aún hay que contratar/configurar S3 compatible mantenido
   sobre TLS, bloquear acceso público, fijar la política de versionado, excluir
   payloads de backups y ejecutar una prueba que cargue, expire, purgue y
   confirme que no se puede listar ni descargar ninguna versión. Las reglas están en
   [Operaciones](OPERATIONS.md#almacenamiento-efímero-y-borrado-permanente).
5. **Backups de PostgreSQL:** los sobres cifrados de mensajes todavía residen en
   `message_envelopes`. Por ello un backup físico, WAL, réplica retrasada o PITR
   de la base principal también puede conservar payload efímero más de 48 horas.
   Antes de producción hay que separar ese payload en un almacén efímero sin
   recuperación histórica, o diseñar y certificar una estrategia criptográfica
   equivalente de destrucción de claves; no alcanza con filtrar consultas.
6. **Certificación de controles distribuidos:** los límites HTTP y WebSocket ya
   usan contadores atómicos compartidos en Redis y fallan de forma cerrada en
   producción. Falta validarlos bajo carga real con múltiples nodos, evasión por
   reconexión, caída de Redis y alertas sobre saturación o indisponibilidad.
7. **Identidad administrativa y frontend:** la sesión administrativa ya tiene
   TTL absoluto, inactividad controlada, revocación, auditoría y WebAuthn; el
   restablecimiento de cajero exige una solicitud de 24 horas y un código
   personal de un solo uso que el administrador nunca conoce. Aún faltan
   dominio/RP ID definitivo, la rotación documentada de secretos y la política de
   cabeceras/CSP del hosting que sirva la PWA.
8. **Infraestructura:** elegir hosting, dominio, certificados, gestor de
   secretos, monitoreo, alertas, respuesta a incidentes y estrategia de respaldo
   que no conserve payload efímero. Probar restauración de metadatos sin
   reintroducir contenido vencido.
9. **Validación:** PostgreSQL, Redis y MinIO locales ya arrancan en Docker, las 28
   migraciones se aplican, la API responde su health check y existe una prueba
   integral del contrato S3 local. Aún faltan las pruebas sobre el proveedor S3
   elegido para producción, autorización y concurrencia,
   compatibilidad móvil/escritorio, carga y SLO de purga.

Hasta cerrar los nueve puntos, SinoChat debe tratarse como un sistema en
desarrollo y no como un servicio de chat seguro listo para producción.
