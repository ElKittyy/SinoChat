import { deepEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrismaService } from "../database/prisma.service";
import type { ObjectStorageService } from "../storage/object-storage.service";
import { RetentionService } from "./retention.service";

describe("RetentionService", () => {
  it("no borra un objeto si otra transacción consumió primero la reserva", async () => {
    const deletedKeys: string[] = [];
    const pendingDeletes: string[] = [];
    const now = new Date("2026-07-26T12:00:00.000Z");

    const prisma = {
      $queryRaw: async () => [{ now }],
      message: {
        deleteMany: async () => ({ count: 0 })
      },
      inAppNotification: {
        deleteMany: async () => ({ count: 0 })
      },
      matrixToDeviceEvent: {
        deleteMany: async () => ({ count: 0 })
      },
      matrixToDeviceSyncBatch: {
        deleteMany: async () => ({ count: 0 })
      },
      matrixDeviceRegistration: {
        deleteMany: async () => ({ count: 0 })
      },
      pendingAttachmentUpload: {
        findMany: async () => [
          { id: "reservation-1", objectKey: "ephemeral/photo-1" }
        ],
        updateMany: async () => ({ count: 0 }),
        deleteMany: async ({ where }: { where: { id: string } }) => {
          pendingDeletes.push(where.id);
          return { count: 1 };
        }
      },
      pendingReportEvidenceUpload: {
        findMany: async () => []
      },
      attachment: {
        findMany: async () => []
      }
    } as unknown as PrismaService;
    const storage = {
      delete: async (key: string) => {
        deletedKeys.push(key);
      }
    } as unknown as ObjectStorageService;

    await new RetentionService(prisma, storage).runBatch();

    deepEqual(deletedKeys, []);
    deepEqual(pendingDeletes, []);
  });

  it("elimina objeto y reserva únicamente después de ganar el claim", async () => {
    const calls: string[] = [];
    const now = new Date("2026-07-26T12:00:00.000Z");

    const prisma = {
      $queryRaw: async () => [{ now }],
      message: {
        deleteMany: async () => ({ count: 0 })
      },
      inAppNotification: {
        deleteMany: async () => ({ count: 0 })
      },
      matrixToDeviceEvent: {
        deleteMany: async () => ({ count: 0 })
      },
      matrixToDeviceSyncBatch: {
        deleteMany: async () => ({ count: 0 })
      },
      matrixDeviceRegistration: {
        deleteMany: async () => ({ count: 0 })
      },
      pendingAttachmentUpload: {
        findMany: async () => [
          { id: "reservation-2", objectKey: "ephemeral/photo-2" }
        ],
        updateMany: async () => {
          calls.push("claim");
          return { count: 1 };
        },
        deleteMany: async () => {
          calls.push("remove-reservation");
          return { count: 1 };
        }
      },
      pendingReportEvidenceUpload: {
        findMany: async () => []
      },
      attachment: {
        findMany: async () => []
      }
    } as unknown as PrismaService;
    const storage = {
      delete: async () => {
        calls.push("remove-object");
      }
    } as unknown as ObjectStorageService;

    await new RetentionService(prisma, storage).runBatch();

    deepEqual(calls, [
      "claim",
      "remove-object",
      "remove-reservation"
    ]);
  });

  it("purga la foto antes de eliminar ledger, mensaje y filas dependientes", async () => {
    const calls: string[] = [];
    const now = new Date("2026-07-28T12:00:00.000Z");
    const attachment = {
      id: "attachment-1",
      messageId: "message-1",
      objectKey: "ephemeral/messages/photo-1"
    };
    let attachmentDeleteWhere: unknown;
    let messageDeleteWhere: unknown;
    const transaction = {
      attachment: {
        deleteMany: async ({ where }: { where: unknown }) => {
          calls.push("remove-ledger");
          attachmentDeleteWhere = where;
          return { count: 1 };
        }
      },
      message: {
        deleteMany: async ({ where }: { where: unknown }) => {
          calls.push("remove-message-cascade");
          messageDeleteWhere = where;
          return { count: 1 };
        }
      }
    };
    const prisma = {
      $queryRaw: async () => [{ now }],
      $transaction: async (
        operation: (tx: typeof transaction) => Promise<void>
      ) => operation(transaction),
      message: { deleteMany: async () => ({ count: 0 }) },
      inAppNotification: { deleteMany: async () => ({ count: 0 }) },
      matrixToDeviceEvent: { deleteMany: async () => ({ count: 0 }) },
      matrixToDeviceSyncBatch: { deleteMany: async () => ({ count: 0 }) },
      matrixDeviceRegistration: { deleteMany: async () => ({ count: 0 }) },
      pendingAttachmentUpload: { findMany: async () => [] },
      pendingReportEvidenceUpload: { findMany: async () => [] },
      attachment: {
        findMany: async () => [attachment],
        updateMany: async () => {
          calls.push("claim-ledger");
          return { count: 1 };
        }
      }
    } as unknown as PrismaService;
    const storage = {
      delete: async () => {
        calls.push("remove-all-object-versions");
      }
    } as unknown as ObjectStorageService;

    await new RetentionService(prisma, storage).runBatch();

    deepEqual(calls, [
      "claim-ledger",
      "remove-all-object-versions",
      "remove-ledger",
      "remove-message-cascade"
    ]);
    deepEqual(attachmentDeleteWhere, {
      id: attachment.id,
      messageId: attachment.messageId,
      objectKey: attachment.objectKey,
      message: { expiresAt: { lte: now } }
    });
    deepEqual(messageDeleteWhere, {
      id: attachment.messageId,
      expiresAt: { lte: now }
    });
  });

  it("conserva el ledger y repite el borrado idempotente si falla el commit final", async () => {
    let now = new Date("2026-07-28T12:00:00.000Z");
    let transactionAttempt = 0;
    let failureUpdates = 0;
    let objectDeletes = 0;
    const attachment = {
      id: "attachment-2",
      messageId: "message-2",
      objectKey: "ephemeral/messages/photo-2"
    };
    const transaction = {
      attachment: {
        deleteMany: async () => ({ count: 1 })
      },
      message: {
        deleteMany: async () => ({
          count: transactionAttempt === 1 ? 0 : 1
        })
      }
    };
    const prisma = {
      $queryRaw: async () => [{ now }],
      $transaction: async (
        operation: (tx: typeof transaction) => Promise<void>
      ) => {
        transactionAttempt += 1;
        return operation(transaction);
      },
      message: { deleteMany: async () => ({ count: 0 }) },
      inAppNotification: { deleteMany: async () => ({ count: 0 }) },
      matrixToDeviceEvent: { deleteMany: async () => ({ count: 0 }) },
      matrixToDeviceSyncBatch: { deleteMany: async () => ({ count: 0 }) },
      matrixDeviceRegistration: { deleteMany: async () => ({ count: 0 }) },
      pendingAttachmentUpload: { findMany: async () => [] },
      pendingReportEvidenceUpload: { findMany: async () => [] },
      attachment: {
        findMany: async () => [attachment],
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          if (!("purgeAttempts" in data)) {
            failureUpdates += 1;
          }
          return { count: 1 };
        }
      }
    } as unknown as PrismaService;
    const storage = {
      delete: async () => {
        objectDeletes += 1;
      }
    } as unknown as ObjectStorageService;
    const service = new RetentionService(prisma, storage);

    await service.runBatch();
    now = new Date(now.getTime() + 61_000);
    await service.runBatch();

    deepEqual(
      { transactionAttempt, failureUpdates, objectDeletes },
      { transactionAttempt: 2, failureUpdates: 1, objectDeletes: 2 }
    );
  });

  it("purga controles Matrix vencidos sin borrar tombstones idempotentes", async () => {
    const now = new Date("2026-08-27T12:00:00.000Z");
    const calls: string[] = [];
    let syncBatchWhere: unknown;
    const prisma = {
      $queryRaw: async () => [{ now }],
      message: { deleteMany: async () => ({ count: 0 }) },
      inAppNotification: { deleteMany: async () => ({ count: 0 }) },
      matrixToDeviceEvent: {
        deleteMany: async () => {
          calls.push("events");
          return { count: 1 };
        }
      },
      matrixToDeviceSyncBatch: {
        deleteMany: async ({ where }: { where: unknown }) => {
          calls.push("sync-batches");
          syncBatchWhere = where;
          return { count: 1 };
        }
      },
      matrixDeviceRegistration: {
        deleteMany: async () => {
          calls.push("registrations");
          return { count: 1 };
        }
      },
      matrixToDeviceTransaction: {
        deleteMany: async () => {
          calls.push("transactions");
          return { count: 1 };
        }
      },
      pendingAttachmentUpload: { findMany: async () => [] },
      pendingReportEvidenceUpload: { findMany: async () => [] },
      attachment: { findMany: async () => [] }
    } as unknown as PrismaService;
    const storage = {} as ObjectStorageService;

    await new RetentionService(prisma, storage).runBatch();

    deepEqual(calls, ["events", "sync-batches", "registrations"]);
    deepEqual(syncBatchWhere, { expiresAt: { lte: now } });
  });
});
