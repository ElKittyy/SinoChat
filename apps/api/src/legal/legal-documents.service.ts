import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

export interface ServedTermsDocument {
  version: string;
  contentHash: string;
  contentType: string;
  content: Uint8Array;
  byteSize: number;
  effectiveAt: Date;
  retiredAt: Date | null;
}

const TERMS_SELECT = {
  version: true,
  contentHash: true,
  contentType: true,
  content: true,
  byteSize: true,
  effectiveAt: true,
  retiredAt: true
} as const;

@Injectable()
export class LegalDocumentsService {
  constructor(private readonly prisma: PrismaService) {}

  async currentTerms(): Promise<ServedTermsDocument> {
    const document = await this.prisma.$transaction(
      async (transaction) => {
        const rows = await transaction.$queryRaw<{ now: Date }[]>`
          SELECT clock_timestamp() AS "now"
        `;
        const now = rows[0]?.now;
        if (!now) {
          throw new Error(
            "No se pudo consultar el reloj de PostgreSQL."
          );
        }
        return transaction.termsDocument.findFirst({
          where: {
            content: { not: null },
            contentType: { not: null },
            byteSize: { not: null },
            effectiveAt: { lte: now },
            OR: [
              { retiredAt: null },
              { retiredAt: { gt: now } }
            ]
          },
          orderBy: [
            { effectiveAt: "desc" },
            { createdAt: "desc" }
          ],
          select: TERMS_SELECT
        });
      }
    );
    if (!document) {
      throw new ServiceUnavailableException(
        "Los términos vigentes todavía no fueron publicados."
      );
    }
    return this.assertComplete(document);
  }

  async termsByVersion(version: string): Promise<ServedTermsDocument> {
    const document = await this.prisma.termsDocument.findUnique({
      where: { version },
      select: TERMS_SELECT
    });
    if (!document?.content) {
      throw new NotFoundException(
        "La versión de términos no está disponible."
      );
    }
    return this.assertComplete(document);
  }

  private assertComplete(document: {
    version: string;
    contentHash: string;
    contentType: string | null;
    content: Uint8Array | null;
    byteSize: number | null;
    effectiveAt: Date;
    retiredAt: Date | null;
  }): ServedTermsDocument {
    if (
      !document.contentType ||
      !document.content ||
      document.byteSize === null ||
      document.content.byteLength !== document.byteSize
    ) {
      throw new ServiceUnavailableException(
        "El documento legal publicado está incompleto."
      );
    }
    return {
      ...document,
      contentType: document.contentType,
      content: document.content,
      byteSize: document.byteSize
    };
  }
}
