# Especificación funcional de SinoChat

Estado: aprobada para iniciar el desarrollo.

## Roles

### Cliente

- Se registra con nombre de usuario, contraseña, fecha de nacimiento y aceptación
  de términos.
- Debe declarar ser mayor de edad.
- Solo puede registrarse mediante el enlace o código vigente de un cajero.
- Tiene un único cajero asignado y un único chat activo.
- Puede enviar texto e imágenes JPEG, JPG, PNG o WebP de hasta 5 MiB.
- Puede reportar y bloquear a su cajero indicando un motivo de al menos 20
  caracteres. La acción provoca una reasignación.
- No dispone de recuperación de cuenta si pierde sus credenciales y su código de
  recuperación.

### Cajero

- Se registra con correo, usuario, contraseña y teléfono.
- Debe ser aprobado por el administrador y tener una suscripción activa para
  recibir clientes.
- Posee un código y enlace de invitación ilimitados que puede regenerar. Al
  regenerarlos, el valor anterior queda invalidado.
- El código se genera criptográficamente en el servidor; el cajero puede rotarlo,
  pero no elegir un valor débil o predecible.
- Atiende varios chats independientes.
- Puede bloquear a un cliente con un motivo de al menos 20 caracteres. El cliente
  se reasigna automáticamente.
- Puede solicitar al administrador un restablecimiento de acceso. Para recuperar
  la cuenta usa uno de ocho códigos de un solo uso mostrados al registrarse; el
  administrador solo abre una solicitud de 24 horas y nunca conoce credenciales.
  Los códigos de cuenta no vencen hasta uso o rotación. Para recuperar además
  los mensajes cifrados necesita un dispositivo confiable o el material de
  recuperación E2EE, que es independiente.
- No existe un cupo máximo de clientes.

### Administrador

- Puede crear, consultar, modificar, suspender y eliminar clientes y cajeros.
- Aprueba cajeros y administra manualmente el estado de suscripción.
- Las acciones administrativas ordinarias se confirman sin pedir una explicación
  escrita y generan auditoría automática. El texto libre se reserva para
  reportes, tickets, acceso a evidencia, resolución o devolución de reportes y
  bloqueos de moderación.
- Puede consultar las asignaciones entre clientes y cajeros y sus cantidades.
- No puede consultar conversaciones ordinarias ni claves privadas.
- Puede revisar únicamente la copia de una conversación entregada voluntariamente
  como evidencia durante un reporte.

## Asignación

- Un alta mediante enlace o código queda vinculada al cajero propietario.
- La clientela existente nunca se redistribuye para equilibrar cantidades.
- Solo se reasignan clientes por bloqueo, reporte, suspensión del cajero,
  desaprobación o suscripción inactiva.
- Para una reasignación se excluyen cajeros no disponibles, el cajero anterior y
  relaciones bloqueadas.
- Se elige entre los cajeros disponibles con menor cantidad de clientes.
- Si hay empate, la elección es aleatoria.
- La nueva conversación comienza sin historial.
- Si no existe ningún cajero elegible, el cliente queda en
  `PENDING_REASSIGNMENT`, sin chat activo. El sistema reintenta cuando aparece un
  cajero disponible y nunca relaja bloqueos, aprobación o suscripción.

## Bloqueos y reportes

- Todo bloqueo o reporte requiere texto libre de al menos 20 caracteres.
- Al reportar a un cajero se incluye toda la conversación todavía disponible,
  incluidas las imágenes.
- La evidencia se conserva cifrada para el administrador hasta que este cierre el
  caso. Al cerrarlo se elimina el contenido y se conserva únicamente el resultado
  administrativo.
- El usuario denunciado se informa después de la revisión.
- Un bloqueo de cliente solo cuenta para el límite si procede de un cajero
  diferente.
- Al llegar a cinco bloqueos distintos, la cuenta del cliente se suspende y pasa a
  revisión; no se elimina automáticamente ni se vuelve a reasignar hasta que el
  administrador resuelva el caso.
- Para un cliente, bloquear a un cajero y reportarlo es una única operación
  atómica: sella el chat, fija la evidencia todavía vigente y solicita la
  reasignación.

## Mensajería

- Texto máximo: 4.000 caracteres.
- Una imagen como máximo por mensaje.
- Estados: enviando, enviado, entregado y leído.
- Indicadores: escribiendo y presencia en línea.
- Avisos internos y notificaciones push genéricas, sin contenido del mensaje.
- Se permiten varias sesiones y dispositivos.

## Retención

- Cada mensaje y adjunto vence exactamente 48 horas después de su creación.
- Al vencer deja de estar disponible de inmediato.
- Se elimina de base de datos, almacenamiento, cachés y almacenamiento local de la
  aplicación mediante trabajos idempotentes y monitorizados.
- La inaccesibilidad se aplica exactamente en `expires_at`. Debido a los límites
  físicos de proveedores y dispositivos apagados, la purga online tendrá un SLO
  inicial de p99 menor a 60 segundos y máximo operativo de 5 minutos; ningún
  payload efímero entra en copias de seguridad.
- Las evidencias de un reporte son una copia separada y siguen su propio ciclo de
  retención.

## Identidad

- Nombre: SinoChat.
- Rojo: `#C8102E`.
- Negro: `#111111`.
- Dorado: `#D4AF37`.
- Idioma inicial: español.
- PWA responsive para computadora y dispositivos móviles.
- Los logotipos pueden adaptarse en tamaño, encuadre y formato, pero no modificarse
  en su diseño.

## Fuera del primer alcance

- Cobros automatizados.
- Otros idiomas.
- Dominio y proveedor definitivo de producción.
- Verificación documental de identidad.
