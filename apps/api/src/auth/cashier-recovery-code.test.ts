import { doesNotMatch, equal, match, notEqual, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrismaService } from "../database/prisma.service";
import { AccountStatus, UserRole } from "../generated/prisma/enums";
import { AuthService } from "./auth.service";
import type { PasswordService } from "./password.service";
import type { SessionTokenService } from "./session-token.service";
import {
  CASHIER_RECOVERY_CODE_COUNT,
  CASHIER_RECOVERY_CODE_PATTERN,
  cashierPasswordResetExpiresAt,
  hashCashierRecoveryCode,
  issueCashierRecoveryCodes,
} from "./cashier-recovery-code";

const CASHIER_ID = "11111111-1111-4111-8111-111111111111";

describe("cashier recovery codes", () => {
  it("genera ocho factores independientes y solo conserva hashes deterministas", () => {
    const issuedAt = new Date("2026-09-01T12:00:00.000Z");
    const recovery = issueCashierRecoveryCodes(issuedAt);

    equal(recovery.codes.length, CASHIER_RECOVERY_CODE_COUNT);
    equal(new Set(recovery.codes).size, CASHIER_RECOVERY_CODE_COUNT);
    equal(recovery.expiresAt, null);
    for (const code of recovery.codes) {
      match(code, CASHIER_RECOVERY_CODE_PATTERN);
      const hash = hashCashierRecoveryCode(CASHIER_ID, code);
      match(hash, /^[0-9a-f]{64}$/);
      doesNotMatch(hash, new RegExp(code.replaceAll("-", ""), "i"));
      equal(hash, hashCashierRecoveryCode(CASHIER_ID, ` ${code.toLowerCase()} `));
      notEqual(
        hash,
        hashCashierRecoveryCode(
          "22222222-2222-4222-8222-222222222222",
          code,
        ),
      );
    }
  });

  it("limita cada solicitud administrativa a veinticuatro horas", () => {
    equal(
      cashierPasswordResetExpiresAt(
        new Date("2026-09-01T12:00:00.000Z"),
      ).toISOString(),
      "2026-09-02T12:00:00.000Z",
    );
  });

  it("rota los ocho códigos, revoca los anteriores y nunca persiste plaintext", async () => {
    const databaseNow = new Date("2026-09-01T12:00:00.000Z");
    let revokedAt: Date | undefined;
    let inserted: Array<Record<string, unknown>> = [];
    let txQuery = 0;
    const user = {
      id: CASHIER_ID,
      role: UserRole.CASHIER,
      status: AccountStatus.ACTIVE,
      passwordHash: "current-hash",
      passwordResetRequired: false
    };
    const transaction = {
      $queryRaw: async () => {
        txQuery += 1;
        return txQuery === 1 ? [{ id: CASHIER_ID }] : [{ now: databaseNow }];
      },
      user: { findUnique: async () => ({ ...user }) },
      cashierRecoveryCode: {
        updateMany: async (input: { data: { revokedAt: Date } }) => {
          revokedAt = input.data.revokedAt;
          return { count: 8 };
        },
        createMany: async (input: { data: Array<Record<string, unknown>> }) => {
          inserted = input.data;
          return { count: input.data.length };
        }
      }
    };
    const prisma = {
      user: { findUnique: async () => ({ ...user }) },
      $queryRaw: async () => [{ now: databaseNow }],
      $transaction: async (
        operation: (tx: typeof transaction) => Promise<unknown>
      ) => operation(transaction)
    } as unknown as PrismaService;
    const service = new AuthService(
      prisma,
      { verify: async () => true } as unknown as PasswordService,
      {} as SessionTokenService
    );

    const result = await service.rotateCashierRecoveryCodes(
      {
        id: CASHIER_ID,
        username: "cajero",
        role: UserRole.CASHIER,
        status: AccountStatus.ACTIVE,
        sessionId: "session-id",
        deviceId: null,
        sessionExpiresAt: new Date("2026-09-02T12:00:00.000Z")
      },
      { currentPassword: "Actual#Segura2026" }
    );

    equal(result.recoveryCodes.length, CASHIER_RECOVERY_CODE_COUNT);
    equal(result.recoveryCodesExpireAt, null);
    equal(revokedAt, databaseNow);
    equal(inserted.length, CASHIER_RECOVERY_CODE_COUNT);
    for (const row of inserted) {
      match(String(row.codeHash), /^[0-9a-f]{64}$/);
      equal(row.expiresAt, null);
    }
    const stored = JSON.stringify(inserted);
    for (const code of result.recoveryCodes) doesNotMatch(stored, new RegExp(code));
  });

  it("no rota si la contraseña actual no se verifica", async () => {
    let transactionStarted = false;
    const service = new AuthService(
      {
        user: {
          findUnique: async () => ({
            id: CASHIER_ID,
            role: UserRole.CASHIER,
            status: AccountStatus.ACTIVE,
            passwordHash: "current-hash",
            passwordResetRequired: false
          })
        },
        $transaction: async () => {
          transactionStarted = true;
        }
      } as unknown as PrismaService,
      { verify: async () => false } as unknown as PasswordService,
      {} as SessionTokenService
    );

    await rejects(
      service.rotateCashierRecoveryCodes(
        {
          id: CASHIER_ID,
          username: "cajero",
          role: UserRole.CASHIER,
          status: AccountStatus.ACTIVE,
          sessionId: "session-id",
          deviceId: null,
          sessionExpiresAt: new Date()
        },
        { currentPassword: "Incorrecta#2026" }
      ),
      /verificar la contraseña actual/
    );
    equal(transactionStarted, false);
  });
});
