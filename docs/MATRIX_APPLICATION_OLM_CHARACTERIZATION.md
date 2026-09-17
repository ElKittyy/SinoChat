# Caracterización histórica de Olm para mensajes de aplicación

- Fecha: 2026-08-30
- SDK probado: `@matrix-org/matrix-sdk-crypto-wasm` 18.6.0
- Estado: evidencia histórica; ADR-002 reemplazó Olm para contenido ordinario

## Alcance

Esta prueba evaluó la decisión original de ADR-001: un sobre Olm individual por
dispositivo para cada mensaje. [ADR-002](ADR-002-MEGOLM_APPLICATION_MESSAGES.md)
la reemplazó por Megolm para contenido ordinario. Olm continúa vigente para
distribuir room keys y eventos de control mediante `to-device`; los resultados
de interoperabilidad y replay siguen siendo evidencia útil para esa capa.

El checker `apps/web/scripts/characterize-matrix-application-olm.mjs` levanta
tres `OlmMachine` reales en memoria (dos dispositivos de una misma cuenta y un
dispositivo de la contraparte), intercambia publicaciones de dispositivo,
ejecuta `keys/query` y `keys/claim`, cifra con
`Device.encryptToDeviceEvent` y descifra con `receiveSyncChanges`.

## Resultados confirmados

1. La interoperabilidad A a B funciona después de publicar las claves, conocer
   el dispositivo destinatario y confirmar una OTK con
   `markRequestAsSent`. El orden de cifrado y entrega para cada par de
   dispositivos debe permanecer serializado.
2. El contenido exterior emitido por la version fijada contiene exactamente
   `algorithm`, `ciphertext`, `sender_key` y `org.matrix.msgid`. El ultimo es un
   identificador hexadecimal aleatorio de 32 caracteres. El algoritmo es
   `m.olm.v1.curve25519-aes-sha2` y hay un unico ciphertext dirigido a la clave
   Curve25519 del dispositivo esperado.
3. `receiveSyncChanges` devuelve el interior `com.sinochat.message.v1`, el
   usuario remitente, el destinatario, claves Ed25519 y el objeto firmado del
   dispositivo remitente. Tambien expone `ToDeviceEncryptionInfo` con usuario,
   dispositivo y clave Curve25519.
4. Alterar el `sender` exterior hace que Rust Crypto entregue
   `UnableToDecrypt`; el contenido no se acepta con una identidad distinta.
5. Repetir el mismo sobre despues de descifrarlo tambien entrega
   `UnableToDecrypt`. La proteccion contra replay persiste en el estado Olm.
6. Aunque se agreguen `event_id` y `origin_server_ts` al objeto proporcionado a
   `receiveSyncChanges`, esos campos se ignoran: no aparecen en el evento
   descifrado y no quedan autenticados por esta primitiva.
7. Un dispositivo puede cifrar para otro dispositivo de su misma cuenta. El
   destinatario recupera el contenido, el usuario común y la identidad exacta
   del dispositivo emisor. Por lo tanto, la sincronización entre dispositivos
   propios sí es compatible con el perfil Olm elegido.
8. Un dispositivo no puede cifrar para sí mismo. Aunque `getDevice` devuelve su
   dispositivo actual y existan OTK publicadas, `encryptToDeviceEvent` falla
   porque no hay una sesión Olm válida consigo mismo. Además,
   `getMissingSessions` excluye el dispositivo actual y devuelve `null`, por lo
   que la API pública del SDK no ofrece el `keys/claim` necesario para crearla.
9. El parser de control `sendToDevice` acepta exactamente los cuatro campos
   emitidos por el SDK, incluido `org.matrix.msgid`, y valida su formato
   hexadecimal de 32 caracteres.
10. La imposibilidad de cifrar Olm para el dispositivo actual y de releer un
    sobre fue una razón para adoptar Megolm. El contrato vigente de mensajes
    incluye al emisor actual y exige una copia Megolm idéntica para todos los
    dispositivos activos de ambos participantes.

## Endurecimiento derivado ya implementado

El parser Olm estricto se conserva para la cola de control: exige Base64/JSON
canónicos, `org.matrix.msgid` y claves Curve25519 exactas. La migración
`20260830000000_message_olm_envelope_hardening` fue una etapa de transición;
`20260831001000_message_megolm_envelope_profile` fija el mensaje ordinario en
`matrix-megolm-v1`/`m.megolm.v1.aes-sha2` y bloquea sobres Olm existentes. Los
adjuntos continúan en `A256CTR`. Ninguna de las migraciones abre el gate.

## Limitación descubierta que motivó ADR-002

### Los mensajes persistidos no se pueden descifrar dos veces

Con el perfil original, un listado, reintento o recarga podía volver a entregar un `MessageEnvelope` ya
procesado, pero Rust Crypto lo trata correctamente como replay. Antes de montar
el historial se necesita un diario local transaccional y una cache de plaintext
cifrada en reposo, ambos ligados a una identidad inmutable del mensaje. El
cliente debe consultar esa cache antes de volver a llamar
`receiveSyncChanges`. Si se pierde la cache local, el producto debe definir de
forma explicita si el historial ya consumido se considera perdido.

Existe además un intervalo crítico de caída: el estado Olm puede haber consumido
el sobre antes de que el plaintext llegue a persistirse en la cache. El diseño
debe demostrar un commit atómico o una recuperación equivalente entre el avance
del ratchet, el diario de mensaje y la cache cifrada. Si esa atomicidad no puede
garantizarse con Rust Crypto/IndexedDB, habrá que revisar la arquitectura de
historial en vez de reintentar el descifrado. Este punto es incompatible con
habilitar de forma segura un historial persistido durante las 48 horas.

ADR-002 elimina este bloqueo específico para mensajes ordinarios: Megolm permite
descifrado repetido y reapertura del store sin una caché de plaintext. No cambia
la semántica antirreplay de Olm para control ni abre el gate de producción.

### Metadatos del servidor no autenticados por Olm

El ID y timestamp creados por el servidor no existen cuando el remitente cifra
el mensaje. Validar que tengan sintaxis correcta evita errores de tipo, pero no
los vuelve autenticados de extremo a extremo. Antes de implementar el adaptador
debe decidirse que identificador y timestamp nacen en el cliente y viajan en el
interior cifrado. El codec Megolm vigente incluye `conversationId`, `roomId`,
`clientMessageId`, `senderUserId` y `senderDeviceId`; `createdAt`, `expiresAt` y
`serverSequence` siguen siendo metadata de transporte y no se presentan como
autenticados de extremo a extremo.

### Confianza de dispositivos pendiente

Descifrar prueba posesion de la sesion Olm y autentica el objeto de dispositivo
conocido, pero no significa que el dispositivo sea confiable para el usuario.
Sin la ceremonia de verificacion/cross-signing pendiente,
`isSenderVerified()` no puede usarse para mostrar una identidad verificada. El
gate debe seguir en `BLOCKED`.

## Trabajo vigente antes de producción

- Conectar al flujo de chat el codec cerrado ya implementado para
  `com.sinochat.message.v1` y sus variantes `TEXT`/`IMAGE`, conservando su enlace
  estricto con conversación, mensaje, dispositivo y metadatos de transporte.
- Conectar el helper de adjuntos Matrix v2 `A256CTR` y demostrar el flujo real de
  carga/descarga sin exponer clave, IV o plaintext al servidor.
- Probar distribución Olm de room keys, rotación Megolm por mensaje/máximo una
  hora, lectura repetida y reapertura del store entre navegadores reales.
- Exigir una copia Megolm idéntica para todos los dispositivos activos, incluido
  el emisor, y revalidar el snapshot ante cambios concurrentes.
- Completar verificacion/cross-signing y definir la politica para dispositivos
  nuevos, eliminados, bloqueados o no verificados.
- Mantener un mutex por `OlmMachine` y por par de dispositivos durante
  consulta/claim/cifrado/envio para preservar el orden requerido por Olm.

## Ejecucion manual

Desde la raiz del repositorio:

```powershell
node apps/web/scripts/characterize-matrix-application-olm.mjs
```

El checker también se ejecuta mediante `npm test`. Su aprobación caracteriza el
comportamiento fijado de Olm para control, pero no cambia el gate E2EE: este debe
permanecer en `BLOCKED` hasta completar integración y auditoría externa.
