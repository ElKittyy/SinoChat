# Modelo de amenazas de SinoChat

Estado: modelo activo previo a producción; perfil E2EE aún bloqueado.  
Alcance: primera versión de producción descrita en `PRODUCT_SPEC.md`,
`SECURITY.md` y `ARCHITECTURE.md`.

Este documento define qué debe proteger SinoChat, frente a quién y cuáles son las
condiciones que no pueden romperse. No sustituye la selección ni la auditoría del
protocolo de cifrado. La aplicación no se considera apta para datos reales hasta
que se cumplan ADR-001/ADR-002 y una auditoría criptográfica externa
independiente apruebe la integración.

## 1. Alcance y objetivos

Están dentro del alcance:

- PWA, servicio worker y almacenamiento local.
- API HTTP, WebSocket, trabajador de expiración y tareas administrativas.
- PostgreSQL, cachés, colas y almacenamiento privado de objetos.
- Autenticación, sesiones, dispositivos y recuperación criptográfica.
- Invitaciones, asignaciones, reasignaciones, bloqueos y suscripciones.
- Paquetes de evidencia, estación de investigación y su clave privada.
- Notificaciones push, observabilidad, copias de seguridad y CI/CD.

Los objetivos prioritarios son:

1. Mantener el contenido ordinario legible únicamente en dispositivos autorizados
   del cliente y del cajero participantes.
2. Evitar que el rol administrador, la API, la base de datos, el almacenamiento de
   objetos y los proveedores de notificaciones obtengan texto plano o claves de
   conversación.
3. Impedir acceso o entrega de contenido al alcanzar `expires_at`.
4. Limitar la excepción de investigación a un reporte explícito, trazable y
   cifrado para una clave separada.
5. Conservar la integridad de las asignaciones: un cliente, un cajero y un chat
   activo, sin redistribuciones no autorizadas.
6. Evitar que un restablecimiento administrativo de acceso se convierta en una
   puerta trasera para el cifrado.

## 2. Datos y activos

| Clasificación | Activos |
| --- | --- |
| Crítica | Claves privadas de dispositivo, secreto/código de recuperación, claves de conversación, clave privada de investigación y texto plano de mensajes o imágenes |
| Muy sensible | Evidencia de reportes, respaldos de claves cifradas, cookies de sesión, credenciales administrativas y material de autorización de dispositivos |
| Personal | Usuario, correo y teléfono del cajero, fecha de nacimiento, asignaciones, estados de suscripción, motivos de bloqueo y relaciones bloqueadas |
| Confidencial | Sobres y adjuntos cifrados, identificadores de conversación, tiempos, tamaños, estados de entrega y presencia |
| Operativa | Métricas agregadas, auditoría administrativa sin contenido, versiones y diagnósticos depurados |

Los metadatos no están protegidos por el cifrado de extremo a extremo. La
infraestructura necesariamente puede conocer participantes, tiempos aproximados,
tamaños, dispositivos, asignaciones y vencimientos. Esta limitación debe
explicarse en la política de privacidad y esos datos deben minimizarse.

## 3. Actores y adversarios

- Visitante no autenticado que intenta enumerar usuarios, adivinar invitaciones o
  agotar recursos.
- Cliente o cajero malicioso que usa una versión modificada del frontend, envía
  eventos falsos, archivos hostiles, replays o reportes fabricados.
- Cuenta legítima robada mediante phishing, reutilización de contraseña o robo de
  sesión.
- Dispositivo perdido, infectado o compartido.
- Varios cajeros que coordinan bloqueos para suspender a un cliente.
- Administrador de aplicación curioso o cuya cuenta fue comprometida.
- Operador de infraestructura o atacante con lectura de base de datos, objetos,
  cachés, logs o copias de seguridad.
- Servidor activamente comprometido que intenta sustituir claves o publicar
  JavaScript malicioso.
- Proveedor de hosting, almacenamiento o push que observa metadatos o demora una
  eliminación física.

## 4. Límites de confianza

1. **Dispositivo y código entregado:** el texto plano existe en el dispositivo,
   pero el JavaScript se entrega desde infraestructura controlada por SinoChat.
   Una publicación maliciosa puede romper el E2EE para sesiones futuras.
2. **Dispositivo y API:** todo lo que llega a HTTP o WebSocket se considera no
   confiable aunque exista una sesión válida.
3. **API y datos:** base, objetos, caché, cola y logs no deben recibir texto plano,
   secretos de recuperación ni claves privadas.
4. **Administración e investigación:** el panel administrativo ordinario no posee
   la clave de investigación. La apertura de evidencia ocurre en una estación
   separada, con autenticación fuerte y auditoría.
5. **Construcción y despliegue:** dependencias, artefactos, service worker,
   variables y pipeline son parte de la frontera criptográfica.
6. **Notificaciones externas:** el proveedor push recibe únicamente un aviso
   genérico y un identificador opaco, nunca remitente, texto, imagen o motivo.

## 5. Supuestos y límites honestos

- Se usará una implementación mantenida y revisada de un protocolo E2EE
  asincrónico y multidispositivo. No se diseñará criptografía propia.
- La autorización de un dispositivo criptográfico nuevo exigirá la firma de un
  dispositivo confiable o del material derivado del código de recuperación. Una
  sesión autenticada o un restablecimiento administrativo no son suficientes.
- Los relojes de clientes no deciden creación ni expiración; el servidor asigna
  ambos tiempos.
- SinoChat puede retirar contenido de sus servicios y de clientes conformes, pero
  no puede borrar capturas, exportaciones o copias realizadas por un participante
  malicioso.
- Un dispositivo apagado no puede ejecutar un borrado exactamente a las 48 horas.
  Al volver a abrirse debe purgar el contenido vencido antes de mostrarlo o
  descifrarlo.
- El servidor no puede verificar el formato real de un adjunto ya cifrado. Puede
  limitar el tamaño del cifrado; la recodificación y la decodificación segura
  tienen que ocurrir en los extremos.
- La evidencia de reporte demuestra qué paquete entregó el denunciante y que no
  fue alterado después. No debe presentarse como prueba jurídica infalible de
  autoría si el protocolo elegido ofrece negación plausible.

## 6. Invariantes de privacidad y seguridad

Estas reglas son requisitos de salida a producción.

### INV-01 — Contenido ordinario

El texto plano y las claves de una conversación ordinaria solo existen en
dispositivos criptográficamente autorizados de sus dos participantes. No aparecen
en API, base, objetos, cachés, colas, analítica, trazas, errores, reportes de
fallos, push ni panel administrativo.

### INV-02 — Participación y autorización

Cada sobre se vincula a una conversación y cada conversación activa contiene
exactamente un cliente y su cajero asignado. Toda lectura, escritura, recibo,
presencia, indicador o unión WebSocket vuelve a autorizar usuario, dispositivo,
estado de cuenta y conversación; conocer un identificador nunca concede acceso.

### INV-03 — Administración sin puerta trasera

Crear, modificar, suspender, eliminar o restablecer una cuenta no entrega claves,
no añade silenciosamente un dispositivo y no permite al administrador descifrar
contenido ordinario. Todo cambio de identidad criptográfica es visible para el
otro participante y bloquea el envío silencioso a claves sustituidas.

### INV-04 — Reasignación

Una reasignación cierra el chat anterior para nuevos envíos y crea uno nuevo sin
historial ni reutilización de claves. Nunca devuelve al cliente al cajero excluido
o a una relación bloqueada. Las asignaciones existentes ajenas al evento no
cambian.

### INV-05 — Excepción de reporte

El administrador solo puede descifrar el paquete que un cliente decide reportar.
La acción exige confirmación explícita de que toda la conversación aún vigente,
incluidas imágenes, será entregada y retenida hasta cerrar el caso. El paquete se
cifra en el extremo para la clave pública de investigación y el servidor no ve
texto plano.

### INV-06 — Separación de evidencia

La evidencia tiene almacenamiento, autorización, clave y ciclo de vida separados.
Solo investigadores autorizados pueden abrirla. Todo acceso queda auditado. Al
cerrar el caso se destruyen paquete, adjuntos, índices y material de clave; solo
permanece el resultado administrativo sin citas ni contenido.

### INV-07 — Caducidad

`expires_at = created_at + 48 horas`, con tiempo del servidor. Desde el primer
instante en que `now >= expires_at`, ninguna API, WebSocket, URL de objeto, caché,
reintento, recibo ni cliente conforme entrega o muestra ese contenido. El proceso
de borrado es idempotente, observable y abarca adjuntos y metadatos por mensaje.

### INV-08 — Recuperación

La recuperación de autenticación y la criptográfica son factores distintos. El
cajero recibe ocho códigos de cuenta de 100 bits; solo se persiste un hash
separado por usuario, cada valor se consume una vez y una rotación invalida el
lote anterior. El administrador solo abre una ventana de 24 horas y nunca elige
ni conoce credenciales. El material de recuperación E2EE no llega al servidor en
texto plano y requiere un dispositivo confiable o su secreto criptográfico.
Restablecer la contraseña conserva perfil, clientes y asignaciones, pero no
autoriza dispositivos ni recupera claves.

### INV-09 — Mínimo privilegio

Las credenciales de API, trabajador, migraciones, almacenamiento, auditoría e
investigación son distintas. La API no posee permisos para leer la clave privada
de investigación y el panel administrativo no dispone de endpoints de contenido
ordinario.

### INV-10 — Metadatos y notificaciones

Se conserva solo el metadato necesario y por el menor tiempo aplicable. Los avisos
externos son genéricos. No se derivan previsualizaciones, thumbnails ni búsquedas
del lado del servidor.

### INV-11 — Estado de cuenta

La suspensión, eliminación, pérdida de aprobación o inactividad de suscripción
invalida inmediatamente las capacidades correspondientes. Los cambios y sus
reasignaciones son atómicos, reintentables y auditados sin contenido.

### INV-12 — Perfil criptográfico de mensajes

Cada mensaje ordinario usa una sesión Megolm nueva y una única representación
ciphertext, copiada sin cambios a todos los dispositivos activos de ambos
participantes. La room key se entrega mediante Olm antes del commit. El interior
autenticado liga protocolo, conversación, sala, mensaje, remitente y dispositivo;
la sesión rota por mensaje y adicionalmente como máximo a una hora. Olm y
`to-device` no transportan texto ni fotos ordinarios.

### INV-12 — Artefacto entregado

Los artefactos de frontend son revisados, reproducibles y servidos con CSP
estricta. El service worker no puede mantener indefinidamente una versión
vulnerable ni servir contenido vencido desde caché.

## 7. Amenazas y controles requeridos

### Identidad, sesiones y dispositivos

| ID | Escenario | Riesgo | Controles obligatorios |
| --- | --- | --- | --- |
| TM-01 | Enumeración, fuerza bruta o credential stuffing | Alto | Respuestas indistinguibles, Argon2id parametrizado, rate limit por cuenta/IP/dispositivo, demoras progresivas, alertas y contraseñas comprometidas bloqueadas |
| TM-02 | Robo o fijación de sesión, CSRF | Alto | Cookie `HttpOnly`, `Secure`, `SameSite`, rotación al autenticar, CSRF por origen/token, expiración, cierre remoto y sesiones visibles por dispositivo |
| TM-03 | Alta silenciosa de dispositivo tras un reset administrativo | Crítico | Autorización criptográfica firmada por dispositivo confiable o recuperación; el reset de acceso nunca firma dispositivos |
| TM-04 | Sustitución de claves o lista de dispositivos por el servidor | Crítico | Identidad estable, lista de dispositivos firmada, verificación de cambios y mecanismo de transparencia/consistencia definido por el ADR |
| TM-05 | Robo del código de recuperación | Crítico | Secreto aleatorio de alta entropía, no registrarlo, respaldo cifrado resistente a prueba offline y opción de rotarlo desde un dispositivo confiable |
| TM-06 | Toma de cuenta administrativa | Crítico | MFA resistente a phishing para administrador, reautenticación para acciones sensibles, sesión corta, auditoría inmutable y alertas fuera de banda |
| TM-07 | Restablecimiento manual del cajero mediante ingeniería social | Alto | El admin no define secretos: solicitud auditada de 24 h, cierre de sesiones, aviso, código personal de 100 bits y un solo uso, respuesta no enumerable y conservación de dispositivos/clientela |

### Mensajería y WebSocket

| ID | Escenario | Riesgo | Controles obligatorios |
| --- | --- | --- | --- |
| TM-08 | IDOR o unión a una sala ajena | Crítico | Autorización en cada evento y consulta desde la identidad autenticada; nunca aceptar `userId` o rol enviado por el cliente |
| TM-09 | Replay, duplicado, alteración o reordenamiento | Alto | IDs impredecibles, autenticación Megolm, bindings interiores estrictos, idempotencia y límites de ventana |
| TM-10 | Un usuario bloqueado, suspendido o reasignado sigue enviando | Alto | Revalidación transaccional antes de persistir y emitir; cierre de salas y revocación de capacidades |
| TM-11 | Texto plano en logs o telemetría | Crítico | Allowlist de campos, redacción central, canarios automáticos y prohibición de serializar cuerpos, claves o excepciones del cifrado |
| TM-12 | Presencia o “escribiendo” filtra actividad a terceros | Medio | Eventos efímeros solo a la conversación activa, sin persistencia detallada y con rate limit |

### Imágenes y almacenamiento

| ID | Escenario | Riesgo | Controles obligatorios |
| --- | --- | --- | --- |
| TM-13 | Archivo demasiado grande o carga multipart abusiva | Alto | Límite de bytes cifrados con margen criptográfico explícito, cuotas, timeout, carga autenticada y limpieza de objetos huérfanos |
| TM-14 | Polyglot, datos EXIF, bomba de descompresión o decoder exploit | Alto | Decodificar y recodificar antes de cifrar, eliminar metadatos, límites de dimensiones/píxeles, decoder aislado y volver a validar al recibir |
| TM-15 | URL de objeto compartible o predecible | Alto | Objetos privados, IDs aleatorios, autorización ligada a participante/dispositivo, URL muy breve y filtro de expiración antes de firmarla |
| TM-16 | Objeto cargado sin mensaje o mensaje sin objeto | Medio | Protocolo de commit, estado temporal, hash/autenticación del adjunto y recolección idempotente de huérfanos |

### Expiración y borrado

| ID | Escenario | Riesgo | Controles obligatorios |
| --- | --- | --- | --- |
| TM-17 | Carrera en el límite de 48 horas | Crítico | Comparación exclusiva `now < expires_at` en toda ruta, reloj central, chequeo antes de lectura y antes de emisión |
| TM-18 | Trabajador detenido deja datos accesibles | Crítico | Las lecturas filtran aunque falle el borrado, métricas de edad del objeto más antiguo, alarma y runbook |
| TM-19 | Caché, cola, push, service worker o reintento revive contenido | Alto | TTL coherente, purga por ID, validación al consumir y ninguna previsualización en push |
| TM-20 | Backups o logs conservan ciphertext fuera de política | Alto | No respaldar payloads efímeros, separar tablas/buckets, cifrado y política comprobable; pruebas periódicas de restauración y borrado |
| TM-21 | Cliente apagado conserva datos más de 48 horas | Medio | Base local cifrada, purga antes de desbloquear/mostrar y al recibir cambios de reloj; limitación explicada al usuario |
| TM-21A | Alta/revocación concurrente o caída durante `shareRoomKey` deja un mensaje sin cobertura completa o entrega la clave a un dispositivo ya excluido | Crítico | Snapshot versionado, exclusión por máquina/sala, confirmar cada request Olm antes del mensaje, revalidación transaccional y reintento cerrado |
| TM-21B | Se altera `sender`, dispositivo, clave o metadata exterior de un evento Megolm que todavía puede descifrarse | Crítico | Bindings interiores obligatorios de usuario/dispositivo/sala/conversación/mensaje, comparación con sesión Rust Crypto y transporte, rechazo de forwarders y campos extra |
| TM-21C | Una sesión Megolm se reutiliza y una room key expone más mensajes de los previstos | Crítico | `rotationPeriodMessages = 1`, máximo temporal de una hora, prueba del `session_id` por mensaje, serialización y alarma ante reutilización |
| TM-21D | Una cascada elimina la fila de adjunto antes del objeto y pierde el ledger de purga | Alto | FK `ON DELETE RESTRICT`, borrar versiones externas primero, worker idempotente y reconciliación por antigüedad |

### Invitaciones, asignación y abuso

| ID | Escenario | Riesgo | Controles obligatorios |
| --- | --- | --- | --- |
| TM-22 | Adivinar o reutilizar un código anterior | Alto | Código generado por CSPRNG con al menos 128 bits, comparación segura, rotación atómica e invalidación inmediata |
| TM-23 | Carrera asigna de forma inequitativa o duplica chats | Alto | Transacción serializable o bloqueo equivalente, constraint de un chat/asignación activos e idempotency key |
| TM-24 | Reasignación a cajero anterior, bloqueado o inelegible | Alto | Exclusiones en la consulta transaccional y nueva comprobación al confirmar |
| TM-25 | No hay cajero elegible y el sistema relaja reglas | Alto | Estado `PENDING_REASSIGNMENT`, sin chat activo y reintento; jamás omitir bloqueos o suscripción para completar |
| TM-26 | Cinco cajeros coordinan bloqueos falsos | Alto | Suspender, no eliminar; motivos, cajeros distintos, evidencia/auditoría de hechos y revisión administrativa |
| TM-27 | Doble bloqueo o concurrencia supera/infravalora el umbral | Alto | Unicidad cliente-cajero para el conteo y actualización transaccional del estado |
| TM-28 | Rotación de invitación interfiere con un registro en curso | Medio | Resolver y consumir el código dentro de la misma transacción; reglas claras de precedencia |
| TM-28A | Código filtrado por URL, Referer, historial, caché o log de acceso | Alto | Enlace con fragmento, limpieza inmediata mediante `replaceState(null, ...)`, `Referrer-Policy: no-referrer`, secreto solo en memoria y validación/revelado exclusivamente por `POST` JSON con rate limit |

### Reportes e investigación

| ID | Escenario | Riesgo | Controles obligatorios |
| --- | --- | --- | --- |
| TM-29 | Reporte incompleto por expiración durante la carga | Alto | Snapshot atómico de IDs y ciphertext todavía vigentes, manifiesto y reintento del material cifrado de evidencia |
| TM-30 | Denunciante altera o fabrica contenido | Alto | Manifiesto firmado, hashes vinculados a sobres originales, timestamps del servidor y etiqueta explícita sobre el grado de autenticidad |
| TM-31 | Servidor lee la evidencia durante el tránsito | Crítico | Cifrado en el dispositivo para clave pública de investigación y prueba automática de ausencia de texto plano |
| TM-32 | Clave de investigación robada | Crítico | Fuera del servidor, hardware/keystore protegido, MFA, respaldo offline cifrado, rotación y acceso de mínimo privilegio |
| TM-33 | Evidencia retenida indefinidamente por olvido | Alto | Panel de antigüedad, alertas, revisión periódica, motivo de extensión y cierre verificable; la política legal debe aprobar el plazo |
| TM-34 | Administrador abre evidencia sin necesidad | Alto | Autorización separada, reautenticación, justificación, auditoría inmutable y revisión de accesos |
| TM-35 | Notificación prematura al denunciado | Medio | Máquina de estados; solo el cambio administrativo posterior a la revisión habilita el aviso |
La contraseña actual, la justificación, el rate limit y un step-up WebAuthn de
menos de cinco minutos ya implementan el límite técnico de TM-06/TM-34. Aún se
deben certificar el RP ID/HTTPS definitivos, navegadores objetivo, recuperación y
alertas fuera de banda; por tanto el control operativo no se considera cerrado
para producción.

### Cadena de suministro y operación

| ID | Escenario | Riesgo | Controles obligatorios |
| --- | --- | --- | --- |
| TM-36 | XSS o despliegue web malicioso exfiltra claves | Crítico | CSP sin `unsafe-inline`/`unsafe-eval`, Trusted Types donde aplique, sanitización, artefactos reproducibles, revisión y protección del pipeline |
| TM-37 | Dependencia o actualización de service worker comprometida | Crítico | Lockfile, SBOM, escaneo, firmas/provenance, actualización controlada y revocación de versiones vulnerables |
| TM-38 | Secretos en repositorio, imagen o error | Alto | Gestor de secretos, escaneo pre-commit/CI, rotación y mensajes de error no sensibles |
| TM-39 | DoS por conexiones, mensajes, reportes o adjuntos | Alto | Cuotas por identidad/IP, backpressure, límites de sockets y tamaño, circuit breakers y presupuesto de almacenamiento |
| TM-40 | Eliminación/suspensión parcial deja sesiones o objetos | Alto | Saga idempotente, estado tombstone, reintentos, conciliación y alarma de residuos |
| TM-41 | Purga externa completada y transacción de cierre fallida, o dos workers compiten | Alto | Estado `CLOSING`, job persistente, DELETE idempotente, lease acotada, backoff, finalización serializable y eliminación del job solo después de cerrar |

## 8. Reglas seguras para flujos sensibles

### Reasignación

1. Se sella la conversación anterior y se impiden nuevos envíos.
2. Se excluyen cajero anterior, relaciones bloqueadas, no aprobados y suscripciones
   inactivas.
3. Se cuentan solo asignaciones activas de clientes activos.
4. Se elige entre quienes tengan el mínimo actual; el empate usa CSPRNG.
5. La selección, la asignación y la conversación vacía se confirman atómicamente.
6. Si no hay candidato, el cliente queda pendiente; no se debilitan exclusiones.
7. En los bloqueos 1 a 4 se reasigna. En el quinto bloqueo distinto se suspende al
   cliente y no se crea una sexta asignación hasta la revisión.

### Reporte de un cajero por un cliente

Para evitar dos acciones ambiguas, la opción segura es una única acción
**“Bloquear y reportar”**. Esta debe:

1. explicar antes de confirmar qué contenido se entregará al administrador;
2. sellar la conversación y bloquear futuras relaciones;
3. tomar un snapshot de todo lo no vencido, incluidas imágenes;
4. producir un manifiesto íntegro y cifrado para investigación;
5. reasignar al cliente sin esperar a que el administrador revise;
6. mantener el caso cifrado hasta su cierre; y
7. informar al cajero solo después de una decisión de revisión.

Un bloqueo iniciado por un cajero contra un cliente no copia el chat a evidencia,
salvo que en el futuro se agregue una acción de reporte separada y consentida.

### Restablecimiento y dispositivo nuevo

- El administrador puede restablecer la autenticación de un cajero, conservando
  perfil, clientela y asignaciones, pero solo inicia la solicitud; el cajero debe
  presentar uno de sus ocho códigos de cuenta y elegir la contraseña nueva.
- Un dispositivo ya confiable o el material de recuperación E2EE autoriza el nuevo
  dispositivo y recupera los mensajes todavía vigentes.
- Si ambos faltan, se crea una identidad criptográfica nueva. Los mensajes
  anteriores quedan inaccesibles y los clientes reciben una advertencia visible
  de cambio de identidad antes de enviar.
- El administrador no puede suprimir esa advertencia ni aprobar el dispositivo.

## 9. Contradicciones y decisiones todavía necesarias

Las siguientes resoluciones seguras deben ratificarse y trasladarse a la
especificación/ADR antes de producción:

| ID | Ambigüedad o contradicción | Decisión segura propuesta |
| --- | --- | --- |
| DEC-01 | “Eliminación permanente exactamente a las 48 h” no es garantizable físicamente en un dispositivo apagado ni en todos los proveedores al milisegundo; la arquitectura usa un trabajador frecuente | Garantizar inaccesibilidad exacta en `expires_at`; purga de infraestructura online con SLO medido (propuesta: p99 menor a 60 s y máximo operativo 5 min), no incluir payload efímero en backups y purgar clientes offline antes de mostrar al volver |
| DEC-02 | El producto permite “reportar y bloquear”, pero solo describe evidencia al reportar | Convertir todo bloqueo de cliente a cajero en la acción atómica “Bloquear y reportar”; no ofrecer un bloqueo silencioso |
| DEC-03 | El cliente “pierde la cuenta” sin credenciales, pero aparece un código de recuperación | Separar conceptos: el cliente no tiene recuperación de autenticación; el código criptográfico solo recupera claves después de una autenticación válida y no recupera la cuenta |
| DEC-04 | “Modificar” el código de invitación puede interpretarse como elegir texto débil | Permitir rotarlo, pero generar el valor en servidor con CSPRNG; nunca aceptar códigos elegidos por el cajero |
| DEC-05 | Cada bloqueo reasigna, pero el quinto suspende | Bloqueos 1–4 reasignan; el quinto sella el chat y suspende sin reasignar |
| DEC-06 | No se define qué ocurre si no hay cajeros disponibles | Usar `PENDING_REASSIGNMENT`, avisar al cliente y reintentar; no volver al bloqueado ni asignar un inelegible |
| DEC-07 | “Toda la conversación disponible” puede expirar durante el reporte | Fijar un snapshot atómico al iniciar el reporte y copiar solo ciphertext no vencido; completar el envoltorio para investigación de forma reintentable |
| DEC-08 | No se define la visibilidad del chat anterior tras reasignar | Sellarlo para nuevos envíos; permitir solo lectura local de lo ya descargado hasta su vencimiento y acceso remoto de los antiguos participantes únicamente si la política de bloqueo lo permite; la opción más segura tras bloqueo es no volver a servirlo salvo para completar evidencia |
| DEC-09 | No se define qué ocurre con evidencia abierta al eliminar una cuenta | Conservar el caso separado hasta que el administrador lo cierre, pseudonimizar la cuenta eliminada y borrar todo contenido ordinario inmediatamente |
| DEC-10 | No se define cómo se verifica al cajero antes de recibir clientes | Exigir prueba de posesión de correo y teléfono, además de aprobación administrativa y suscripción activa |
| DEC-11 | La evidencia se conserva hasta cierre sin límite máximo | Mantener la regla solicitada, pero exigir alertas de antigüedad, revisión periódica y aprobación legal/documental de la retención antes del lanzamiento |
| DEC-12 | La autenticidad probatoria del reporte no está definida | Conservar sobres originales, hashes, timestamps y firma del dispositivo; presentar la evidencia como aportada por el denunciante salvo garantías adicionales del protocolo |
| DEC-13 | ADR-001/ADR-002 ya eligen Matrix Rust Crypto, Megolm ordinario y Olm para room keys/control, pero la integración privada aún no fue auditada | Mantener el gate `BLOCKED` hasta completar transparencia/cross-signing, pruebas entre navegadores y auditoría criptográfica externa; es un bloqueo absoluto de producción |

## 10. Riesgos residuales aceptables solo con divulgación

- Un participante puede fotografiar, copiar o capturar contenido antes de vencer.
- Un dispositivo comprometido puede leer lo que su usuario legítimo puede leer.
- La PWA no protege frente a un servidor que entregue JavaScript malicioso en
  tiempo real con la misma fuerza que un cliente nativo firmado.
- El servidor y los proveedores observan metadatos operativos mínimos.
- Una clave de investigación comprometida expone los casos todavía abiertos, pero
  no debe exponer conversaciones ordinarias.
- La distribución equitativa significa elegir el menor conteo al momento de cada
  reasignación; no garantiza cantidades históricas iguales ni reorganiza
  clientelas existentes.
