# Bootstrap público de cross-signing

Estado: publicación atómica y consulta de la identidad del primer dispositivo implementadas; autorización de dispositivos adicionales pendiente. Gate compilado `BLOCKED`.

`apps/api/src/e2ee/matrix-cross-signing.ts` valida el conjunto público inicial generado por Matrix Rust Crypto 18.6. Sigue siendo una función pura. El servicio `matrix-cross-signing.service.ts` incorpora ahora autorización y persistencia transaccional, y el inicializador web `matrixCrossSigning.ts` publica el conjunto y comprueba la confianza del SDK en el dispositivo propio. Ninguno permite registrar dispositivos adicionales, recuperar secretos o abrir conversaciones. El bloqueo `E2EE_INTEGRATION_INCOMPLETE` no cambia.

## Contrato y origen de la confianza

La entrada es `parseMatrixCrossSigningBootstrap(signingKeysValue, signaturesValue, expected)`. Los dos primeros argumentos son datos no confiables que contienen los cuerpos públicos de publicación de claves y de firmas. El tercer argumento debe construirlo exclusivamente el servidor:

- `userId` y `deviceId`: identidad interna derivada de la sesión autenticada y de su dispositivo elegible; nunca de los cuerpos recibidos.
- `registeredDeviceKeys`: instantánea original, inmutable y autofirmada del dispositivo, obtenida del directorio ya validado. Debe contener la firma original del dispositivo, no una copia proporcionada por quien publica las firmas ni la versión enriquecida con firmas de cross-signing.
- `pinnedIdentity`: argumento obligatorio. Solo admite `null` cuando el servidor ha comprobado que todavía no existe una identidad; en los demás casos contiene el triplete público persistido de ese usuario. Omitirlo o pasar `undefined` se rechaza.

El validador vuelve a verificar la instantánea original y compara las claves Ed25519 y Curve25519, los algoritmos y los identificadores del certificado recibido con ella. Una firma criptográficamente válida no permite reemplazar esas claves. La función reconstruye objetos nuevos y no modifica las entradas; eso no convierte su resultado en un registro persistido ni impide que un consumidor lo modifique posteriormente.

## Perfil cerrado de publicación

Este perfil es deliberadamente más limitado que la API general de Matrix: exige el triplete completo, la misma identidad y un único dispositivo propio. No acepta actualizaciones parciales, firmas de otras personas o dispositivos, rotaciones, semillas privadas, `auth`, `unsigned` ni campos adicionales.

Las claves y firmas usan Base64 canónico sin relleno, de 32 y 64 bytes respectivamente. Cada clave pública tiene un único identificador `ed25519:<clave pública>` y un único uso: `master`, `self_signing` o `user_signing`. Los tres valores públicos deben ser distintos entre sí y no reutilizar ninguna clave del dispositivo. Se rechazan objetos ajenos al perfil JSON, propiedades accesoras, símbolos, campos ocultos y arrays alterados.

La caracterización local del SDK 18.6 produjo las siguientes cinco firmas de bootstrap, todas bajo el identificador del mismo usuario:

| Objeto firmado | Firmante exigido |
| --- | --- |
| `master_key` | Dispositivo original del directorio |
| `master_key` | La propia clave maestra |
| `self_signing_key` | Clave maestra |
| `user_signing_key` | Clave maestra |
| Certificado del dispositivo propio | Clave `self_signing` |

En la solicitud `SignatureUploadRequest` observada, el certificado contiene **solo la firma nueva de `self_signing`**, no la autofirma original del dispositivo. Por eso el validador compara primero el objeto sin `signatures` contra la instantánea del directorio, verifica la firma nueva y devuelve `signedDeviceKeys` con ambas firmas. No exige que el navegador reenvíe una firma original ni permite que sustituya la que conserva el directorio. El resultado también incluye `signingKeys` e `identity`.

Este tratamiento de firmas adicionales corresponde al contrato de objetos previamente publicados de [Matrix 1.18, publicación de firmas](https://spec.matrix.org/v1.18/client-server-api/#post_matrixclientv3keyssignaturesupload). La exigencia de las cinco firmas exactas anteriores es el perfil local comprobado con el SDK, no una afirmación de que toda implementación de Matrix deba emitir ese conjunto exacto.

## Reintento frente a sustitución de identidad

Las pruebas llaman dos veces a `bootstrapCrossSigning(false)` sobre la misma instancia y verifican que conserva el triplete. Con una identidad ya fijada, el validador acepta ese mismo triplete y rechaza cambios en cualquiera de sus tres claves, aunque la nueva cadena tenga firmas válidas. No compara solamente la raíz.

Un reintento no es un reinicio de identidad. No se debe usar `bootstrapCrossSigning(true)` para resolver automáticamente errores de red, una pérdida de contraseña o una discrepancia con el servidor. Este perfil no implementa ningún procedimiento para cambiar raíces o subclaves. El servicio compara también el hash canónico del conjunto completo persistido, bajo bloqueo por usuario: un reintento exacto no escribe ni publica otro `CHANGED`; otro conjunto válido recibe conflicto. La función pura no ofrece por sí sola esa garantía transaccional.

Matrix contempla reintentar la publicación del mismo conjunto sin tratarla como una sustitución; SinoChat mantiene aquí una política cerrada sin flujo de reemplazo. Véase [Matrix 1.18, publicación de claves de cross-signing](https://spec.matrix.org/v1.18/client-server-api/#post_matrixclientv3keysdevice_signingupload).

## Verificación Ed25519 y puntos débiles

La revisión local reprodujo que la verificación nativa de Node 24/OpenSSL, por sí sola, acepta ciertos casos de punto público identidad con firmas constantes que no requieren un secreto. Las regresiones cubren una raíz débil avalada por un dispositivo legítimo, una `self_signing` débil avalada por una raíz legítima y una `user_signing` débil con certificado válido.

El verificador compartido de `matrix-key-upload.ts` ahora sigue esta secuencia:

1. Comprueba la codificación y longitud de la clave y de la firma.
2. Decodifica el punto público `A` y el punto `R` de la firma mediante `ed25519.Point.fromBytes(bytes, false)` de `@noble/curves` 2.4.0; rechaza codificaciones no canónicas, puntos inválidos y puntos de orden pequeño mediante `isSmallOrder()`.
3. Conserva `node:crypto.verify` para comprobar la ecuación de firma sobre el JSON canónico, excluyendo `signatures` y `unsigned`. El perfil de bootstrap ya rechaza `unsigned` en la entrada. No sustituye esa verificación por la modalidad ZIP215 predeterminada de Noble.

El parser comprueba además los puntos públicos de las tres claves de cross-signing antes de aceptarlas. Es necesario para `user_signing_key`: durante este bootstrap su certificado se verifica con la raíz, pero todavía no se verifica ninguna firma utilizando esa clave como firmante. Un certificado de raíz válido no basta para aceptar un punto público débil.

Estas comprobaciones usan operaciones existentes de [Noble 2.4.0, implementación de puntos Edwards](https://github.com/paulmillr/noble-curves/blob/2.4.0/src/abstract/edwards.ts). No equivalen a una auditoría criptográfica independiente ni implementan un protocolo nuevo de firmas.

## Privacidad de las consultas

Las claves publicadas son públicas, pero eso no significa que toda consulta deba devolverlas a cualquier cuenta. El directorio devuelve `master_keys` y `self_signing_keys` únicamente para identidades solicitadas y autorizadas por la relación vigente. `user_signing_keys` se devuelve exclusivamente al propio usuario, y solo si lo solicitó. El certificado enriquecido se limita a los dispositivos activos seleccionados; la instantánea original no se sobrescribe. Un lote con un tercero ajeno falla completo antes de leer certificados. Las firmas futuras sobre identidades ajenas tampoco deben exponerse a terceros. Esta restricción evita revelar relaciones de confianza; véase [Matrix 1.18, seguridad de claves y firmas](https://spec.matrix.org/v1.18/client-server-api/#key-and-signature-security).

No se exportan ni se reciben secretos de cross-signing en este módulo. El futuro restablecimiento administrativo de contraseña no debe convertirse en acceso a claves privadas, autorización de nuevos dispositivos ni descifrado de chats.

## Publicación y almacenamiento implementados

- `GET /api/e2ee/matrix/cross-signing` informa `UNINITIALIZED` o `PINNED` y el triplete público propio. `POST /api/e2ee/matrix/cross-signing/bootstrap` acepta exactamente `{ signing_keys, device_signatures }`; ambos permanecen detrás de sesión, roles `CLIENT`/`CASHIER` y `E2eeReleaseGuard`. Los límites son 20 y 5 solicitudes por minuto respectivamente. `ADMIN` también se rechaza dentro del servicio.
- La transacción adquiere el bloqueo de dispositivos del usuario y bloqueos compartidos de usuario, elegibilidad de cajero, dispositivo y sesión. Relee el registro original y el pin dentro de esa transacción. Comprueba revocación, versión, rol, reset pendiente y vencimientos con reloj PostgreSQL después de los bloqueos y nuevamente antes de confirmar. Exige exactamente un dispositivo histórico.
- `MatrixCrossSigningIdentity` conserva el triplete y el hash canónico; `MatrixDeviceCrossSigning` conserva el certificado público con las dos firmas. La migración `20260910000000_matrix_cross_signing_identity` exige ambas filas mediante referencias, una de ellas diferida hasta el commit. Los triggers rechazan cambios y borrados, estructuras incompletas, propietarios incorrectos y reemplazos del dispositivo original. Las firmas criptográficas se verifican en la aplicación, no en SQL.
- La publicación inserta raíz, certificado y un único evento `CHANGED` en la misma transacción. Un fallo revierte todo. Los conflictos de concurrencia se devuelven sin repetir automáticamente la operación. La prueba real hace competir dos raíces válidas, confirma un único ganador y comprueba que una sesión revocada mientras espera el bloqueo no publique nada.
- La nueva migración se comprobó en una base temporal vacía junto con las 29 anteriores. No se aplicó a la base habitual durante esta tanda. No se eliminó el índice que bloquea un segundo dispositivo histórico.

## Inicialización web implementada

El lifecycle sigue consultando el gate antes de tocar almacenamiento. Tras registrar y confirmar las claves originales, finalizar el journal y vincular la sesión, ejecuta el inicializador bajo la exclusión del coordinador. Solo después de completarlo drena las solicitudes salientes y construye el adaptador Megolm.

El inicializador compara primero el pin remoto con la identidad y disponibilidad de secretos locales. Llama únicamente a `bootstrapCrossSigning(false)`. Para este perfil inicial, la `KeysUploadRequest` ya debe estar confirmada: si el bootstrap devuelve otra, falla cerrado. Publica los cuerpos públicos de claves y firmas en una única operación propia de SinoChat; no simula dos commits independientes de un homeserver.

El SDK 18.6 genera aquí una `SignatureUploadRequest` sin `id`; no se inventa un identificador para `markRequestAsSent`. Después de publicar, el navegador consulta sus propias claves mediante el coordinador, confirma esa consulta según el contrato del SDK y exige identidad verificada, ausencia de violación de confianza y `trustsOurOwnDevice()`. Un fallo de red permite repetir el mismo conjunto. Una identidad distinta, claves locales incompletas o confianza no verificada detienen el chat, con un mensaje seguro en español y sin ofrecer un reset administrativo.

## Certificado de un candidato adicional, sin autorización

`parseMatrixDeviceCertificate(signaturesValue, expected)` valida ahora el certificado público de un candidato contra sus claves originales inmutables y un triplete existente obligatorio. `expected` debe proceder exclusivamente del servidor. No acepta `null`, nueva raíz, claves privadas ni sustituciones Ed25519/Curve25519, incluso si están firmadas correctamente. Devuelve un objeto nuevo con la firma `self_signing` verificada y la autofirma original conservada.

El triplete es contexto ya autenticado por el bootstrap y fijado por el servidor: el certificado de dispositivo por sí solo no autentica de nuevo la cadena master→self-signing ni la clave user-signing. Sus 61 pruebas cubren SDK real, firmantes independientes, sustituciones separadas de cada clave, esquemas, puntos débiles y conservación de la instantánea. No hay ruta, servicio de aprobación ni persistencia nueva para este validador.

Una firma de dispositivo no contiene solicitud, caducidad, sesión aprobadora ni consentimiento humano. Por eso el resultado no puede activar un `Device`. El controlador, panel y caracterización SAS adicionales son piezas aisladas de la [ceremonia pendiente](DEVICE_APPROVAL.md), sin cambios en las restricciones SQL ni en el gate. Resultados de esta tanda en la [validación del 12 de septiembre](VALIDATION_2026-09-12.md).

La tanda posterior añadió `MatrixDeviceCandidate` y rutas de reserva/estado/cancelación
separadas del directorio. Exigen sesión solicitante sin vínculo y pin existente;
conservan solo el snapshot público autofirmado, no el certificado self-signing adicional.
La nueva tabla no modifica los permisos del bootstrap ni sus restricciones.
Pruebas y límites en la [validación de cuarentena](VALIDATION_2026-09-12_QUARANTINE.md).

El dispositivo inicial confiable ya puede consultar el snapshot pendiente propio
y descartarlo sin motivo mediante rutas separadas. Estas revalidan ambas sesiones
para entregar claves públicas y nunca emiten certificados ni aprueban dispositivos.
Pruebas en la [validación de revisión](VALIDATION_2026-09-12_DEVICE_REVIEW.md).

## Pendientes del punto 1

- Completar el diseño e integrar la ceremonia visible desde un dispositivo confiable: canal SAS con sesión autorizante exacta y promoción atómica con caducidad, revocación y protección contra repetición. La reserva/revisión ya implementadas y el panel aislado no terminan ese recorrido.
- Conectar la verificación visible de identidades y advertencias de cambios con la política de confianza del interlocutor. Fijar la identidad propia inicial no acredita automáticamente la identidad del otro participante.
- Probar esos recorridos completos entre navegadores y la API autenticada, incluyendo suspensión, revocación, carreras y reinicios. Las pruebas actuales de SDK y PostgreSQL son separadas.
- Mantener cerrados el registro de dispositivos adicionales y el gate hasta completar las garantías y revisiones pendientes.

La recuperación E2EE corresponde al punto 2 y no se implementó en esta tanda. Tampoco se añadió exportación/importación de secretos ni un endpoint de reset de identidad.

El orden y las diferencias de solicitudes se verificaron en `node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm.d.ts` de la versión 18.6 y en las pruebas locales. El contrato público del contenedor se documenta en [Matrix Rust Crypto, solicitudes de bootstrap](https://matrix-org.github.io/matrix-sdk-crypto-wasm/classes/CrossSigningBootstrapRequests.html); para cambios de versión debe prevalecer la comprobación del paquete fijado y sus pruebas.

## Evidencia local

`matrix-cross-signing.test.ts` cubre 49 casos con solicitudes públicas del SDK real,
reintento, esquemas y codificaciones. `matrix-cross-signing-adversarial.test.ts`
añade 26 casos con claves Ed25519 generadas independientemente, firmas adversariales,
sustitución de identidades y puntos débiles. `matrix-ed25519-validation.test.ts`
añade 18 regresiones para claves y puntos `R` débiles, no canónicos o inválidos,
incluyendo alta y reposición de claves. Esos 93 casos del validador se documentan
en la [validación local del 10 de septiembre](VALIDATION_2026-09-10.md).

La integración añade 28 pruebas unitarias del servicio y seis de distribución
autorizada. La suite web añade 26 casos con SDK real y transporte sintético:
primer bootstrap, reintentos, concurrencia serializada, aborto, respuestas
hostiles, claves ausentes y confianza del dispositivo propio. No exporta secretos.
`npm.cmd run check:cross-signing-db` prueba por separado los servicios y las
restricciones con PostgreSQL real en una base exclusiva que elimina al terminar,
tras verificar nombre, OID y propietario. Rechaza producción y URLs remotas.
Alcance y resultados en la [validación del 11 de septiembre](VALIDATION_2026-09-11.md).
