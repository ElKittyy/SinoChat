# Autorización de un dispositivo adicional

Estado: **reserva, revisión y admisión de un flujo SAS implementadas; entrega y ceremonia completa pendientes; alta adicional no habilitada**. Es parte del punto 1, identidad y autorización de dispositivos. No define recuperación E2EE, sustitución de la raíz ni acceso administrativo a secretos. Estas piezas y la caracterización del SDK no equivalen a una ceremonia completa. Resultados de la vinculación de sesiones en la [validación del 16 de septiembre](VALIDATION_2026-09-16_SAS_ADMISSION.md); el panel continúa aislado.

El gate compilado sigue en `BLOCKED`. Este documento no autoriza a retirar la restricción de un único dispositivo histórico, crear un segundo `Device`, publicar sus claves, vincular su sesión o entregarle mensajes.

## Problema que debe resolver

Una sesión autenticada con usuario y contraseña demuestra acceso a la cuenta, no posesión de sus claves E2EE. La autorización de otro navegador debe proceder de un dispositivo propio confiable y de una comprobación visible entre ambos extremos. El administrador no puede sustituir esa aprobación mediante un cambio de contraseña.

Los participantes de una solicitud son exactamente:

- El usuario CLIENT o CASHIER propietario de la identidad existente.
- Una sesión solicitante de ese usuario, vigente y todavía sin dispositivo vinculado, que conserva localmente las claves privadas del candidato.
- Un dispositivo aprobador activo del mismo usuario, con certificado correspondiente a la raíz fijada y claves locales que permitan completar la verificación. Su sesión también debe estar vigente.

No participan ADMIN, el cajero o cliente interlocutor, otro usuario ni un dispositivo revocado. Un identificador de solicitud, un enlace o una huella pública no otorgan permisos por sí mismos.

## Restricciones actuales que deben permanecer

| Evidencia local | Consecuencia |
| --- | --- |
| [`matrix-key-directory.service.ts`](../apps/api/src/e2ee/matrix-key-directory.service.ts), `reserveDevice` y `completeInitialUpload` | El alta inicial rechaza historial previo. Su finalización crea el dispositivo activo, publica claves y preclaves, crea cursor, emite cambios y vincula la sesión; no sirve como cuarentena. |
| [`schema.prisma`](../apps/api/prisma/schema.prisma), `Device` y `AuthSession` | Un `Device` nace `ACTIVE` y forma parte del modelo operativo de directorio, mensajes y sincronización. |
| [Migración de vinculación de dispositivos](../apps/api/prisma/migrations/20260727011000_device_binding_hardening/migration.sql), `devices_one_historical_device_per_user_key` | La base impide una segunda fila de dispositivo, incluso si el primero se revocó. |
| [Migración de cross-signing](../apps/api/prisma/migrations/20260910000000_matrix_cross_signing_identity/migration.sql), `sinochat_validate_matrix_device_cross_signing` | Solo puede persistirse el certificado del dispositivo de bootstrap. |
| [`matrix-cross-signing.service.ts`](../apps/api/src/e2ee/matrix-cross-signing.service.ts) | La publicación inicial requiere el único dispositivo histórico y no ofrece aprobación ni reset. |
| [`matrix-to-device.ts`](../apps/api/src/e2ee/matrix-to-device.ts), `parseMatrixToDeviceRequest` | El transporte HTTP actual solo admite `m.room.encrypted`; la enumeración de tipos de verificación en SQL no habilita esos tipos en la aplicación. |
| [`matrixCrossSigning.ts`](../apps/web/src/e2ee/matrixCrossSigning.ts) | El inicializador es exclusivo del dispositivo inicial y rechaza un pin remoto cuando faltan los secretos locales. |

No basta añadir `PENDING` al enum de `Device`: eso exigiría revisar todos sus consumidores y restricciones antes de garantizar que el candidato queda excluido. La implementación de reserva mantiene la cuarentena fuera de esas tablas operativas.

## Reserva de cuarentena implementada

`MatrixDeviceCandidate` reserva el UUIDv4 del candidato sin crear un `Device` ni reutilizar `MatrixDeviceRegistration`, cuya finalización está diseñada para el primer dispositivo. El navegador propone el UUID en la ruta; el servidor deriva los identificadores Matrix y exige que no exista en las tablas operativas o de registro inicial.

La fila contiene:

- UUID del candidato, que identifica esta reserva, con namespace Matrix derivado por el servidor. No constituye un secreto ni una autorización.
- Propietario, sesión solicitante y versión de sesión esperada.
- Referencia a la identidad ya fijada, su hash de bootstrap, el dispositivo inicial confiable y las claves públicas inmutables del candidato, con autofirma verificada y hash canónico.
- Creación y caducidad calculadas con reloj PostgreSQL: máximo diez minutos, acotados también por la sesión y suscripción.
- Estado `PENDING`, `CANCELLED` o `EXPIRED` y fecha de resolución. No hay estado aprobado o consumido ni nonce de ceremonia inventado. El flujo inicial y la sesión revisora exacta se fijan ahora en una fila separada `MatrixDeviceVerificationFlow`.

La admisión ya liga un `flowId` propuesto por el SDK a la reserva y ambas sesiones. Su relación con una prueba autorizante de la ceremonia completa sigue pendiente. Un identificador almacenado por el servidor no constituye, por sí solo, prueba de aprobación ni de posesión de claves. No se deben añadir campos arbitrarios al protocolo Matrix para aparentar que existe esa prueba.

La reserva no publica preclaves, eventos `CHANGED`, cursores, firmas en el directorio operativo ni referencias de sesión a dispositivo. No permite `keys/query`, `keys/claim`, `sync`, envío o lectura de conversaciones. Sus datos no deben entrar en la selección normal de destinatarios de mensajes.

En las rutas de la sesión solicitante, solo la sesión original, vigente y todavía sin dispositivo vinculado puede consultar o cancelar su reserva. Otra sesión sin vínculo tampoco hereda el acceso. ADMIN y otros usuarios quedan excluidos también en el servicio, no únicamente en el controlador. El dispositivo confiable dispone ahora de las rutas separadas de revisión descritas abajo; el canal limitado de verificación aún no está implementado.

Las rutas de `MatrixDeviceCandidatesController` están bajo `SessionAuthGuard`, roles CLIENT/CASHIER y `E2eeReleaseGuard`; las mutaciones conservan el CSRF global. Todas siguen bloqueadas en ejecución normal por el gate compilado.

| Ruta relativa a `/api/e2ee/matrix/device-candidates` | Contrato |
| --- | --- |
| `PUT /:candidateId` | Exactamente `{ device_keys }`, solo autofirma y claves públicas; cinco peticiones/minuto |
| `GET /:candidateId` | Metadatos de estado/fechas/identificadores de la reserva propia; treinta/minuto |
| `POST /:candidateId/cancel` | Cancela sin motivo ni credenciales nuevas; diez/minuto |

`parseMatrixDeviceCandidate` reconstruye los contenedores por descriptores antes de verificar la autofirma; rechaza getters, proxies, campos ocultos, arrays dispersos, preclaves, raíces y secretos. Congela la copia y calcula su hash canónico completo. No devuelve material de dispositivo ni pin en el estado HTTP.

Un índice parcial exige una sola fila `PENDING` por usuario; esto limita ceremonias simultáneas, no el número comercial de dispositivos ni clientes. El índice no contiene un reloj: el servicio expira explícitamente las reservas anteriores bajo el mismo lock. Las filas terminales quedan como registros contra reutilización del ID; su política de compactación/retención está pendiente y no debe resolverse borrándolas sin otro mecanismo antirrepetición. No contienen mensajes, fotografías, tokens ni claves privadas.

La migración `20260912000000_matrix_device_candidate_quarantine` valida forma pública, propietario, sesión real sin vínculo, versión, pin, dispositivo inicial activo y elegibilidad de cajero en inserción. Impide modificar el snapshot, fechas o reabrir/eliminar filas terminales. Las transiciones de mantenimiento no exigen que la sesión siga vigente; los endpoints sí revalidan al llamante. SQL verifica forma y relaciones; las firmas y hashes los comprueba la aplicación.

La unicidad parcial y los bloqueos siguen los mecanismos de [PostgreSQL 17, índices parciales](https://www.postgresql.org/docs/17/indexes-partial.html) y [bloqueos explícitos](https://www.postgresql.org/docs/17/explicit-locking.html). Las pruebas reales observan ambos trabajadores esperando antes de liberarlos; no infieren concurrencia de dos llamadas que podrían ejecutarse secuencialmente.

## Revisión desde el dispositivo confiable

`MatrixDeviceCandidateReviewService` permite consultar o descartar solicitudes propias únicamente desde una sesión CLIENT/CASHIER vinculada al dispositivo inicial confiable. Ese dispositivo debe seguir activo, con protocolo Matrix, directorio original y certificado existentes, y corresponder al bootstrap fijado de la cuenta. Un ID conocido o una sesión sin dispositivo no bastan; ADMIN tampoco participa.

| Ruta relativa a `/api/e2ee/matrix/device-candidate-reviews` | Contrato |
| --- | --- |
| `GET /` | `{ pending: metadatos \| null }`, una solicitud como máximo; treinta/minuto |
| `GET /:candidateId` | Metadatos y `deviceKeys` originales públicos, solo si sigue disponible; diez/minuto |
| `POST /:candidateId/reject` | `{ candidateId, state: CANCELLED \| EXPIRED }`, sin motivo; diez/minuto |

Las tres rutas conservan sesión, roles y gate compilado; el POST conserva CSRF global. Responden con `Cache-Control: no-store`. No exponen tokens, IDs de sesiones, hash del pin, secretos ni claves de conversaciones. El detalle reconstruye una copia pública congelada y vuelve a verificar autofirma, hash y ambas claves contra el snapshot almacenado; no entrega un certificado de aprobación.

La transacción comparte el lock de dispositivos, bloquea la cuenta, elegibilidad de cajero y sesión/dispositivo revisor. Selecciona y bloquea el candidato por propietario y dispositivo confiable antes de cargar sus claves. Para presentarlo como disponible exige además que la sesión solicitante original continúe sin vínculo, sin revocación, con versión y plazo vigentes; la bloquea y comprueba el reloj tras leer/verificar el snapshot. La sesión revisora y su suscripción se revalidan antes de confirmar la operación.

No disponible devuelve `pending: null` o un 404 genérico en detalle, sin indicar si pertenece a otra cuenta. La caducidad observada se persiste como EXPIRED y ese 404 se genera después del commit, para no revertirla. Si la sesión solicitante pierde vigencia antes del plazo de la reserva, esta no se presenta como disponible; puede permanecer PENDING hasta caducar o ser descartada. La sesión confiable que ya conoce su ID puede descartarla incluso después del logout del solicitante: es una denegación, no una concesión de autoridad.

Descartar es idempotente y no modifica snapshot, plazo, sesión, directorio ni dispositivos. Una sesión revisora revocada no puede hacerlo. Distintas sesiones vigentes del mismo dispositivo inicial pueden revisar/descartar; hacerlo no reclama la ceremonia. La admisión SAS separada sí fija la sesión revisora exacta y rechaza que otra la sustituya.

Consultar no demuestra posesión de las claves privadas, no establece confianza local del SDK, no inicia un flujo SAS y no concede acceso a conversaciones. Estas rutas aún no están conectadas al panel de incorporación del navegador y siguen bloqueadas en ejecución normal.

## Vigencia, reintentos y cancelación

La reserva de cuarentena tiene un máximo de diez minutos, acotado por sesión y suscripción. La admisión del flujo también queda limitada por ambas sesiones, la reserva y el timestamp original del SDK; el plazo más corto prevalece. Las futuras operaciones de la ceremonia deben respetar ese límite, nunca extender un flujo vencido.

Las operaciones de reserva se serializan por usuario, compartiendo el lock de dispositivos. Bloquean usuario, elegibilidad de cajero, sesión solicitante y dispositivo inicial confiable; releen estado ACTIVE, rol, versión, reset y caducidad. Se usa un reloj nuevo antes del commit y la creación que vence durante I/O se revierte. La admisión añade la vinculación a la sesión revisora sin convertirla en aprobación.

Las reglas previstas son:

- Un reintento con los mismos identificadores y contenido público devuelve la misma solicitud y conserva la fecha original de vencimiento.
- Cambiar claves, raíz, propietario, sesión o contenido bajo el mismo identificador devuelve conflicto; no actualiza silenciosamente el candidato.
- Cancelar o expirar impide reabrir esta reserva. La consulta que observa caducidad la persiste como terminal, para que retroceder el reloj no la reactive; ese GET puede escribir únicamente esa expiración de mantenimiento. Reabrir requiere otro UUID y, en el futuro, otra ceremonia.
- Revocar cualquiera de las sesiones involucradas, cambiar su versión, suspender la cuenta o revocar el dispositivo aprobador invalida la autorización pendiente.
- Una solicitud consumida no puede autorizar otro dispositivo ni producir una segunda publicación o evento. El resultado de un reintento debe permanecer sujeto a autorización vigente; la idempotencia no es un bypass de sesión.
- Una nueva sesión obtenida después de restablecer la contraseña no hereda la solicitud ni una autorización anterior.

La terminalización periódica de solicitudes vencidas es mantenimiento, no el mecanismo de seguridad: todos los accesos comprueban la caducidad aunque la fila siga existiendo. No se eliminan los registros antirrepetición sin una política que preserve esa garantía.

## Certificado no significa aprobación

Un certificado cross-signing válido demuestra que la clave `self_signing` firmó el objeto público de un dispositivo. Su relación con la raíz depende de que el servidor ya haya validado y fijado el triplete completo. El nuevo `parseMatrixDeviceCertificate` no vuelve a autenticar esa cadena a partir del certificado aislado. Tampoco demuestra cuándo se autorizó el dispositivo ni que una persona confirmó una comparación en pantalla.

La declaración local del SDK, [`matrix_sdk_crypto_wasm.d.ts`](../node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm.d.ts), documenta que `Device.verify()` devuelve una `SignatureUploadRequest` para un dispositivo propio. El objeto de claves firmado no contiene el identificador, nonce, caducidad ni contexto de sesión de una solicitud de SinoChat. Por tanto, una firma válida puede verificarse independientemente de una solicitud vigente.

Un validador puro de ese certificado no debe convertirse en un endpoint `approve` que active el candidato únicamente por recibirlo. Tampoco basta recibir `confirmed: true`, comprobar una cookie del dispositivo aprobador o asumir consentimiento porque el certificado existe. La promoción necesitará una vinculación verificable con la ceremonia exacta, la posesión de las claves y la autorización vigente.

El mecanismo final de esa vinculación sigue pendiente. La existencia de `OlmMachine.sign()` tampoco acredita por sí misma interacción humana: permite firmar con la clave de dispositivo y, cuando está disponible, la raíz master. No debe utilizarse para inventar un protocolo de verificación alternativo al SDK sin diseño y pruebas específicos.

## SAS del SDK: caracterización local ejecutada

[`characterize-matrix-device-approval.mjs`](../apps/web/scripts/characterize-matrix-device-approval.mjs) ejecuta dos máquinas independientes de Matrix Rust Crypto 18.6.0 en memoria. Distingue la firma directa `Device.verify()` de la verificación interactiva `requestVerification` / `startSas`, y ejercita el controlador real en el caso SAS positivo. Sus 15 pruebas no usan HTTP, base de datos ni claves de usuarios reales.

Lo comprobado:

- La firma directa del candidato contiene solo el nuevo certificado `self_signing` y no incorpora la autofirma original. Es repetible y no prueba consentimiento. Su `SignatureUploadRequest` no tiene `id`; no se inventa un ACK.
- El recorrido SAS usa `request`, `ready`, `start`, `accept`, `key`, `mac`, `done` y `cancel`. El relay limita participantes y flujo, valida los reintentos y no transporta mensajes ni secretos.
- El controlador muestra valores reales del SDK, exige confirmación explícita simulada en ambos extremos y espera al par; solo después del intercambio y la consulta se comprueba la confianza propia y en el dispositivo remoto. Los valores no se imprimen.
- El dispositivo candidato puede verificar la identidad propia sin poseer las tres claves privadas de cross-signing. Tener únicamente un certificado no había bastado para marcar esa identidad como verificada.
- La firma de dispositivo producida por SAS se encola con `id` y se confirma tras la publicación sintética. No se exige una firma candidato→raíz que este recorrido no emitió. `OwnUserIdentity.verify()` sí se caracteriza separadamente; no se usa como atajo de consentimiento en SAS.
- Confirmación unilateral, cancelación, compromiso o MAC alterados y flujo ajeno no completan la aprobación local. El SDK puede encolar `m.secret.request` tras verificar: el relay no lo envía ni lo confirma.

Quedan pendientes el transporte real de cuarentena, toda la matriz de reordenamiento/reconexión y el vínculo transaccional con las sesiones. La secuencia observada debe volver a probarse si cambia la versión fijada del SDK; no es una promesa de interoperabilidad general.

Mostrar la misma huella recibida del servidor en dos pantallas no establece un canal independiente contra sustitución del servidor. Una futura comparación manual o QR debe estar vinculada al material verificado y al flujo auténtico. La selección y experiencia de QR no están implementadas ni resueltas por este documento.

Una prueba SAS en memoria solo caracteriza el SDK. No prueba la UI humana, un canal autenticado desplegado, persistencia entre reinicios, aislamiento de navegador ni la aplicación de las reglas de autorización en PostgreSQL.

## Controlador y pantalla aislados

[`MatrixSasComparison`](../apps/web/src/e2ee/matrixSasComparison.ts) recibe un SAS ya iniciado; no inicia la solicitud ni publica certificados. Todas las operaciones del SDK deben compartir la cola exclusiva de su `OlmMachine`. El transporte inyectado debe resolver únicamente tras éxito HTTP validado y ACK real; la ruta `to-device` de conversaciones existente no sirve para estos eventos de cuarentena.

El controlador fija propietario, ambos dispositivos y flujo en cada operación. Emite un recibo efímero asociado a los valores mostrados y lo consume antes de confirmar; valores distintos o un doble clic no reutilizan consentimiento. Usa límite inclusivo de pared y reloj monotónico, `timedOut()` del SDK y un temporizador que aborta I/O. Cancelar interrumpe una confirmación en curso antes de esperar la cola. Error, cierre y vencimiento cancelan localmente el flujo cuando todavía está vivo; cierre libera el handle una sola vez. No envía desde una sesión cerrada. Un navegador suspendido requiere revalidar al reanudarse; el temporizador no sustituye la caducidad del servidor ni el timeout HTTP.

El límite local de diez minutos corresponde al máximo aceptado para esta fase, no implementa el plazo completo de la solicitud inicial. Las reglas del protocolo y el formato decimal están documentados en [Matrix 1.18, SAS](https://spec.matrix.org/v1.18/client-server-api/#short-authentication-string-sas-verification). El SDK deriva los valores; SinoChat no implementa su criptografía.

[`SasComparisonPanel`](../apps/web/src/components/SasComparisonPanel.tsx) presenta tres grupos numéricos en español y una casilla explícita, además de rechazar o cancelar. Cambiar el recibo o los números reinicia la casilla. No confirma desde un efecto, oculta valores en estados terminales y muestra errores genéricos. Importa solo el tipo del controlador: no carga SDK, red ni almacenamiento. Sus 19 comprobaciones en Chrome usan vistas y callbacks sintéticos; las 40 del controlador usan un puerto SDK controlable. Son evidencias complementarias, no una prueba integral entre dos pantallas reales.

`comparison-complete` significa únicamente que la comparación local terminó; la pantalla aclara que el alta sigue pendiente. Ninguna de estas piezas está montada en `App`, conectada al lifecycle de incorporación o habilitada para activar dispositivos.

## Perfil público del futuro canal SAS

El [validador de eventos de cuarentena](MATRIX_SAS_TRANSPORT.md) ya comprueba
envoltura, par propio, flujo esperado, algoritmos, claves/MAC codificados y
campos exactos, con copia inmutable. Las 118 pruebas incluyen eventos
de dos máquinas reales del SDK, confirmaciones sintéticas y cancelaciones.
El parser puro no es un relay ni verifica criptografía MAC, sesiones, plazos
o aprobación. Su nuevo servicio de admisión registra solo el request inicial
bootstrap→candidato, liga ambas sesiones y aplica límites temporales bajo locks.
Cancelar el candidato invalida también ese flujo; ninguno concede permisos.
Las rutas de conversaciones no admiten SAS. Contrato completo y límites en
[MATRIX_SAS_TRANSPORT](MATRIX_SAS_TRANSPORT.md).

## Rama nueva del navegador, sin regeneración de identidad

El candidato posee sus propias claves de dispositivo, pero no debe suponerse que conserva las claves privadas master, `self_signing` y `user_signing` de la cuenta. Un certificado tampoco le entrega esas claves ni sesiones Megolm históricas.

La rama actual de [`matrixSessionLifecycle.ts`](../apps/web/src/e2ee/matrixSessionLifecycle.ts) finaliza el alta inicial y ejecuta `initializeMatrixCrossSigning` antes de iniciar el transporte. No puede utilizarse sin cambios como alta de un dispositivo adicional.

La rama futura de incorporación debe permanecer en cuarentena mientras verifica la identidad existente y el certificado del candidato con el SDK. **No debe invocar `bootstrapCrossSigning(false)` en el candidato sin los secretos de la raíz existente**: no es una operación de incorporación ni una manera segura de aceptar el pin remoto. Tampoco debe utilizar `bootstrapCrossSigning(true)`, marcar confianza local automáticamente o desactivar la comprobación que hoy falla cerrado.

La caracterización SAS demuestra confianza local sin regenerar la raíz, pero falta implementar y probar la rama persistente que habilite operar al candidato después de la promoción real. Este trabajo no autoriza exportación/importación de secretos, recuperación administrativa ni entrega retroactiva del historial: la recuperación E2EE continúa en el punto 2.

## Promoción atómica futura

Solo cuando exista la ceremonia completa podrá diseñarse una transición de cuarentena a dispositivo operativo. En una única transacción deberá:

1. Bloquear la solicitud y el conjunto de dispositivos, comprobar vigencia, consumo, ambas sesiones, usuario y dispositivo aprobador.
2. Verificar el mismo pin y las mismas claves inmutables que participaron en la ceremonia, junto con su resultado de autorización vinculante y certificado público.
3. Crear el dispositivo, directorio y certificado, publicar las preclaves que correspondan y crear el cursor, sin estados parcialmente visibles.
4. Vincular exclusivamente la sesión solicitante autorizada, consumir la solicitud y emitir una sola actualización de lista de dispositivos.
5. Revalidar los plazos antes del commit y revertir todo ante una condición inválida.

Esto requiere un diseño SQL posterior que sustituya las restricciones de dispositivo inicial por invariantes equivalentes para dispositivos aprobados. No se deben retirar esas restricciones anticipadamente para facilitar pruebas. La entrega de credenciales de vinculación y el reintento después de una respuesta perdida también requieren un contrato probado que no conceda permisos a otra sesión.

## Qué queda después de caracterizar el SDK

- Definir y revisar la vinculación entre solicitud, flujo de verificación, claves exactas, resultado y promoción; un certificado aislado no la resuelve.
- Completar recepción, entrega, negociación, orden y deduplicación del canal SAS usando las sesiones ya fijadas por la admisión. Registrar el primer request no entrega eventos ni autoriza dispositivos.
- Integrar el panel y controlador aislados en ambos dispositivos y construir la rama local persistente de incorporación, con reinicios, varias pestañas y pérdida de conectividad.
- Implementar la promoción transaccional y sus restricciones SQL; probar carreras con revocación, suspensión, expiración, reintento y solicitud consumida en PostgreSQL real.
- Probar que el candidato pendiente nunca aparece en directorios ni recibe claves o mensajes, y que ADMIN y terceros no pueden aprobar ni consultar sus solicitudes.
- Verificar la confianza bidireccional y la identidad del interlocutor con pruebas de navegador y revisión de seguridad antes de considerar cerrado el punto 1.

Hasta completar esas piezas, la autorización de dispositivos adicionales sigue pendiente y el gate no cambia.
