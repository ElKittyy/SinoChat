# Perfil de eventos SAS para cuarentena

Estado: **perfil público y admisión persistente implementados; entrega y ceremonia completa pendientes**.
Es parte del punto 1 de [autorización de dispositivos](DEVICE_APPROVAL.md).
La admisión añade una ruta protegida y una tabla de cuarentena, sin permisos
operativos, aprobación ni recuperación de claves.
El gate continúa compilado `BLOCKED`.

## Contrato implementado

[`parseMatrixSasToDeviceRequest`](../apps/api/src/e2ee/matrix-sas-to-device.ts)
recibe tipo de evento, identificador del envío HTTP, cuerpo exacto `{ messages }`
y un contexto esperado: usuario Matrix propio, dispositivos emisor/destinatario,
flujo SAS ya vinculado y master pública fijada. El futuro servicio debe obtener
ese contexto de sus controles y registros autenticados, nunca copiarlo del cuerpo
para aparentar una comprobación. La primera solicitud tiene la frontera de
admisión separada descrita a continuación.

Solo admite un destinatario: el dispositivo esperado de la misma cuenta. No
admite comodines, grupos, salas, usuarios adicionales, mensajes ordinarios,
solicitudes/respuestas de secretos ni claves de conversación. El endpoint de
conversaciones sigue aceptando exclusivamente su perfil Olm previo; no llama
a este validador para ampliar tipos.

La salida es una copia congelada con evento, ID HTTP, flujo, emisor, destinatario,
messages y hash canónico. El hash incluye tipo, ID HTTP, emisor, master fijada y
messages (con destinatario/flujo). No autentica por sí mismo el paquete ni evita
replay por sí mismo. La admisión ya conserva el request inicial y su hash;
almacenamiento, deduplicación y entrega del resto de eventos siguen pendientes.

## Admisión del request inicial

[`MatrixDeviceVerificationService`](../apps/api/src/e2ee/matrix-device-verification.service.ts)
acepta únicamente un `m.key.verification.request` iniciado desde el bootstrap
confiable y dirigido al candidato propio reservado. Esa dirección ya está
caracterizada con dos máquinas SDK nuevas, tanto al completar como al cancelar.
No está integrada al navegador ni constituye una prueba SDK→HTTP→SDK.

Ruta relativa a `/api/e2ee/matrix/device-verification-flows`:
`PUT /:candidateId/:flowId/:transactionId`, cuerpo exacto `{ messages }` original
del SDK, cinco peticiones/minuto, sesión, rol CLIENT/CASHIER, CSRF y gate
compilado. El handler declara `Cache-Control: no-store`. La respuesta contiene
solo `candidateId`, `flowId`, `state: PENDING`, `createdAt` y `expiresAt`.
No existe aún GET de entrega ni endpoint de aceptación, consumo o aprobación.

En esta frontera el `flowId` es explícitamente una propuesta no confiable del
SDK y debe coincidir con `content.transaction_id`. No se finge que ya estaba
vinculado. El usuario, emisor bootstrap, destinatario y master fijada proceden
de registros propios bloqueados en PostgreSQL. Se reconstruye también el
snapshot original del candidato y se vuelve a verificar su autofirma/hash.

La migración `20260913000000_matrix_device_verification_flow` crea
`MatrixDeviceVerificationFlow`, separada de `Device`. Conserva candidato,
propietario, flujo, sesión revisora exacta y versión, ID del envío, contenido
request, hash y fechas. La sesión solicitante, pin y claves ya están fijados
en el candidato al que referencia. Otra sesión del mismo bootstrap puede
descartar el candidato, pero no heredar el flujo iniciado por la primera.

La unicidad es histórica, incluso tras cancelar o vencer: un flujo por
candidato, un `flowId` por propietario y un ID de envío por propietario. Este
último ámbito es deliberadamente conservador mientras solo existe un bootstrap
por cuenta. No hay UPDATE de contenido/contexto ni DELETE de tombstones. Su
compactación requiere una política posterior que preserve la protección contra
reutilización. No contienen mensajes, fotos ni claves privadas.

Orden de bloqueos: conjunto de dispositivos por usuario → cuenta/elegibilidad
→ sesión revisora y bootstrap → candidato → sesión solicitante → flujo.
El reloj se obtiene después de las esperas; al crear se vuelve a comprobar antes
de finalizar. Ambas sesiones deben continuar vigentes, con versión actual; la
solicitante permanece sin dispositivo y el bootstrap sigue activo/certificado.

El request admite como máximo diez minutos de antigüedad y cinco de adelanto,
conforme al [criterio temporal de Matrix](https://spec.matrix.org/v1.18/client-server-api/#mkeyverificationrequest).
La expiración fijada es el mínimo entre reserva, ambas sesiones, suscripción,
diez minutos desde el reloj PostgreSQL y `timestamp + diez minutos`. Un plazo
vacío se rechaza; adelantar el reloj del cliente nunca amplía límites del
servidor. El replay exacto devuelve las fechas originales y revalida autoridad.

Cancelar/rechazar/expirar el candidato terminaliza atómicamente el flujo. El
trigger espera su lock antes de clasificar `EXPIRED` o `CANCELLED`. Si una nueva
apertura observa el flujo vencido, descarta también su candidato y conserva
esa resolución aunque responda 409. Un nuevo intento necesita nueva reserva y
nuevos IDs. La terminalización SQL de mantenimiento no requiere sesiones vivas;
los endpoints sí revalidan a su llamante. Los consumidores futuros deben
comprobar ambos estados, sesiones y plazos, nunca solo `flow.status`.

SQL valida forma y relaciones; la aplicación calcula el hash canónico. La
admisión no prueba entrega, posesión de claves, comparación humana, MAC ni
aprobación. Un cliente futuro no debe hacer ACK del SDK como si este PUT ya
implementara un relay: todavía no hay recepción/entrega del request.

Se reconstruyen los contenedores mediante descriptores. No se ejecutan getters,
proxies, conversiones personalizadas ni `toJSON`; se rechazan campos ocultos,
símbolos, prototipos ajenos y arrays dispersos o con propiedades adicionales.
Se valida antes de serializar y se limita el cuerpo reconstruido a 8 KiB.

## Perfil observado y probado en SDK 18.6.0

Todos los contenidos incluyen `transaction_id`. Los demás campos exactos son:

| Evento `m.key.verification.*` | Campos adicionales |
| --- | --- |
| `request` | `from_device`, `methods`, `timestamp` |
| `ready` | `from_device`, `methods` |
| `start` | `from_device`, `hashes`, `key_agreement_protocols`, `message_authentication_codes`, `method`, `short_authentication_string` |
| `accept` | `commitment`, `hash`, `key_agreement_protocol`, `message_authentication_code`, `short_authentication_string` |
| `key` | `key` |
| `mac` | `keys`, `mac` |
| `done` | Ninguno |
| `cancel` | `code`, `reason` |

`request` y `ready` solo admiten `m.sas.v1`. `start` exige ese método, SHA-256,
`curve25519-hkdf-sha256` y presentación decimal (emoji opcional). Las ofertas
MAC pueden incluir las tres emitidas por el SDK:

```text
hkdf-hmac-sha256
hkdf-hmac-sha256.v2
org.matrix.msc3783.hkdf-hmac-sha256
```

La oferta debe incluir v2. `accept` exige exclusivamente v2, SHA-256,
`curve25519-hkdf-sha256` y decimal; no incluye `method` en este SDK.
No se agregan ni eliminan campos o algoritmos para hacer pasar un mensaje.
Se preserva el orden de las listas: el SDK verifica el compromiso sobre el
contenido original. El servidor no decide que una negociación ocurrió
simplemente porque dos mensajes aislados son válidos.

Esto es un perfil cerrado de SinoChat, no compatibilidad con toda extensión o
versión de Matrix. La norma describe la negociación SAS y exige preferir MAC v2
cuando ambos extremos lo soportan; el MAC antiguo tiene un problema de
codificación. Véanse [SAS](https://spec.matrix.org/v1.18/client-server-api/#short-authentication-string-sas-verification)
y [cálculo MAC](https://spec.matrix.org/v1.18/client-server-api/#mac-calculation).

## Identificadores, claves y cancelación

`ToDeviceRequest.id` y `txn_id` coinciden en el SDK instalado: identifican un
envío y su ACK. `content.transaction_id` identifica la comparación completa.
El validador no exige igualdad ni desigualdad entre esos espacios. Ambos deben
respetar el perfil local de 1–255 caracteres ASCII alfanuméricos o `._~-`.

Compromiso, clave efímera y valores MAC requieren 32 bytes, Base64 estándar
canónica sin padding (43 caracteres). `key` es la clave Curve25519 efímera SAS,
no la clave persistente de dispositivo y no un punto Ed25519. El validador
comprueba codificación, **no posesión, compromiso ni autenticidad MAC**.

El mapa MAC requiere `ed25519:<dispositivo emisor>` y admite únicamente la
master pública fijada como segunda entrada. La fixture inicial observa ambas
en el dispositivo confiable y solo la propia en el candidato. El parser no
deduce posesión de la clave privada master a partir de un MAC sobre su clave
pública; la política del flujo completo sigue pendiente.

`cancel` admite los códigos estándar del framework/SAS y un diagnóstico SDK
de hasta 512 bytes UTF-8, sin controles ni UTF-16 incompleto. Ese `reason` no es
un motivo que deba escribir el usuario. No debe registrarse ni mostrarse como
texto confiable. Limitar un diagnóstico no permite demostrar que alguien nunca
codificó información sensible dentro de una cadena: se excluyen campos y tipos
de secretos, no todos los posibles canales encubiertos.

## Límites que todavía faltan

- Reutilizar la vinculación persistente de admisión al recibir cada evento;
  nunca admitir contexto autodeclarado ni otra sesión del mismo dispositivo.
- Extender los controles de cuenta, suscripción, sesiones, dispositivo y reloj
  de la admisión a todas las operaciones del futuro canal.
- Mantener negociación, orden, estado terminal y consumo único. Un `done`
  estructuralmente válido no es confirmación humana ni promoción autorizada.
- Persistir y entregar eventos solo a ese par, con reintentos idénticos,
  conflicto ante ID reutilizado con otro contenido, cuotas y limpieza.
- Integrar ACK HTTP real, reanudación del navegador y SAS del SDK sin regenerar
  raíz, exportar secretos o permitir el transporte operativo al candidato.

## Evidencia

[`matrix-sas-to-device.test.ts`](../apps/api/src/e2ee/matrix-sas-to-device.test.ts)
usa dos máquinas nuevas de Matrix mediante una
[fixture aislada](../apps/api/src/e2ee/testing/matrix-sas.fixture.ts). Cada evento
emitido se valida antes de entregarlo al otro SDK. Se comprueba finalización
local con confirmaciones sintéticas y cancelación por usuario, timeout y
comparación discrepante. No se publican certificados ni se transportan secretos;
el candidato permanece sin claves privadas de cross-signing.

También hay pruebas de entradas malformadas, aislamiento, codificación,
inmutabilidad y de que el parser operativo anterior rechaza todos los tipos SAS.
Estas pruebas del perfil no certifican UI humana, sesiones HTTP/DB, negociación
persistida, orden adverso completo ni recuperación tras reinicios. La evidencia
inicial está en la [validación del 13 de septiembre](VALIDATION_2026-09-13_SAS_PROFILE.md).
La admisión tiene suites separadas de servicio, HTTP con gate cerrado y
PostgreSQL desechable, documentadas en la
[validación del 16 de septiembre](VALIDATION_2026-09-16_SAS_ADMISSION.md).
