import { deepEqual, equal, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import {
  AccountStatus,
  AdminAuditAction,
  UserRole
} from "../generated/prisma/enums";
import { AdminMfaService } from "./admin-mfa.service";
import type { SessionPrincipal } from "./auth.types";
import { hashAdminRecoveryCode } from "./admin-recovery-code";
import { hashWebAuthnChallenge } from "./admin-webauthn-payload";
import type { AdminWebAuthnCrypto } from "./admin-webauthn.crypto";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const CHALLENGE_ID = "33333333-3333-4333-8333-333333333333";
const CREDENTIAL_ROW_ID = "44444444-4444-4444-8444-444444444444";
const CHALLENGE = "A".repeat(43);
const CREDENTIAL_ID = "B".repeat(32);
const SECOND_CREDENTIAL_ROW_ID = "55555555-5555-4555-8555-555555555555";

const PENDING_ADMIN: SessionPrincipal = {
  id: ADMIN_ID,
  username: "admin",
  role: UserRole.ADMIN,
  status: AccountStatus.ACTIVE,
  sessionId: SESSION_ID,
  deviceId: null,
  sessionExpiresAt: new Date("2026-09-01T20:00:00.000Z"),
  adminMfaVerified: false,
  adminMfaVerifiedAt: null
};

describe("AdminMfaService", () => {
  it("informa enrolamiento sin convertir una sesión pendiente en verificada", async () => {
    const service = createService(
      {
        adminWebAuthnCredential: { count: async () => 1 }
      },
      {}
    );
    deepEqual(await service.state(PENDING_ADMIN), {
      required: true,
      enrolled: true,
      verified: false
    });
  });

  it("guarda solo el hash del desafío de registro ligado a la sesión", async () => {
    let createdChallenge: any;
    const tx = {
      $queryRaw: async () => [{ now: NOW }],
      adminWebAuthnChallenge: {
        updateMany: async () => ({ count: 0 }),
        create: async (input: any) => {
          createdChallenge = input.data;
          return { id: CHALLENGE_ID };
        }
      }
    };
    const service = createService(
      {
        user: {
          findUnique: async () => ({
            id: ADMIN_ID,
            username: "admin",
            role: UserRole.ADMIN,
            status: AccountStatus.ACTIVE,
            adminWebAuthnUserHandle: Buffer.alloc(32, 7),
            adminWebAuthnCredentials: []
          })
        },
        $transaction: async (operation: (client: typeof tx) => Promise<unknown>) =>
          operation(tx)
      },
      {
        registrationOptions: async () => ({ challenge: CHALLENGE })
      }
    );

    const result = await service.registrationOptions(PENDING_ADMIN);
    equal(result.challengeId, CHALLENGE_ID);
    equal((result.options as any).challenge, CHALLENGE);
    equal(createdChallenge.adminUserId, ADMIN_ID);
    equal(createdChallenge.sessionId, SESSION_ID);
    equal(createdChallenge.challengeHash, hashWebAuthnChallenge(CHALLENGE));
    equal(JSON.stringify(createdChallenge).includes(CHALLENGE), false);
    equal(createdChallenge.expiresAt.getTime() - NOW.getTime(), 5 * 60_000);
  });

  it("limita el inventario administrativo a diez passkeys", async () => {
    const service = createService(
      {
        user: {
          findUnique: async () => ({
            id: ADMIN_ID,
            username: "admin",
            role: UserRole.ADMIN,
            status: AccountStatus.ACTIVE,
            adminWebAuthnUserHandle: Buffer.alloc(32, 7),
            adminWebAuthnCredentials: Array.from({ length: 10 }, (_, index) => ({
              credentialId: `${index}`.padEnd(32, "B"),
              transports: ["internal"]
            }))
          })
        }
      },
      {}
    );

    await rejects(
      service.registrationOptions({
        ...PENDING_ADMIN,
        adminMfaVerified: true,
        adminMfaVerifiedAt: NOW
      }),
      (error: any) =>
        error?.status === 409 &&
        error?.response?.code === "ADMIN_PASSKEY_LIMIT_REACHED"
    );
  });

  it("exige confirmar una passkey previa antes de iniciar un alta adicional con MFA antiguo", async () => {
    const service = createService(
      {
        $queryRaw: async () => [{ now: NOW }],
        user: {
          findUnique: async () => ({
            id: ADMIN_ID,
            username: "admin",
            role: UserRole.ADMIN,
            status: AccountStatus.ACTIVE,
            adminWebAuthnUserHandle: Buffer.alloc(32, 7),
            adminWebAuthnCredentials: [
              { credentialId: CREDENTIAL_ID, transports: ["internal"] }
            ]
          })
        }
      },
      {}
    );

    await rejects(
      service.registrationOptions({
        ...PENDING_ADMIN,
        adminMfaVerified: true,
        adminMfaVerifiedAt: new Date(NOW.getTime() - 5 * 60_000)
      }),
      (error: any) =>
        error?.status === 403 &&
        error?.response?.code === "ADMIN_MFA_STEP_UP_REQUIRED"
    );
  });

  it("conserva el primer enrolamiento sin MFA previo y entrega sus códigos de recuperación", async () => {
    const { service, writes } = registrationFixture(0);

    const result = await service.verifyRegistration(
      PENDING_ADMIN,
      CHALLENGE_ID,
      browserResponse(CHALLENGE, "webauthn.create"),
      {}
    );

    equal(result.verified, true);
    equal(result.recoveryCodes.length, 10);
    equal(writes.credentials, 1);
    equal(writes.sessions, 1);
    equal(writes.recoveryCodes, 10);
  });

  it("acepta una passkey adicional con MFA reciente sin reemplazar los códigos de recuperación", async () => {
    const { service, writes } = registrationFixture(1);

    const result = await service.verifyRegistration(
      { ...PENDING_ADMIN, adminMfaVerified: true, adminMfaVerifiedAt: NOW },
      CHALLENGE_ID,
      browserResponse(CHALLENGE, "webauthn.create"),
      {}
    );

    deepEqual(result, { verified: true, recoveryCodes: [] });
    equal(writes.credentials, 1);
    equal(writes.sessions, 1);
    equal(writes.recoveryCodes, 0);
  });

  it("revalida la antigüedad MFA dentro de la transacción antes de persistir otra passkey", async () => {
    const { service, writes } = registrationFixture(
      1,
      new Date(NOW.getTime() + 1_000)
    );

    await rejects(
      service.verifyRegistration(
        {
          ...PENDING_ADMIN,
          adminMfaVerified: true,
          adminMfaVerifiedAt: new Date(NOW.getTime() - 5 * 60_000 + 1_000)
        },
        CHALLENGE_ID,
        browserResponse(CHALLENGE, "webauthn.create"),
        {}
      ),
      (error: any) =>
        error?.status === 403 &&
        error?.response?.code === "ADMIN_MFA_STEP_UP_REQUIRED"
    );
    deepEqual(writes, {
      challenges: 0,
      credentials: 0,
      sessions: 0,
      recoveryCodes: 0
    });
  });

  it("revalida el límite de diez passkeys al verificar una ceremonia ya iniciada", async () => {
    const { service, writes } = registrationFixture(10);

    await rejects(
      service.verifyRegistration(
        { ...PENDING_ADMIN, adminMfaVerified: true, adminMfaVerifiedAt: NOW },
        CHALLENGE_ID,
        browserResponse(CHALLENGE, "webauthn.create"),
        {}
      ),
      (error: any) =>
        error?.status === 409 &&
        error?.response?.code === "ADMIN_PASSKEY_LIMIT_REACHED"
    );
    equal(writes.credentials, 0);
    equal(writes.sessions, 0);
  });

  it("verifica una assertion, consume el desafío y actualiza contador y sesión", async () => {
    let credentialUpdate: any;
    let sessionUpdate: any;
    const tx = {
      $queryRaw: async () => [{ now: NOW }],
      adminWebAuthnChallenge: {
        updateMany: async () => ({ count: 1 })
      },
      adminWebAuthnCredential: {
        updateMany: async (input: any) => {
          credentialUpdate = input;
          return { count: 1 };
        }
      },
      authSession: {
        updateMany: async (input: any) => {
          sessionUpdate = input;
          return { count: 1 };
        }
      }
    };
    const service = createService(
      {
        $queryRaw: async () => [{ now: NOW }],
        adminWebAuthnCredential: {
          findFirst: async () => ({
            id: CREDENTIAL_ROW_ID,
            credentialId: CREDENTIAL_ID,
            publicKey: Buffer.alloc(64, 9),
            counter: 4n,
            transports: ["internal"]
          })
        },
        adminWebAuthnChallenge: {
          findFirst: async () => ({
            challengeHash: hashWebAuthnChallenge(CHALLENGE)
          })
        },
        $transaction: async (operation: (client: typeof tx) => Promise<unknown>) =>
          operation(tx)
      },
      {
        verifyAuthentication: async () => ({
          verified: true,
          authenticationInfo: {
            credentialID: CREDENTIAL_ID,
            newCounter: 5,
            userVerified: true,
            credentialDeviceType: "singleDevice",
            credentialBackedUp: false,
            origin: "http://localhost:5173",
            rpID: "localhost"
          }
        })
      }
    );

    const result = await service.verifyAuthentication(
      PENDING_ADMIN,
      CHALLENGE_ID,
      browserResponse(CHALLENGE)
    );
    deepEqual(result, { verified: true });
    equal(credentialUpdate.where.counter, 4n);
    equal(credentialUpdate.data.counter, 5n);
    equal(credentialUpdate.data.lastUsedAt, NOW);
    equal(sessionUpdate.data.adminMfaVerifiedAt, NOW);
  });

  it("falla cerrado si otro request consumió el mismo desafío", async () => {
    const tx = {
      $queryRaw: async () => [{ now: NOW }],
      adminWebAuthnChallenge: {
        updateMany: async () => ({ count: 0 })
      }
    };
    const service = createService(
      {
        $queryRaw: async () => [{ now: NOW }],
        adminWebAuthnCredential: {
          findFirst: async () => ({
            id: CREDENTIAL_ROW_ID,
            credentialId: CREDENTIAL_ID,
            publicKey: Buffer.alloc(64, 9),
            counter: 0n,
            transports: []
          })
        },
        adminWebAuthnChallenge: {
          findFirst: async () => ({
            challengeHash: hashWebAuthnChallenge(CHALLENGE)
          })
        },
        $transaction: async (operation: (client: typeof tx) => Promise<unknown>) =>
          operation(tx)
      },
      {
        verifyAuthentication: async () => ({
          verified: true,
          authenticationInfo: {
            credentialID: CREDENTIAL_ID,
            newCounter: 0,
            userVerified: true,
            credentialDeviceType: "multiDevice",
            credentialBackedUp: true,
            origin: "http://localhost:5173",
            rpID: "localhost"
          }
        })
      }
    );

    await rejects(
      service.verifyAuthentication(
        PENDING_ADMIN,
        CHALLENGE_ID,
        browserResponse(CHALLENGE)
      ),
      (error: any) =>
        error?.status === 400 &&
        error?.response?.code === "ADMIN_WEBAUTHN_INVALID"
    );
  });

  it("lista solo metadatos seguros de las passkeys activas", async () => {
    const service = createService(
      {
        adminWebAuthnCredential: {
          findMany: async () => [
            {
              id: CREDENTIAL_ROW_ID,
              credentialId: CREDENTIAL_ID,
              publicKey: Buffer.alloc(64, 9),
              createdAt: NOW,
              lastUsedAt: null,
              deviceType: "singleDevice",
              backedUp: false
            }
          ]
        }
      },
      {}
    );

    deepEqual(await service.listPasskeys(PENDING_ADMIN), [
      {
        id: CREDENTIAL_ROW_ID,
        createdAt: NOW,
        lastUsedAt: null,
        deviceType: "singleDevice",
        backedUp: false
      }
    ]);
  });

  it("revoca una passkey solo si queda otra y audita metadatos", async () => {
    let credentialUpdate: any;
    let audit: any;
    const tx = {
      $queryRaw: async () => [{ now: NOW }],
      adminWebAuthnCredential: {
        findMany: async () => [
          {
            id: CREDENTIAL_ROW_ID,
            createdAt: new Date("2026-08-01T12:00:00.000Z"),
            lastUsedAt: null,
            deviceType: "singleDevice",
            backedUp: false
          },
          {
            id: SECOND_CREDENTIAL_ROW_ID,
            createdAt: new Date("2026-08-02T12:00:00.000Z"),
            lastUsedAt: NOW,
            deviceType: "multiDevice",
            backedUp: true
          }
        ],
        updateMany: async (input: any) => {
          credentialUpdate = input;
          return { count: 1 };
        }
      },
      adminAuditEvent: {
        create: async (input: any) => {
          audit = input.data;
          return {};
        }
      }
    };
    const service = createService(
      {
        $transaction: async (operation: (client: typeof tx) => Promise<unknown>) =>
          operation(tx)
      },
      {}
    );

    deepEqual(
      await service.revokePasskey(PENDING_ADMIN, CREDENTIAL_ROW_ID, {
        ip: "127.0.0.1"
      }),
      { revoked: true }
    );
    equal(credentialUpdate.where.id, CREDENTIAL_ROW_ID);
    equal(credentialUpdate.data.revokedAt, NOW);
    equal(audit.action, AdminAuditAction.ADMIN_PASSKEY_REVOKED);
    equal(audit.reasonCode, "ADMIN_PASSKEY_SELF_SERVICE_REVOCATION");
    equal(JSON.parse(audit.stateBefore).credentialId, CREDENTIAL_ROW_ID);
  });

  it("impide revocar la última passkey administrativa", async () => {
    const tx = {
      $queryRaw: async () => [{ now: NOW }],
      adminWebAuthnCredential: {
        findMany: async () => [
          {
            id: CREDENTIAL_ROW_ID,
            createdAt: NOW,
            lastUsedAt: null,
            deviceType: "singleDevice",
            backedUp: false
          }
        ]
      }
    };
    const service = createService(
      {
        $transaction: async (operation: (client: typeof tx) => Promise<unknown>) =>
          operation(tx)
      },
      {}
    );

    await rejects(
      service.revokePasskey(PENDING_ADMIN, CREDENTIAL_ROW_ID, {}),
      (error: any) =>
        error?.status === 409 &&
        error?.response?.code === "ADMIN_PASSKEY_LAST_REQUIRED"
    );
  });

  for (const failure of [
    { code: "P2034" },
    { code: "P2010", meta: { code: "40001" } },
    { code: "P2010", meta: { code: "40P01" } }
  ]) {
    it(`responde conflicto seguro ante ${failure.code}/${failure.meta?.code ?? "transaction"} sin repetir la revocación`, async () => {
      let attempts = 0;
      const service = createService(
        {
          $transaction: async () => {
            attempts += 1;
            throw new Prisma.PrismaClientKnownRequestError(
              "SQL_AND_DATABASE_DETAILS_MUST_STAY_PRIVATE",
              { ...failure, clientVersion: "test" }
            );
          }
        },
        {}
      );
      await rejects(
        service.revokePasskey(PENDING_ADMIN, CREDENTIAL_ROW_ID, {}),
        (error: any) => {
          equal(error?.status, 409);
          deepEqual(error?.response, {
            code: "ADMIN_MFA_CONCURRENT_CHANGE",
            message:
              "La seguridad de tu cuenta cambió mientras realizabas esta acción. Actualiza la página e inténtalo de nuevo."
          });
          equal(JSON.stringify(error).includes("SQL_AND_DATABASE_DETAILS"), false);
          return true;
        }
      );
      equal(attempts, 1);
    });
  }

  it("no convierte errores de infraestructura ni objetos con códigos arbitrarios en conflictos MFA", async () => {
    for (const failure of [
      new Error("database offline"),
      { code: "P2034" },
      new Prisma.PrismaClientKnownRequestError("connection failed", {
        code: "P2010",
        clientVersion: "test",
        meta: { code: "08006" }
      })
    ]) {
      let attempts = 0;
      const service = createService(
        {
          $transaction: async () => {
            attempts += 1;
            throw failure;
          }
        },
        {}
      );
      await rejects(
        service.revokePasskey(PENDING_ADMIN, CREDENTIAL_ROW_ID, {}),
        (error: unknown) => error === failure
      );
      equal(attempts, 1);
    }
  });

  it("un conflicto al confirmar el alta no devuelve códigos ni vuelve a ejecutar la transacción", async () => {
    const failure = new Prisma.PrismaClientKnownRequestError("write conflict", {
      code: "P2034",
      clientVersion: "test"
    });
    const { service, writes } = registrationFixture(0, NOW, failure);
    await rejects(
      service.verifyRegistration(
        PENDING_ADMIN,
        CHALLENGE_ID,
        browserResponse(CHALLENGE, "webauthn.create"),
        {}
      ),
      (error: any) => error?.status === 409 &&
        error?.response?.code === "ADMIN_MFA_CONCURRENT_CHANGE"
    );
    deepEqual(writes, { challenges: 0, credentials: 0, sessions: 0, recoveryCodes: 0 });
  });

  it("un código recupera una sola vez y revoca passkeys y otras sesiones", async () => {
    const recoveryCode = "SA-ABCDE-FGHJK-MNPQR-STUVW-XYZ23";
    let credentialUpdate: any;
    let sessionsUpdate: any;
    let audit: any;
    const tx = {
      $queryRaw: async () => [{ now: NOW }],
      adminRecoveryCode: {
        findFirst: async (input: any) => {
          equal(
            input.where.codeHash,
            hashAdminRecoveryCode(ADMIN_ID, recoveryCode)
          );
          return { id: "55555555-5555-4555-8555-555555555555" };
        },
        updateMany: async (input: any) =>
          input.data.usedAt ? { count: 1 } : { count: 9 }
      },
      adminWebAuthnCredential: {
        updateMany: async (input: any) => {
          credentialUpdate = input;
          return { count: 2 };
        }
      },
      adminWebAuthnChallenge: {
        updateMany: async () => ({ count: 1 })
      },
      authSession: {
        updateMany: async (input: any) => {
          if (input.where.id?.not) sessionsUpdate = input;
          return { count: 1 };
        }
      },
      adminAuditEvent: {
        create: async (input: any) => {
          audit = input.data;
          return {};
        }
      }
    };
    const service = createService(
      {
        $transaction: async (operation: (client: typeof tx) => Promise<unknown>) =>
          operation(tx)
      },
      {}
    );

    deepEqual(
      await service.recover(PENDING_ADMIN, recoveryCode, { ip: "127.0.0.1" }),
      { recovered: true }
    );
    equal(credentialUpdate.where.adminUserId, ADMIN_ID);
    equal(credentialUpdate.data.revokedAt, NOW);
    equal(sessionsUpdate.where.id.not, SESSION_ID);
    equal(sessionsUpdate.data.revocationReason, "ADMIN_MFA_RECOVERY");
    equal(audit.action, AdminAuditAction.ADMIN_MFA_RECOVERED);
    equal(JSON.stringify(audit).includes(recoveryCode), false);
  });

  it("exige step-up dentro de cinco minutos usando el reloj DB", async () => {
    const service = createService(
      { $queryRaw: async () => [{ now: NOW }] },
      {}
    );
    await service.assertRecentMfa({
      ...PENDING_ADMIN,
      adminMfaVerified: true,
      adminMfaVerifiedAt: new Date(NOW.getTime() - 5 * 60_000 + 1)
    });
    await rejects(
      service.assertRecentMfa({
        ...PENDING_ADMIN,
        adminMfaVerified: true,
        adminMfaVerifiedAt: new Date(NOW.getTime() - 5 * 60_000)
      }),
      (error: any) =>
        error?.status === 403 &&
        error?.response?.code === "ADMIN_MFA_STEP_UP_REQUIRED"
    );
  });
});

function createService(prisma: object, crypto: object): AdminMfaService {
  return new AdminMfaService(
    prisma as PrismaService,
    crypto as AdminWebAuthnCrypto
  );
}

function registrationFixture(activeCredentialCount: number, transactionNow = NOW, transactionFailure?: Error) {
  const writes = { challenges: 0, credentials: 0, sessions: 0, recoveryCodes: 0 };
  const tx = {
    $queryRaw: async () => [{ now: transactionNow }],
    adminWebAuthnCredential: {
      count: async () => activeCredentialCount,
      create: async () => {
        writes.credentials += 1;
        return { id: CREDENTIAL_ROW_ID };
      }
    },
    adminWebAuthnChallenge: {
      updateMany: async () => {
        writes.challenges += 1;
        return { count: 1 };
      }
    },
    authSession: {
      updateMany: async () => {
        writes.sessions += 1;
        return { count: 1 };
      }
    },
    adminRecoveryCode: {
      updateMany: async () => ({ count: 0 }),
      createMany: async (input: any) => {
        writes.recoveryCodes += input.data.length;
        return { count: input.data.length };
      }
    },
    adminAuditEvent: { create: async () => ({}) }
  };
  const service = createService(
    {
      $queryRaw: async () => [{ now: NOW }],
      adminWebAuthnChallenge: {
        findFirst: async () => ({
          challengeHash: hashWebAuthnChallenge(CHALLENGE)
        })
      },
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => {
        if (transactionFailure) throw transactionFailure;
        return operation(tx);
      }
    },
    {
      verifyRegistration: async () => ({
        verified: true,
        registrationInfo: {
          userVerified: true,
          credential: {
            id: CREDENTIAL_ID,
            publicKey: Buffer.alloc(64, 9),
            counter: 0,
            transports: ["internal"]
          },
          credentialDeviceType: "singleDevice",
          credentialBackedUp: false
        }
      })
    }
  );
  return { service, writes };
}

function browserResponse(challenge: string, type = "webauthn.get") {
  return {
    id: CREDENTIAL_ID,
    rawId: CREDENTIAL_ID,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: Buffer.from(
        JSON.stringify({
          type,
          challenge,
          origin: "http://localhost:5173"
        }),
        "utf8"
      ).toString("base64url"),
      authenticatorData: "A".repeat(32),
      signature: "A".repeat(64)
    }
  };
}
