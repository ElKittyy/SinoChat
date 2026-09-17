import { Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  AccountStatus,
  CashierApprovalStatus,
  SubscriptionStatus
} from "../generated/prisma/enums";
import { PrismaService } from "../database/prisma.service";

@Injectable()
export class InvitationsService {
  constructor(private readonly prisma: PrismaService) {}

  async validate(code: string, role: "cliente" | "cajero") {
    const rows = await this.prisma.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS "now"
    `;
    const now = rows[0]?.now;
    if (!(now instanceof Date)) {
      throw new Error("No se pudo consultar el reloj de PostgreSQL.");
    }
    const codeLookupHash = createHash("sha256")
      .update(code.trim().toUpperCase(), "utf8")
      .digest("hex");

    const exists =
      role === "cliente"
        ? await this.prisma.cashierInvitation.findFirst({
            where: {
              codeLookupHash,
              revokedAt: null,
              cashier: {
                approvalStatus: CashierApprovalStatus.APPROVED,
                user: {
                  status: AccountStatus.ACTIVE,
                  passwordResetRequired: false
                },
                subscriptions: {
                  some: {
                    status: SubscriptionStatus.ACTIVE,
                    startsAt: { lte: now },
                    OR: [{ endsAt: null }, { endsAt: { gt: now } }]
                  }
                }
              }
            },
            select: { id: true }
          })
        : await this.prisma.cashierOnboardingInvitation.findFirst({
            where: {
              codeLookupHash,
              revokedAt: null,
              redeemedAt: null,
              expiresAt: { gt: now }
            },
            select: { id: true }
          });

    if (!exists) {
      throw new NotFoundException("La invitación no está disponible.");
    }

    return {
      valid: true,
      role
    };
  }
}
