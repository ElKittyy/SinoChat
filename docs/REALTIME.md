# Tiempo real distribuido

SinoChat usa Socket.IO con el adaptador oficial de Redis Pub/Sub. Esto distribuye
eventos, rooms, `fetchSockets()` y desconexiones entre todas las instancias de la
API. Redis es infraestructura obligatoria en producción y opcional durante el
desarrollo de una sola instancia.

El mismo servicio Redis, mediante una tercera conexión dedicada, conserva los
contadores de rate limit HTTP y WebSocket. No se crea una conexión por request.

## Configuración

- `REDIS_URL`: usa el formato `redis://` o `rediss://`, con usuario, contraseña,
  puerto y número de base cuando correspondan. En producción es obligatoria y
  debe usar `rediss://`.
- `SOCKET_IO_REDIS_CHANNEL_PREFIX`: identifica los canales Pub/Sub de esta
  instalación. El valor predeterminado es
  `sinochat:<NODE_ENV>:socket.io`. Debe ser único si varias instalaciones usan
  el mismo Redis.
- `RATE_LIMIT_REDIS_PREFIX`: namespace exclusivo de contadores. Si se omite se
  deriva como `<SOCKET_IO_REDIS_CHANNEL_PREFIX>:rate-limit`.
- `RATE_LIMIT_HMAC_SECRET`: secreto aleatorio de al menos 32 bytes, obligatorio
  en producción, idéntico en todas las instancias y diferente de los demás
  secretos. Convierte IP, sesión, usuario y clave HTTP en un HMAC-SHA-256 antes
  de formar una clave Redis.

En desarrollo, dejar `REDIS_URL` vacía conserva el adaptador en memoria. Ese modo
solo admite una instancia de la API. `compose.yaml` incluye Redis 7.4 local sin
persistencia:

```powershell
docker compose up -d postgres redis
```

El Redis local solo se publica en `127.0.0.1:6379`. No debe reutilizarse como
configuración productiva.

## Inicio, fallo y cierre

Antes de abrir el puerto HTTP, la API:

1. crea conexiones independientes para publicación y suscripción;
2. deshabilita la cola offline y la reconexión automática;
3. conecta ambas con timeout;
4. exige que ambas respondan `PING`; y
5. instala el adaptador distribuido; y
6. abre una conexión independiente para rate limit, comprueba `PING` y exige el
   estado `ready`.

Una URL ausente o inválida, un error de TLS, autenticación, ACL o conectividad
impide que producción arranque. Si cualquiera de las conexiones cae después del
inicio, la API termina con error y el supervisor debe reiniciarla. No continúa
en el modo local parcial del adaptador.

La conexión de rate limit deshabilita cola offline y reconexión automática. Cada
comando tiene un timeout de un segundo: si Redis no está listo, devuelve una
respuesta inválida o excede el plazo, HTTP no autoriza la petición y WebSocket
desconecta el socket. Nunca se cambia al contador en memoria durante una caída.

El cierre de Nest desconecta Socket.IO y cierra las dos conexiones Pub/Sub y la
conexión dedicada de rate limit.
Si el cierre motivado por Redis no termina en diez segundos, el proceso finaliza
para dejar de aceptar conexiones.

Los eventos de presencia y escritura son efímeros y no se reproducen. Los
mensajes continúan en PostgreSQL y el cliente los recupera por secuencia tras
reconectarse.

## Límites anteriores a PostgreSQL

El contador distribuido es un script Lua atómico con reloj `TIME` de Redis,
ventana fija, bloqueo y expiración de la clave. El límite HTTP global es 120
peticiones por minuto por ruta y tracker; los decoradores de endpoints sensibles
pueden reducirlo.

Antes de consultar una sesión al abrir WebSocket se aplican 120 conexiones por
minuto por IP y 20 por minuto por cookie de sesión. La IP se resuelve con la
misma semántica de `TRUST_PROXY` que Express: `X-Forwarded-For` se ignora si el
par inmediato o el salto correspondiente no es confiable. Así, clientes detrás
de un reverse proxy autorizado no comparten una única clave. Para cada socket,
un bucket local rechaza más de 40 paquetes cada 10 segundos y más de 8 eventos de escritura
cada 2 segundos. Solo se acepta actualmente `conversation:typing`. Después se
aplican límites Redis de 120 paquetes y 60 eventos de escritura por minuto por
usuario. Recién entonces se revalida la sesión en PostgreSQL; la autorización
exacta de la conversación continúa inmediatamente antes de emitir.

Una configuración incorrecta de `TRUST_PROXY` puede agrupar clientes o confiar
headers falsificados. Debe declarar exactamente los saltos o CIDR reales del
balanceador; `true` continúa prohibido y una dirección resuelta inválida cierra
la conexión antes de consultar PostgreSQL.

En desarrollo sin `REDIS_URL`, HTTP y WebSocket delegan al almacenamiento local
de Nest. Este modo no agrega capacidad al levantar otra instancia y no puede
usarse para certificar carga ni evasión distribuida.

## Seguridad de Redis

El protocolo Pub/Sub del adaptador no firma ni cifra sus mensajes. Quien pueda
publicar o suscribirse a sus canales podría observar metadatos o inyectar eventos.
En producción:

- ubicar Redis en red privada y no exponer su puerto a Internet;
- usar `rediss://`, una CA confiable y nunca
  `NODE_TLS_REJECT_UNAUTHORIZED=0`;
- usar credenciales dedicadas y ACL de mínimo privilegio para `PING`, Pub/Sub y
  solo los canales del prefijo configurado; la conexión de rate limit necesita
  además `EVAL`, `TIME`, `HMGET`, `HSET` y `PEXPIREAT`, restringidos al prefijo
  `RATE_LIMIT_REDIS_PREFIX`;
- no compartir el prefijo con staging, pruebas u otra aplicación; y
- no incluir texto, fotos, tokens, cookies, URLs firmadas ni claves en eventos.

Si se necesita una CA privada, debe instalarse mediante el almacén de confianza
del sistema o `NODE_EXTRA_CA_CERTS`, nunca deshabilitando la validación TLS.

## Balanceador y despliegue

El balanceador debe aceptar `Upgrade: websocket`, mantener conexiones largas y
retirar una instancia antes de terminarla. La aplicación actualmente fuerza
transporte WebSocket; si en el futuro se habilita long-polling, también será
obligatoria la afinidad de sesión indicada por Socket.IO.

Cada despliegue debe probar al menos dos instancias:

1. conectar dos navegadores a instancias diferentes;
2. intercambiar mensaje, recibo, escritura y presencia;
3. comprobar que `disconnectUser` cierra sockets remotos;
4. cortar Redis y confirmar que ambas APIs dejan de aceptar tráfico; y
5. restaurar Redis, reiniciar las APIs y verificar recuperación desde
   PostgreSQL sin duplicar contenido.

Referencias operativas:

- <https://socket.io/docs/v4/redis-adapter/>
- <https://redis.js.org/>
