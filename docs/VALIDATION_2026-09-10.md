# Validación local del 10 de septiembre de 2026

La primera tanda conecta las pruebas con el cliente criptográfico real y corrige
tres fallos de integración. La segunda incorpora validación de bootstrap público
y rechazo de firmas Ed25519 con puntos débiles. No habilita el chat ni constituye una aprobación
de producción. La estimación orientativa permanece en 85% de implementación
y 70% de preparación para producción; no se deriva del número de pruebas.

## Correcciones

1. `BrowserMatrixSessionLockProvider` combinaba `ifAvailable: true` y `signal`,
   una combinación rechazada por Web Locks. Conserva la adquisición exclusiva
   sin espera y gestiona el aborto pendiente por separado. Una señal abortada
   después de adquirir no libera la máquina mientras sigue trabajando.
   Referencia: [algoritmo de request(), paso 8](https://w3c.github.io/web-locks/#dom-lockmanager-request).
2. `MatrixMegolmMessageCrypto` esperaba cinco campos al descifrar; el SDK
   fijado 18.6.0 devuelve siete, incluyendo `room_id` y `unsigned`. Ahora acepta
   exactamente ese contrato, compara la sala con la esperada y exige
   `unsigned: {}`. No se permiten campos arbitrarios ni se relajan los
   vínculos interiores de remitente, dispositivo o mensaje.
3. La eliminación del texto en React dependía de finalizar el siguiente
   polling HTTP. Un reloj local independiente retira ahora los mensajes
   vencidos de todas las conversaciones conservadas en el panel, incluso
   cuando no están seleccionadas. Recomprueba al recuperar foco/visibilidad o
   `pageshow`. El polling conserva solo metadatos de su conversación objetivo.

## Nueva prueba de navegador

```powershell
npm.cmd run check:e2ee-browser
```

Ejecuta tres contextos aislados de Chrome/Chromium (emisor, receptor y tercero),
con IndexedDB, Web Locks, Web Crypto y Matrix Rust Crypto WASM reales. Importa
las clases de SinoChat y el componente React de chat; no copia el algoritmo.

El directorio/transporte HTTP es un relay sintético en memoria, exclusivo del
verificador, y el listado/recibos del timeline son fixtures. Los mensajes
ordinarios se pasan como sobres cifrados; el relay recibe claves públicas y
controles Olm cifrados. La foto se descarga como bytes cifrados desde loopback.
No se utiliza `.env`, la API local, PostgreSQL, Redis ni datos de usuarios.
No hay cambio a `READY` ni variable que anule el gate del producto.

Comprobaciones aprobadas:

- Exclusión entre pestañas con AbortSignal real; aborto previo y reapertura
  después de cerrar la pestaña propietaria. La liberación del navegador se
  observa con `navigator.locks.query()` antes de intentar reabrir.
- Texto bidireccional con Unicode y contenido parecido a HTML; dos envíos
  concurrentes producen distintas sesiones Megolm y sobres idénticos para
  ambos dispositivos, incluido el emisor.
- El receptor no descifra antes de recibir la room key; después puede volver
  a leer el historial. El tercero sin claves no puede descifrar.
- Rechazo de alteraciones de ciphertext, sala, usuario/dispositivo remitente,
  clave Curve25519, `clientMessageId` y metadatos del adjunto.
- PNG sintético cifrado, descifrado y decodificado con los mismos bytes;
  descriptor secreto solo dentro de Megolm. Rechazo de MIME falso, más de
  5 MiB y archivo cifrado manipulado.
- Recarga conserva historial, claves y cursor IndexedDB; emisor y receptor
  siguen operando después de reabrir. Un secreto local incorrecto no abre ni
  reemplaza el store, y el secreto correcto conserva el historial después de
  ese intento. No prueba recuperación de claves perdidas.
- Un HTTP 503 al compartir la room key impide completar el cifrado para
  persistir el mensaje; el reintento posterior es descifrable.
- El controlador real rechaza reutilizar un mensaje autenticado bajo otro
  ID de transporte y no emite un recibo de lectura por ese intento.
- Con reloj de navegador controlado, el texto sigue visible un milisegundo
  antes de vencer y se retira al vencer; también se limpia el chat no
  seleccionado. La foto desaparece, su Blob URL queda revocada y volver a
  listar no recupera contenido caducado. No se solicita la red para retirarlo.
- Un salto del reloj seguido de `visibilitychange` retira contenido vencido
  sin esperar el timer previo.

Las herramientas usan puerto loopback exclusivo y cachés/perfiles temporales
con limpieza acotada. La caracterización Megolm anterior comparte ahora
localización de navegador y limpieza multiplataforma; no modifica la caché
Vite de la PWA de desarrollo. El build rechaza marcadores del relay y del
harness en los artefactos productivos.

## Resultados de la primera tanda

| Comprobación | Resultado |
| --- | --- |
| `npm.cmd run typecheck` | Correcto en contratos, API y web |
| Suite API y contratos | 335 pruebas API y 3 de contratos correctas |
| Suite web | Correcta, incluyendo nuevos controles de retención local, 19 casos del adaptador Megolm y 8 pruebas del relay |
| `npm.cmd run check:e2ee-browser` | Correcto en Chrome local con contextos aislados y reloj controlado |
| `npm.cmd run build` | Correcto; React productivo, WASM diferido y fixtures fuera del artefacto |
| Gate compilado | Sigue `BLOCKED`, `E2EE_INTEGRATION_INCOMPLETE` |

CI queda configurado para instalar Chromium desde la versión fijada de
`playwright-core` y ejecutar también la prueba de cliente. GitHub Actions y
la ejecución Linux no se han certificado desde este entorno Windows.
No se añadieron dependencias ni migraciones en esta primera tanda.

## Segunda tanda: identidad pública y firmas estrictas

Se implementó `parseMatrixCrossSigningBootstrap`, una función pura para validar
las solicitudes públicas del SDK Matrix Rust Crypto 18.6. Comprueba la cadena
de cinco firmas y el certificado del dispositivo contra sus claves originales;
conserva su autofirma y prohíbe cambiar el triplete público fijado, incluso con
firmas nuevas válidas. Rechaza campos privados, propietarios ajenos y cuerpos
fuera del perfil. Contrato completo en
[Bootstrap público de cross-signing](CROSS_SIGNING_BOOTSTRAP.md).

La revisión reprodujo un caso importante en Node 24/OpenSSL: una clave Ed25519
de orden pequeño puede aceptar una firma constante sin secreto. El verificador
compartido ahora comprueba los puntos públicos `A` y `R` con las operaciones
estándar de `@noble/curves` y conserva `node:crypto.verify` para la ecuación de
firma. No usa la verificación ZIP215 predeterminada de Noble. También valida
los puntos de las tres claves públicas de cross-signing, incluida `user_signing`.
Se añadieron `@noble/curves` 2.4.0 y su dependencia `@noble/hashes` 2.4.0 al lockfile;
no cambió la versión del SDK Matrix ni se implementó un algoritmo propio.

Las nuevas pruebas son 49 casos con solicitudes del SDK, 26 cadenas adversariales
firmadas con claves independientes y 18 regresiones del verificador Ed25519:
93 en total. La prueba previa de sustitución del directorio utiliza ahora otra
clave Ed25519 válida: los bytes cero fallan correctamente antes, por ser débiles.

| Comprobación final | Resultado |
| --- | --- |
| `npm.cmd test` | 428 pruebas API, 3 de contratos y suite web correctas |
| `npm.cmd run typecheck` | Contratos, API y web correctos |
| `npm.cmd run build` | Correcto; se mantienen los controles de artefactos web |
| `npm.cmd run check:e2ee-browser` | Correcto en Chrome aislado, con relay sintético |
| `npm audit` completo y `--omit=dev`, mediante npm 11.19.1 | Cero vulnerabilidades conocidas reportadas en esta ejecución |
| Estado de chat/Matrix | `BLOCKED`; sin endpoints de cross-signing nuevos |

La instalación se hizo con npm 11.19.1 e `--ignore-scripts`, sin ejecutar scripts
de los paquetes agregados. No se aplicaron migraciones, no se modificaron cuentas
y no se reiniciaron servicios persistentes de la aplicación. La validación de
firmas y la auditoría de dependencias no sustituyen una auditoría criptográfica
independiente ni certifican que la aplicación esté lista para producción.

Siguen pendientes la persistencia atómica de identidad, publicación/consulta con
permisos adecuados, autorización visible de nuevos dispositivos y recuperación.
No hay un endpoint de reset de raíces; el administrador no obtiene acceso E2EE.

## Lo que sigue pendiente

Esto no certifica compatibilidad Chrome/Firefox/Safari ni un recorrido
completo contra la API autenticada y almacenamiento productivo. Siguen
pendientes cross-signing/confianza visible, autorización de dispositivos
adicionales, recuperación E2EE, reportes con evidencia verificable, auditoría
independiente y validación operativa de infraestructura.

La prueba de 48 horas adelanta el reloj: no es una espera física de 48 horas
ni demuestra borrado permanente en PostgreSQL, S3, WAL, backups o réplicas.
Una página suspendida no puede ejecutar JavaScript; se comprueba la caducidad
al volver a ejecutarse. Tampoco se pueden borrar capturas, descargas externas
o copias conservadas por un dispositivo comprometido.
