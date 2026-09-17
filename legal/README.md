# Documentos legales

`terminos-desarrollo-local-v1.md` es un borrador creado únicamente para probar
los registros locales. La base local lo publica como `dev-local-v1`.

No se debe desplegar esa versión en producción ni presentarla como asesoramiento
legal. Antes de una publicación real:

1. sustituirla por términos y política de privacidad revisados para la
   jurisdicción aplicable;
2. aprobar los bytes definitivos sin BOM ni transformaciones posteriores;
3. calcular su SHA-256;
4. publicarlos con `npm run terms:publish --workspace @sinochat/api` siguiendo
   `docs/RUNBOOK_WINDOWS.md`;
5. verificar versión, headers, hash y contenido desde
   `GET /api/legal/terms/current`.

Las versiones ya publicadas son inmutables. Una corrección se publica como una
versión nueva con una fecha efectiva posterior.
