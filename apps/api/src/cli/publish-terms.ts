import "../config/load-env";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { PrismaService } from "../database/prisma.service";
import {
  isHelpRequest,
  parseTermsPublicationInput,
  validateTermsDocument
} from "./operational-input";
import {
  runOperationalTransaction
} from "./operational-transaction";
import { lockTermsLifecycle } from "../legal/terms-lifecycle-lock";

const HELP = `
Publica una versión inmutable de TermsDocument.

Uso:
  npm run terms:publish -- --file <ruta> --version <versión> \\
    --type <text/markdown|text/plain> --effective-at <ISO-8601>

Opcional:
  --expected-sha256 <64 hex minúsculos>

Variables equivalentes:
  TERMS_DOCUMENT_FILE
  TERMS_DOCUMENT_VERSION
  TERMS_DOCUMENT_TYPE
  TERMS_DOCUMENT_EFFECTIVE_AT
  TERMS_DOCUMENT_EXPECTED_SHA256
`.trim();

interface PublicationResult {
  created: boolean;
  document: {
    id: string;
    version: string;
    contentHash: string;
    effectiveAt: Date;
    retiredAt: Date | null;
  };
  previousRetired?: {
    id: string;
    version: string;
    retiredAt: Date;
  };
}

async function publishTerms(): Promise<void> {
  const argv = process.argv.slice(2);
  if (isHelpRequest(argv)) {
    console.log(HELP);
    return;
  }

  const input = parseTermsPublicationInput(argv, process.env);
  const filePath = isAbsolute(input.file)
    ? input.file
    : resolve(process.cwd(), input.file);
  const fileStats = await stat(filePath);
  if (!fileStats.isFile()) {
    throw new Error("TERMS_DOCUMENT_FILE debe apuntar a un archivo regular.");
  }
  const bytes = await readFile(filePath);
  const inspected = validateTermsDocument(bytes, input.sourceType);
  if (
    input.expectedSha256 &&
    input.expectedSha256 !== inspected.sha256
  ) {
    throw new Error(
      "El SHA-256 calculado no coincide con TERMS_DOCUMENT_EXPECTED_SHA256."
    );
  }

  const prisma = new PrismaService();
  try {
    await prisma.$connect();
    const result = await runOperationalTransaction(
      prisma,
      async (tx): Promise<PublicationResult> => {
        await lockTermsLifecycle(tx);

        const existing = await tx.termsDocument.findUnique({
          where: { version: input.version },
          select: {
            id: true,
            version: true,
            contentHash: true,
            contentType: true,
            content: true,
            byteSize: true,
            effectiveAt: true,
            retiredAt: true
          }
        });
        if (existing) {
          if (
            existing.contentHash !== inspected.sha256 ||
            existing.contentType !== input.sourceType ||
            existing.byteSize !== inspected.byteSize ||
            !existing.content ||
            !Buffer.from(existing.content).equals(bytes) ||
            existing.effectiveAt.getTime() !==
              input.effectiveAt.getTime()
          ) {
            throw new Error(
              "La versión ya existe con otro hash o fecha efectiva."
            );
          }
          return {
            created: false,
            document: existing
          };
        }

        const sameContent = await tx.termsDocument.findFirst({
          where: { contentHash: inspected.sha256 },
          select: { version: true }
        });
        if (sameContent) {
          throw new Error(
            `El mismo contenido ya fue publicado como versión ${sameContent.version}.`
          );
        }

        const [latest, openDocuments, overlappingDocuments] =
          await Promise.all([
            tx.termsDocument.findFirst({
              orderBy: [
                { effectiveAt: "desc" },
                { createdAt: "desc" }
              ],
              select: {
                id: true,
                version: true,
                effectiveAt: true,
                retiredAt: true
              }
            }),
            tx.termsDocument.findMany({
              where: { retiredAt: null },
              orderBy: { effectiveAt: "desc" },
              take: 2,
              select: {
                id: true,
                version: true,
                effectiveAt: true
              }
            }),
            tx.termsDocument.count({
              where: {
                effectiveAt: { lte: input.effectiveAt },
                OR: [
                  { retiredAt: null },
                  { retiredAt: { gt: input.effectiveAt } }
                ]
              }
            })
          ]);

        if (
          openDocuments.length > 1 ||
          overlappingDocuments > 1
        ) {
          throw new Error(
            "Hay más de una versión abierta o superpuesta; corrige el historial antes de publicar."
          );
        }
        if (
          latest &&
          input.effectiveAt.getTime() <= latest.effectiveAt.getTime()
        ) {
          throw new Error(
            "La fecha efectiva debe ser posterior a la última versión publicada."
          );
        }
        if (
          latest &&
          openDocuments[0] &&
          latest.id !== openDocuments[0].id
        ) {
          throw new Error(
            "La versión sin retiro no es la última del historial."
          );
        }
        if (
          latest?.retiredAt &&
          latest.retiredAt > input.effectiveAt
        ) {
          throw new Error(
            "La nueva vigencia se superpone con un retiro ya inmutable."
          );
        }

        let previousRetired: PublicationResult["previousRetired"];
        if (openDocuments[0]) {
          if (
            input.effectiveAt.getTime() <=
            openDocuments[0].effectiveAt.getTime()
          ) {
            throw new Error(
              "El retiro debe ser posterior a la activación anterior."
            );
          }
          const retired = await tx.termsDocument.updateMany({
            where: {
              id: openDocuments[0].id,
              retiredAt: null
            },
            data: {
              retiredAt: input.effectiveAt
            }
          });
          if (retired.count !== 1) {
            throw new Error(
              "La versión anterior cambió durante la publicación."
            );
          }
          previousRetired = {
            id: openDocuments[0].id,
            version: openDocuments[0].version,
            retiredAt: input.effectiveAt
          };
        }

        const document = await tx.termsDocument.create({
          data: {
            version: input.version,
            contentHash: inspected.sha256,
            contentType: input.sourceType,
            content: bytes,
            byteSize: inspected.byteSize,
            effectiveAt: input.effectiveAt
          },
          select: {
            id: true,
            version: true,
            contentHash: true,
            effectiveAt: true,
            retiredAt: true
          }
        });

        return {
          created: true,
          document,
          previousRetired
        };
      }
    );

    console.log(
      JSON.stringify(
        {
          status: result.created ? "PUBLISHED" : "UNCHANGED",
          id: result.document.id,
          version: result.document.version,
          sourceType: input.sourceType,
          sourceByteSize: inspected.byteSize,
          contentSha256: result.document.contentHash,
          effectiveAt: result.document.effectiveAt.toISOString(),
          retiredAt: result.document.retiredAt?.toISOString() ?? null,
          previousRetired: result.previousRetired
            ? {
                ...result.previousRetired,
                retiredAt:
                  result.previousRetired.retiredAt.toISOString()
              }
            : null,
        },
        null,
        2
      )
    );
  } finally {
    await prisma.$disconnect();
  }
}

void publishTerms().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Error desconocido";
  console.error(`No se pudieron publicar los términos: ${message}`);
  process.exitCode = 1;
});
