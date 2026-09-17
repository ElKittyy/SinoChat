import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { InvitationCryptoService } from "./invitation-crypto.service";

/** Impide retirar una clave mientras una invitación aún utilizable la necesita. */
@Injectable()
export class InvitationKeyringAuditService
  implements OnApplicationBootstrap
{
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: InvitationCryptoService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    let cursor: string | undefined;
    do {
      const invitations = await this.prisma.cashierInvitation.findMany({
        where: { revokedAt: null },
        orderBy: { id: "asc" },
        take: 500,
        ...(cursor
          ? {
              cursor: { id: cursor },
              skip: 1
            }
          : {}),
        select: {
          id: true,
          cashierUserId: true,
          codeLookupHash: true,
          codeCiphertext: true,
          codeNonce: true,
          encryptionKeyVersion: true,
          cipherFormatVersion: true
        }
      });

      for (const invitation of invitations) {
        const code = this.crypto.decrypt(
          invitation.codeCiphertext,
          invitation.codeNonce,
          invitation.encryptionKeyVersion,
          invitation.cipherFormatVersion,
          {
            kind: "client",
            invitationId: invitation.id,
            ownerUserId: invitation.cashierUserId
          }
        );
        if (!this.crypto.matchesLookupHash(code, invitation.codeLookupHash)) {
          throw new Error(
            `La invitación activa ${invitation.id} no coincide con su hash de búsqueda.`
          );
        }
      }

      cursor = invitations.at(-1)?.id;
      if (invitations.length < 500) {
        cursor = undefined;
      }
    } while (cursor);
  }
}
