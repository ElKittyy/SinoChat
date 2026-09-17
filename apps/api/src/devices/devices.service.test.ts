import {
  deepEqual,
  equal,
  throws
} from "node:assert/strict";
import { describe, it } from "node:test";
import { ForbiddenException } from "@nestjs/common";
import type { SessionPrincipal } from "../auth/auth.types";
import type { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import type { PrismaService } from "../database/prisma.service";
import type { MatrixDeviceListPublisher } from "../database/matrix-device-list.publisher";
import { DeviceStatus, UserRole } from "../generated/prisma/enums";
import type { RealtimeService } from "../realtime/realtime.service";
import { DevicesController } from "./devices.controller";
import { DevicesService } from "./devices.service";
import type { KeyRecoveryService } from "./key-recovery.service";

const REQUESTER_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PEER_USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQUESTER_DEVICE_ID =
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RECIPIENT_DEVICE_ID =
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CONVERSATION_ID =
  "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PRE_KEY_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const CLAIM_ID = "11111111-1111-4111-8111-111111111111";

describe("DevicesService pre-key claims", () => {
  it("reintenta con el mismo claim sin consumir otra preclave", async () => {
    const claimedAt = new Date("2026-07-26T20:00:00.000Z");
    const publicKey = Buffer.alloc(32, 7);
    const signature = Buffer.alloc(64, 8);
    let durableClaim:
      | {
          id: string;
          claimedAt: Date;
          oneTimePreKey: {
            keyId: number;
            publicKey: Buffer;
            signature: Buffer;
          };
        }
      | null = null;
    let claimCreates = 0;
    let preKeyUpdates = 0;
    let candidateSelections = 0;
    let eligibilityChecks = 0;
    const advisoryLockOrder: string[] = [];

    const transaction = {
      conversation: {
        findFirst: async () => ({
          id: CONVERSATION_ID,
          assignment: {
            clientUserId: REQUESTER_USER_ID,
            cashierUserId: PEER_USER_ID
          }
        })
      },
      device: {
        findFirst: async () => ({ id: REQUESTER_DEVICE_ID }),
        findMany: async () => [
          {
            id: RECIPIENT_DEVICE_ID,
            registrationId: 17,
            identityPublicKey: Buffer.alloc(32, 1),
            identityKeyFingerprint: "a".repeat(64),
            signedPreKeyId: 21,
            signedPreKeyPublic: Buffer.alloc(32, 2),
            signedPreKeySignature: Buffer.alloc(64, 3),
            protocolVersion: "test-v1"
          }
        ]
      },
      oneTimePreKey: {
        updateMany: async () => {
          preKeyUpdates += 1;
          return { count: 1 };
        }
      },
      oneTimePreKeyClaim: {
        findUnique: async () => durableClaim,
        create: async ({
          data
        }: {
          data: {
            oneTimePreKeyId: string | null;
            claimedAt: Date;
          };
        }) => {
          claimCreates += 1;
          equal(data.oneTimePreKeyId, PRE_KEY_ID);
          durableClaim = {
            id: CLAIM_ID,
            claimedAt: data.claimedAt,
            oneTimePreKey: {
              keyId: 44,
              publicKey,
              signature
            }
          };
          return durableClaim;
        }
      },
      $queryRaw: async (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => {
        const sql = strings.join("?");
        if (sql.includes("pg_advisory_xact_lock")) {
          advisoryLockOrder.push(String(values[0]));
          return [];
        }
        if (sql.includes("clock_timestamp()")) {
          return [{ now: claimedAt }];
        }
        if (sql.includes('FROM "one_time_pre_keys"')) {
          candidateSelections += 1;
          return [{ id: PRE_KEY_ID }];
        }
        throw new Error(`Consulta inesperada en la prueba: ${sql}`);
      }
    };
    const prisma = {
      $transaction: async (
        operation: (client: typeof transaction) => Promise<unknown>
      ) => operation(transaction)
    } as unknown as PrismaService;
    const service = new DevicesService(
      prisma,
      {} as RealtimeService,
      {
        lockCurrent: async () => {
          eligibilityChecks += 1;
          return {
            id: CONVERSATION_ID,
            assignmentId: "22222222-2222-4222-8222-222222222222",
            clientUserId: REQUESTER_USER_ID,
            cashierUserId: PEER_USER_ID,
            subscriptionEndsAt: null
          };
        }
      } as unknown as ConversationEligibilityService
    );

    const first = await service.claimPeerBundles(
      REQUESTER_USER_ID,
      REQUESTER_DEVICE_ID,
      CONVERSATION_ID
    );
    const retry = await service.claimPeerBundles(
      REQUESTER_USER_ID,
      REQUESTER_DEVICE_ID,
      CONVERSATION_ID
    );

    deepEqual(retry, first);
    equal(first.devices[0]?.claimId, CLAIM_ID);
    equal(first.devices[0]?.oneTimePreKey?.keyId, 44);
    equal(claimCreates, 1);
    equal(preKeyUpdates, 1);
    equal(candidateSelections, 1);
    equal(eligibilityChecks, 6);
    deepEqual(advisoryLockOrder, [
      PEER_USER_ID,
      REQUESTER_USER_ID,
      PEER_USER_ID,
      REQUESTER_USER_ID
    ]);
  });
});

describe("DevicesService device-list publication", () => {
  it("publica la revocacion antes de confirmar y desconecta despues del commit", async () => {
    const revokedAt = new Date("2026-08-27T19:00:00.000Z");
    const order: string[] = [];
    const transaction = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        const sql = strings.join(" ");
        if (sql.includes("clock_timestamp")) {
          return [{ now: revokedAt }];
        }
        return [];
      },
      device: {
        updateMany: async ({ data }: any) => {
          equal(data.status, DeviceStatus.REVOKED);
          equal(data.revokedAt, revokedAt);
          order.push("device");
          return { count: 1 };
        }
      },
      authSession: {
        updateMany: async ({ data }: any) => {
          equal(data.revocationReason, "DEVICE_REVOKED");
          order.push("sessions");
          return { count: 2 };
        }
      }
    };
    let committed = false;
    const prisma = {
      $transaction: async (
        operation: (client: typeof transaction) => Promise<unknown>
      ) => {
        const result = await operation(transaction);
        committed = true;
        order.push("commit");
        return result;
      }
    } as unknown as PrismaService;
    const realtime = {
      disconnectUser: (userId: string) => {
        equal(userId, REQUESTER_USER_ID);
        equal(committed, true);
        order.push("disconnect");
      }
    } as unknown as RealtimeService;
    const deviceLists = {
      publishDeviceSetChanged: async (
        _transaction: unknown,
        userId: string,
        deviceId: string,
        createdAt: Date
      ) => {
        equal(userId, REQUESTER_USER_ID);
        equal(deviceId, REQUESTER_DEVICE_ID);
        equal(createdAt, revokedAt);
        order.push("publish");
      }
    } as unknown as MatrixDeviceListPublisher;
    const service = new DevicesService(
      prisma,
      realtime,
      {} as ConversationEligibilityService,
      deviceLists
    );

    await service.revoke(REQUESTER_USER_ID, REQUESTER_DEVICE_ID);

    deepEqual(order, [
      "device",
      "sessions",
      "publish",
      "commit",
      "disconnect"
    ]);
  });
});

describe("DevicesController claim session binding", () => {
  it("rechaza una sesión sin dispositivo y transmite únicamente el dispositivo ligado", async () => {
    const calls: string[] = [];
    const devices = {
      claimPeerBundles: async (
        _userId: string,
        requesterDeviceId: string
      ) => {
        calls.push(requesterDeviceId);
        return { devices: [] };
      }
    } as unknown as DevicesService;
    const controller = new DevicesController(
      devices,
      {} as KeyRecoveryService
    );
    const principal: SessionPrincipal = {
      id: REQUESTER_USER_ID,
      username: "cliente",
      role: UserRole.CLIENT,
      status: "ACTIVE",
      sessionId: "22222222-2222-4222-8222-222222222222",
      deviceId: null,
      sessionExpiresAt: new Date("2026-07-27T20:00:00.000Z")
    };

    throws(
      () =>
        controller.claimPeerBundles(
          principal,
          CONVERSATION_ID
        ),
      ForbiddenException
    );
    principal.deviceId = REQUESTER_DEVICE_ID;
    await controller.claimPeerBundles(principal, CONVERSATION_ID);

    deepEqual(calls, [REQUESTER_DEVICE_ID]);
  });
});
