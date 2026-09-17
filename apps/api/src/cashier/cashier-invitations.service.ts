import { Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Prisma } from "../generated/prisma/client";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import { PrismaService } from "../database/prisma.service";
import { InvitationCryptoService } from "../invitations/invitation-crypto.service";

@Injectable()
export class CashierInvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: InvitationCryptoService,
    private readonly eligibility: ConversationEligibilityService
  ) {}

  async getCurrent(cashierUserId: string) {
    const invitation = await this.prisma.cashierInvitation.findFirst({
      where: {
        cashierUserId,
        revokedAt: null
      },
      orderBy: { createdAt: "desc" }
    });

    if (!invitation) {
      throw new NotFoundException("Aún no existe una invitación activa.");
    }

    const code = this.crypto.decrypt(
      invitation.codeCiphertext,
      invitation.codeNonce,
      invitation.encryptionKeyVersion,
      invitation.cipherFormatVersion,
      {
        kind: "client",
        invitationId: invitation.id,
        ownerUserId: cashierUserId
      }
    );
    if (!this.crypto.matchesLookupHash(code, invitation.codeLookupHash)) {
      throw new Error("La invitación cifrada no coincide con su identidad.");
    }

    return {
      id: invitation.id,
      code,
      createdAt: invitation.createdAt
    };
  }

  async rotate(cashierUserId: string) {
    const code = this.crypto.generateCode();
    const invitationId = randomUUID();
    const encrypted = this.crypto.encrypt(code, {
      kind: "client",
      invitationId,
      ownerUserId: cashierUserId
    });

    const invitation = await this.prisma.$transaction(async (tx) => {
      const availability = await this.assertAvailable(
        tx,
        cashierUserId
      );
      const now = await this.eligibility.assertPeriodStillActive(
        tx,
        availability.subscriptionEndsAt
      );
      await tx.cashierInvitation.updateMany({
        where: {
          cashierUserId,
          revokedAt: null
        },
        data: { revokedAt: now }
      });

      const created = await tx.cashierInvitation.create({
        data: {
          id: invitationId,
          cashierUserId,
          codeLookupHash: this.crypto.lookupHash(code),
          codeCiphertext: encrypted.ciphertext,
          codeNonce: encrypted.nonce,
          encryptionKeyVersion: encrypted.keyVersion,
          cipherFormatVersion: encrypted.formatVersion,
          createdAt: now
        },
        select: {
          id: true,
          createdAt: true
        }
      });
      await this.eligibility.assertPeriodStillActive(
        tx,
        availability.subscriptionEndsAt
      );
      return created;
    });

    return {
      ...invitation,
      code
    };
  }

  private async assertAvailable(
    tx: Prisma.TransactionClient,
    cashierUserId: string
  ) {
    return this.eligibility.lockCurrentCashier(
      tx,
      cashierUserId
    );
  }
}
