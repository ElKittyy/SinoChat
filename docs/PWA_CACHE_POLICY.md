# Política de caché de la PWA

El service worker de SinoChat usa una lista positiva estricta. CacheStorage solo
contiene el shell público y recursos estáticos propios; no funciona como caché
general de red.

## Contenido permitido

- La página pública raíz, solicitada expresamente sin credenciales.
- `offline.html` y `manifest.webmanifest`.
- El logotipo y los iconos PWA incluidos explícitamente en `sw.js`.
- JavaScript, CSS y fuentes generados por Vite cuyo nombre contiene un hash de
  versión, por ejemplo `/assets/index-DWYF02gd.js`.

Los archivos estables se renuevan al cambiar `CACHE_NAME`. Durante la instalación,
el service worker lee el HTML público sin cookies para localizar y precargar los
recursos versionados de esa compilación.

## Contenido prohibido

- Cualquier ruta `/api` y `/socket.io`.
- Respuestas de `/app` o de cualquier otra navegación autenticada.
- Mensajes, sobres cifrados, recibos, notificaciones y claves.
- Fotos o archivos enviados por usuarios.
- URLs firmadas, recursos de otros orígenes y cualquier imagen no incluida en la
  lista estática.
- Respuestas a `POST`, `PATCH`, `PUT` o `DELETE`.

Las navegaciones usan la red y nunca escriben su respuesta en caché. Si no hay red,
se muestra `offline.html`; solo la raíz pública puede reutilizar su shell sin
credenciales.

## Despliegue

`/sw.js` debe servirse con `Cache-Control: no-cache` (o una política equivalente)
y `Content-Type: application/javascript`; el manifest debe usar
`application/manifest+json`. El worker está ubicado en la raíz y solicita alcance
`/`. El hosting también debe reescribir `/app` hacia `index.html` cuando hay red,
sin convertir esa respuesta en una caché HTTP privada.

Al modificar el shell o los recursos estables se debe cambiar la versión de
`CACHE_NAME`; al activarse, el worker elimina únicamente cachés anteriores que
comiencen con `sinochat-shell-`.
