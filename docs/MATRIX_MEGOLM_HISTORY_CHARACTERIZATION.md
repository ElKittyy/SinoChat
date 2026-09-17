# Caracterización de Megolm para historial de mensajes

- Fecha: 2026-08-31
- SDK probado: `@matrix-org/matrix-sdk-crypto-wasm` 18.6.0
- Entorno: Chrome headless, origen HTTP local e IndexedDB real cifrado con
  passphrase
- Estado: evidencia que sustenta ADR-002; no abre el gate E2EE

## Pregunta evaluada

El perfil Olm ordinario originalmente seleccionado en ADR-001 rechaza como replay un
sobre que ya fue descifrado. Eso crea un intervalo de caída entre consumir el
ratchet Olm y guardar el plaintext en una caché local. La prueba evalúa si
Megolm puede conservar el historial ordinario de 48 horas sin ese segundo
descifrado imposible.

El script
`apps/web/scripts/characterize-matrix-megolm-history.mjs` crea dos
`OlmMachine` reales, publica y consulta sus claves, reclama una OTK, comparte
una room key con `shareRoomKey`, cifra con `encryptRoomEvent` y descifra con
`decryptRoomEvent`. El intercambio de la room key sí viaja protegido por Olm.

## Resultados confirmados

1. El receptor descifra correctamente el mismo evento Megolm más de una vez.
   No aparece el rechazo de replay observado al reutilizar un sobre Olm de
   aplicación.
2. El receptor sigue descifrando el evento después de cerrar su `OlmMachine`,
   reabrir el mismo IndexedDB con la misma identidad y passphrase y recuperar
   la sesión.
3. El dispositivo emisor descifra su propio evento tanto antes como después de
   cerrar y reabrir su store. No necesita crear una sesión Olm consigo mismo.
4. La salida de `encryptRoomEvent` contiene exactamente:

   ```text
   algorithm, ciphertext, device_id, sender_key, session_id
   ```

   `algorithm` vale `m.megolm.v1.aes-sha2`. La room key dirigida al receptor se
   transporta como `m.room.encrypted` con
   `m.olm.v1.curve25519-aes-sha2`.
5. Alterar el ciphertext, `session_id` o `algorithm` impide el descifrado.
   Proporcionar otro `room_id` a `decryptRoomEvent` también falla porque la
   sesión de entrada está asociada a la sala original.
6. Alterar `event_id` u `origin_server_ts` no impide el descifrado y el evento
   resultante conserva los valores alterados. Son metadatos exteriores, no
   autenticados por Megolm.

## Binding de identidad: resultado crítico

El comportamiento de la versión fijada no permite confiar sin más en todos los
campos exteriores:

| Modificación | ¿Se descifra? | Evidencia devuelta por Rust Crypto |
| --- | --- | --- |
| `sender` exterior cambiado al receptor | Sí | `sender` refleja el valor alterado y `senderDevice` queda indefinido |
| `content.device_id` exterior cambiado | Sí | `senderDevice` conserva el dispositivo original derivado de la sesión |
| `content.sender_key` exterior cambiado | Sí | `senderCurve25519Key` conserva la clave original derivada de la sesión |
| `room_id` distinto al descifrar | No | no encuentra una room key para esa sala |

Por lo tanto, el adaptador Megolm de SinoChat incluye dentro del
contenido cifrado, como mínimo, `senderUserId`, `senderDeviceId`, `roomId`,
`conversationId` y `clientMessageId`. Después de descifrar debe exigir igualdad
entre esos bindings, la sesión/dispositivo conocido, el participante autorizado
y la conversación solicitada. Un mismatch debe fallar cerrado. El `sender`
exterior, `event_id` y timestamps del servidor no deben mostrarse como
autenticados de extremo a extremo.

La prueba incluye esos cinco campos dentro de
`com.sinochat.message.v1` y confirma que reaparecen intactos. También demuestra
que modificar el ciphertext sí es detectado. No afirma que el SDK valide el
contrato de SinoChat: esa comparación seguirá siendo responsabilidad explícita
del codec/adaptador.

## Qué problema resuelve

Megolm elimina dos bloqueos concretos del prototipo Olm ordinario:

- el historial puede descifrarse nuevamente en listados, recargas y reintentos;
- el emisor conserva acceso a sus propios mensajes sin un sobre Olm dirigido a
  su dispositivo actual.

Esto evita que la disponibilidad del historial dependa de un commit atómico
imposible de demostrar entre el avance antirreplay de Olm y una caché de
plaintext local. El store de Rust Crypto conserva la room key y no requiere
guardar plaintext para volver a mostrar un ciphertext todavía vigente.

## Límites y trabajo pendiente

ADR-002 ya adopta Megolm para mensajes ordinarios, pero esta evidencia aislada
no autoriza producción. Antes de abrir el gate se requiere:

- demostrar en navegadores reales la política conservadora de una sesión Megolm
  por mensaje y máximo una hora, además de rotación inmediata al cambiar
  participantes o dispositivos;
- probar varios dispositivos por usuario, altas tardías, sesiones rotadas,
  claves faltantes, concurrencia entre pestañas y recuperación de pérdida del
  store;
- validar el contrato vigente del servidor: una copia con ciphertext Megolm
  idéntico para cada dispositivo activo y distribución Olm separada de la room
  key; las migraciones no convierten ciphertext heredado;
- validar estrictamente forma, Base64, límites, algoritmo, sala, remitente,
  dispositivo y bindings interiores antes de aceptar o presentar un mensaje;
- mantener la purga permanente del ciphertext y adjuntos a las 48 horas y
  purgar cualquier caché local. Que una clave sobreviva en IndexedDB no debe
  prolongar la disponibilidad del contenido eliminado;
- completar verificación/cross-signing, revocación de dispositivos, pruebas
  entre navegadores y auditoría criptográfica externa.

La prueba usa `TrustRequirement.Untrusted` para caracterizar criptografía y
persistencia sin fingir que existe una ceremonia de confianza. Ese modo no es
una política final de producción.

## Conclusión

Megolm es el perfil seleccionado por ADR-002 para el ciphertext ordinario de
SinoChat y soluciona la incompatibilidad principal entre replay Olm e historial
de 48 horas. La caracterización también descubre una condición obligatoria: el
adaptador debe autenticar a nivel de aplicación los bindings interiores y no
confiar en `sender` o metadata exterior.

El gate debe permanecer en `BLOCKED` hasta que la arquitectura esté integrada,
probada en los casos anteriores y aprobada por una auditoría criptográfica
externa. La caracterización no reemplaza pruebas extremo a extremo ni auditoría.

## Ejecución

Desde la raíz del repositorio:

```powershell
node apps/web/scripts/characterize-matrix-megolm-history.mjs
```

El checker abre Chrome o Edge headless, usa un servidor Vite local efímero y
stores IndexedDB únicos, y elimina su perfil temporal al terminar. Falla si el
SDK deja de cumplir cualquiera de las propiedades caracterizadas.
