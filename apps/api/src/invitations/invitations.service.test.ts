import { equal } from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrismaService } from "../database/prisma.service";
import { InvitationsService } from "./invitations.service";

describe("InvitationsService", () => {
  it("evalúa la disponibilidad con el reloj de PostgreSQL", async () => {
    const databaseNow = new Date("2026-08-02T12:00:00.000Z");
    let receivedEndsAt: Date | undefined;
    let requiresCompletedPasswordReset = false;
    const prisma = {
      $queryRaw: async () => [{ now: databaseNow }],
      cashierInvitation: {
        findFirst: async (query: {
          where: {
            cashier: {
              subscriptions: {
                some: { OR: Array<{ endsAt?: { gt: Date } }> };
              };
            };
          };
        }) => {
          receivedEndsAt = query.where.cashier.subscriptions.some.OR[1]
            ?.endsAt?.gt;
          requiresCompletedPasswordReset =
            (query.where.cashier as unknown as {
              user: { passwordResetRequired: boolean };
            }).user.passwordResetRequired === false;
          return { id: "invitation" };
        }
      }
    } as unknown as PrismaService;

    const result = await new InvitationsService(prisma).validate(
      "SINO-ABCDEFGHIJKLMNOP",
      "cliente"
    );

    equal(receivedEndsAt, databaseNow);
    equal(requiresCompletedPasswordReset, true);
    equal(result.valid, true);
  });
});
