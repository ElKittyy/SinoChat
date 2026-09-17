# Plan de pruebas de SinoChat

Estado: plan normativo en implementación; ninguna cobertura parcial autoriza
producción.  
Referencias: `PRODUCT_SPEC.md`, `SECURITY.md`, `ARCHITECTURE.md`,
`ADR-001-E2EE_PROTOCOL.md` y `THREAT_MODEL.md`.

## 1. Objetivo

Este plan demuestra que las reglas de negocio y los invariantes de privacidad se
mantienen en condiciones normales, en límites temporales, bajo concurrencia y
frente a clientes hostiles. Una prueba visual o un recorrido manual no bastan
para validar cifrado, expiración, autorización ni borrado.

Prioridades:

- **P0:** una falla expone contenido, rompe E2EE, autoriza a otro usuario,
  conserva contenido vencido accesible o corrompe una asignación.
- **P1:** una falla rompe un flujo central, retención de evidencia,
  recuperación, suspensión o disponibilidad.
- **P2:** una falla degrada UX, observabilidad o comportamiento no esencial.

Toda corrección de P0 o P1 debe añadir una prueba de regresión.

## 2. Estrategia y entornos

### Capas

1. **Unitarias:** reglas puras de elegibilidad, conteo, vencimiento, estados y
   validaciones.
2. **Componentes:** repositorios, worker, almacenamiento de objetos, cifrado,
   sesiones y autorización WebSocket con dependencias reales efímeras.
3. **Integración:** API + PostgreSQL + objetos + caché/cola + worker.
4. **E2E multidispositivo:** navegadores reales, PWA, service worker, push y
   estación de investigación separada.
5. **Seguridad:** pruebas negativas de autorización, fuzzing, SAST/DAST,
   dependencias, secretos y revisión manual.
6. **Concurrencia y resiliencia:** carreras, reinicios, reintentos, caída del
   worker, pérdida de red y restauración.
7. **Revisión criptográfica:** vectores oficiales, interoperabilidad y auditoría
   independiente del diseño y su integración.

### Entornos requeridos

- `test`: reloj controlable, CSPRNG inyectable solo para resultados deterministas,
  PostgreSQL y almacenamiento compatibles con producción.
- `staging`: misma topología, políticas, CSP, TLS, service worker y proveedor de
  objetos que producción; nunca datos reales.
- Navegadores soportados en escritorio y móvil, incluidos dos dispositivos
  simultáneos por usuario.
- Capturador de logs/trazas y escáner de valores canario.
- Estación de investigación sin acceso a claves de conversación ordinaria.

No se validan las 48 horas con esperas reales. El servidor y el worker deben
aceptar un reloj sustituible en pruebas; en staging se añade una prueba de larga
duración.

## 3. Datos y oráculos

El fixture mínimo incluye:

- un administrador con MFA;
- cajeros aprobados/activos, no aprobados, suspendidos e inactivos;
- clientes activos, suspendidos y pendientes de reasignación;
- relaciones bloqueadas y conteos desiguales de 0, 5 y 10 clientes;
- al menos dos dispositivos por cliente y cajero;
- mensajes a ambos lados del límite de expiración;
- adjuntos JPEG, JPG, PNG y WebP válidos, hostiles y sobredimensionados;
- un caso abierto y uno cerrado.

Se insertarán canarios únicos en texto, nombre de archivo, EXIF y claves. La
prueba falla si cualquier canario aparece en base, objetos sin cifrar, logs,
trazas, excepciones, analítica, caché, cola o push.

Para pruebas de expiración, la regla exacta es:

```text
visible si y solo si server_now < expires_at
expires_at = server_created_at + 48 horas
```

## 4. Trazabilidad de invariantes

| Invariante | Suites mínimas |
| --- | --- |
| INV-01 Contenido ordinario | CRY, MSG, IMG, LOG |
| INV-02 Participación/autorización | AUTH, MSG, WS |
| INV-03 Administración sin puerta trasera | CRY, REC, ADM |
| INV-04 Reasignación | ASG, BLK, RPT |
| INV-05 Excepción de reporte | RPT |
| INV-06 Separación de evidencia | RPT, ADM, RET |
| INV-07 Caducidad | RET, MSG, IMG, PWA |
| INV-08 Recuperación | REC, CRY |
| INV-09 Mínimo privilegio | AUTH, ADM, OPS |
| INV-10 Metadatos/notificaciones | LOG, PUSH |
| INV-11 Estado de cuenta | ASG, BLK, ADM |
| INV-12 Artefacto entregado | WEB, SUP, PWA |

## 5. Casos críticos

### 5.1 Invitación, asignación y reasignación

| ID | Prioridad | Escenario y resultado esperado |
| --- | --- | --- |
| ASG-001 | P0 | Registro por enlace vigente de cajero elegible: crea exactamente un cliente, una asignación al propietario y un chat vacío, aunque otro cajero tenga menor carga |
| ASG-002 | P0 | Registro introduciendo el mismo código: comportamiento idéntico al enlace y sin posibilidad de elegir otro cajero |
| ASG-003 | P0 | Registro directo sin enlace/código: no crea cuenta ni asignación |
| ASG-004 | P0 | Código inexistente, rotado, revocado o del cajero no aprobado/inactivo: respuesta no enumerable y cero efectos parciales |
| ASG-005 | P1 | Rotación: el nuevo código funciona, el anterior deja de funcionar inmediatamente y registros concurrentes siguen la precedencia transaccional definida |
| ASG-006 | P0 | Diferencia existente de 10 contra 5 clientes: ningún trabajo de equilibrio mueve clientela existente |
| ASG-007 | P0 | Reasignación: excluye al cajero anterior, todos los bloqueados, suspendidos, no aprobados e inactivos; selecciona solo entre el menor conteo elegible |
| ASG-008 | P1 | Empate entre tres mínimos: con CSPRNG simulado cada candidato puede ser elegido; ningún candidato fuera del empate puede serlo |
| ASG-009 | P0 | Nueva asignación: conversación nueva sin mensajes, claves, receipts o adjuntos anteriores; la anterior queda sellada |
| ASG-010 | P0 | Ningún cajero elegible: cliente queda `PENDING_REASSIGNMENT`, sin chat activo; el sistema no relaja exclusiones y reintenta al aparecer uno |
| ASG-011 | P0 | Cien reasignaciones concurrentes: no existen dos asignaciones/chats activos por cliente, no se pierden clientes y la selección usa conteos confirmados |
| ASG-012 | P1 | Suspensión o suscripción inactiva de un cajero con varios clientes: cada cliente se procesa una vez, de forma idempotente, sin tocar clientelas ajenas |
| ASG-013 | P0 | Reintento con la misma idempotency key tras timeout: devuelve el mismo resultado sin crear otro chat |
| ASG-014 | P0 | Una reasignación administrativa explícita no solicita motivo libre: muestra solo confirmación, conserva todas las exclusiones de elegibilidad y registra el código automático de auditoría |
| ASG-015 | P0 | Tras rotar la clave de invitaciones, un código activo cifrado con una versión anterior sigue siendo legible solo si esa versión permanece en el keyring; una versión ausente o repetida falla sin usar otra clave |
| ASG-016 | P0 | Los enlaces de cliente y onboarding llevan el código solo después de `#`; al abrirlos la primera solicitud no contiene el secreto y la PWA limpia fragmento, query y `history.state` antes de renderizar, sin escribir en `localStorage` |
| ASG-017 | P0 | Validar o revelar un código mediante `GET`, path o query no tiene endpoint; `POST /api/invitations/validate` rechaza campos extra/formato/rol inválidos, aplica rate limit y responde sin reflejar el secreto |
| ASG-018 | P0 | Una transacción de alta/reasignación comienza antes del vencimiento de la suscripción y confirma en `endsAt` o después: el trigger diferido usa `clock_timestamp()` al confirmar, rechaza el INSERT completo y el flujo reintenta sin dejar asignación o chat inutilizable |
| ASG-019 | P1 | Dos suscripciones vencen y la primera conserva más clientes que un lote: el cursor durable mueve cada tanda al final del round-robin, la segunda progresa en el ciclo siguiente y la UI muestra ambas como vencidas/en conciliación hasta que el estado persistido cambie |

### 5.2 Bloqueos y umbral de cinco cajeros

| ID | Prioridad | Escenario y resultado esperado |
| --- | --- | --- |
| BLK-001 | P1 | Motivo vacío, solo espacios o menor de 20 caracteres Unicode tras `trim`: rechazo en cliente y servidor |
| BLK-002 | P0 | Primer a cuarto cajero distinto bloquea al cliente: registra una relación única, sella el chat y reasigna a un elegible no bloqueado |
| BLK-003 | P0 | El mismo cajero reintenta o duplica el bloqueo: cuenta una sola vez y no genera reasignaciones adicionales |
| BLK-004 | P0 | Quinto cajero distinto: el cliente queda suspendido, no eliminado; se invalidan sesiones/capacidades y no se crea una sexta asignación |
| BLK-005 | P0 | Dos bloqueos concurrentes intentan alcanzar cinco: constraint y transacción producen exactamente conteo 5 y una sola suspensión |
| BLK-006 | P0 | Cliente suspendido intenta enviar, conectarse por WS o registrarse de nuevo con la misma identidad: no obtiene acceso |
| BLK-007 | P0 | Revisión administrativa no puede borrar o alterar el historial de auditoría de quién bloqueó y por qué |
| BLK-008 | P0 | Cliente bloquea a cajero: ejecuta “Bloquear y reportar”, no un bloqueo silencioso; crea evidencia y reasigna |
| BLK-009 | P0 | Una relación bloqueada nunca vuelve a ser candidata, incluso tras rotación de invitación o empate de carga |

### 5.3 Expiración exacta y borrado

Para todos estos casos se prueban texto, imagen, thumbnail local si existiera,
estados de entrega, índices y cualquier registro relacionado.

| ID | Prioridad | Escenario y resultado esperado |
| --- | --- | --- |
| RET-001 | P0 | A `expires_at - 1 unidad de precisión` el participante autorizado puede leer; a `expires_at` y después, toda lectura devuelve ausencia, no un payload oculto |
| RET-002 | P0 | El reloj del dispositivo adelantado/atrasado no cambia `created_at`, `expires_at` ni la decisión del servidor |
| RET-003 | P0 | Mensaje en cola WebSocket al vencer: el consumidor vuelve a validar y no lo emite |
| RET-004 | P0 | URL de objeto obtenida antes de vencer: al llegar el límite deja de servir el objeto o usa una vigencia que nunca supera `expires_at` |
| RET-005 | P0 | Cache hit, reintento HTTP, paginación y búsqueda con cursor antiguo no devuelven mensajes vencidos |
| RET-006 | P0 | Worker elimina fila, objeto, caché, cola y metadatos; dos o más ejecuciones producen el mismo estado sin error |
| RET-007 | P0 | Worker detenido durante el vencimiento: el contenido sigue inaccesible; al reiniciar purga atrasos y activa alarma por SLO |
| RET-008 | P0 | Carrera entre envío/recibo/leído y expiración: ninguna operación resucita o prolonga el TTL |
| RET-009 | P0 | Service worker/PWA abierta, en segundo plano y reiniciada purga antes de mostrar; un dispositivo offline purga antes de desbloquear o descifrar al volver |
| RET-010 | P0 | Restauración de backup y réplica: no contiene payload efímero vencido ni hace reaparecer datos; se conserva el filtro de expiración |
| RET-011 | P0 | Un reporte abierto conserva únicamente su copia separada después de las 48 h; la conversación ordinaria desaparece |
| RET-012 | P1 | Métricas registran atraso, conteos y errores sin IDs sensibles, texto, URLs firmadas ni claves |
| RET-013 | P0 | La purga cumple el SLO ratificado en DEC-01 bajo carga y fallo/reinicio del worker |

### 5.4 Cifrado de extremo a extremo y multidispositivo

| ID | Prioridad | Escenario y resultado esperado |
| --- | --- | --- |
| CRY-001 | P0 | Vectores oficiales e interoperabilidad interna entre dos clientes SinoChat que usan la biblioteca seleccionada pasan en todos los navegadores soportados; no se interpreta como compatibilidad con clientes Matrix externos |
| CRY-002 | P0 | Texto y cada tipo de imagen se cifran antes de salir del dispositivo; captura de red, DB, objeto, caché y logs contiene solo ciphertext autenticado |
| CRY-003 | P0 | Solo los dispositivos autorizados de cliente y cajero descifran; administrador, otro cliente, otro cajero y API no pueden |
| CRY-004 | P0 | Dos dispositivos autorizados por usuario reciben mediante Olm la room key correcta y copias byte por byte idénticas del evento Megolm, sin compartir claves privadas de dispositivo |
| CRY-005 | P0 | Dispositivo nuevo aprobado desde uno confiable puede leer solo contenido todavía vigente según el diseño y no contenido expirado |
| CRY-006 | P0 | El servidor añade o sustituye una clave/dispositivo sin firma válida: los extremos lo detectan y se niegan a enviar silenciosamente |
| CRY-007 | P0 | Replay, alteración de un bit, sobre para otra conversación y cambio de destinatario fallan autenticación |
| CRY-008 | P0 | Mensajes offline, fuera de orden, simultáneos y tras rotación de prekeys/room keys interoperan sin reutilizar sesión, nonce o clave fuera de su alcance |
| CRY-009 | P0 | Revocar un dispositivo impide que obtenga claves o mensajes posteriores; se documenta que no puede retirar texto ya visto |
| CRY-010 | P0 | Reasignación inicia material criptográfico independiente; cajero nuevo no descifra ciphertext anterior y cajero viejo no descifra el nuevo |
| CRY-011 | P0 | Agotar/duplicar prekeys, reiniciar durante distribución de room key y recuperar de una transacción parcial falla de forma segura y no persiste el mensaje con cobertura incompleta |
| CRY-012 | P0 | El secreto de recuperación, claves privadas y plaintext no aparecen en IndexedDB sin cifrar, localStorage, crash reports ni telemetría |
| CRY-013 | P0 | La revisión criptográfica externa no encuentra un camino por el que el servidor o admin puedan añadir una clave de escucha |
| CRY-014 | P0 | `MATRIX_SERVER_NAME` ausente/inválido bloquea producción; un valor válido genera IDs deterministas desde UUID y cambiarlo después del registro se detecta como cambio incompatible, no como rotación silenciosa |
| CRY-015 | P0 | Las 32 migraciones se aplican sobre una base limpia y una actualizada; la base Matrix, sus siete forward `01000` a `07000`, registro reintentable, endurecimiento Olm transitorio, ledger de adjuntos y perfil Megolm no convierten blobs genéricos. `20260831000000_attachment_purge_ledger_hardening` exige borrar el objeto antes de perder su fila y `20260831001000_message_megolm_envelope_profile` falla ante cualquier sobre Olm antes de fijar por `CHECK` `matrix-megolm-v1`, `m.megolm.v1.aes-sha2` y `A256CTR`; recuperación de cajeros y MFA WebAuthn no persisten códigos/desafíos en claro; `20260902000000_admin_passkey_management` añade `ADMIN_PASSKEY_REVOKED` sin reescribir el ledger. `20260910000000_matrix_cross_signing_identity` exige raíz y certificado públicos atómicos e inmutables; `20260912000000_matrix_device_candidate_quarantine` conserva candidatos no operativos, con una sola PENDING por usuario y snapshot inmutable, sin ampliar dispositivos. `20260913000000_matrix_device_verification_flow` fija request, sesiones, replay histórico y ventana de admisión SAS sin promover dispositivos. `check:cross-signing-db` valida las 32 en una base nueva; una actualización con datos existentes sigue requiriendo ensayo separado |
| CRY-016 | P0 | Reserva de dispositivo vence como máximo a los 15 minutos y solo una reserva abierta pertenece a la sesión; finalizar crea `Device` + clave Matrix + binding de sesión y consume la reserva en una sola transacción |
| CRY-017 | P0 | `/keys/upload` acepta una reposición parcial firmada contra el Ed25519 ya confiable, hace idempotente el reintento idéntico y rechaza sustitución de identidad, campos extra, downgrade, firma inválida y más de 100 OTK disponibles |
| CRY-018 | P0 | Reclamos concurrentes entregan cada OTK exactamente una vez y conservan su tombstone; al agotarse usan solo el fallback vigente, marcan su primer uso y un reintento con el mismo request ID/hash devuelve exactamente el mismo resultado, incluso `null` |
| CRY-019 | P0 | Consulta/reclamo de claves falla por lote completo ante usuario ajeno, admin, dispositivo revocado o relación no vigente; una reasignación confirmada impide obtener material del interlocutor anterior |
| CRY-020 | P0 | El cliente y los contratos nunca enrutan texto/foto por `to-device`; `PUT /api/e2ee/matrix/sendToDevice/:eventType/:transactionId` solo admite exterior `m.room.encrypted` Olm, sin wildcard, hasta 20 dispositivos exactos, payload acotado, TTL de 48 h y máximo 2000 pendientes por dispositivo. Las pruebas descifran los eventos generados y confirman tipos interiores de control |
| CRY-021 | P0 | Cada mensaje ordinario queda en `Message`/`MessageEnvelope`: exterior exacto `m.room.encrypted` Megolm con `algorithm`, `ciphertext`, `device_id`, `sender_key`, `session_id`, algoritmo `m.megolm.v1.aes-sha2` e interior autenticado `com.sinochat.message.v1`; un tipo/algoritmo/cuerpo alternativo falla cerrado |
| CRY-022 | P0 | `/sync` entrega como máximo el batch permitido y no borra al responder; solo la siguiente solicitud con el `next_batch` anterior confirma y elimina, mientras un token vencido/alterado/ajeno o un evento de 48 h nunca recupera contenido |
| CRY-023 | P0 | Cambios de lista usan una fila global bloqueada y `to-device` un cursor bloqueado por destinatario: commits concurrentes producen posiciones estrictamente consecutivas y nunca dependen de `BIGSERIAL` asignado antes del commit |
| CRY-024 | P0 | Entre encolar y entregar, cada sync revalida conversación/asignación; bloquear, suspender, revocar o reasignar antes del commit impide la entrega posterior al dispositivo excluido |
| CRY-025 | P0 | Captura de red y configuración confirman que `MATRIX_SERVER_NAME` no provoca I/O hacia un homeserver, que ningún timeline/media sale a Matrix/Synapse y que un cliente Matrix externo no constituye una superficie soportada |
| CRY-026 | P0 | Los tokens de `GET /api/e2ee/matrix/sync` tienen formato `sct1`, HMAC dedicado y hash persistido; alteración, otro dispositivo, secreto rotado, rango/snapshot mutado o vencimiento fallan con `M_UNKNOWN_POS`, mientras el mismo `since` reconstruye exactamente el mismo sucesor |
| CRY-027 | P0 | Crear el sucesor confirma el predecesor y purga físicamente solo sus eventos cubiertos; perder la respuesta antes del commit no confirma, y repetir después del commit conserva eventos/respuesta del hijo. El worker elimina eventos y lotes al vencer |
| CRY-028 | P0 | Registro, rotación, revocación, suspensión y reasignación emiten todos los `CHANGED`/`LEFT` necesarios en orden de commit. Las pruebas unitarias actuales cubren alta, revocación, eliminación, reset y reasignación; el caso no se cierra hasta probar concurrencia real y rotación/cross-signing entre navegadores |
| CRY-029 | P0 | El coordinador web procesa `receiveSyncChanges` antes de persistir `next_batch`, elimina un cursor local inválido, divide `keys/query` a 20 y `keys/claim` por identidad, y nunca llama `markRequestAsSent` antes de validar HTTP. Reiniciar entre cada límite conserva solicitudes pendientes y no duplica consumo criptográfico |
| CRY-030 | P0 | El lifecycle consulta y valida el gate antes de almacenamiento/locks/rutas Matrix, registra el alta con journal reintentable, vincula una sesión existente antes de abrir crypto y mantiene una sola `OlmMachine` por usuario entre pestañas. Una pestaña ocupada no toca IndexedDB ni reserva dispositivos; aborto, fallo y logout drenan operaciones y liberan exactamente una vez. Se prueba `M_UNKNOWN_POS` una sola vez y luego falla cerrado |
| CRY-031 | P0 | El codec interior acepta solo el tipo `com.sinochat.message.v1` y los esquemas cerrados `TEXT`/`IMAGE`; rechaza campos extra, prototipos hostiles, UUID/tipos/Unicode/tamaños inválidos y cualquier discrepancia entre conversación, `clientMessageId`, dispositivo remitente, clase, protocolo, cipher suite o metadatos autenticados y los del transporte |
| CRY-032 | P0 | El helper de fotos reconoce por bytes JPEG/PNG/WebP, rechaza MIME falso, mutación concurrente y plaintext vacío o mayor a 5 MiB; cifra/descifra con Matrix v2 `A256CTR`, verifica clave/IV/SHA-256/tamaños canónicos y permite consumir `EncryptedAttachment` exactamente una vez |
| CRY-033 | P0 | Los exteriores Olm de **control** contienen exactamente `algorithm`, `ciphertext`, `org.matrix.msgid` y `sender_key`; `sendToDevice` exige el msgid real, Base64/JSON canónicos y claves remitente/destinataria del directorio. El contenido ordinario nunca usa esa cola |
| CRY-034 | P0 | La caracterización Megolm con dos `OlmMachine`, navegador e IndexedDB reales confirma que receptor y emisor descifran repetidamente el mismo evento, incluso tras cerrar/reabrir el store. Listado, reintento y recarga no requieren persistir plaintext y nunca muestran contenido después de 48 horas |
| CRY-035 | P0 | `MessageEnvelope` incluye exactamente una copia para cada dispositivo activo de ambos participantes, incluido el emisor actual, y todas contienen el mismo Base64 Megolm. Omitir, duplicar o agregar un dispositivo, variar un byte entre copias o enviar sin dispositivo seguro de la contraparte falla cerrado |
| CRY-036 | P0 | `rotationPeriodMessages = 1` y el máximo temporal es una hora; cada mensaje comparte una room key nueva mediante Olm y confirma todos los requests antes de cifrar/persistir. Dos envíos, reintento parcial o carrera de dispositivos nunca reutilizan la sesión ni dejan cobertura incompleta |
| CRY-037 | P0 | Mutar `sender`, `device_id`, `sender_key`, `event_id`, timestamp, sala, conversación, `clientMessageId`, usuario o dispositivo demuestra que solo ciphertext/sesión/sala e interior dan el binding esperado. El receptor compara todos los bindings interiores con transporte y estado Rust Crypto y falla cerrado ante cualquier diferencia |
| CRY-038 | P0 | El adaptador acepta exactamente los siete campos de `DecryptedRoomEvent` del SDK 18.6.0, compara `room_id` y exige `unsigned` vacío. La prueba real del cliente en contextos Chrome aislados verifica ciphertext, rotación concurrente, historial, PNG, tercero sin claves y fallo HTTP al distribuir la room key; el relay es sintético y no cierra por sí solo interoperabilidad ni autorización multidispositivo |
| CRY-039 | P0 | React retira texto y fotos al vencer sin esperar HTTP, incluso en conversaciones no seleccionadas; un milisegundo antes sigue visible, al vencer desaparece y el Blob URL es inutilizable. Un salto de reloj con recuperación de visibilidad fuerza limpieza local; se prueba con reloj controlado, sin confundirlo con certificación de borrado físico en servidores |

Pruebas adicionales del bootstrap público, con SDK y PostgreSQL separados y sin
cerrar todavía CRY-003/005/006/013 de autorización integral:

| ID | Prioridad | Escenario y resultado esperado |
| --- | --- | --- |
| CRY-040 | P0 | Aceptar las cinco firmas públicas reales del SDK 18.6 y conservar la autofirma del dispositivo; rechazar otro usuario, dispositivo, campo privado, algoritmo, uso, firma o cambio de claves, incluso con certificado nuevo válido |
| CRY-041 | P0 | `bootstrap(false)` mantiene el triplete; un pin leído dentro de la transacción prohíbe sustituir raíz o subclaves. `undefined` no equivale a primera identidad. El servicio distingue reintento exacto de sustitución por hash canónico; dos raíces válidas concurrentes producen un único ganador |
| CRY-042 | P0 | Rechazar Ed25519 no canónica, fuera de curva o de orden pequeño en claves y en `R`, tanto en bootstrap como en alta/reposición Matrix; una `user_signing` débil no se acepta aunque la raíz firme su certificado |
| CRY-043 | P0 | Persistir raíz, certificado y un solo `CHANGED` de forma atómica; fallo, sesión revocada durante la espera, vencimiento o cambio de versión no dejan publicación parcial. SQL directo no permite cambiar ni borrar filas y las referencias diferidas impiden confirmar una mitad. Se prueba con servicio unitario y PostgreSQL real aislado |
| CRY-044 | P0 | Consulta devuelve raíces y certificados solo dentro del scope autorizado y dispositivos solicitados activos; `user_signing_keys` únicamente para el propietario solicitado. ADMIN o un lote con un tercero falla antes de leer certificados; una sesión revocada tras el primer control tampoco consulta |
| CRY-045 | P0 | Lifecycle completa registro/ACK y binding antes del bootstrap exclusivo; publica solo datos públicos, consulta su certificado y exige confianza del SDK en el dispositivo propio antes de construir Megolm. Reintento o respuesta perdida conservan el pin; claves ausentes, cambio de triplete, firma inválida, aborto y respuestas inesperadas fallan sin reset ni autorización de otro dispositivo |
| CRY-046 | P0 | El certificado adicional exige un triplete previamente autenticado y fijado por el servidor, y las claves originales del candidato; conserva su autofirma y rechaza sustituciones independientes de Ed25519/Curve25519, incluso válidamente firmadas. Certificado repetible no equivale a autorización de una solicitud |
| CRY-047 | P0 | SAS real entre dos máquinas exige ambos extremos; confirmación unilateral, cancelación, compromiso/MAC alterados y flujo ajeno no completan confianza. Firmas encoladas se confirman con su ID real; no se exportan ni transportan secretos. La caracterización en memoria no certifica HTTP, sesiones ni promoción |
| CRY-048 | P0 | El controlador solo confirma un recibo previamente emitido para los mismos valores y flujo; rechaza doble clic y consentimiento obsoleto. Vencimiento inclusivo, rollback de reloj, cancelación y cierre interrumpen I/O y no envían el siguiente paquete. Un fallo cancela el SAS vivo y todos los wrappers se liberan una sola vez |
| CRY-049 | P0 | El panel requiere casilla y acción explícita; cambiar recibo/valores reinicia consentimiento, busy impide acciones, errores no exponen detalles y estados terminales retiran números. Chrome comprueba móvil/teclado, doble clic y desmontaje con promesa pendiente; no hay red SDK, persistencia ni autorización real |
| CRY-050 | P0 | Reserva acepta únicamente claves públicas autofirmadas; rechaza proxies/getters, campos ocultos, preclaves, secretos, sustituciones y namespaces ajenos antes de escribir. Solo CLIENT/CASHIER con sesión real vigente sin vínculo y pin/bootstrap confiable pueden reservar; no crea Device, clave operativa, preclave, cursor, certificado ni evento |
| CRY-051 | P0 | Un reintento conserva sesión, snapshot y plazo original; otra sesión no consulta/cancela/hereda. Solo una PENDING por usuario; vencimiento inclusivo observado se persiste y no revive al retroceder el reloj. Cancelación sin motivo es irreversible. Expiración de sesión, suscripción o reserva durante la operación revierte los cambios |
| CRY-052 | P0 | PostgreSQL rechaza INSERT con sesión/versión/pin/formato inválidos y UPDATE/DELETE que reabran o sustituyan candidato. Dos trabajadores observados esperando el lock producen una sola reserva; revocación durante la espera no deja fila. Mantenimiento puede terminalizar con sesión revocada sin conceder autoridad. Esta reserva no prueba la ceremonia ni promoción futuras |
| CRY-053 | P0 | Solo sesiones vigentes vinculadas al bootstrap propio consultan/rechazan candidatos; ADMIN, otras cuentas y sesiones sin vínculo no acceden. El detalle verifica nuevamente autofirma/hash/claves y omite tokens, sesiones y secretos; todas las rutas conservan gate y no-store |
| CRY-054 | P0 | Solicitud o sesión solicitante vencida/revocada/vinculada no se presenta como disponible. Una expiración observada persiste aun cuando el detalle responde 404. El descarte sin motivo es idempotente y puede denegar tras logout del solicitante, pero nunca tras revocar al revisor |
| CRY-055 | P0 | En PostgreSQL dos descartes esperan simultáneamente el lock y mantienen una sola resolución; revocación de solicitante/revisor/dispositivo o cancelación confirmada durante espera impiden claves o mutaciones indebidas. Consultar/descartar no crea Device, vínculo, certificado, preclave, cursor ni CHANGED |
| CRY-056 | P0 | HTTP local con routing/guards reales mantiene 401 sin sesión, 403 para ADMIN/CSRF/origen inválidos, 415 sin JSON y 429 al superar 30/10/10 peticiones. CLIENT/CASHIER válidos reciben 503 por gate compilado y el servicio nunca se invoca. No existen rutas approve/activate; no se reemplaza el gate para probarlas |
| CRY-057 | P0 | Validador SAS de cuarentena solo acepta request/ready/start/accept/key/mac/done/cancel para un par propio y flujo esperado; IDs HTTP/flow independientes, copias congeladas y hash contextual. Rechaza mensajes/secretos, destinatarios extra, getters/proxies, campos ocultos, extensiones y Base64 no canónica |
| CRY-058 | P0 | Eventos reales de SDK 18.6.0 pasan antes de relay sintético; start preserva ofertas y orden, accept sin method selecciona v2, MAC solo emisor/master fijada. Ambos SDK completan comparación local o cancelan por usuario/timeout/SAS discrepante sin exportar secretos. No se infiere aprobación de MAC/done ni vigencia del timestamp |
| CRY-059 | P0 | Admisión acepta solo request del bootstrap propio hacia el candidato y fija ambas sesiones exactas e inmutables. Reparsea el snapshot público y deriva emisor, destinatario y pin del contexto bloqueado. Replay idéntico no renueva el plazo; otra sesión revisora, cambio de contenido, candidato reutilizado o ID histórico de flow/HTTP transaction por usuario fallan cerrados. No escribe Device, certificados, claves, cursores, eventos ni vínculos de sesión |
| CRY-060 | P0 | PostgreSQL valida independientemente dueño, ambas sesiones, versiones, dispositivo certificado, perfil SAS y ventana temporal; impide sustitución, extensión, borrado o reapertura del flujo. TTL no supera diez minutos del servidor, candidato, ambas sesiones, suscripción ni timestamp SDK más diez minutos; reloj fresco después de locks rechaza timestamps anteriores en más de diez minutos o adelantados en más de cinco. Cancelar o vencer el candidato terminaliza atómicamente su flujo; una expiración observada se conserva pese al 409. Dos revisores en contención producen una sola admisión y revocar cualquiera de las sesiones durante la espera impide crearla |
| CRY-061 | P0 | El controlador de admisión solo declara PUT `/api/e2ee/matrix/device-verification-flows/:candidateId/:flowId/:transactionId`, con roles CLIENT/CASHIER, no-store declarado y guards reales de sesión, CSRF, origen y JSON. HTTP local comprueba 401/403/415, límite de cinco PUT por minuto con 429 aun cambiando IDs, y 503 por gate compilado para sesiones válidas sin invocar el servicio. En ese controlador no existen rutas de lectura, entrega, confirmación, aprobación ni activación; la bandeja independiente se cubre en CRY-062 a CRY-064. La prueba no habilita el gate ni certifica Redis o la ceremonia entre navegadores |
| CRY-062 | P0 | La bandeja entrega solamente el request SAS inicial a la sesión original del candidato CLIENT/CASHIER con deviceId NULL. Revalida usuario/elegibilidad, ambas sesiones exactas y versiones, bootstrap certificado, identidad/pin, snapshot autofirmado del candidato, hash contextual del request y reloj final de PostgreSQL. Devuelve una copia del evento SDK `{ sender, type, content }` con IDs públicos y fechas inmutables; otra cuenta/sesión, contexto alterado, revocación o expiración no obtiene el request. No devuelve secretos, eventos siguientes ni autoridad de dispositivo |
| CRY-063 | P0 | En PostgreSQL aislado, las consultas repetidas conservan contenido y plazo sin ACK ni consumo. La expiración observada terminaliza el candidato y su flujo mediante el trigger existente; no publica dispositivos, claves, certificados, preclaves, cursores, eventos operativos ni vínculos de sesión. Caducidad real y revocación de cualquiera de las sesiones o del bootstrap durante espera impiden entregar un request vigente solo al inicio. Se mantienen las 32 migraciones, sin tocar la base habitual |
| CRY-064 | P0 | Solo existe GET `/api/e2ee/matrix/device-verification-inbox/:candidateId`, con CLIENT/CASHIER, no-store declarado y guards reales en orden. GET no exige CSRF: no abre ni aprueba la ceremonia. HTTP comprueba 401 sin sesión o con sesión inválida, 403 ADMIN, 503 de gate compilado para CLIENT/CASHIER y 429 tras 30 consultas por minuto aun cambiando candidateId; el servicio no se invoca. No hay variantes POST/PUT/PATCH/DELETE, lista general ni rutas approve/activate/consume. La prueba usa throttle en memoria y no habilita el gate ni certifica Redis o entrega entre navegadores |

Comando de alcance completo local: `npm.cmd test`. Las suites
`matrix-cross-signing.test.ts`, `matrix-cross-signing-adversarial.test.ts` y
`matrix-ed25519-validation.test.ts` usan SDK real o vectores sintéticos en memoria;
no habilitan rutas, roles ni dispositivos. Contrato y límites en
[Bootstrap público de cross-signing](CROSS_SIGNING_BOOTSTRAP.md).

`matrix-cross-signing.service.test.ts` y `matrix-cross-signing-directory.test.ts`
añaden controles de servicio con transacciones simuladas; la suite web incluye
26 pruebas del inicializador con SDK real y HTTP sintético.
`npm.cmd run check:cross-signing-db` usa servicios y PostgreSQL reales en una base
exclusiva que migra y elimina al terminar. Esta separación no sustituye el
recorrido completo de autorización entre navegadores, API y dispositivos nuevos.

`matrix-device-certificate.test.ts` añade 61 pruebas puras con SDK real y
firmantes independientes. Las nuevas comprobaciones web incluyen 40 casos del
controlador, 15 de caracterización del SDK y 19 interacciones en Chrome del
panel aislado. Alcance en [Autorización de dispositivos](DEVICE_APPROVAL.md) y
resultados en la [validación del 12 de septiembre](VALIDATION_2026-09-12.md).
Todavía deben probarse juntos ambos navegadores, sesiones autenticadas,
cuarentena, promoción transaccional y revocación: CRY-046 a CRY-049 no cierran
por sí solos los requisitos multidispositivo anteriores.

La reserva añade 81 pruebas del parser y 43 del servicio/controlador a la suite
API. `check:cross-signing-db` valida su nueva migración con los servicios reales,
incluyendo vencimiento y contención observada entre dos conexiones. Alcance de
CRY-050 a CRY-052 en la [validación de cuarentena](VALIDATION_2026-09-12_QUARANTINE.md).

La revisión propia añade 64 pruebas de servicio/rutas y 25 de frontera HTTP.
Extiende el verificador PostgreSQL con otro propietario sintético, dos sesiones
confiables, descarte simultáneo y revocaciones durante contención observada.
Evidencia de CRY-053 a CRY-056 en la
[validación de revisión](VALIDATION_2026-09-12_DEVICE_REVIEW.md).
La fixture HTTP sustituye el almacén de sesiones y el servicio que no debe
alcanzarse, no los guards. Usa rate limiting en memoria, no certifica Redis
distribuido, la ceremonia SAS ni HTTP de incorporación con gate habilitado.

El perfil SAS cuenta con 118 pruebas puras y con SDK real en la suite API. Sus
fixtures no publican certificados ni convierten al candidato en dispositivo
operativo. Alcance y límites de CRY-057/058 en
[Perfil de eventos SAS](MATRIX_SAS_TRANSPORT.md) y
[validación inicial del 13 de septiembre](VALIDATION_2026-09-13_SAS_PROFILE.md).

La admisión añade 106 pruebas unitarias del servicio y 29 comprobaciones de frontera
HTTP. El perfil SDK también comprueba la solicitud iniciada por el bootstrap
hacia el candidato; no se presupone entrega real por haber persistido ese
`request`. El verificador PostgreSQL aplica las 32 migraciones en una base
exclusiva e incluye replay, restricciones SQL, caducidad, invalidación en
cascada y contención entre dos sesiones revisoras. Alcance de CRY-059 a CRY-061
y resultados de esta tanda en la
[validación de admisión del 16 de septiembre](VALIDATION_2026-09-16_SAS_ADMISSION.md).
Los fixtures HTTP sustituyen el almacén de sesiones y el servicio inalcanzable,
no los guards ni el gate compilado; el rate limit usa memoria. No prueban todavía
entrega SDK, navegador conectado, consentimiento SAS ni promoción transaccional.

La bandeja inicial añade 23 comprobaciones de frontera HTTP con el gate real
`BLOCKED`. Las pruebas del servicio y el escenario PostgreSQL
`check-matrix-verification-inbox.ts` cubren por separado la entrega inicial,
integridad del request, exclusividad de sesión y denegación tras caducidad o
revocación; no equivalen a una ceremonia completa. Alcance de CRY-062 a CRY-064
y resultados efectivos de ejecución en la
[validación de bandeja del 16 de septiembre](VALIDATION_2026-09-16_SAS_INBOX.md).
El evento recibido aún no se integra con la PWA: faltan los eventos SAS
posteriores, confirmación de ambos extremos y promoción transaccional.

### 5.5 Recuperación y cambio de contraseña

| ID | Prioridad | Escenario y resultado esperado |
| --- | --- | --- |
| REC-001 | P0 | Cajero restablece contraseña con administrador y conserva perfil, clientes y asignaciones; el reset no autoriza un dispositivo criptográfico |
| REC-002 | P0 | Con otro dispositivo confiable, autoriza el nuevo y recupera contenido todavía vigente |
| REC-003 | P0 | Con código correcto y sin dispositivo, recupera claves; código incorrecto, truncado o modificado no revela información ni corrompe el respaldo |
| REC-004 | P0 | Sin dispositivo ni código, crea identidad nueva, no recupera mensajes anteriores y cada cliente ve una advertencia de seguridad antes de enviar |
| REC-005 | P0 | Administrador o atacante con la nueva contraseña, pero sin aprobación/código, no puede descifrar ni suprimir la advertencia |
| REC-006 | P0 | Cliente que pierde credenciales no dispone de reset administrativo; su código criptográfico no funciona como recuperación de cuenta |
| REC-007 | P1 | Código se muestra/exporta según la política, nunca se registra y puede rotarse desde un dispositivo confiable invalidando el anterior |
| REC-008 | P0 | Restablecer contraseña invalida las sesiones definidas por política y notifica a dispositivos existentes sin incluir información sensible |
| REC-009 | P1 | Procedimiento manual de verificación del cajero resiste un intento de ingeniería social y deja auditoría completa |
| REC-010 | P0 | El administrador solo inicia una solicitud de 24 horas: no elige, recibe ni modifica ninguna contraseña; el flag bloquea sesiones preexistentes hasta completar el flujo |
| REC-011 | P0 | Usuario inexistente, cliente, cajero sin reset pendiente, código incorrecto/usado y segundo consumo producen la misma respuesta no enumerable |
| REC-012 | P0 | Dos consumos concurrentes del mismo código: exactamente uno cambia el hash, ambos preservan perfil/dispositivos/clientes y el perdedor no revoca ni sobrescribe el resultado |
| REC-013 | P0 | Completar el cambio revoca sesiones e incrementa `sessionVersion`, responde sin cookies y la sesión funcional solo aparece tras un login normal con la contraseña nueva |
| REC-014 | P0 | Una solicitud autenticada antes del reset no puede completar mensajes, adjuntos, receipts, typing, presencia, prekeys, rotación ni nuevas asignaciones después del commit; el trigger SQL cubre la carrera de asignación |
| REC-015 | P0 | El reset no cierra ni reasigna la clientela existente y el cliente aún puede bloquear/reportar al cajero y cargar evidencia cifrada |
| REC-016 | P0 | El registro muestra ocho códigos de cuenta una sola vez; PostgreSQL conserva solo hashes ligados al cajero y los códigos no vencen hasta uso o rotación |
| REC-017 | P0 | Rotar con la contraseña actual invalida atómicamente todos los códigos anteriores, entrega ocho nuevos sin persistir plaintext y falla cerrado durante suspensión o reset pendiente |

### 5.6 Reportes y evidencia

| ID | Prioridad | Escenario y resultado esperado |
| --- | --- | --- |
| RPT-001 | P0 | El panel admin no lista ni abre chats ordinarios; llamadas directas/IDOR a endpoints internos también fallan |
| RPT-002 | P0 | Antes de confirmar, el cliente ve que entregará toda la conversación vigente e imágenes; cancelar no bloquea, reporta ni copia |
| RPT-003 | P0 | Confirmar toma un snapshot de todos y solo los mensajes con `now < expires_at`, incluidos adjuntos, con IDs/hashes sin duplicados |
| RPT-004 | P0 | El paquete se cifra para la clave pública de investigación en el dispositivo; servidor, DB y operador no encuentran texto plano |
| RPT-005 | P0 | Sellado, relación bloqueada, snapshot y estado de reasignación son atómicos o conciliables; nunca continúa el chat con el cajero reportado |
| RPT-006 | P0 | Si falla la carga después del bloqueo, la seguridad del cliente no se revierte; el snapshot cifrado queda reintentable y el caso marca evidencia incompleta |
| RPT-007 | P0 | Mensajes que vencen durante la carga siguen la decisión de snapshot sin reabrir la conversación ordinaria |
| RPT-008 | P0 | Investigador autorizado abre exactamente el paquete del caso; otro admin/servicio no puede; cada acceso usa POST, exige contraseña actual, justificación de 20–1000 caracteres, límite de 5/min, assertion WebAuthn de menos de cinco minutos y auditoría |
| RPT-009 | P0 | Alterar manifiesto, hash, objeto, orden o ciphertext se detecta antes de mostrar evidencia |
| RPT-010 | P1 | La UI distingue evidencia aportada por el denunciante de autoría criptográficamente probada |
| RPT-011 | P0 | A las 48 h desaparece la copia ordinaria, pero el caso abierto continúa cifrado y legible solo en investigación |
| RPT-012 | P0 | Cerrar guarda primero `CLOSING` y un job; fallos inyectados antes/después del DELETE o durante la transacción conservan un reintento durable; solo tras purgar cierra/notifica/audita, elimina el job/objectKey y una búsqueda física no encuentra residuos gestionados |
| RPT-013 | P0 | Tras cerrar solo queda resultado administrativo sin citas, miniaturas, extractos ni contenido |
| RPT-014 | P1 | Cajero denunciado no recibe aviso al crear/abrir el caso; solo se notifica después del estado de revisión definido |
| RPT-015 | P0 | Dos confirmaciones/reintentos crean un solo caso, un bloqueo y una reasignación |
| RPT-016 | P0 | Eliminar la cuenta con caso abierto aplica DEC-09: caso separado permanece, cuenta se pseudonimiza y contenido ordinario se elimina |
| RPT-017 | P1 | Alertas identifican casos antiguos sin copiar su contenido a notificaciones o logs |
| RPT-018 | P0 | Repetir el PUT firmado recibe precondición fallida; solicitar cierre antes de vencer la firma conserva `CLOSING` y no purga hasta `purgeNotBefore`; después de cerrar, ningún replay recrea el objeto ni deja ciphertext huérfano |
| RPT-019 | P0 | Una carga lenta iniciada en el último instante de la firma es cortada por proveedor/proxy antes del margen de cinco minutos; cierre y recolector concurrentes no dejan un objeto huérfano |
| RPT-020 | P0 | El grant de evidencia, `X-Amz-Date` y `uploadAuthorizedUntil` nacen del mismo `clock_timestamp()`; con desfase controlado del nodo API la firma no cambia de reloj y un desfase DB/proveedor fuera del SLO bloquea staging |

### 5.7 Imágenes

| ID | Prioridad | Escenario y resultado esperado |
| --- | --- | --- |
| IMG-001 | P0 | JPEG/JPG, PNG y WebP menores o iguales a 5 MiB antes de cifrar se recodifican, cifran y descifran correctamente |
| IMG-002 | P0 | Archivo de más de 5 MiB, dos imágenes por mensaje o ciphertext sobre el máximo con overhead se rechaza antes de commit |
| IMG-003 | P0 | Extensión falsa, MIME falso, polyglot, SVG renombrado, dimensiones extremas y bomba de descompresión se rechazan en el extremo receptor sin ejecución |
| IMG-004 | P1 | Recodificación elimina EXIF, ubicación, perfiles/metadatos inesperados y nombres originales antes de cifrar |
| IMG-005 | P0 | Descifrado con tag inválido, objeto truncado o hash incorrecto no llega al decoder |
| IMG-006 | P0 | Cajero/cliente ajeno y admin no obtienen URL ni objeto; URL autorizada nunca supera `expires_at` |
| IMG-007 | P1 | Carga abortada y mensaje fallido dejan objetos temporales que el recolector elimina dentro del SLO |
| IMG-008 | P0 | Ningún thumbnail o previsualización se genera en servidor o se envía por push; si existe localmente, vence con el adjunto |
| IMG-009 | P0 | Cada PUT firmado exige `If-None-Match: *`; un segundo uso no reemplaza un adjunto ya verificado |
| IMG-010 | P0 | El grant de foto, `X-Amz-Date` y `grantExpiresAt` nacen del mismo `clock_timestamp()` aun con desfase controlado del nodo API |
| IMG-011 | P0 | Un PUT de foto iniciado al borde de los cinco minutos y ralentizado es cortado dentro del margen; el recolector espera `grantExpiresAt` y luego no queda objeto ni versión huérfana |

### 5.8 Autorización, administración y tiempo real

| ID | Prioridad | Escenario y resultado esperado |
| --- | --- | --- |
| AUTH-001 | P0 | Matriz completa rol × recurso × acción en HTTP y WS; se prueban IDs propios, ajenos, inexistentes y de otra conversación |
| AUTH-002 | P0 | Cambiar `role`, `userId`, `conversationId`, `assignmentId` o `deviceId` en payload no cambia la identidad autorizada |
| AUTH-003 | P0 | Suspensión/eliminación invalida sesión, socket, URL de objeto y próximos eventos sin esperar reconexión |
| AUTH-004 | P0 | Desaprobar o inactivar suscripción impide nuevos clientes y nuevos mensajes según la política, y dispara una sola reasignación por cliente |
| AUTH-005 | P0 | Admin puede gestionar cuentas/asignaciones/metadatos permitidos, pero ninguna variante de consulta devuelve sobres, adjuntos o claves |
| AUTH-006 | P0 | Una contraseña administrativa correcta crea una sesión limitada con `adminMfaVerifiedAt = NULL`; `RolesGuard` bloquea todo endpoint `ADMIN` hasta verificar WebAuthn, pero permite las rutas de estado, enrolamiento, autenticación, recuperación y logout necesarias para completar la ceremonia |
| AUTH-007 | P0 | El registro incluye la versión exacta de términos aceptada; una versión distinta a la vigente se rechaza antes de crear usuario, aceptación o asignación |
| AUTH-008 | P0 | Si la versión de términos cambia entre la validación inicial y la transacción, el reloj de PostgreSQL y la segunda comprobación abortan el alta completa |
| AUTH-009 | P1 | Cualquier petición autenticada que reciba `SESSION_INVALID` desmonta el panel, aborta y cierra E2EE, y vuelve al inicio de sesión; un `401` funcional distinto, como contraseña actual incorrecta, no se confunde con vencimiento |
| WEB-001 | P1 | Si falla la descarga o ejecución de un panel cargado de forma diferida, el límite de errores evita una pantalla vacía y ofrece recarga o regreso seguro al inicio de sesión sin registrar estado ni propiedades sensibles |
| WEB-002 | P0 | El parser web del listado de conversaciones acepta únicamente metadatos documentados; cualquier campo adicional de contenido, ciphertext, sobre o adjunto falla cerrado y no se representa |
| WEB-003 | P1 | Cliente fuerza una sola conversación y cajero recorre páginas sin límite silencioso; páginas incoherentes, saltadas o con distinto tamaño no se anexan al panel |
| WEB-004 | P0 | Mientras el gate E2EE está `BLOCKED`, el panel puede mostrar la asignación pero no ofrece envío, historial ni reporte incompleto; el bloqueo con motivo del cajero sí reasigna y retira al cliente de la lista local tras éxito HTTP |
| AUTH-010 | P1 | Con más de 100 clientes y cajeros, asignaciones y suscripciones recorren todas sus páginas con totales globales independientes de la página de usuarios; las respuestas no contienen conversación, mensaje, sobre, adjunto, clave ni ciphertext |
| AUTH-011 | P1 | Alta o revocación de onboarding, edición, aprobación, suspensión, reactivación, suscripción, reasignación, baja y reset administrativo funcionan sin campo ni diálogo de motivo; las acciones sensibles mantienen confirmación y cada operación deja un código automático estable en la auditoría |
| AUTH-012 | P1 | UI, DTO y API no reutilizan un campo genérico de motivo en operaciones ordinarias; el texto libre sigue siendo obligatorio únicamente en bloqueos/reportes de moderación, tickets, acceso a evidencia y resolución o devolución de reportes, con sus validaciones específicas |
| AUTH-013 | P0 | El primer enrolamiento exige credencial residente, presencia y verificación del usuario, RP ID y origen exactos; persiste solo clave pública/contador y devuelve exactamente diez códigos de recuperación una única vez, sin registrarlos en logs ni almacenamiento del navegador |
| AUTH-014 | P0 | Cada desafío WebAuthn queda ligado a administrador, sesión y propósito, se persiste solo como SHA-256, reemplaza el anterior del mismo propósito, vence a los cinco minutos y solo una de dos verificaciones concurrentes puede consumirlo |
| AUTH-015 | P0 | Una assertion válida actualiza atómicamente el contador esperado y `adminMfaVerifiedAt`; replay, contador concurrente, credencial revocada, usuario/sesión ajenos, origen o RP ID distintos fallan cerrados sin verificar la sesión |
| AUTH-016 | P0 | Un código de recuperación válido se consume una sola vez y revoca todas las passkeys, los demás códigos, desafíos abiertos y otras sesiones; la sesión actual queda limitada, el panel sigue bloqueado y un nuevo enrolamiento emite un lote nuevo de diez códigos |
| AUTH-017 | P0 | Acceder a evidencia exige `adminMfaVerifiedAt` estrictamente posterior a `DB now() - 5 minutos`; el instante exacto del límite, un valor futuro y una sesión sin assertion reciben `ADMIN_MFA_STEP_UP_REQUIRED`, y la PWA autentica y reintenta una sola vez |
| AUTH-018 | P1 | La configuración de producción rechaza RP ID ausente, localhost, protocolo, dominio padre o cualquier host distinto del origen; staging valida HTTPS, dominio estable y ceremonias reales en todos los navegadores/autenticadores declarados como soportados |
| AUTH-019 | P1 | `check:webauthn-browser` debe completar en Chrome/Edge login limitado, primer enrolamiento, diez códigos, step-up obligatorio para una passkey de respaldo, recuperación real de un uso, segundo login, assertion, panel, inventario y revocación auditada del respaldo, step-up vencido y revocación auditada de otra sesión con un autenticador virtual; nunca imprime secretos y deja la identidad reservada `DELETED`, sin sesiones, credenciales ni códigos activos, conservando el ledger append-only |
| AUTH-020 | P0 | El parser previo rechaza `crossOrigin=true`, tipos no booleanos y cualquier `topOrigin`; una ceremonia delegada por un iframe no alcanza la verificación criptográfica aunque el origen interior coincida |
| AUTH-021 | P0 | El listado devuelve solo sesiones activas propias y exactamente una marcada como actual, sin token, IP ni user-agent; la UI nunca ofrece cerrar la actual, mientras la revocación individual y la masiva exigen assertion WebAuthn estrictamente menor a cinco minutos, son idempotentes y auditan únicamente cambios reales |
| AUTH-022 | P0 | El inventario devuelve de una a diez passkeys activas propias y solo ID interno, fecha de alta, último uso, tipo de dispositivo y backup; rechaza una undécima, nunca expone `credentialId`, clave pública o transports, no permite revocar la última, serializa revocaciones concurrentes mediante el bloqueo del usuario, exige MFA reciente y registra exactamente un `ADMIN_PASSKEY_REVOKED` por cambio real |
| AUTH-023 | P0 | El primer enrolamiento funciona sin MFA previo porque aún no existe una passkey; desde la segunda, tanto las opciones de registro como la verificación transaccional exigen `adminMfaVerifiedAt` estrictamente reciente, y la PWA hace como máximo un step-up y un reintento |
| AUTH-024 | P0 | `check:webauthn-concurrency` aplica migraciones en una base local temporal y comprueba dos transacciones realmente bloqueadas a la vez: dos revocaciones sobre dos passkeys conservan una; dos altas sobre nueve conservan diez y no consumen el desafío perdedor; cada carrera genera exactamente una auditoría y la base temporal se elimina tras comprobar su identidad |
| AUTH-025 | P0 | Los conflictos Prisma `P2034` y SQLSTATE `40001`/`40P01` envueltos en `P2010` responden HTTP 409 `ADMIN_MFA_CONCURRENT_CHANGE`, sin filtrar datos SQL ni repetir operaciones; otros errores no se disfrazan de conflicto; la prueba Chrome conserva inventario y confirmación, muestra el mensaje y verifica un solo DELETE y ninguna autenticación automática |
| WS-001 | P0 | Socket sin cookie, con cookie vencida, origen no permitido o usuario incorrecto no conecta |
| WS-002 | P0 | Cada evento vuelve a autorizar; revocar durante una conexión activa surte efecto en el siguiente evento |
| WS-003 | P1 | Presencia y escribiendo solo llegan al interlocutor del chat activo, tienen rate limit y no se conservan |
| WS-004 | P0 | Desconexión/reconexión/replay no duplica mensajes ni omite expiración |
| RATE-001 | P0 | Dos o más instancias comparten el cupo HTTP: repartir peticiones entre nodos no aumenta el límite efectivo |
| RATE-002 | P0 | El script Redis incrementa, bloquea y fija TTL atómicamente con `TIME`; carga concurrente no pierde incrementos ni crea ventanas por reloj de nodo |
| RATE-003 | P0 | Caída, timeout, respuesta inválida o estado no-ready de Redis falla cerrado en HTTP y desconecta WebSocket sin consultar PostgreSQL |
| RATE-004 | P0 | Las claves observadas en Redis contienen solo namespace y HMAC; no incluyen IP, cookie, usuario, ruta ni identificador en claro |
| RATE-005 | P0 | Conexiones WebSocket inválidas y reconexiones distribuidas alcanzan el límite antes de consultar la sesión en PostgreSQL; un par no confiable no falsifica IP con `X-Forwarded-For` y dos clientes tras el mismo proxy confiable conservan claves distintas |
| RATE-006 | P0 | El noveno `conversation:typing` en dos segundos y eventos desconocidos se rechazan por conexión antes de Redis/DB; el límite distribuido por usuario no se evade con múltiples sockets o nodos |
| RATE-007 | P1 | Un cliente legítimo bajo NAT y la carga objetivo conservan margen; headers HTTP y errores WS no revelan tracker, HMAC ni topología Redis |

### 5.9 Logs, notificaciones y privacidad de metadatos

| ID | Prioridad | Escenario y resultado esperado |
| --- | --- | --- |
| LOG-001 | P0 | Canarios de texto, imagen, clave, recuperación y evidencia no aparecen en logs, trazas, métricas, errores ni analítica |
| LOG-002 | P1 | Auditoría contiene actor, acción, objetivo, tiempo y resultado necesarios, pero no cuerpo de chat, evidencia, token o URL firmada |
| PUSH-001 | P0 | Payload externo es genérico y no contiene usuario del interlocutor, texto, tipo de imagen, motivo o identificador correlacionable |
| PUSH-002 | P0 | Push atrasado después de 48 h no muestra previsualización ni permite recuperar el mensaje |
| PUSH-003 | P1 | Endpoint push revocado/ajeno no permite consultar cuenta, chat o presencia |

## 6. Pruebas de seguridad adicionales

### Aplicación y API

- Fuzzing de DTO, eventos WebSocket, cursores, códigos y paquetes cifrados.
- Inyección SQL/NoSQL, XSS almacenado/reflejado/DOM, CSRF, SSRF, traversal,
  request smuggling y mass assignment.
- Pruebas de rate limit distribuidas y evasión por socket/reconexión.
- Verificación de cookies, CORS/origin, CSP, Trusted Types, headers y TLS.
- DAST autenticado para los tres roles y pruebas manuales de lógica de negocio.
- Revisión de que errores y health checks no revelen secretos o topología.

### Cadena de suministro

- Lockfile reproducible, SBOM por versión y escaneo de dependencias de producción
  y desarrollo.
- Escaneo de secretos, SAST y análisis de licencias en CI.
- Artefacto construido una vez, firmado/promovido sin recompilar y hash verificable.
- Dependabot/proceso equivalente con SLA de parcheo.
- Prueba de actualización y retirada forzada de service worker vulnerable.

### Infraestructura

- Roles separados para API, worker, migración, backup e investigación.
- Ejecutar `npm.cmd run check:storage` en el entorno local: debe validar bucket
  versionado privado, CORS, IAM limitado, checksum, replay, descarga y cero
  versiones tras la purga.
- Intentos explícitos de leer recursos fuera de cada rol.
- Cifrado TLS y en reposo, rotación de secretos y restauración documentada.
- Buckets sin acceso público, política de ciclo de vida como defensa adicional.
- Escaneo de imágenes de contenedor y ejecución sin privilegios.

## 7. Concurrencia, carga y resiliencia

Antes de fijar números de infraestructura se debe aprobar un objetivo de capacidad
de lanzamiento. Como mínimo:

- definir sockets concurrentes, mensajes por segundo, cargas de imágenes por
  minuto y número de reasignaciones masivas esperadas;
- ejecutar carga sostenida al objetivo y picos a 2×;
- demostrar que autorización y expiración no se omiten bajo backpressure;
- medir p50, p95 y p99 de entrega, creación de reporte y purga;
- reiniciar API y worker durante mensajes, reportes y reasignaciones;
- simular caída de PostgreSQL, objetos, caché, push y red del cliente;
- verificar reconciliación de operaciones parcialmente confirmadas; y
- comprobar que el modo degradado falla cerrado para privacidad.

La ausencia actual de una estimación de volumen no impide desarrollar, pero sí
impide declarar una capacidad de producción y un costo máximo.

## 8. Criterios de salida a producción

### Producto y datos

- Las decisiones DEC-01 a DEC-13 de `THREAT_MODEL.md` están ratificadas y
  reflejadas en especificación, UX, ADR y política de privacidad.
- Todos los P0 y P1 pasan en CI y staging; no hay pruebas críticas deshabilitadas o
  inestables.
- Matriz de roles y máquinas de estado de cuenta, conversación, asignación,
  bloqueo y reporte aprobadas.
- Términos/versionado de aceptación, fecha de nacimiento y aviso de mayoría de
  edad probados; tratamiento legal de datos y evidencia revisado para los países
  de operación.
- Cambio concurrente v1→v2: el formulario conserva el contenido/hash de v1, el
  backend serializa publicación y registro, rechaza la aceptación ya obsoleta y
  la interfaz desmarca la casilla sin actualizarla silenciosamente.
- Invariante legal en PostgreSQL: se rechazan inserciones con `accepted_at`
  fuera de `[effective_at, retired_at)` y retiros que dejarían aceptaciones fuera
  de su ventana; probar además reintento de conflicto serializable.

### Criptografía y privacidad

- ADR selecciona protocolo y biblioteca mantenidos, modelo de dispositivos,
  recuperación, transparencia/cambio de identidad y formato de adjuntos.
- Revisión criptográfica externa completada; cero hallazgos críticos o altos
  abiertos y riesgos residuales aprobados por escrito.
- Prueba automática demuestra ausencia de plaintext y claves en todo componente
  servidor.
- Administrador y reset de contraseña no descifran ni autorizan dispositivos.
- Reporte es la única ruta de contenido hacia investigación y su cierre purga.
- SLO de expiración/borrado medido bajo carga, caída y restauración.

### Seguridad de aplicación

- Pentest independiente de autorización, lógica de negocio, PWA/WS y panel
  administrativo; cero críticos/altos abiertos.
- La implementación WebAuthn/passkey administrativa pasa la suite P0/P1; dominio,
  HTTPS, navegadores/autenticadores soportados, custodia de códigos,
  recuperación y respuesta a ingeniería social quedan ensayados y documentados.
- Sin secretos en repositorio/artefactos; SBOM, SAST, DAST y dependencias sin
  críticos/altos explotables.
- CSP estricta sin excepciones temporales peligrosas, protección CSRF, rate limits
  y sesiones verificadas.

### Operación

- Capacidad inicial y presupuesto de recursos aprobados; carga a 2× satisface SLO.
- Monitores y alertas para expiración atrasada, objetos huérfanos, fallos de
  reasignación, reportes incompletos, intentos de acceso y salud de prekeys.
- Runbooks ensayados para caída del worker, fuga de sesión, dispositivo perdido,
  compromiso de clave de investigación, restauración y rollback.
- Backups no reintroducen contenido efímero; restauración probada.
- Clave de investigación fuera del servidor, con respaldo offline cifrado,
  rotación y recuperación probadas.
- Auditoría administrativa protegida contra alteración y con retención definida.
- Responsable y plazo de atención para alertas de casos abiertos y borrado.

### Lanzamiento y cliente web

- Artefactos reproducibles, revisados y promovidos con integridad.
- Service worker actualiza/retira versiones de forma segura y no cachea contenido
  vencido.
- Navegadores/dispositivos soportados publicados; E2E completo en cada uno.
- Política de privacidad explica E2EE, metadatos, reportes, retención y límites
  frente a capturas/dispositivos comprometidos.
- Despliegue gradual, rollback probado y plan de respuesta a incidentes activo.

## 9. Condiciones de no lanzamiento

SinoChat no debe recibir usuarios reales si se cumple cualquiera:

- la integración Matrix E2EE, su transporte privado completo o la autorización
  multidispositivo siguen pendientes;
- distribución Olm de room keys, rotación Megolm por mensaje, bindings interiores
  o lectura repetida tras reabrir el store no están demostrados extremo a extremo;
- no hubo auditoría criptográfica externa y pentest independientes;
- el administrador o un reset pueden añadir silenciosamente un dispositivo;
- existe una ruta de servidor que recibe plaintext o claves;
- contenido vencido puede obtenerse por API, WS, objetos, caché o PWA;
- el borrado no está medido/alertado o los backups reintroducen payload;
- el reporte no separa clave, permisos y retención;
- las carreras permiten dos chats activos, reasignar a bloqueados o evitar el
  quinto bloqueo;
- la frontera MFA administrativa se puede omitir, o su configuración WebAuthn,
  recuperación, logs seguros o procedimiento de incidentes no fueron
  certificados operativamente; o
- capacidad objetivo y comportamiento bajo caída no están definidos.
