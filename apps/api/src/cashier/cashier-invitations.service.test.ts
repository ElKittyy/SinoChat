import { equal, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import { PrismaService } from "../database/prisma.service";
import { InvitationCryptoService } from "../invitations/invitation-crypto.service";
import { CashierInvitationsService } from "./cashier-invitations.service";

describe("CashierInvitationsService subscription boundary", () => {
  it("revierte la rotacion si la suscripcion vence antes del commit", async () => {
    const boundary = new Date("2026-08-02T20:00:00.000Z");
    let clockCalls = 0;
    let creates = 0;
    const tx = {
      $queryRaw: async (query: { sql?: string }) => {
        const sql = String(query.sql ?? query);
        if (sql.includes('FROM "cashier_profiles"')) {
          return [
            {
              userId: "11111111-1111-4111-8111-111111111111",
              subscriptionEndsAt: boundary
            }
          ];
        }
        clockCalls += 1;
        return [
          {
            now:
              clockCalls === 1
                ? new Date(boundary.getTime() - 1)
                : boundary
          }
        ];
      },
      cashierInvitation: {
        updateMany: async () => ({ count: 1 }),
        create: async () => {
          creates += 1;
          return {
            id: "22222222-2222-4222-8222-222222222222",
            createdAt: new Date(boundary.getTime() - 1)
          };
        }
      }
    };
    const prisma = {
      $transaction: async (
        operation: (transaction: typeof tx) => Promise<unknown>
      ) => operation(tx)
    } as unknown as PrismaService;
    const crypto = {
      generateCode: () => "codigo-seguro",
      encrypt: () => ({
        ciphertext: Buffer.alloc(32),
        nonce: Buffer.alloc(12),
        keyVersion: 1,
        formatVersion: 1
      }),
      lookupHash: () => "a".repeat(64)
    } as unknown as InvitationCryptoService;
    const service = new CashierInvitationsService(
      prisma,
      crypto,
      new ConversationEligibilityService({} as PrismaService)
    );

    await rejects(() =>
      service.rotate("11111111-1111-4111-8111-111111111111")
    );
    equal(creates, 1);
    equal(clockCalls, 2);
  });
});
