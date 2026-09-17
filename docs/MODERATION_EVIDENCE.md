# Moderación y evidencia cifrada

## Límite de privacidad

Los servicios de moderación no consultan `Message`, `MessageEnvelope`,
`Attachment` ni el contenido de una conversación ordinaria. Un reporte existe
solo cuando el dispositivo del cliente prepara voluntariamente una copia de lo
que todavía puede ver y la cifra para una `InvestigationKey`.

La API conserva únicamente el paquete cifrado, su tamaño, SHA-256, algoritmo,
versión de manifiesto y relaciones administrativas. La clave privada de
investigación debe vivir fuera del servidor y del panel web ordinario, bajo
custodia administrativa separada.

## Contrato del dispositivo, versión 1

Antes de confirmar la acción, la interfaz debe explicar que el chat vigente,
incluidas sus imágenes aún disponibles, se entregará al administrador hasta el
cierre del caso. El dispositivo:

1. obtiene `GET /api/moderation/investigation-key`;
2. toma un snapshot consistente de todos los mensajes no vencidos de la
   conversación actual;
3. crea un manifiesto versión 1 con `assignmentId`, `conversationId`, fecha del
   snapshot, IDs, secuencias y fechas emitidas por el servidor, fingerprints de
   dispositivos, hashes de sobres originales y hashes de cada imagen;
4. incluye el contenido descifrado y las imágenes recodificadas que el cliente
   está denunciando;
5. firma el manifiesto con la identidad del dispositivo denunciante;
6. cifra el paquete completo para la clave pública de investigación mediante
   una implementación criptográfica auditada;
7. solicita `POST /api/moderation/report-evidence/upload-grant` indicando
   `investigationKeyId`, tamaño exacto del ciphertext, SHA-256, `cipherSuite` y
   `manifestVersion: 1`;
8. carga `application/octet-stream` con todos los headers firmados; y
9. confirma `POST /api/moderation/report-cashier` con el motivo y
   `evidenceGrantToken`.

La carga al almacenamiento ocurre antes de la transacción porque un objeto S3
no puede participar en una transacción PostgreSQL. La confirmación sí crea de
forma serializable y atómica el bloqueo, reporte, referencia de evidencia,
cierre de conversación y solicitud de reasignación. Un permiso vence en diez
minutos y está ligado al cliente, asignación, conversación, clave, hash y
tamaño. El máximo defensivo inicial del paquete cifrado es 512 MiB.

La aplicación web todavía debe implementar el empaquetador, la firma y el
cifrado del manifiesto. No se debe sustituir este punto por criptografía propia
ni enviar texto plano a la API.

## Revisión administrativa

- `GET /api/admin/reports` devuelve metadatos, nunca chats ordinarios ni claves
  de objeto. También expone `CLOSING` y el estado operativo no sensible de su
  reintento.
- `PATCH /api/admin/reports/:id/review` asigna el caso al administrador.
- `POST /api/admin/reports/:id/evidence-access` exige `currentPassword` y una
  justificación recortada de 20 a 1000 caracteres. Tiene un límite adicional de
  cinco intentos por minuto, reautentica la contraseña Argon2id y funciona
  únicamente durante `IN_REVIEW` para el administrador asignado. La URL dura 60
  segundos y la justificación queda en el evento de auditoría antes de que la
  respuesta sea entregada.
- La descarga se abre y descifra solo en la estación de investigación externa.
- `PATCH /api/admin/reports/:id/close` requiere resultado y resumen. Una
  evidencia accedida previamente por el mismo revisor (evento de auditoría
  `REPORT_EVIDENCE_ACCESSED`) es una precondición; iniciar la revisión por sí
  solo no habilita un borrado irreversible. Una
  transacción guarda la intención, pasa el caso a `CLOSING` y crea exactamente
  un `ReportClosureJob` con lease persistente. Desde ese momento no se emiten
  nuevas URLs de evidencia.
- Los resultados `CASHIER_SUSPENDED` y `CASHIER_DELETED` describen hechos, no
  órdenes diferidas: el cajero debe estar ya suspendido o eliminado mediante el
  flujo administrativo auditado. La API rechaza cerrar si el estado no coincide.
- El resultado `WARNING` genera una notificación administrativa específica para
  el cajero en la misma transacción que registra el cierre y su outcome. No
  incluye evidencia ni contenido del chat.
- El worker intenta la purga inmediatamente y también recorre los jobs
  pendientes una vez vencida toda autorización de carga. Cada PUT exige
  `If-None-Match: *`, y el job conserva `purgeNotBefore` a partir del
  `uploadAuthorizedUntil` original; una firma de carga todavía válida nunca
  puede recrear ciphertext después de que se olvide la clave. Solo después de
  borrar permanentemente el objeto elimina
  `ReportEvidence`, marca `CLOSED` y `evidencePurgedAt`, notifica, audita y
  elimina el job. Al eliminar el job también desaparece la última copia de
  `objectKey`.

El inicio criptográfico de la firma (`X-Amz-Date`), el grant y
`uploadAuthorizedUntil` comparten exactamente el mismo instante obtenido con
`clock_timestamp()` de PostgreSQL. Esta invariante se prueba para impedir que
el reloj local de una instancia API acorte o prolongue silenciosamente la
ventana de carga respecto del límite de purga.

El margen entre la firma de cinco minutos y la autorización de diez solo es
válido si el proveedor corta cualquier PUT que permanezca abierto cinco minutos
o más. Antes de producción debe comprobarse con una carga deliberadamente lenta
que ningún request en vuelo termina después de `purgeNotBefore`; hasta certificar
ese límite del proveedor, el cierre resistente a replays sigue siendo un gate.

Si el proveedor o PostgreSQL falla, el reporte continúa `CLOSING`. El job libera
su lease y programa un backoff exponencial limitado a cinco minutos; si esa
actualización falla, la lease vence como máximo en dos minutos. Un reintento
repite el borrado idempotente y completa la transacción. Nunca se marca evidencia
como purgada, se notifica ni se audita el cierre antes de borrar el objeto y la
fila cifrada.

Que un caso permanezca brevemente en `CLOSING` tras solicitar su cierre puede
ser deliberado: el límite de autorización de carga es inmutable y no se adelanta
para acelerar la purga.

## Operación pendiente antes de producción

La organización debe generar cada par de investigación fuera de SinoChat,
registrar solo su clave pública y fingerprint mediante
`npm run investigation-key:register --workspace @sinochat/api`, y conservar la
privada en hardware o keystore separado con MFA, respaldo cifrado y
procedimiento de rotación. El procedimiento y sus validaciones se encuentran en
`docs/OPERATIONS.md`. No deben aplicarse reglas de ciclo de vida al prefijo de
evidencia confirmada porque los casos se conservan hasta que el administrador
los cierre.

El endpoint combina reautenticación por contraseña con un step-up WebAuthn de
menos de cinco minutos. La PWA solicita la passkey al recibir
`ADMIN_MFA_STEP_UP_REQUIRED` y reintenta una sola vez. Antes de producción aún
deben certificarse RP ID/HTTPS, navegadores, recuperación y alertas fuera de
banda; la clave privada de investigación continúa fuera del servidor.
