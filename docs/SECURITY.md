# Modelo de seguridad

## Objetivo de privacidad

Los mensajes y adjuntos normales se cifran de extremo a extremo. El servidor
almacena exclusivamente contenido cifrado y metadatos mínimos necesarios para
entrega, expiración y control de abuso.

El administrador controla cuentas, asignaciones e infraestructura, pero su rol de
aplicación no posee claves para descifrar conversaciones.

## Validación de identidad criptográfica: alcance actual

El [validador de bootstrap público](CROSS_SIGNING_BOOTSTRAP.md) comprueba el
triplete de cross-signing y el certificado del dispositivo propio contra la
instantánea original del directorio. Conserva la autofirma original, rechaza
campos privados y no permite reemplazar ninguna clave de una identidad ya fijada.
El parser es una función pura; ahora un servicio separado publica atómicamente
el triplete público, su certificado y un evento de cambio. Revalida elegibilidad,
sesión y dispositivo bajo bloqueos; un reintento exacto no escribe y no existe
reset de raíces. SQL exige ambas filas, valida su forma pública e impide
modificarlas o eliminarlas. Las consultas excluyen a ADMIN y a identidades sin
relación vigente; la clave `user_signing` solo se devuelve a su propietario.

El inicializador web conserva las claves privadas en el store local del SDK,
compara la identidad fijada y exige confianza en el dispositivo propio después
de consultar su certificado. Claves locales ausentes o una identidad distinta
provocan un error seguro, nunca una regeneración automática. Esto no autoriza
dispositivos adicionales ni acredita al interlocutor: la ceremonia visible,
la política de confianza entre participantes y la recuperación E2EE siguen
pendientes. El gate continúa compilado `BLOCKED` y el límite SQL de un único
dispositivo histórico permanece vigente. Alcance de las pruebas separadas de
SDK y PostgreSQL en la [validación local](VALIDATION_2026-09-11.md).

La comprobación compartida de firmas Ed25519 incluye decodificación canónica
y rechazo de puntos inválidos o de orden pequeño tanto en la clave pública como
en `R`, antes de verificar la firma con Node. Esto protege también el alta y la
reposición de claves Matrix. Se verifican asimismo los puntos de las tres claves
de cross-signing, aunque la clave `user_signing` aún no firme otro objeto en este
bootstrap. Las regresiones reproducen firmas falsificables aceptadas por la
comprobación nativa sin estas defensas; no constituyen una auditoría externa.

## Comparación de dispositivos: piezas aisladas

El validador adicional verifica el certificado contra claves originales y un
triplete ya fijado por el servidor. No prueba consentimiento, frescura ni sesión
aprobadora; no activa un dispositivo. El controlador SAS solo confirma valores
emitidos y mostrados por el SDK para el mismo usuario, par de dispositivos y
flujo. Rechaza recibos obsoletos y cancela flujos vivos ante cierre, vencimiento o
error. La pantalla requiere una casilla explícita y no almacena los valores.

Estas piezas no están montadas en el alta real. Falta ligar solicitud, ceremonia
y promoción transaccional. `comparison-complete` no concede permisos. El relay
de caracterización no transporta solicitudes ni respuestas de secretos y el
nuevo candidato no recibe claves privadas de cross-signing. No hay recuperación
E2EE administrativa ni cambios al gate o al índice de dispositivo único.
Alcance y pruebas en [Autorización de un dispositivo adicional](DEVICE_APPROVAL.md).

La reserva pública ya se implementó separadamente en API y SQL. Se liga a una
sesión propia sin dispositivo, con versión vigente, y al bootstrap confiable
existente. Tiene plazo máximo de diez minutos, una sola PENDING por usuario y
transiciones irreversibles. Un estado consultado como vencido se persiste para
no revivir por retroceso del reloj. Rutas protegidas por sesión, rol y gate no
entregan claves, secretos ni permisos operativos. ADMIN y otras sesiones propias
quedan excluidos de las rutas del solicitante; el dispositivo confiable usa
las rutas separadas de revisión descritas abajo. Las filas terminales conservan metadatos públicos contra replay;
compactarlas exige una política posterior que no permita reutilizar IDs.

La migración de cuarentena no elimina el índice de dispositivo histórico único
ni permite certificados adicionales. Fue probada exclusivamente en una base
temporal, no aplicada a la base habitual; véase [validación de cuarentena](VALIDATION_2026-09-12_QUARANTINE.md).

La revisión desde el bootstrap propio ya permite consultar metadatos/claves
públicas y descartar sin motivo. Se comprueban cuenta, dispositivo, certificado,
pin y sesión reales; para mostrar una reserva también se bloquea/revalida su
sesión solicitante. El descarte puede denegar una reserva cuyo solicitante ya
cerró sesión, pero nunca conceder autoridad. La caducidad observada se confirma
antes de responder 404; las respuestas usan `no-store` y no incluyen IDs de
sesión ni secretos. No hay endpoint approve ni publicación operativa.
Faltan la entrega del canal SAS, su resultado autorizante y la promoción atómica.
Pruebas y límites de la revisión en la
[validación de revisión](VALIDATION_2026-09-12_DEVICE_REVIEW.md).

El [perfil público SAS](MATRIX_SAS_TRANSPORT.md) ya tiene validador puro que
limita par/flujo, campos, algoritmos y codificación, sin ampliar el transporte
de conversaciones. No autentica contexto ni verifica MAC/compromisos: eso exige
servicio autorizado y SDK, respectivamente. Un timestamp bien formado o un
`done` no conceden vigencia ni aprobación. El diagnóstico `reason` de cancelación
es del protocolo, no un motivo obligatorio escrito por el usuario.

La admisión separada del primer request ya fija candidato, flujo SDK propuesto,
sesión revisora y envío bajo locks, conservando las referencias inmutables a
sesión solicitante, pin y claves. Solo lo inicia el bootstrap propio; no puede
heredarlo otra sesión del mismo dispositivo. Su TTL está limitado por ambas
sesiones, reserva, suscripción, reloj PostgreSQL y timestamp original. IDs de
flujo/envío no se reutilizan tras terminar y un reintento no extiende el plazo.
Cancelar el candidato invalida el flujo atómicamente, con reloj posterior a
las esperas. Las filas terminales quedan como protección contra replay hasta
definir una compactación segura; no guardan conversaciones.

Esta admisión no entrega el request, verifica MAC ni demuestra comparación
humana. No publica certificados, crea dispositivos ni vincula sesiones. La
única ruta nueva conserva CSRF, roles, límite de frecuencia y el gate cerrado.
La migración 32 se comprueba en una base desechable, sin aplicarla a la habitual.
Resultados y alcance en la [validación de admisión](VALIDATION_2026-09-16_SAS_ADMISSION.md).

## Recuperación

- Cada dispositivo posee identidad criptográfica propia.
- Las claves de recuperación se protegen con un secreto de alta entropía entregado
  al usuario.
- Un dispositivo nuevo se aprueba desde otro dispositivo confiable o mediante el
  código de recuperación.
- El administrador puede iniciar el restablecimiento de autenticación de un
  cajero, pero no elige ni conoce una contraseña y no recupera claves E2EE. La
  solicitud dura 24 horas y bloquea HTTP, CSRF, dispositivos y WebSocket hasta
  que el cajero consume uno de sus ocho códigos personales para elegir una
  contraseña fuerte distinta. Solo se almacenan hashes; cada código es de un
  uso y los no usados siguen válidos hasta rotación. El endpoint no inicia
  sesión y exige después un login normal. Los clientes no admiten ese reset.
- Para un cajero sin dispositivo confiable ni código se conservan cuenta y
  asignaciones, pero no se pueden recuperar mensajes cifrados anteriores. Un
  cliente que pierde sus credenciales pierde el acceso a su cuenta.

## Identidad administrativa

- Una contraseña administrativa correcta crea únicamente una sesión pendiente.
  `RolesGuard` no permite acceder al panel hasta completar WebAuthn con
  verificación de usuario obligatoria.
- El alta usa passkeys descubribles, attestation `none`, un user handle aleatorio
  de 32 bytes y desafíos de cinco minutos ligados a usuario, sesión y propósito.
  PostgreSQL conserva solo el hash del desafío, la clave pública, transports y
  contador anti-replay.
- El primer enrolamiento es la única excepción al step-up previo. Registrar una
  passkey adicional exige una assertion de menos de cinco minutos tanto al pedir
  opciones como nuevamente dentro de la transacción que verifica el alta; la PWA
  reautentica y reintenta una sola vez.
- La primera passkey genera diez códigos administrativos de aproximadamente 125
  bits. Se muestran una sola vez, solo se guarda su hash y cada uno se consume
  una vez. Recuperar revoca todas las passkeys, los demás códigos y las demás
  sesiones, y obliga a enrolar una passkey nueva.
- Abrir evidencia exige que la assertion WebAuthn tenga menos de cinco minutos,
  además de la contraseña actual, la justificación y el límite de frecuencia.
- El administrador puede registrar hasta diez passkeys activas. Su inventario
  expone únicamente ID interno, fechas de alta/último uso, tipo de dispositivo y
  estado de backup; no expone `credentialId`, clave pública ni transports.
- Revocar una passkey exige un step-up WebAuthn de menos de cinco minutos y nunca
  permite revocar la última. La operación bloquea la fila del administrador para
  que dos revocaciones concurrentes no eliminen todas sus credenciales y registra
  `ADMIN_PASSKEY_REVOKED` en el ledger append-only, sin motivo de texto libre.
- Las transacciones MFA bloquean primero el usuario, también al emitir desafíos
  y confirmar assertions. Los conflictos de serialización y deadlocks conocidos
  devuelven HTTP 409 con `ADMIN_MFA_CONCURRENT_CHANGE`, sin detalles SQL y sin
  reintentar automáticamente la ceremonia. La interfaz conserva la confirmación
  y permite volver a actuar tras revisar el estado.
- El administrador puede listar únicamente metadatos temporales de sus propias
  sesiones. La UI marca la actual y solo
  permite revocar otras; la revocación individual o masiva exige el mismo
  step-up de cinco minutos y genera un evento de auditoría.
- En producción `WEBAUTHN_RP_ID` es obligatorio, debe coincidir exactamente con
  el host de `WEB_ORIGIN` y el origen debe usar HTTPS. La
  certificación entre navegadores y el ensayo operativo de recuperación siguen
  siendo requisitos previos al lanzamiento.

## Reportes

El dispositivo denunciante descifra localmente la conversación vigente y genera
un paquete de evidencia cifrado para la clave pública de investigación. El
servidor nunca recibe la evidencia en texto plano.

La clave privada de investigación debe mantenerse fuera del servidor de la
aplicación y estar protegida con autenticación fuerte.

El acceso administrativo exige asignación exclusiva del caso, estado
`IN_REVIEW`, justificación, reautenticación de la contraseña y un permiso de
descarga de 60 segundos. El cierre pasa primero a `CLOSING`, bloquea nuevos
accesos y se completa mediante un job durable únicamente después de la purga.
Antes de emitir el permiso, un guard exige además una passkey verificada durante
los últimos cinco minutos; la PWA inicia el step-up y reintenta una sola vez.

## Archivos

- Lista permitida: JPEG/JPG, PNG y WebP.
- Límite estricto: 5 MiB antes del cifrado.
- Una imagen por mensaje.
- Objetos privados con identificadores aleatorios.
- Cifrado antes de la carga.
- El servidor no puede analizar el contenido cifrado; el cliente debe decodificar
  y volver a codificar imágenes antes de cifrarlas para reducir contenido activo
  o metadatos inesperados.

## Retención

- `expires_at = created_at + 48 horas`, calculado en el servidor.
- Todas las lecturas filtran contenido vencido.
- El estado React retira contenido vencido mediante un reloj local independiente
  de HTTP, incluidas conversaciones del cajero que no estén seleccionadas.
  Foco, `pageshow` y cambios de visibilidad vuelven a comprobar la caducidad;
  los Blob URL se revocan en el controlador. Una pestaña suspendida no puede
  ejecutar la purga hasta volver a ejecutarse, y estas medidas no borran
  capturas ni copias externas.
- Un trabajo frecuente elimina filas y objetos vencidos.
- Una política del proveedor actúa como defensa adicional, no como mecanismo
  principal.
- Las copias de seguridad no deben conservar claves privadas ni texto plano.
- Se registran métricas y fallos del proceso de borrado sin registrar contenido.

## Códigos de invitación

- Los enlaces usan exclusivamente el fragmento del navegador:
  `/invitacion#cliente=CODIGO` o `/invitacion#cajero=CODIGO`. El fragmento no
  forma parte de la solicitud HTTP y, por tanto, no llega al proxy ni a los
  logs de acceso.
- La PWA lee el fragmento al arrancar y reemplaza inmediatamente la entrada
  actual por `/invitacion`, con `history.state = null`. El código se conserva
  solo en memoria durante la validación y el registro; no se escribe en
  `localStorage`, query strings ni rutas.
- La validación pública usa `POST /api/invitations/validate` con JSON estricto,
  respuesta no enumerable y límite de frecuencia. No existe una variante
  `GET` que incluya o devuelva el código.
- El cajero revela su código vigente mediante
  `POST /api/cashier/invitation/reveal`, con sesión, rol, CSRF y rate limit.
  Rotación, alta administrativa y registros también transportan el secreto
  solo en cuerpos `POST`.
- El ciphertext AES-256-GCM usa AAD para ligar tipo, ID y propietario de cada
  invitación. El arranque falla si una versión de clave que aún necesita una
  invitación no revocada está ausente del keyring; las claves de registros ya
  revocados pueden retirarse según el procedimiento de rotación.
  `cipher_format_version` distingue explícitamente filas legacy sin AAD de las
  nuevas; nunca se prueba otro formato después de fallar la autenticación. Al
  revelar una invitación activa también se verifica que el código descifrado
  coincida con su `code_lookup_hash`; los cajeros deben rotar cualquier fila
  legacy antes de retirar su clave anterior.
- El HTML declara `Referrer-Policy: no-referrer`. El despliegue debe enviar la
  misma política como cabecera HTTP y no ejecutar analítica previa a la limpieza
  del fragmento.

## Controles obligatorios

- TLS en producción.
- Cookies de sesión `HttpOnly`, `Secure` y `SameSite`.
- Contraseñas almacenadas con Argon2id.
- Restablecimiento administrativo exclusivo de cajeros, con solicitud de 24
  horas, código personal de un solo uso, actualización condicionada y
  revocación de sesiones; el administrador nunca maneja credenciales.
- Protección CSRF, CSP, límites de frecuencia y bloqueo de intentos.
- Validación de autorización tanto en HTTP como en cada evento WebSocket.
- Separación entre permisos administrativos, de aplicación y de base de datos.
- Auditoría de acciones administrativas sin incluir contenido de chat.
- Revisión criptográfica externa antes de considerar el sistema listo para datos
  reales.

## Límite inherente de una aplicación web

El cifrado protege el contenido almacenado y transportado, pero quien controle el
servidor web podría intentar publicar JavaScript malicioso en una versión futura.
Se mitigará con despliegues reproducibles, CSP estricta, integridad de artefactos,
revisión de cambios y registro de versiones. Una garantía más fuerte frente a un
servidor activamente malicioso requeriría clientes nativos firmados.
