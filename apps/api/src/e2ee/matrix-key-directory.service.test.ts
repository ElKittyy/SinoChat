import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import {
  DeviceId,
  initAsync,
  OlmMachine,
  RequestType,
  UserId
} from "@matrix-org/matrix-sdk-crypto-wasm";
import type { SessionPrincipal } from "../auth/auth.types";
import type { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import type { PrismaService } from "../database/prisma.service";
import { MatrixKeyDirectoryService } from "./matrix-key-directory.service";
import {
  matrixClaimHashInput,
  parseMatrixKeysClaim
} from "./matrix-key-requests";
import { hashMatrixCanonicalJson } from "./matrix-key-upload";

process.env.NODE_ENV = "test";
process.env.MATRIX_SERVER_NAME = "sinochat.invalid";
process.env.DEVICE_BINDING_HMAC_SECRET = "d".repeat(32);

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const REGISTRATION_ID = "33333333-3333-4333-8333-333333333333";
const CASHIER_ID = "44444444-4444-4444-8444-444444444444";
const CONVERSATION_ID = "55555555-5555-4555-8555-555555555555";
const CLIENT_TWO_ID = "66666666-6666-4666-8666-666666666666";

describe("MatrixKeyDirectoryService device reservation", () => {
  it("reutiliza la reserva abierta de la sesion en un retry", async () => {
    const now = new Date("2026-08-27T12:00:00.000Z");
    const expiresAt = new Date("2026-08-27T12:10:00.000Z");
    let rawQuery = 0;
    let deviceCountCalls = 0;
    let createCalls = 0;
    const transaction = {
      $queryRaw: async () => {
        rawQuery += 1;
        return rawQuery === 2 ? [{ now }] : [{ pg_advisory_xact_lock: null }];
      },
      authSession: {
        findUnique: async () => currentSession(now)
      },
      matrixDeviceRegistration: {
        deleteMany: async () => ({ count: 0 }),
        findFirst: async () => ({ id: REGISTRATION_ID, expiresAt }),
        create: async () => {
          createCalls += 1;
          return { id: "unexpected", expiresAt };
        }
      },
      device: {
        count: async () => {
          deviceCountCalls += 1;
          return 0;
        }
      }
    };
    const prisma = {
      $transaction: async (operation: (client: unknown) => Promise<unknown>) =>
        operation(transaction)
    } as unknown as PrismaService;
    const eligibility = {
      lockOperationalUser: async () => undefined
    } as unknown as ConversationEligibilityService;
    const service = new MatrixKeyDirectoryService(prisma, eligibility);

    const result = await service.reserveDevice(principal());

    equal(result.deviceId, REGISTRATION_ID);
    equal(result.matrixDeviceId, "D33333333333343338333333333333333");
    equal(
      result.matrixUserId,
      "@u11111111111141118111111111111111:sinochat.invalid"
    );
    equal(result.expiresAt, expiresAt);
    equal(deviceCountCalls, 0);
    equal(createCalls, 0);
  });

  it("reproduce una confirmacion perdida solo para el mismo upload", async () => {
    const now = new Date("2026-08-27T12:05:00.000Z");
    const publishedAt = new Date("2026-08-27T12:04:00.000Z");
    const expiresAt = new Date("2026-08-27T12:10:00.000Z");
    const originalBody = await createInitialUploadBody();
    const otherValidBody = await createInitialUploadBody();
    let deviceReads = 0;
    const transaction = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        const sql = strings.join(" ");
        if (sql.includes("clock_timestamp")) return [{ now }];
        if (sql.includes("matrix_device_registrations")) {
          return [{ id: REGISTRATION_ID }];
        }
        return [{ pg_advisory_xact_lock: null }];
      },
      authSession: {
        findUnique: async () => currentSession(now, REGISTRATION_ID)
      },
      matrixDeviceRegistration: {
        findUnique: async () => ({
          userId: USER_ID,
          sessionId: SESSION_ID,
          expiresAt,
          consumedAt: publishedAt,
          initialUploadSha256: hashMatrixCanonicalJson(originalBody),
          initialOneTimeKeyCount: 50
        })
      },
      device: {
        findFirst: async ({ where }: any) => {
          deviceReads += 1;
          equal(where.id, REGISTRATION_ID);
          equal(where.userId, USER_ID);
          equal(where.protocolVersion, "matrix-olm-v1");
          equal(typeof where.bindingSecretHash, "string");
          return { id: REGISTRATION_ID };
        }
      }
    };
    const prisma = {
      $transaction: async (operation: (client: unknown) => Promise<unknown>) =>
        operation(transaction)
    } as unknown as PrismaService;
    const eligibility = {
      lockOperationalUser: async () => undefined
    } as unknown as ConversationEligibilityService;
    const service = new MatrixKeyDirectoryService(prisma, eligibility);

    const firstReplay = await service.completeInitialUpload(
      boundPrincipal(),
      REGISTRATION_ID,
      originalBody
    );
    const secondReplay = await service.completeInitialUpload(
      boundPrincipal(),
      REGISTRATION_ID,
      originalBody
    );

    deepEqual(secondReplay, firstReplay);
    equal(firstReplay.deviceId, REGISTRATION_ID);
    equal(firstReplay.publishedAt, publishedAt);
    equal(firstReplay.one_time_key_counts.signed_curve25519, 50);
    equal(deviceReads, 2);
    await rejects(
      service.completeInitialUpload(
        boundPrincipal(),
        REGISTRATION_ID,
        otherValidBody
      ),
      ConflictException
    );
  });
});

describe("MatrixKeyDirectoryService scoped key directory", () => {
  it("rechaza el lote completo si keys/query incluye un tercero", async () => {
    const now = new Date("2026-08-27T12:00:00.000Z");
    let rawQuery = 0;
    let directoryReads = 0;
    const transaction = {
      $queryRaw: async () => {
        rawQuery += 1;
        return rawQuery === 3 ? [{ now }] : [{ pg_advisory_xact_lock: null }];
      },
      authSession: {
        findUnique: async () => currentSession(now, REGISTRATION_ID)
      },
      matrixDeviceKey: {
        findMany: async () => {
          directoryReads += 1;
          return [];
        }
      }
    };
    const service = serviceWith(
      transaction,
      async () => ({
        clientUserId: USER_ID,
        cashierUserId: CASHIER_ID
      })
    );

    await rejects(
      service.queryKeys(boundPrincipal(), CONVERSATION_ID, {
        device_keys: {
          "@u99999999999949998999999999999999:sinochat.invalid": []
        }
      }),
      ForbiddenException
    );
    equal(directoryReads, 0);
  });

  it("reproduce un keys/claim idempotente sin consumir otra OTK", async () => {
    const now = new Date("2026-08-27T12:00:00.000Z");
    const cashierMatrixUser =
      "@u44444444444444448444444444444444:sinochat.invalid";
    const cashierMatrixDevice = "D66666666666646668666666666666666";
    let rawQuery = 0;
    let preKeyReads = 0;
    const transaction = {
      $queryRaw: async () => {
        rawQuery += 1;
        return rawQuery === 3 ? [{ now }] : [{ pg_advisory_xact_lock: null }];
      },
      authSession: {
        findUnique: async () => currentSession(now, REGISTRATION_ID)
      },
      matrixKeyClaimRequest: {
        findUnique: async () => ({
          id: "77777777-7777-4777-8777-777777777777",
          conversationId: CONVERSATION_ID,
          requestSha256: hashMatrixCanonicalJson(
            matrixClaimHashInput(
              parseMatrixKeysClaim({
                one_time_keys: {
                  [cashierMatrixUser]: {
                    [cashierMatrixDevice]: "signed_curve25519"
                  }
                }
              })
            )
          )
        })
      },
      matrixKeyClaimResult: {
        findMany: async () => [
          {
            algorithm: "signed_curve25519",
            recipientDevice: {
              matrixDeviceKey: {
                matrixUserId: cashierMatrixUser,
                matrixDeviceId: cashierMatrixDevice
              }
            },
            oneTimeKey: {
              keyId: "AAAAAQ",
              signedKey: { key: "A".repeat(43), signatures: {} }
            },
            fallbackKey: null
          }
        ]
      },
      matrixOneTimeKey: {
        findFirst: async () => {
          preKeyReads += 1;
          return null;
        }
      }
    };
    const service = serviceWith(
      transaction,
      async () => ({
        clientUserId: USER_ID,
        cashierUserId: CASHIER_ID
      })
    );
    const body = {
      one_time_keys: {
        [cashierMatrixUser]: {
          [cashierMatrixDevice]: "signed_curve25519"
        }
      }
    };

    const result = await service.claimKeys(
      boundPrincipal(),
      CONVERSATION_ID,
      "claim-01",
      body
    );

    deepEqual(result, {
      failures: {},
      one_time_keys: {
        [cashierMatrixUser]: {
          [cashierMatrixDevice]: {
            "signed_curve25519:AAAAAQ": {
              key: "A".repeat(43),
              signatures: {}
            }
          }
        }
      }
    });
    equal(preKeyReads, 0);
  });

  it("autoriza en servidor un keys/query agrupado para varios clientes del cajero", async () => {
    const now = new Date("2026-08-27T12:00:00.000Z");
    const cashierMatrixUser =
      "@u44444444444444448444444444444444:sinochat.invalid";
    const firstClientMatrixUser =
      "@u11111111111141118111111111111111:sinochat.invalid";
    const secondClientMatrixUser =
      "@u66666666666646668666666666666666:sinochat.invalid";
    const relationshipLocks: Array<[string, string]> = [];
    const transaction = {
      matrixCrossSigningIdentity: { findMany: async () => [] },
      matrixDeviceCrossSigning: { findMany: async () => [] },
      $queryRaw: async () => [{ now }],
      authSession: {
        findUnique: async () =>
          currentSession(now, REGISTRATION_ID, CASHIER_ID)
      },
      matrixDeviceKey: {
        findUnique: async () => ({
          userId: CASHIER_ID,
          matrixUserId: cashierMatrixUser
        }),
        findMany: async () => []
      }
    };
    const prisma = {
      $transaction: async (operation: (client: unknown) => Promise<unknown>) =>
        operation(transaction)
    } as unknown as PrismaService;
    const eligibility = {
      lockCurrentByParticipants: async (
        _transaction: unknown,
        clientUserId: string,
        cashierUserId: string
      ) => {
        relationshipLocks.push([clientUserId, cashierUserId]);
        return {
          id:
            clientUserId === USER_ID
              ? CONVERSATION_ID
              : "77777777-7777-4777-8777-777777777777",
          clientUserId,
          cashierUserId
        };
      }
    } as unknown as ConversationEligibilityService;
    const service = new MatrixKeyDirectoryService(prisma, eligibility);

    const result = await service.queryRelatedKeys(boundCashierPrincipal(), {
      device_keys: {
        [cashierMatrixUser]: [],
        [firstClientMatrixUser]: [],
        [secondClientMatrixUser]: []
      }
    });

    deepEqual(relationshipLocks, [
      [USER_ID, CASHIER_ID],
      [CLIENT_TWO_ID, CASHIER_ID]
    ]);
    deepEqual(result.device_keys, {
      [cashierMatrixUser]: {},
      [firstClientMatrixUser]: {},
      [secondClientMatrixUser]: {}
    });
  });

  it("reproduce un claim entre dispositivos propios con scope nulo", async () => {
    const now = new Date("2026-08-27T12:00:00.000Z");
    const ownMatrixUser =
      "@u11111111111141118111111111111111:sinochat.invalid";
    const otherOwnDevice = "D88888888888848888888888888888888";
    const body = {
      one_time_keys: {
        [ownMatrixUser]: {
          [otherOwnDevice]: "signed_curve25519"
        }
      }
    };
    let targetReads = 0;
    const transaction = {
      $queryRaw: async () => [{ now }],
      authSession: {
        findUnique: async () => currentSession(now, REGISTRATION_ID)
      },
      matrixDeviceKey: {
        findUnique: async () => ({
          userId: USER_ID,
          matrixUserId: ownMatrixUser
        }),
        findMany: async () => {
          targetReads += 1;
          return [];
        }
      },
      matrixKeyClaimRequest: {
        findUnique: async () => ({
          id: "99999999-9999-4999-8999-999999999999",
          conversationId: null,
          requestSha256: hashMatrixCanonicalJson(
            matrixClaimHashInput(parseMatrixKeysClaim(body))
          )
        })
      },
      matrixKeyClaimResult: {
        findMany: async () => []
      }
    };
    const prisma = {
      $transaction: async (operation: (client: unknown) => Promise<unknown>) =>
        operation(transaction)
    } as unknown as PrismaService;
    const service = new MatrixKeyDirectoryService(
      prisma,
      {} as ConversationEligibilityService
    );

    const result = await service.claimRelatedKeys(
      boundPrincipal(),
      "claim-own-01",
      body
    );

    deepEqual(result, { failures: {}, one_time_keys: {} });
    equal(targetReads, 0);
  });
});

function principal(): SessionPrincipal {
  return {
    id: USER_ID,
    role: "CLIENT",
    username: "cliente",
    sessionId: SESSION_ID,
    deviceId: null
  } as SessionPrincipal;
}

function boundPrincipal(): SessionPrincipal {
  return { ...principal(), deviceId: REGISTRATION_ID };
}

function boundCashierPrincipal(): SessionPrincipal {
  return {
    id: CASHIER_ID,
    role: "CASHIER",
    username: "cajero",
    sessionId: SESSION_ID,
    deviceId: REGISTRATION_ID
  } as SessionPrincipal;
}

function currentSession(
  now: Date,
  deviceId: string | null = null,
  userId = USER_ID
) {
  return {
    userId,
    deviceId,
    expiresAt: new Date(now.getTime() + 60_000),
    revokedAt: null,
    sessionVersion: 1,
    user: {
      sessionVersion: 1,
      status: "ACTIVE",
      passwordResetRequired: false
    }
  };
}

async function createInitialUploadBody(): Promise<Record<string, unknown>> {
  await initAsync();
  const matrixUserId =
    "@u11111111111141118111111111111111:sinochat.invalid";
  const matrixDeviceId = "D33333333333343338333333333333333";
  const userId = new UserId(matrixUserId);
  const deviceId = new DeviceId(matrixDeviceId);
  let machine: OlmMachine | undefined;
  try {
    machine = await OlmMachine.initialize(userId, deviceId);
    const request = (await machine.outgoingRequests()).find(
      (candidate) => candidate.type === RequestType.KeysUpload
    );
    ok(request, "OlmMachine debe producir el upload inicial");
    return JSON.parse(request.body) as Record<string, unknown>;
  } finally {
    machine?.close();
    userId.free();
    deviceId.free();
  }
}

function serviceWith(
  transaction: object,
  lockCurrent: () => Promise<{
    clientUserId: string;
    cashierUserId: string;
  }>
): MatrixKeyDirectoryService {
  const prisma = {
    $transaction: async (operation: (client: unknown) => Promise<unknown>) =>
      operation(transaction)
  } as unknown as PrismaService;
  const eligibility = {
    lockCurrent
  } as unknown as ConversationEligibilityService;
  return new MatrixKeyDirectoryService(prisma, eligibility);
}
