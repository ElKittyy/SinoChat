# Gestión administrativa de usuarios

## Endpoints

- `GET /api/admin/users`: lista y busca cuentas con paginación.
- `GET /api/admin/assignments`: lista asignaciones activas con paginación
  propia y filtro opcional por cajero.
- `GET /api/admin/subscriptions`: lista todos los cajeros y el último período
  de suscripción, con paginación y total global de períodos vigentes.
- `PATCH /api/admin/users/:userId`: edita los campos permitidos.
- `DELETE /api/admin/users/:userId`: ejecuta la baja lógica.
- `PATCH /api/admin/users/:userId/password`: restablece únicamente la
  contraseña de una cuenta `CASHIER`.
- `POST /api/auth/complete-admin-reset`: consume un código personal de un solo
  uso y obliga al cajero a definir una contraseña distinta antes de entrar.
- `POST /api/auth/cashiers/recovery-codes/rotate`: invalida los códigos
  anteriores y muestra ocho nuevos tras verificar la contraseña actual.
- `POST /api/admin/cashier-invitations`: inicia el onboarding de un cajero.

Los endpoints de `/api/admin` requieren sesión `ADMIN` y protección CSRF. Las
operaciones administrativas ordinarias no solicitan ni aceptan un motivo de
texto libre: la interfaz muestra una confirmación simple cuando la acción es
sensible y el servidor asigna un código de auditoría estable. Esto incluye alta
y revocación de onboarding, edición, aprobación, suspensión, reactivación,
activación o desactivación de suscripción, reasignación, baja y restablecimiento
de contraseña. `complete-admin-reset` no acepta una sesión previa: usa JSON,
límite de frecuencia y una respuesta no enumerable.

Las tres consultas administrativas tienen páginas de 1 a 100 elementos. Las
asignaciones y suscripciones no se derivan de la página visible de usuarios:
conservan su propio cursor de página y totales globales, por lo que siguen
siendo completas al crecer la plataforma. Devuelven exclusivamente identidad,
estado, vínculo, origen y fechas administrativas; no seleccionan conversación,
mensajes, sobres, adjuntos, claves ni ciphertext.

## Límites de alta

El administrador no crea cuentas completas ni acepta términos en nombre de
otra persona.

- Un cajero recibe una invitación de onboarding de un solo uso y con
  vencimiento. El titular elige usuario, contraseña, fecha de nacimiento y
  acepta los términos durante el registro.
- Un cliente debe registrarse con el enlace único del cajero que lo atenderá.
  Ese enlace pertenece al cajero y determina la asignación inicial.

El modelo actual no tiene una invitación de cliente independiente ni permite
crear un cliente sin cajero. Por eso el panel no fabrica, rota ni revela el
código de un cajero para simular un alta administrativa. Hacerlo cambiaría la
propiedad del enlace y podría invalidar invitaciones ya distribuidas.

Los enlaces compartibles usan `/invitacion#cajero=...` para onboarding y
`/invitacion#cliente=...` para clientes. El código nunca se coloca en path,
query ni `history.state`: la PWA consume y elimina el fragmento al arrancar y
lo mantiene solo en memoria hasta completar el registro. La validación se hace
por `POST /api/invitations/validate`; el código vigente de un cajero se revela
por `POST /api/cashier/invitation/reveal`, nunca mediante `GET`.

## Edición

Solo se pueden editar cuentas `CLIENT` y `CASHIER` no eliminadas.

- Ambas admiten cambio de `username`.
- Solo un cajero admite cambio de correo y teléfono.
- Si el cajero ya estaba aprobado, un cambio administrativo de contacto queda
  verificado en la misma operación. Si aún estaba pendiente, sigue sin
  verificarse hasta la aprobación.
- Cada edición conserva un evento `USER_UPDATED` con un código automático y
  valores administrativos anteriores y posteriores. No contiene datos del
  chat.

## Eliminación lógica

La baja se ejecuta dentro de una transacción serializable:

- marca la cuenta como `DELETED` y establece `deletedAt`;
- incrementa `sessionVersion`, revoca todas las sesiones y, después del
  commit, desconecta los sockets del usuario;
- para un cliente, cierra su asignación y conversación activas y cancela
  cualquier reasignación pendiente;
- para un cajero, cierra las asignaciones actuales y reasigna cada cliente al
  cajero elegible con menor carga, o deja una solicitud pendiente si no hay
  candidato;
- revoca las invitaciones activas del cajero, cancela sus suscripciones
  activas y marca su aprobación como revocada;
- conserva perfiles, auditoría, bloqueos, reportes, asignaciones,
  conversaciones y mensajes.

Cerrar una conversación no elimina sus mensajes. El worker de retención sigue
siendo el único responsable de su eliminación permanente al cumplir 48 horas.

## Restablecimiento de contraseña

Solo las cuentas `CASHIER` admiten este procedimiento. El administrador
confirma la acción sin proporcionar motivo ni credencial. El servidor:

- invalida cualquier solicitud abierta y crea una nueva que vence en 24 horas;
- no cambia `passwordHash` ni `passwordChangedAt` y nunca devuelve un secreto;
- activa `passwordResetRequired` e incrementa `sessionVersion`;
- revoca todas las sesiones y desconecta sockets después del commit;
- registra `PASSWORD_RESET` con el motivo automático del servidor.

Al registrarse, el cajero recibe ocho códigos de cuenta aleatorios que la API
muestra una sola vez. PostgreSQL conserva solo hashes ligados al ID del cajero;
los códigos no vencen automáticamente, se consumen una vez y todos los no usados
se invalidan al rotarlos desde una sesión autenticada. El administrador no puede
consultarlos, generarlos para otra persona ni usarlos desde el panel.

El login normal rechaza toda autenticación mientras la solicitud está pendiente,
sin crear sesión ni cookies. El titular usa `complete-admin-reset` con usuario,
uno de esos códigos y una contraseña nueva fuerte y diferente. En una transacción
serializable se bloquean usuario, solicitud y código; un consumo concurrente o
repetido falla sin revocar ni sobrescribir el resultado ganador. Al completarse:

- limpia `passwordResetRequired`, vuelve a incrementar `sessionVersion` y
  revoca defensivamente cualquier sesión todavía abierta;
- responde `204` sin iniciar sesión; el cajero debe entrar normalmente con la
  contraseña nueva;
- un cajero suspendido puede reemplazar la credencial, pero sigue sin obtener
  acceso mientras permanezca suspendido.

Mientras el indicador está activo, las consultas de elegibilidad impiden que el
cajero envíe mensajes o adjuntos, actualice recibos, publique presencia/typing,
use preclaves, rote invitaciones o reciba clientes nuevos. Las asignaciones y
conversaciones existentes no se cierran ni se redistribuyen por este motivo. El
cliente conserva expresamente la ruta separada para bloquear/reportar al cajero
y cargar su evidencia cifrada durante el restablecimiento.

No se modifican dispositivos, bundles de claves, asignaciones ni material
E2EE.

Una cuenta `CLIENT` no dispone de restablecimiento administrativo. Si pierde
sus credenciales, pierde el acceso; un código de recuperación criptográfica no
recupera la cuenta ni sustituye la contraseña.

## Límites de atomicidad y operación

- Los cambios de base de datos y su auditoría se confirman juntos. La
  desconexión del socket ocurre después del commit y no puede formar parte de
  la transacción SQL. Si el proceso falla en ese intervalo, la sesión ya está
  revocada en base de datos, pero el cierre inmediato del transporte requiere
  reintento o reconciliación operativa.
- Crear una invitación y auditarla es atómico, pero entregar su código en la
  respuesta HTTP no lo es. Si se pierde la respuesta después del commit, la
  invitación permanece válida hasta vencer. El secreto no puede recuperarse,
  pero el panel permite localizar sus metadatos y revocarla para emitir una
  nueva sin conservar el código en claro.

## Auditoría

Toda operación administrativa ordinaria se audita de forma inmutable con actor,
acción, objetivo, fecha, resultado y un código automático; no depende de que el
administrador redacte una explicación. Los cuerpos de estas solicitudes no
incluyen un campo genérico `reason` y la interfaz no presenta una caja de texto.

El texto libre queda reservado para flujos en los que la explicación forma
parte del caso: motivos de bloqueo o reporte, tickets, justificación para abrir
evidencia y resolución o devolución de un reporte. Esos textos conservan sus
límites y validaciones específicos y nunca se copian a una operación rutinaria.
La migración `20260727010000_admin_audit_details` mantiene capacidad suficiente
en los campos de `admin_audit_events` para estas justificaciones excepcionales
sin truncarlas.
