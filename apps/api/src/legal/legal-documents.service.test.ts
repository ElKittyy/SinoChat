import { equal, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrismaService } from "../database/prisma.service";
import { LegalDocumentsService } from "./legal-documents.service";

describe("LegalDocumentsService", () => {
  it("sirve los bytes exactos de la versión vigente", async () => {
    const content = Buffer.from("Términos exactos\n", "utf8");
    const now = new Date("2026-08-02T12:00:00.000Z");
    const transaction = {
      $queryRaw: async () => [{ now }],
      termsDocument: {
        findFirst: async () => ({
          version: "v1",
          contentHash: "a".repeat(64),
          contentType: "text/plain",
          content,
          byteSize: content.byteLength,
          effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
          retiredAt: null
        })
      }
    };
    const prisma = {
      $transaction: async (
        operation: (client: typeof transaction) => Promise<unknown>
      ) => operation(transaction)
    } as unknown as PrismaService;

    const document = await new LegalDocumentsService(
      prisma
    ).currentTerms();

    equal(document.version, "v1");
    equal(Buffer.from(document.content).equals(content), true);
    equal(document.byteSize, content.byteLength);
  });

  it("no publica una versión histórica sin contenido verificable", async () => {
    const prisma = {
      termsDocument: {
        findUnique: async () => ({
          version: "legacy",
          contentHash: "b".repeat(64),
          contentType: null,
          content: null,
          byteSize: null,
          effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
          retiredAt: null
        })
      }
    } as unknown as PrismaService;

    await rejects(
      new LegalDocumentsService(prisma).termsByVersion("legacy"),
      /no está disponible/
    );
  });
});
