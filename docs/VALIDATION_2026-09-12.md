# Validación local — 12 de septiembre de 2026

## Alcance: continúa el punto 1

Se implementaron piezas aisladas para comparar y certificar un dispositivo
adicional: validador público, controlador SAS y panel React. Se caracterizó la
verificación con dos máquinas reales de Matrix Rust Crypto 18.6.0.

**El punto 1 no está terminado.** El panel no está montado en la aplicación y no
existe todavía un recorrido de cuarentena y promoción conectado a sesiones
autenticadas. `comparison-complete` no autoriza un dispositivo. El gate permanece
`BLOCKED` / `E2EE_INTEGRATION_INCOMPLETE`; no se comenzó el punto 2 de recuperación.

## Cambios comprobados

- `parseMatrixDeviceCertificate` exige claves originales inmutables del candidato
  y el triplete ya autenticado y fijado por el servidor. Rechaza sustituciones de
  claves, algoritmos, identidad y firma; conserva la autofirma original junto a
  la firma nueva `self_signing`. No recibe claves privadas, no publica nada ni
  transforma el certificado en una aprobación. La cadena master→self-signing
  sigue siendo contexto confiable del servidor, no una prueba incluida en ese
  certificado aislado.
- `MatrixSasComparison` controla la fase de comparación de un SAS existente.
  Vincula usuario, ambos dispositivos y flujo; solo confirma un recibo emitido
  para los mismos valores. Serializa las operaciones con la cola proporcionada,
  consume el consentimiento antes de I/O y verifica todo el lote saliente antes
  de enviar. Error, cierre y vencimiento cancelan localmente un flujo todavía
  vivo. La cancelación del usuario aborta una confirmación pendiente antes de
  esperar esa cola. El temporizador también aborta un envío detenido sin esperar
  una nueva lectura; un navegador suspendido requiere revalidación al volver.
- `SasComparisonPanel` presenta tres grupos numéricos, casilla explícita,
  confirmación, rechazo y cancelación en español. Cambiar el recibo o los valores
  borra el consentimiento; los estados terminales retiran los números y las
  acciones. No muestra errores internos ni persiste códigos. Importa únicamente
  el tipo del controlador, sin cargar SDK o transporte.
- La caracterización distingue `Device.verify()` directo de SAS interactivo.
  Prueba confirmación en ambos extremos y consulta posterior, sin copiar secretos
  al candidato. Las firmas encoladas por SAS se confirman con su ID real; la
  solicitud directa sin ID no recibe un ACK inventado. La fixture no exige una
  firma candidato→raíz que el recorrido SAS observado no emitió.
- Negativos con SDK real: confirmación unilateral, cancelación, compromiso y MAC
  alterados y flujo ajeno. El relay sintético limita los eventos al usuario, par
  y flujo exactos y no transporta `m.secret.request` ni `m.secret.send`. No se
  imprimen los valores SAS.
- Se añadieron los tres comandos web a `npm.cmd test`. La prueba del panel usa
  Chrome, Vite y caché exclusivos, bloquea accesos a API/SDK y orígenes externos,
  y limpia únicamente sus temporales validados. Se corrigió su arranque aislado
  incluyendo `react/jsx-dev-runtime` en la optimización de dependencias; no se
  cambió el JSX del producto para resolver el harness.
- El build comprueba también que los hooks y la ruta de la fixture SAS no
  aparezcan en los artefactos de producción. No se modificaron los logotipos.

Diseño, contratos y siguientes pasos en
[Autorización de un dispositivo adicional](DEVICE_APPROVAL.md) y
[Bootstrap público de cross-signing](CROSS_SIGNING_BOOTSTRAP.md).

## Resultados ejecutados

Entorno: Windows local, Node 24.18.0, Matrix Rust Crypto 18.6.0 y Chrome headless.
No se certificó GitHub Actions, Linux, Firefox o Safari.

| Comprobación | Resultado |
| --- | --- |
| `npm.cmd test` | Correcto: 523 pruebas API, 3 de contratos y suite web |
| Nuevo certificado, incluido en el total API | 61 pruebas correctas; SDK real y firmantes independientes |
| `npm.cmd run check:sas-comparison` | 40 pruebas correctas del controlador con puerto SDK controlable |
| `npm.cmd run check:device-approval-sdk`, dentro de la suite | 15 pruebas correctas con SDK real; incluye controlador real en el recorrido SAS positivo |
| `npm.cmd run check:sas-panel` | 19 comprobaciones correctas de interacciones reales en Chrome con vistas sintéticas |
| `npm.cmd run typecheck` | Contratos, API y web correctos |
| `npm.cmd run build` | Correcto; React productivo, WASM diferido y fixtures excluidas |
| `npm.cmd run check:e2ee-browser` | Correcto: cliente cifrado, texto, fotos, recarga y caducidad local con relay HTTP sintético |
| Gate y restricción de dispositivo histórico único | Sin cambios |

Las regresiones del controlador incluyen cancelación remota durante I/O,
cancelación local mientras el envío está esperando, un transporte que rechaza
al abortarse, vencimiento con red detenida y liberación de wrappers una sola
vez. Las pruebas del panel incluyen doble clic, casilla reiniciada, cinco
estados terminales, error de una acción anterior, ancho de 320 px, teclado y
desmontaje con promesa pendiente.

No hay nuevas migraciones: siguen siendo 30. No se ejecutaron comprobaciones
PostgreSQL ni se aplicaron migraciones en esta tanda. La ejecución anterior en
base exclusiva se conserva en la [validación del 11 de septiembre](VALIDATION_2026-09-11.md),
sin atribuirla a esta fecha. No se cambiaron cuentas, asignaciones, auditorías,
secretos o dependencias; no se reiniciaron servidores persistentes. Las pruebas
cerraron sus contextos de navegador y eliminaron únicamente sus temporales de
prueba, recreables al volver a ejecutarlas.

## Límites y siguiente trabajo

El certificado puro, el SAS en memoria y la pantalla con callbacks sintéticos
son tres pruebas complementarias. **No constituyen una prueba integral de
autorización entre navegadores y la API real.** Falta:

1. Definir y revisar la vinculación autorizante entre solicitud, flujo, claves
   exactas, ambas sesiones, resultado y consumo único. La existencia del
   certificado no prueba frescura ni consentimiento.
2. Implementar cuarentena fuera del directorio operativo y su canal limitado,
   sin acceso a conversaciones, preclaves o permisos de un dispositivo activo.
3. Integrar controlador y pantalla con esa rama de incorporación, persistencia,
   pérdida de conectividad, reinicios y varias pestañas. El transporte real debe
   compartir la cola del SDK, tener timeout y resolver tras HTTP válido y ACK.
4. Probar la promoción atómica y sus carreras con cancelación, revocación,
   suspensión, vencimiento y reintentos sobre PostgreSQL real.
5. Completar la verificación de identidad del interlocutor y las pruebas entre
   navegadores antes de cerrar el punto 1.

No hay reset de raíces, exportación de claves privadas, recuperación E2EE
administrativa ni entrega de historial a un nuevo dispositivo. Estas pruebas
no sustituyen una auditoría criptográfica independiente ni autorizan producción.
