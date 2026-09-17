import { deepEqual, equal, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import type { MatrixDeviceListPublisher } from "../database/matrix-device-list.publisher";
import { AccountStatus, UserRole } from "../generated/prisma/enums";
import { AuthService } from "./auth.service";
import { hashCashierRecoveryCode } from "./cashier-recovery-code";
import { PasswordService } from "./password.service";
import { SessionTokenService } from "./session-token.service";

const INPUT = {
  username: "cajero_seguro",
  recoveryCode: "SC-ABCDE-FGHJK-MNPQR-STUVW",
  newPassword: "Nueva#Segura2026"
};

const CASHIER = {
  id: "cashier-id",
  username: "cajero_seguro",
  normalizedUsername: "cajero_seguro",
  role: UserRole.CASHIER,
  status: AccountStatus.ACTIVE,
  passwordHash: "old-hash",
  passwordResetRequired: true,
  passwordChangedAt: new Date("2026-08-02T10:00:00.000Z"),
  sessionVersion: 4,
  failedLoginAttempts: 0,
  lockedUntil: null,
  lastLoginAt: null,
  suspendedAt: null,
  suspensionReasonCode: null,
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-02T10:00:00.000Z")
};

function responseOf(error: unknown): unknown {
  return error instanceof HttpException ? error.getResponse() : error;
}

async function rejectedResponse(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error: unknown) {
    return responseOf(error);
  }
  throw new Error("Se esperaba que la operación fuera rechazada.");
}

describe("cashier password recovery completion", () => {
  it("consume un código una sola vez, cambia la contraseña y no crea una sesión", async () => {
    const databaseNow = new Date("2026-09-01T15:00:00.000Z");
    let user = { ...CASHIER };
    let rawQuery = 0;
    let codeClaim: Record<string, unknown> | undefined;
    let resetClaim: Record<string, unknown> | undefined;
    let sessionRevocation: Record<string, unknown> | undefined;
    let completionData: Record<string, unknown> | undefined;
    let sessionCreates = 0;
    let relationshipPublication:
      | { userId: string; changeType: string; createdAt: Date }
      | undefined;

    const transaction = {
      $queryRaw: async () => {
        rawQuery += 1;
        return rawQuery === 1 ? [{ id: CASHIER.id }] : [{ now: databaseNow }];
      },
      cashierPasswordReset: {
        findFirst: async () => ({ id: "reset-id" }),
        updateMany: async (input: { data: Record<string, unknown> }) => {
          resetClaim = input.data;
          return { count: 1 };
        }
      },
      cashierRecoveryCode: {
        findFirst: async (input: { where: Record<string, unknown> }) => {
          equal(
            input.where.codeHash,
            hashCashierRecoveryCode(CASHIER.id, INPUT.recoveryCode)
          );
          return { id: "code-id" };
        },
        updateMany: async (input: { data: Record<string, unknown> }) => {
          codeClaim = input.data;
          return { count: 1 };
        }
      },
      user: {
        updateMany: async (input: { data: Record<string, unknown> }) => {
          completionData = input.data;
          user = {
            ...user,
            passwordHash: "new-hash",
            passwordResetRequired: false,
            passwordChangedAt: databaseNow,
            sessionVersion: user.sessionVersion + 1
          };
          return { count: 1 };
        }
      },
      authSession: {
        updateMany: async (input: { data: Record<string, unknown> }) => {
          sessionRevocation = input.data;
          return { count: 2 };
        },
        create: async () => {
          sessionCreates += 1;
          return {};
        }
      }
    };
    const prisma = {
      user: { findUnique: async () => ({ ...user }) },
      $transaction: async (
        operation: (tx: typeof transaction) => Promise<unknown>
      ) => operation(transaction)
    } as unknown as PrismaService;
    const passwords = {
      verify: async () => false,
      verifyAgainstDummy: async () => undefined,
      hash: async (password: string) => {
        equal(password, INPUT.newPassword);
        return "new-hash";
      }
    } as unknown as PasswordService;
    const service = new AuthService(
      prisma,
      passwords,
      {} as SessionTokenService,
      {
        publishCurrentRelationshipsForUser: async (
          _transaction: unknown,
          userId: string,
          changeType: string,
          createdAt: Date
        ) => {
          relationshipPublication = { userId, changeType, createdAt };
        }
      } as unknown as MatrixDeviceListPublisher
    );

    await service.completeAdminReset(INPUT);

    equal(sessionCreates, 0);
    equal(user.passwordResetRequired, false);
    equal(user.sessionVersion, 5);
    equal(codeClaim?.usedAt, databaseNow);
    equal(resetClaim?.consumedAt, databaseNow);
    equal(resetClaim?.recoveryCodeId, "code-id");
    equal(completionData?.passwordHash, "new-hash");
    equal(completionData?.passwordResetRequired, false);
    deepEqual(completionData?.sessionVersion, { increment: 1 });
    equal(sessionRevocation?.revocationReason, "ADMIN_PASSWORD_CHANGE_COMPLETED");
    deepEqual(relationshipPublication, {
      userId: CASHIER.id,
      changeType: "CHANGED",
      createdAt: databaseNow
    });

    const replay = await rejectedResponse(service.completeAdminReset(INPUT));
    deepEqual(replay, {
      code: "ADMIN_PASSWORD_RESET_INVALID",
      message:
        "No se pudo completar el restablecimiento con los datos proporcionados."
    });
  });

  it("da la misma respuesta para usuario inexistente, rol incorrecto o solicitud inactiva", async () => {
    let selected:
      | (Omit<typeof CASHIER, "role"> & { role: UserRole })
      | null = null;
    let dummyChecks = 0;
    const prisma = {
      user: { findUnique: async () => selected }
    } as unknown as PrismaService;
    const passwords = {
      verifyAgainstDummy: async () => {
        dummyChecks += 1;
      }
    } as unknown as PasswordService;
    const service = new AuthService(
      prisma,
      passwords,
      {} as SessionTokenService
    );

    const missing = await rejectedResponse(service.completeAdminReset(INPUT));
    selected = { ...CASHIER, role: UserRole.CLIENT };
    const client = await rejectedResponse(service.completeAdminReset(INPUT));
    selected = { ...CASHIER, passwordResetRequired: false };
    const inactive = await rejectedResponse(service.completeAdminReset(INPUT));

    deepEqual(client, missing);
    deepEqual(inactive, missing);
    equal(dummyChecks, 3);
  });

  it("rechaza un código incorrecto sin revocar sesiones", async () => {
    let sessionsTouched = false;
    let rawQuery = 0;
    const transaction = {
      $queryRaw: async () => {
        rawQuery += 1;
        return rawQuery === 1 ? [{ id: CASHIER.id }] : [{ now: new Date() }];
      },
      cashierPasswordReset: { findFirst: async () => ({ id: "reset-id" }) },
      cashierRecoveryCode: { findFirst: async () => null },
      authSession: {
        updateMany: async () => {
          sessionsTouched = true;
          return { count: 0 };
        }
      }
    };
    const prisma = {
      user: { findUnique: async () => ({ ...CASHIER }) },
      $transaction: async (
        operation: (tx: typeof transaction) => Promise<unknown>
      ) => operation(transaction)
    } as unknown as PrismaService;
    const service = new AuthService(
      prisma,
      {
        hash: async () => "new-hash",
        verify: async () => false
      } as unknown as PasswordService,
      {} as SessionTokenService
    );

    const response = await rejectedResponse(service.completeAdminReset(INPUT));
    deepEqual(response, {
      code: "ADMIN_PASSWORD_RESET_INVALID",
      message:
        "No se pudo completar el restablecimiento con los datos proporcionados."
    });
    equal(sessionsTouched, false);
  });

  it("falla cerrado si otro consumo gana la carrera", async () => {
    let rawQuery = 0;
    let userChanged = false;
    let sessionsTouched = false;
    const transaction = {
      $queryRaw: async () => {
        rawQuery += 1;
        return rawQuery === 1 ? [{ id: CASHIER.id }] : [{ now: new Date() }];
      },
      cashierPasswordReset: {
        findFirst: async () => ({ id: "reset-id" }),
        updateMany: async () => ({ count: 1 })
      },
      cashierRecoveryCode: {
        findFirst: async () => ({ id: "code-id" }),
        updateMany: async () => ({ count: 0 })
      },
      user: {
        updateMany: async () => {
          userChanged = true;
          return { count: 1 };
        }
      },
      authSession: {
        updateMany: async () => {
          sessionsTouched = true;
          return { count: 1 };
        }
      }
    };
    const service = new AuthService(
      {
        user: { findUnique: async () => ({ ...CASHIER }) },
        $transaction: async (
          operation: (tx: typeof transaction) => Promise<unknown>
        ) => operation(transaction)
      } as unknown as PrismaService,
      {
        hash: async () => "new-hash",
        verify: async () => false
      } as unknown as PasswordService,
      {} as SessionTokenService
    );

    const response = await rejectedResponse(service.completeAdminReset(INPUT));
    deepEqual(response, {
      code: "ADMIN_PASSWORD_RESET_INVALID",
      message:
        "No se pudo completar el restablecimiento con los datos proporcionados."
    });
    equal(userChanged, false);
    equal(sessionsTouched, false);
  });

  it("no permite reutilizar la contraseña anterior como contraseña final", async () => {
    let codeClaimed = false;
    let rawQuery = 0;
    const transaction = {
      $queryRaw: async () => {
        rawQuery += 1;
        return rawQuery === 1 ? [{ id: CASHIER.id }] : [{ now: new Date() }];
      },
      cashierPasswordReset: { findFirst: async () => ({ id: "reset-id" }) },
      cashierRecoveryCode: {
        findFirst: async () => ({ id: "code-id" }),
        updateMany: async () => {
          codeClaimed = true;
          return { count: 1 };
        }
      }
    };
    const prisma = {
      user: { findUnique: async () => ({ ...CASHIER }) },
      $transaction: async (
        operation: (tx: typeof transaction) => Promise<unknown>
      ) => operation(transaction)
    } as unknown as PrismaService;
    const service = new AuthService(
      prisma,
      {
        hash: async () => "old-hash",
        verify: async () => true
      } as unknown as PasswordService,
      {} as SessionTokenService
    );

    await rejects(service.completeAdminReset(INPUT), /debe ser diferente/);
    equal(codeClaimed, false);
  });

  it("impide que la contraseña anterior cree una sesión mientras hay recuperación pendiente", async () => {
    let sessionCreated = false;
    const prisma = {
      user: { findUnique: async () => ({ ...CASHIER }) },
      $queryRaw: async () => [{ now: new Date() }],
      authSession: {
        create: async () => {
          sessionCreated = true;
          return {};
        }
      }
    } as unknown as PrismaService;
    const service = new AuthService(
      prisma,
      { verify: async () => true } as unknown as PasswordService,
      {} as SessionTokenService
    );

    const response = await rejectedResponse(
      service.login({ username: INPUT.username, password: "Anterior#2026" }, {})
    );
    deepEqual(response, {
      code: "ADMIN_PASSWORD_CHANGE_REQUIRED",
      message:
        "Debes completar el restablecimiento de contraseña antes de iniciar sesión."
    });
    equal(sessionCreated, false);
  });
});
