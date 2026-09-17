import {
  deepEqual,
  equal,
  rejects
} from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrismaService } from "../database/prisma.service";
import {
  AccountStatus,
  AdminAuditAction,
  AdminAuditTargetType,
  UserRole
} from "../generated/prisma/enums";
import { AuthService } from "./auth.service";
import type { PasswordService } from "./password.service";
import type { SessionTokenService } from "./session-token.service";
import type { SessionPrincipal } from "./auth.types";

const NOW = new Date("2026-08-26T12:00:00.000Z");
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const CURRENT_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_SESSION_ID = "33333333-3333-4333-8333-333333333333";

const ADMIN_PRINCIPAL: SessionPrincipal = {
  id: ADMIN_ID,
  username: "admin",
  role: UserRole.ADMIN,
  status: AccountStatus.ACTIVE,
  sessionId: CURRENT_SESSION_ID,
  deviceId: null,
  sessionExpiresAt: new Date("2026-08-26T20:00:00.000Z")
};

const ADMIN_SESSION = {
  id: CURRENT_SESSION_ID,
  userId: ADMIN_ID,
  deviceId: null,
  tokenHash: "t".repeat(64),
  csrfSecretHash: "c".repeat(64),
  sessionVersion: 3,
  ipHash: null,
  userAgentHash: null,
  createdAt: new Date("2026-08-26T08:00:00.000Z"),
  lastSeenAt: new Date("2026-08-26T11:30:00.001Z"),
  expiresAt: new Date("2026-08-26T20:00:00.000Z"),
  revokedAt: null,
  revocationReason: null,
  user: {
    id: ADMIN_ID,
    username: "admin",
    role: UserRole.ADMIN,
    status: AccountStatus.ACTIVE,
    passwordResetRequired: false,
    sessionVersion: 3
  },
  device: null
};

describe("endurecimiento de sesiones ADMIN", () => {
  it("acepta actividad un milisegundo dentro del límite y actualiza lastSeenAt atómicamente", async () => {
    let update: any;
    const service = authService({
      $queryRaw: async () => [{ now: NOW }],
      authSession: {
        findUnique: async () => ({ ...ADMIN_SESSION }),
        updateMany: async (input: any) => {
          update = input;
          return { count: 1 };
        }
      }
    });

    const principal = await withAdminSessionEnvironment(() =>
      service.getSessionPrincipal("token-plano")
    );

    equal(principal.sessionId, CURRENT_SESSION_ID);
    equal(update.where.userId, ADMIN_ID);
    equal(update.where.deviceId, null);
    equal(
      update.where.lastSeenAt.gt.toISOString(),
      "2026-08-26T11:30:00.000Z"
    );
    equal(update.where.lastSeenAt.lte, NOW);
    equal(update.data.lastSeenAt, NOW);
  });

  it("revoca y deniega exactamente en el boundary de inactividad", async () => {
    const updates: any[] = [];
    const service = authService({
      $queryRaw: async () => [{ now: NOW }],
      authSession: {
        findUnique: async () => ({
          ...ADMIN_SESSION,
          lastSeenAt: new Date("2026-08-26T11:30:00.000Z")
        }),
        updateMany: async (input: any) => {
          updates.push(input);
          return { count: 1 };
        }
      }
    });

    await rejects(
      withAdminSessionEnvironment(() =>
        service.getSessionPrincipal("token-plano")
      ),
      (error: any) => error?.status === 401
    );
    equal(updates.length, 1);
    equal(updates[0].data.revocationReason, "ADMIN_SESSION_IDLE_TIMEOUT");
    equal(updates[0].data.revokedAt, NOW);
  });

  it("revoca y deniega exactamente al vencer el TTL absoluto", async () => {
    let reason = "";
    const service = authService({
      $queryRaw: async () => [{ now: NOW }],
      authSession: {
        findUnique: async () => ({ ...ADMIN_SESSION, expiresAt: NOW }),
        updateMany: async (input: any) => {
          reason = input.data.revocationReason;
          return { count: 1 };
        }
      }
    });

    await rejects(
      withAdminSessionEnvironment(() =>
        service.getSessionPrincipal("token-plano")
      ),
      (error: any) => error?.status === 401
    );
    equal(reason, "ADMIN_SESSION_ABSOLUTE_TIMEOUT");
  });

  it("falla cerrado si el reloj DB no está disponible", async () => {
    let refreshed = false;
    const service = authService({
      $queryRaw: async () => {
        throw new Error("DB clock unavailable");
      },
      authSession: {
        findUnique: async () => ({ ...ADMIN_SESSION }),
        updateMany: async () => {
          refreshed = true;
          return { count: 1 };
        }
      }
    });

    await rejects(
      withAdminSessionEnvironment(() =>
        service.getSessionPrincipal("token-plano")
      ),
      /DB clock unavailable/
    );
    equal(refreshed, false);
  });

  it("revoca si una carrera invalida la sesión durante el refresh", async () => {
    const updates: any[] = [];
    const service = authService({
      $queryRaw: async () => [{ now: NOW }],
      authSession: {
        findUnique: async () => ({ ...ADMIN_SESSION }),
        findFirst: async () => null,
        updateMany: async (input: any) => {
          updates.push(input);
          return input.data.lastSeenAt ? { count: 0 } : { count: 1 };
        }
      }
    });

    await rejects(
      withAdminSessionEnvironment(() =>
        service.getSessionPrincipal("token-plano")
      ),
      (error: any) => error?.status === 401
    );
    equal(updates.length, 2);
    equal(
      updates[1].data.revocationReason,
      "ADMIN_SESSION_VALIDATION_FAILED"
    );
  });

  it("acepta si otra solicitud válida avanzó lastSeenAt durante el refresh", async () => {
    let revocations = 0;
    let concurrencyCheck: any;
    const service = authService({
      $queryRaw: async () => [{ now: NOW }],
      authSession: {
        findUnique: async () => ({ ...ADMIN_SESSION }),
        findFirst: async (input: any) => {
          concurrencyCheck = input;
          return { id: CURRENT_SESSION_ID };
        },
        updateMany: async (input: any) => {
          if (input.data.lastSeenAt) return { count: 0 };
          revocations += 1;
          return { count: 1 };
        }
      }
    });

    const principal = await withAdminSessionEnvironment(() =>
      service.getSessionPrincipal("token-plano")
    );

    equal(principal.sessionId, CURRENT_SESSION_ID);
    equal(concurrencyCheck.where.id, CURRENT_SESSION_ID);
    equal(concurrencyCheck.where.lastSeenAt.gt, NOW);
    equal(revocations, 0);
  });

  it("tolera dos validaciones concurrentes sin revocar una sesión válida", async () => {
    let refreshes = 0;
    let revocations = 0;
    const service = authService({
      $queryRaw: async () => [{ now: NOW }],
      authSession: {
        findUnique: async () => ({ ...ADMIN_SESSION }),
        updateMany: async (input: any) => {
          if (input.data.lastSeenAt) refreshes += 1;
          else revocations += 1;
          return { count: 1 };
        }
      }
    });

    const results = await withAdminSessionEnvironment(() =>
      Promise.all([
        service.getSessionPrincipal("token-plano"),
        service.getSessionPrincipal("token-plano")
      ])
    );

    equal(results.length, 2);
    equal(refreshes, 2);
    equal(revocations, 0);
  });

  it("mantiene intacto el comportamiento de CLIENT y CASHIER", async () => {
    for (const role of [UserRole.CLIENT, UserRole.CASHIER]) {
      let databaseClockRead = false;
      let sessionUpdated = false;
      const service = authService({
        $queryRaw: async () => {
          databaseClockRead = true;
          return [{ now: NOW }];
        },
        authSession: {
          findUnique: async () => ({
            ...ADMIN_SESSION,
            expiresAt: new Date(Date.now() + 60_000),
            user: { ...ADMIN_SESSION.user, role }
          }),
          updateMany: async () => {
            sessionUpdated = true;
            return { count: 1 };
          }
        }
      });

      const principal = await service.getSessionPrincipal("token-plano");
      equal(principal.role, role);
      equal(databaseClockRead, false);
      equal(sessionUpdated, false);
    }
  });

  it("emite el TTL ADMIN desde el reloj de PostgreSQL", async () => {
    let expiryInput: { now?: Date; role?: UserRole } = {};
    let created: any;
    const prisma = {
      $queryRaw: async () => [{ now: NOW }],
      user: {
        findUnique: async () => ({
          ...ADMIN_SESSION.user,
          normalizedUsername: "admin",
          passwordHash: "hash",
          lockedUntil: null
        }),
        updateMany: async () => ({ count: 1 })
      },
      authSession: {
        create: async (input: any) => {
          created = input.data;
          return {};
        }
      }
    } as unknown as PrismaService;
    const service = new AuthService(
      prisma,
      {
        verify: async () => true
      } as unknown as PasswordService,
      {
        create: () => ({ token: "session", tokenHash: "session-hash" }),
        createCsrf: () => ({ token: "csrf", tokenHash: "csrf-hash" }),
        expiresAt: (now: Date, role: UserRole) => {
          expiryInput = { now, role };
          return new Date("2026-08-27T00:00:00.000Z");
        }
      } as unknown as SessionTokenService
    );

    const result = await service.login(
      { username: "admin", password: "segura" },
      {}
    );

    equal(expiryInput.now, NOW);
    equal(expiryInput.role, UserRole.ADMIN);
    equal(created.expiresAt, result.expiresAt);
  });

  it("lista solo campos públicos de las sesiones propias y marca la actual", async () => {
    let query: any;
    const service = authService({
      $queryRaw: async () => [{ now: NOW }],
      authSession: {
        findMany: async (input: any) => {
          query = input;
          return [
            {
              id: CURRENT_SESSION_ID,
              createdAt: ADMIN_SESSION.createdAt,
              lastSeenAt: ADMIN_SESSION.lastSeenAt,
              expiresAt: ADMIN_SESSION.expiresAt,
              tokenHash: "no-debe-salir",
              csrfSecretHash: "no-debe-salir"
            }
          ];
        }
      }
    });

    const result = await withAdminSessionEnvironment(() =>
      service.listOwnAdminSessions(ADMIN_PRINCIPAL)
    );

    equal(query.where.userId, ADMIN_ID);
    deepEqual(query.select, {
      id: true,
      createdAt: true,
      lastSeenAt: true,
      expiresAt: true
    });
    deepEqual(Object.keys(result[0]!).sort(), [
      "createdAt",
      "expiresAt",
      "id",
      "isCurrent",
      "lastSeenAt"
    ]);
    equal(result[0]?.isCurrent, true);
    equal(JSON.stringify(result).includes("no-debe-salir"), false);
  });

  it("rechaza el uso de la gestión ADMIN por otros roles antes de consultar DB", async () => {
    let databaseTouched = false;
    const service = authService({
      $queryRaw: async () => {
        databaseTouched = true;
        return [{ now: NOW }];
      }
    });
    const clientPrincipal = {
      ...ADMIN_PRINCIPAL,
      role: UserRole.CLIENT
    };

    await rejects(
      service.listOwnAdminSessions(clientPrincipal),
      (error: any) => error?.status === 403
    );
    await rejects(
      service.revokeOtherAdminSessions(clientPrincipal, {}),
      (error: any) => error?.status === 403
    );
    equal(databaseTouched, false);
  });

  it("nunca permite revocar por id una sesión de otro usuario", async () => {
    let updates = 0;
    let audits = 0;
    const tx = {
      authSession: {
        findFirst: async (input: any) => {
          equal(input.where.id, OTHER_SESSION_ID);
          equal(input.where.userId, ADMIN_ID);
          return null;
        },
        updateMany: async () => {
          updates += 1;
          return { count: 1 };
        }
      },
      adminAuditEvent: {
        create: async () => {
          audits += 1;
        }
      }
    };
    const service = authService(transactionalPrisma(tx));

    await rejects(
      service.revokeOwnAdminSession(
        ADMIN_PRINCIPAL,
        OTHER_SESSION_ID,
        { ip: "127.0.0.1" }
      ),
      (error: any) => error?.status === 404
    );
    equal(updates, 0);
    equal(audits, 0);
  });

  it("hace idempotentes dos revocaciones concurrentes y audita solo el cambio", async () => {
    let active = true;
    const auditEvents: any[] = [];
    const updateFilters: any[] = [];
    const tx = {
      $queryRaw: async () => [{ now: NOW }],
      authSession: {
        findFirst: async () => ({ id: OTHER_SESSION_ID, revokedAt: null }),
        updateMany: async (input: any) => {
          updateFilters.push(input.where);
          if (!active) return { count: 0 };
          active = false;
          return { count: 1 };
        }
      },
      adminAuditEvent: {
        create: async (input: any) => {
          auditEvents.push(input.data);
          return {};
        }
      }
    };
    const service = authService(transactionalPrisma(tx));

    const results = await Promise.all([
      service.revokeOwnAdminSession(ADMIN_PRINCIPAL, OTHER_SESSION_ID, {}),
      service.revokeOwnAdminSession(ADMIN_PRINCIPAL, OTHER_SESSION_ID, {})
    ]);

    equal(results.filter((result) => result.revoked).length, 1);
    equal(auditEvents.length, 1);
    equal(auditEvents[0].action, AdminAuditAction.ADMIN_SESSION_REVOKED);
    equal(auditEvents[0].targetType, AdminAuditTargetType.AUTH_SESSION);
    equal(auditEvents[0].targetUserId, ADMIN_ID);
    equal(JSON.stringify(auditEvents[0]).includes("token"), false);
    equal(
      updateFilters.every(
        (where) => where.id === OTHER_SESSION_ID && where.userId === ADMIN_ID
      ),
      true
    );
  });

  it("revoca todas las otras sesiones sin tocar la actual y audita el total", async () => {
    let update: any;
    let audit: any;
    const tx = {
      $queryRaw: async () => [{ now: NOW }],
      authSession: {
        updateMany: async (input: any) => {
          update = input;
          return { count: 3 };
        }
      },
      adminAuditEvent: {
        create: async (input: any) => {
          audit = input.data;
          return {};
        }
      }
    };
    const service = authService(transactionalPrisma(tx));

    const result = await service.revokeOtherAdminSessions(
      ADMIN_PRINCIPAL,
      { ip: "127.0.0.1" }
    );

    equal(result.revokedCount, 3);
    equal(update.where.userId, ADMIN_ID);
    deepEqual(update.where.id, { not: CURRENT_SESSION_ID });
    equal(update.data.revocationReason, "ADMIN_REVOKED_OTHER_SESSIONS");
    equal(audit.action, AdminAuditAction.ADMIN_OTHER_SESSIONS_REVOKED);
    equal(audit.targetType, AdminAuditTargetType.USER);
    deepEqual(JSON.parse(audit.stateAfter), { revokedCount: 3 });
  });
});

function authService(prisma: object): AuthService {
  return new AuthService(
    prisma as PrismaService,
    { constantTimeEqual: () => true } as unknown as PasswordService,
    {
      hash: () => "h".repeat(64)
    } as unknown as SessionTokenService
  );
}

function transactionalPrisma(tx: object): object {
  return {
    $transaction: async (
      operation: (client: typeof tx) => Promise<unknown>
    ) => operation(tx)
  };
}

async function withAdminSessionEnvironment<T>(
  action: () => Promise<T>
): Promise<T> {
  const names = [
    "NODE_ENV",
    "SESSION_TTL_HOURS",
    "ADMIN_SESSION_TTL_HOURS",
    "ADMIN_SESSION_IDLE_TIMEOUT_MINUTES"
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  process.env.NODE_ENV = "test";
  process.env.SESSION_TTL_HOURS = "168";
  process.env.ADMIN_SESSION_TTL_HOURS = "12";
  process.env.ADMIN_SESSION_IDLE_TIMEOUT_MINUTES = "30";

  try {
    return await action();
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
