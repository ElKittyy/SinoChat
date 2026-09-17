# Validación local — perfil SAS, 13 de septiembre de 2026

Tanda iniciada el 12 y documentada al continuar el 13 de septiembre. Continúa
exclusivamente el punto 1, identidad y autorización de dispositivos.

## Resultado y alcance

Se implementó `parseMatrixSasToDeviceRequest`: un validador puro para los ocho
tipos de eventos de comparación SAS entre dos dispositivos de la misma cuenta.
No se implementó un canal HTTP, admisión de flujo, almacenamiento de eventos,
aprobación ni recuperación de claves. El gate continúa compilado
`BLOCKED` / `E2EE_INTEGRATION_INCOMPLETE`.

Archivos principales:

- [Validador SAS](../apps/api/src/e2ee/matrix-sas-to-device.ts).
- [Pruebas del perfil](../apps/api/src/e2ee/matrix-sas-to-device.test.ts).
- [Fixture de dos máquinas SDK](../apps/api/src/e2ee/testing/matrix-sas.fixture.ts).
- [Contrato y límites del futuro canal](MATRIX_SAS_TRANSPORT.md).

La reserva y revisión de candidatos ya implementadas no se modificaron. Se
conservaron las 31 migraciones, el límite histórico de dispositivos y la
restricción de certificados bootstrap. El parser nuevo solo se importa desde
su suite: no amplía rutas de conversación ni está montado en el navegador.

## Comprobaciones nuevas

Las 115 pruebas cubren:

- Perfil real de request, ready, start, accept, key, mac, done y cancel del SDK
  Matrix Rust Crypto 18.6.0, validado antes de entregarse a la máquina receptora.
- Finalización local con confirmaciones sintéticas y cancelación por usuario,
  timeout y comparación discrepante. No se muestran valores SAS ni se exportan
  claves privadas; no se publican certificados ni se entregan eventos de secretos.
- Oferta MAC original del SDK conservada sin reordenar y accept exclusivamente
  v2. El accept observado no tiene `method`; exigirlo rompería ese recorrido.
- MAC del emisor: dispositivo+master fijada para el extremo confiable, solo
  dispositivo para el candidato en la fixture inicial. Entradas ajenas se rechazan.
- Separación entre ID de envío HTTP e ID de comparación. No se exige que sean
  iguales ni diferentes. Hash reproducible y sensible al contexto/contenido.
- Un único destinatario propio y flujo esperado; sin comodines, salas,
  destinatarios adicionales, cuerpos de chat o solicitudes/respuestas de secretos.
- Campos exactos, Base64 estándar canónica de 32 bytes, algoritmos acotados,
  timestamp estructuralmente válido y diagnóstico de cancelación limitado.
- Clonación/congelación profundas; rechazo de proxies, getters, `toJSON`,
  propiedades ocultas, símbolos, arrays incompletos y prototipos ajenos.
- El parser operativo anterior sigue rechazando todos los tipos SAS.

La fixture compara contenido cuando observa un ID repetido antes de omitir su
segunda entrega. Esto no es un ledger persistente de reintentos y no prueba
carreras de entrega, respuestas perdidas ni consumo único en PostgreSQL.

## Resultados ejecutados

Entorno local Windows con Node 24 y SDK Matrix Rust Crypto 18.6.0 fijado.

| Comprobación | Resultado |
| --- | --- |
| `npm.cmd test` | 851 pruebas API, 3 de contratos y suite web correctas |
| Nuevo perfil SAS, incluido en el total API | 115 pruebas correctas |
| `npm.cmd run typecheck` | Contratos, API y web correctos |
| `npm.cmd run build` | Correcto; bundle web sin fixtures ni hooks de prueba |
| Gate compilado y rutas de conversación | Sin cambios; SAS no habilitado |
| Migraciones | Sin cambios; siguen siendo 31 |

La primera compilación de la fixture detectó una unión TypeScript del SDK que
no discrimina `OutgoingRequest` por enum; se acotó después de comprobar su tipo.
Un test inicial usaba una cadena válida para representar un flow inválido:
se corrigió la entrada del test, sin relajar el validador. La ejecución final
pasó todos los casos. Los errores de Redis/almacenamiento que imprime la suite
general corresponden a sus escenarios negativos controlados.

No se ejecutaron migraciones, pruebas PostgreSQL ni cambios sobre la base
habitual en esta tanda; no los necesita un módulo puro sin persistencia. La
evidencia PostgreSQL de reserva/revisión permanece en la
[validación anterior](VALIDATION_2026-09-12_DEVICE_REVIEW.md), sin presentarla
como una prueba del nuevo canal. No se cambiaron dependencias, secretos,
cuentas, asignaciones ni logotipos. No se reiniciaron API o PWA persistentes.

## Garantías que todavía faltan

Un paquete válido aquí no autentica al llamante ni prueba comparación humana.
El contexto esperado debe proceder de un servicio autorizado. El parser no
verifica MAC/compromisos ni negociación entre start y accept: esa criptografía
corresponde al SDK. Tampoco evalúa vigencia de sesión o solicitud; un timestamp
válido no puede sustituir el reloj PostgreSQL ni extender la cuarentena.

Próximos trabajos dentro del punto 1:

1. Diseñar y persistir la vinculación de reserva, flujo real, pin, snapshots y
   dos sesiones; admitir el primer evento sin confiar en contexto autodeclarado.
2. Implementar el canal restringido con autorización, TTL, orden, cuotas,
   reintentos, revocación y limpieza, sin destinatarios operativos para candidatos.
3. Integrar ambas pantallas con el SDK y la rama persistente del navegador.
4. Implementar promoción atómica con una prueba autorizante vinculada a la
   ceremonia, nunca mediante un `done`, cookie o certificado aislados.
5. Verificar confianza del interlocutor y completar la revisión de seguridad.

La cobertura actual usa máquinas nuevas para cada recorrido; no certifica
reutilización de handles SDK, reinicios, varias pestañas, QR ni versiones
distintas. El punto 1 y el acceso a producción siguen pendientes.
