import { deepEqual, equal, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import { ConflictException } from "@nestjs/common";
import type { SessionPrincipal } from "../auth/auth.types";
import type { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import type { PrismaService } from "../database/prisma.service";
import { hashMatrixCanonicalJson } from "./matrix-key-upload";
import {
  MATRIX_OLM_ALGORITHM,
  MATRIX_OLM_EVENT_TYPE,
  matrixToDeviceHashInput,
  parseMatrixToDeviceRequest
} from "./matrix-to-device";
import { MatrixToDeviceService } from "./matrix-to-device.service";
import {
  issueMatrixSyncToken,
  type MatrixSyncTokenData
} from "./matrix-sync-token";

process.env.NODE_ENV = "test";
process.env.DEVICE_BINDING_HMAC_SECRET = "d".repeat(32);
process.env.MATRIX_SYNC_TOKEN_SECRET = "s".repeat(32);

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const MATRIX_USER_ID =
  "@u11111111111141118111111111111111:sinochat.invalid";
const MATRIX_DEVICE_ID = "D33333333333343338333333333333333";

describe("MatrixToDeviceService", () => {
  it("reconoce el mismo txnId desde otra sesion del mismo dispositivo", async () => {
    const body = olmBody();
    const parsed = parseMatrixToDeviceRequest(
      MATRIX_OLM_EVENT_TYPE,
      "txn-retry",
      body
    );
    const expectedHash = hashMatrixCanonicalJson(
      matrixToDeviceHashInput(parsed)
    );
    let createCalls = 0;
    let requestedWhere: unknown;
    const transaction = {
      $queryRaw: async () => [{ pg_advisory_xact_lock: null }],
      matrixToDeviceTransaction: {
        findUnique: async ({ where }: { where: unknown }) => {
          requestedWhere = where;
          return { requestSha256: expectedHash };
        },
        create: async () => {
          createCalls += 1;
          return { id: "unexpected" };
        }
      }
    };
    const service = serviceWith(transaction);

    deepEqual(
      await service.send(
        { ...principal(), sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        MATRIX_OLM_EVENT_TYPE,
        "txn-retry",
        body
      ),
      {}
    );
    deepEqual(requestedWhere, {
      senderDeviceId_eventType_transactionId: {
        senderDeviceId: DEVICE_ID,
        eventType: MATRIX_OLM_EVENT_TYPE,
        transactionId: "txn-retry"
      }
    });
    equal(createCalls, 0);
  });

  it("rechaza reutilizar el txnId del dispositivo con otro cuerpo", async () => {
    const transaction = {
      $queryRaw: async () => [{ pg_advisory_xact_lock: null }],
      matrixToDeviceTransaction: {
        findUnique: async () => ({ requestSha256: "0".repeat(64) })
      }
    };
    await rejects(
      serviceWith(transaction).send(
        principal(),
        MATRIX_OLM_EVENT_TYPE,
        "txn-conflict",
        olmBody()
      ),
      ConflictException
    );
  });

  it("reproduce el sucesor ya creado para el mismo token since", async () => {
    const now = new Date("2026-08-27T12:00:00.000Z");
    const parent = batch({
      id: "44444444-4444-4444-8444-444444444444",
      previousBatchId: null,
      fromSequence: 0n,
      upToSequence: 4n,
      fromDeviceListPosition: 0n,
      deviceListPosition: 2n,
      oneTimeKeyCount: 8,
      unusedFallbackKey: true
    });
    const child = batch({
      id: "55555555-5555-4555-8555-555555555555",
      previousBatchId: parent.id,
      fromSequence: 4n,
      upToSequence: 7n,
      fromDeviceListPosition: 2n,
      deviceListPosition: 3n,
      oneTimeKeyCount: 6,
      unusedFallbackKey: false
    });
    let rawQueries = 0;
    let creates = 0;
    const transaction = {
      $queryRaw: async () => {
        rawQueries += 1;
        return rawQueries === 1
          ? [
              {
                now,
                latestSequence: 9n,
                deviceListPosition: 4n
              }
            ]
          : [];
      },
      matrixToDeviceSyncBatch: {
        findUnique: async ({ where }: { where: Record<string, string> }) =>
          where.id ? parent : child,
        create: async () => {
          creates += 1;
          return child;
        },
        updateMany: async () => ({ count: 1 })
      },
      matrixDeviceListChange: {
        findMany: async () => []
      },
      matrixToDeviceEvent: {
        deleteMany: async () => ({ count: 0 })
      }
    };
    const response = await serviceWith(transaction).sync(
      principal(),
      issueMatrixSyncToken(parent).token,
      "0"
    );

    deepEqual(response, {
      next_batch: issueMatrixSyncToken(child).token,
      to_device: { events: [] },
      device_one_time_keys_count: { signed_curve25519: 6 },
      device_unused_fallback_key_types: [],
      device_lists: { changed: [], left: [] }
    });
    equal(creates, 0);
  });
});

function principal(): SessionPrincipal {
  return {
    id: USER_ID,
    role: "CLIENT",
    username: "cliente",
    sessionId: SESSION_ID,
    deviceId: DEVICE_ID
  } as SessionPrincipal;
}

function olmBody() {
  return {
    messages: {
      [MATRIX_USER_ID]: {
        [MATRIX_DEVICE_ID]: {
          algorithm: MATRIX_OLM_ALGORITHM,
          ciphertext: {
            ["B".repeat(43)]: { body: "QUJDRA==", type: 0 }
          },
          "org.matrix.msgid": "0".repeat(32),
          sender_key: "A".repeat(43)
        }
      }
    }
  };
}

function batch(
  data: Omit<MatrixSyncTokenData, "deviceId">
): MatrixSyncTokenData & {
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  acknowledgedAt: Date | null;
} {
  const tokenData = { ...data, deviceId: DEVICE_ID };
  return {
    ...tokenData,
    tokenHash: issueMatrixSyncToken(tokenData).tokenHash,
    createdAt: new Date("2026-08-27T11:59:00.000Z"),
    expiresAt: new Date("2026-08-27T13:00:00.000Z"),
    acknowledgedAt: null
  };
}

function serviceWith(transaction: object): MatrixToDeviceService {
  const prisma = {
    $transaction: async (operation: (client: unknown) => Promise<unknown>) =>
      operation(transaction)
  } as unknown as PrismaService;
  return new MatrixToDeviceService(
    prisma,
    {} as ConversationEligibilityService
  );
}
