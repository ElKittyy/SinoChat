import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import { ConflictException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import {
  AdminAuditAction,
  AdminAuditTargetType
} from "../generated/prisma/enums";
import { InvitationCryptoService } from "../invitations/invitation-crypto.service";
import { ADMIN_AUTOMATIC_REASON } from "./admin-automatic-reason";
import { AdminInvitationsService } from "./admin-invitations.service";

describe("AdminInvitationsService", () => {
  it("crea onboarding y auditoría en una sola transacción sin guardar el código plano", async () => {
    let invitationData: any;
    let auditData: any;
    let transactionCalls = 0;
    const tx = {
      cashierOnboardingInvitation: {
        create: async (query: any) => {
          invitationData = query.data;
          return {
            id: "11111111-1111-4111-8111-111111111111",
            createdAt: new Date(),
            expiresAt: query.data.expiresAt
          };
        }
      },
      adminAuditEvent: {
        create: async (query: any) => {
          auditData = query.data;
          return {};
        }
      }
    };
    const prisma = {
      $transaction: async (
        operation: (transaction: typeof tx) => Promise<unknown>
      ) => {
        transactionCalls += 1;
        return operation(tx);
      }
    } as unknown as PrismaService;
    const crypto = {
      generateCode: () => "CODIGO-SECRETO",
      encrypt: () => ({
        ciphertext: Buffer.from("cifrado"),
        nonce: Buffer.from("nonce"),
        keyVersion: 1,
        formatVersion: 1
      }),
      lookupHash: () => "a".repeat(64)
    } as unknown as InvitationCryptoService;
    const service = new AdminInvitationsService(prisma, crypto);

    const result = await service.createCashierInvitation(
      "22222222-2222-4222-8222-222222222222",
      72
    );

    equal(transactionCalls, 1);
    equal(invitationData.codeLookupHash, "a".repeat(64));
    equal(invitationData.cipherFormatVersion, 1);
    equal("code" in invitationData, false);
    equal(auditData.action, AdminAuditAction.CASHIER_ONBOARDING_INVITATION_CREATED);
    equal(
      auditData.targetType,
      AdminAuditTargetType.CASHIER_ONBOARDING_INVITATION
    );
    equal(
      auditData.reasonCode,
      ADMIN_AUTOMATIC_REASON.CASHIER_ONBOARDING_INVITATION_CREATED
    );
    equal(JSON.stringify(auditData).includes("CODIGO-SECRETO"), false);
    equal(result.code, "CODIGO-SECRETO");
    ok(result.expiresAt > result.createdAt);
  });

  it("lista metadatos paginados por estado sin exponer secretos", async () => {
    const now = new Date("2026-08-26T12:00:00.000Z");
    let findQuery: any;
    let transactionOptions: any;
    const base = {
      createdByAdmin: { id: "admin-id", username: "administrador" },
      redeemedBy: null,
      codeLookupHash: "SECRETO-HASH",
      codeCiphertext: Buffer.from("SECRETO-CIPHERTEXT"),
      codeNonce: Buffer.from("SECRETO-NONCE")
    };
    const tx = {
      $queryRaw: async () => [{ now }],
      cashierOnboardingInvitation: {
        count: async () => 4,
        findMany: async (query: any) => {
          findQuery = query;
          return [
            {
              ...base,
              id: "active",
              createdAt: new Date("2026-08-25T12:00:00.000Z"),
              expiresAt: new Date("2026-08-27T12:00:00.000Z"),
              redeemedAt: null,
              revokedAt: null
            },
            {
              ...base,
              id: "expired",
              createdAt: new Date("2026-08-20T12:00:00.000Z"),
              expiresAt: new Date("2026-08-22T12:00:00.000Z"),
              redeemedAt: null,
              revokedAt: null
            },
            {
              ...base,
              id: "redeemed",
              createdAt: new Date("2026-08-20T12:00:00.000Z"),
              expiresAt: new Date("2026-08-27T12:00:00.000Z"),
              redeemedAt: new Date("2026-08-25T12:00:00.000Z"),
              revokedAt: null,
              redeemedBy: {
                user: { id: "cashier-id", username: "cajero" }
              }
            },
            {
              ...base,
              id: "revoked",
              createdAt: new Date("2026-08-20T12:00:00.000Z"),
              expiresAt: new Date("2026-08-27T12:00:00.000Z"),
              redeemedAt: null,
              revokedAt: new Date("2026-08-25T12:00:00.000Z")
            }
          ];
        }
      }
    };
    const prisma = {
      $transaction: async (
        operation: (transaction: typeof tx) => Promise<unknown>,
        options: unknown
      ) => {
        transactionOptions = options;
        return operation(tx);
      }
    } as unknown as PrismaService;
    const service = new AdminInvitationsService(
      prisma,
      {} as InvitationCryptoService
    );

    const result = await service.listCashierInvitations({
      status: "ACTIVE",
      page: 2,
      pageSize: 4
    });

    deepEqual(findQuery.where, {
      redeemedAt: null,
      revokedAt: null,
      expiresAt: { gt: now }
    });
    equal(findQuery.skip, 4);
    equal(findQuery.take, 4);
    equal(findQuery.select.codeLookupHash, undefined);
    equal(findQuery.select.codeCiphertext, undefined);
    equal(findQuery.select.codeNonce, undefined);
    deepEqual(
      result.items.map((item) => item.status),
      ["ACTIVE", "EXPIRED", "REDEEMED", "REVOKED"]
    );
    equal(result.items[0]?.canRevoke, true);
    equal(result.items[2]?.canRevoke, false);
    equal(result.pagination.totalPages, 1);
    equal(transactionOptions.isolationLevel, "RepeatableRead");
    equal(JSON.stringify(result).includes("SECRETO"), false);
  });

  it("revoca y audita una sola vez mediante actualización condicional", async () => {
    const now = new Date("2026-08-26T12:00:00.000Z");
    let updateQuery: any;
    let auditData: any;
    const invitation = {
      id: "11111111-1111-4111-8111-111111111111",
      createdAt: new Date("2026-08-25T12:00:00.000Z"),
      expiresAt: new Date("2026-08-27T12:00:00.000Z"),
      redeemedAt: null,
      revokedAt: now,
      createdByAdmin: { id: "admin-id", username: "administrador" },
      redeemedBy: null
    };
    const tx = {
      $queryRaw: async () => [{ now }],
      cashierOnboardingInvitation: {
        updateMany: async (query: any) => {
          updateQuery = query;
          return { count: 1 };
        },
        findUnique: async () => invitation
      },
      adminAuditEvent: {
        create: async (query: any) => {
          auditData = query.data;
          return {};
        }
      }
    };
    const prisma = {
      $transaction: async (
        operation: (transaction: typeof tx) => Promise<unknown>
      ) => operation(tx)
    } as unknown as PrismaService;
    const service = new AdminInvitationsService(
      prisma,
      {} as InvitationCryptoService
    );
    const result = await service.revokeCashierInvitation(
      "22222222-2222-4222-8222-222222222222",
      invitation.id
    );

    deepEqual(updateQuery.where, {
      id: invitation.id,
      redeemedAt: null,
      revokedAt: null
    });
    equal(updateQuery.data.revokedAt, now);
    equal(result.revokedNow, true);
    equal(result.invitation.status, "REVOKED");
    equal(auditData.action, AdminAuditAction.CASHIER_ONBOARDING_INVITATION_REVOKED);
    equal(
      auditData.reasonCode,
      ADMIN_AUTOMATIC_REASON.CASHIER_ONBOARDING_INVITATION_REVOKED
    );
    equal(auditData.stateBefore, "ACTIVE");
    equal(auditData.stateAfter, "REVOKED");
  });

  it("trata una revocación repetida como no-op sin duplicar auditoría", async () => {
    const now = new Date("2026-08-26T12:00:00.000Z");
    const tx = {
      $queryRaw: async () => [{ now }],
      cashierOnboardingInvitation: {
        updateMany: async () => ({ count: 0 }),
        findUnique: async () => ({
          id: "11111111-1111-4111-8111-111111111111",
          createdAt: new Date("2026-08-25T12:00:00.000Z"),
          expiresAt: new Date("2026-08-27T12:00:00.000Z"),
          redeemedAt: null,
          revokedAt: new Date("2026-08-26T11:00:00.000Z"),
          createdByAdmin: { id: "admin-id", username: "administrador" },
          redeemedBy: null
        })
      },
      adminAuditEvent: {
        create: async () => {
          throw new Error("No debe auditar nuevamente");
        }
      }
    };
    const prisma = {
      $transaction: async (
        operation: (transaction: typeof tx) => Promise<unknown>
      ) => operation(tx)
    } as unknown as PrismaService;
    const service = new AdminInvitationsService(
      prisma,
      {} as InvitationCryptoService
    );

    const result = await service.revokeCashierInvitation(
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111"
    );

    equal(result.revokedNow, false);
    equal(result.invitation.status, "REVOKED");
  });

  it("pierde de forma segura la carrera si el registro canjeó primero", async () => {
    const now = new Date("2026-08-26T12:00:00.000Z");
    const tx = {
      $queryRaw: async () => [{ now }],
      cashierOnboardingInvitation: {
        updateMany: async () => ({ count: 0 }),
        findUnique: async () => ({
          id: "11111111-1111-4111-8111-111111111111",
          createdAt: new Date("2026-08-25T12:00:00.000Z"),
          expiresAt: new Date("2026-08-27T12:00:00.000Z"),
          redeemedAt: now,
          revokedAt: null,
          createdByAdmin: { id: "admin-id", username: "administrador" },
          redeemedBy: {
            user: { id: "cashier-id", username: "cajero" }
          }
        })
      },
      adminAuditEvent: { create: async () => ({}) }
    };
    const prisma = {
      $transaction: async (
        operation: (transaction: typeof tx) => Promise<unknown>
      ) => operation(tx)
    } as unknown as PrismaService;
    const service = new AdminInvitationsService(
      prisma,
      {} as InvitationCryptoService
    );

    await rejects(
      service.revokeCashierInvitation(
        "22222222-2222-4222-8222-222222222222",
        "11111111-1111-4111-8111-111111111111"
      ),
      ConflictException
    );
  });
});
