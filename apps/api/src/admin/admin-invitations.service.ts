import {
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import {
  AdminAuditAction,
  AdminAuditTargetType
} from "../generated/prisma/enums";
import { InvitationCryptoService } from "../invitations/invitation-crypto.service";
import type {
  CashierOnboardingInvitationStatus,
  CashierOnboardingInvitationsQueryDto
} from "./dto/cashier-onboarding-invitations.dto";
import { ADMIN_AUTOMATIC_REASON } from "./admin-automatic-reason";

interface SafeInvitationRecord {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  redeemedAt: Date | null;
  revokedAt: Date | null;
  createdByAdmin: { id: string; username: string };
  redeemedBy: {
    user: { id: string; username: string };
  } | null;
}

@Injectable()
export class AdminInvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: InvitationCryptoService
  ) {}

  async listCashierInvitations(
    query: CashierOnboardingInvitationsQueryDto
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const now = await this.databaseNow(tx);
        const where = this.statusWhere(query.status, now);
        const [items, total] = await Promise.all([
          tx.cashierOnboardingInvitation.findMany({
            where,
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: {
              id: true,
              createdAt: true,
              expiresAt: true,
              redeemedAt: true,
              revokedAt: true,
              createdByAdmin: {
                select: { id: true, username: true }
              },
              redeemedBy: {
                select: {
                  user: { select: { id: true, username: true } }
                }
              }
            }
          }),
          tx.cashierOnboardingInvitation.count({ where })
        ]);

        return {
          items: items.map((item) => this.safeInvitation(item, now)),
          pagination: {
            page: query.page,
            pageSize: query.pageSize,
            total,
            totalPages: Math.ceil(total / query.pageSize)
          }
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 5_000,
        timeout: 15_000
      }
    );
  }

  async createCashierInvitation(
    adminUserId: string,
    expiresInHours: number
  ) {
    const code = this.crypto.generateCode();
    const invitationId = randomUUID();
    const encrypted = this.crypto.encrypt(code, {
      kind: "cashier-onboarding",
      invitationId,
      ownerUserId: adminUserId
    });
    const expiresAt = new Date(
      Date.now() + expiresInHours * 60 * 60 * 1_000
    );

    const invitation = await this.prisma.$transaction(async (tx) => {
      const created = await tx.cashierOnboardingInvitation.create({
        data: {
          id: invitationId,
          createdByAdminUserId: adminUserId,
          codeLookupHash: this.crypto.lookupHash(code),
          codeCiphertext: encrypted.ciphertext,
          codeNonce: encrypted.nonce,
          encryptionKeyVersion: encrypted.keyVersion,
          cipherFormatVersion: encrypted.formatVersion,
          expiresAt
        },
        select: {
          id: true,
          createdAt: true,
          expiresAt: true
        }
      });
      await tx.adminAuditEvent.create({
        data: {
          actorAdminId: adminUserId,
          action:
            AdminAuditAction.CASHIER_ONBOARDING_INVITATION_CREATED,
          targetType:
            AdminAuditTargetType.CASHIER_ONBOARDING_INVITATION,
          targetId: created.id,
          reasonCode:
            ADMIN_AUTOMATIC_REASON.CASHIER_ONBOARDING_INVITATION_CREATED,
          stateBefore: "NONE",
          stateAfter: JSON.stringify({
            expiresAt: created.expiresAt.toISOString()
          }),
          requestId: randomUUID()
        }
      });
      return created;
    });

    return {
      ...invitation,
      code
    };
  }

  async revokeCashierInvitation(
    adminUserId: string,
    invitationId: string
  ) {
    return this.prisma.$transaction(async (tx) => {
      const now = await this.databaseNow(tx);
      const update = await tx.cashierOnboardingInvitation.updateMany({
        where: {
          id: invitationId,
          redeemedAt: null,
          revokedAt: null
        },
        data: { revokedAt: now }
      });
      const invitation = await tx.cashierOnboardingInvitation.findUnique({
        where: { id: invitationId },
        select: {
          id: true,
          createdAt: true,
          expiresAt: true,
          redeemedAt: true,
          revokedAt: true,
          createdByAdmin: {
            select: { id: true, username: true }
          },
          redeemedBy: {
            select: {
              user: { select: { id: true, username: true } }
            }
          }
        }
      });

      if (!invitation) {
        throw new NotFoundException("La invitación no existe.");
      }
      if (update.count === 0) {
        if (invitation.revokedAt) {
          return {
            invitation: this.safeInvitation(invitation, now),
            revokedNow: false
          };
        }
        if (invitation.redeemedAt) {
          throw new ConflictException(
            "La invitación ya fue canjeada y no puede revocarse."
          );
        }
        throw new ConflictException(
          "La invitación cambió de estado. Actualiza el listado."
        );
      }

      const stateBefore: CashierOnboardingInvitationStatus =
        invitation.expiresAt <= now ? "EXPIRED" : "ACTIVE";
      await tx.adminAuditEvent.create({
        data: {
          actorAdminId: adminUserId,
          action: AdminAuditAction.CASHIER_ONBOARDING_INVITATION_REVOKED,
          targetType: AdminAuditTargetType.CASHIER_ONBOARDING_INVITATION,
          targetId: invitation.id,
          reasonCode:
            ADMIN_AUTOMATIC_REASON.CASHIER_ONBOARDING_INVITATION_REVOKED,
          stateBefore,
          stateAfter: "REVOKED",
          requestId: randomUUID()
        }
      });

      return {
        invitation: this.safeInvitation(invitation, now),
        revokedNow: true
      };
    });
  }

  private statusWhere(
    status: CashierOnboardingInvitationStatus | undefined,
    now: Date
  ): Prisma.CashierOnboardingInvitationWhereInput {
    if (status === "ACTIVE") {
      return { redeemedAt: null, revokedAt: null, expiresAt: { gt: now } };
    }
    if (status === "EXPIRED") {
      return { redeemedAt: null, revokedAt: null, expiresAt: { lte: now } };
    }
    if (status === "REDEEMED") {
      return { redeemedAt: { not: null }, revokedAt: null };
    }
    if (status === "REVOKED") {
      return { revokedAt: { not: null }, redeemedAt: null };
    }
    return {};
  }

  private safeInvitation(invitation: SafeInvitationRecord, now: Date) {
    const status: CashierOnboardingInvitationStatus = invitation.redeemedAt
      ? "REDEEMED"
      : invitation.revokedAt
        ? "REVOKED"
        : invitation.expiresAt <= now
          ? "EXPIRED"
          : "ACTIVE";
    return {
      id: invitation.id,
      status,
      canRevoke: status === "ACTIVE" || status === "EXPIRED",
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
      redeemedAt: invitation.redeemedAt,
      revokedAt: invitation.revokedAt,
      createdByAdmin: invitation.createdByAdmin,
      redeemedByCashier: invitation.redeemedBy?.user ?? null
    };
  }

  private async databaseNow(
    client: PrismaService | Prisma.TransactionClient
  ): Promise<Date> {
    const rows = await client.$queryRaw<Array<{ now: Date }>>(
      Prisma.sql`SELECT clock_timestamp() AS "now"`
    );
    const now = rows[0]?.now;
    if (!(now instanceof Date)) {
      throw new Error("No se pudo consultar el reloj de PostgreSQL.");
    }
    return now;
  }
}
