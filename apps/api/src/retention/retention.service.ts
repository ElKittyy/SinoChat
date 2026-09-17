import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { AttachmentUploadStatus } from "../generated/prisma/enums";
import { ObjectStorageService } from "../storage/object-storage.service";

const DEFAULT_INTERVAL_MILLISECONDS = 30_000;
const BATCH_SIZE = 100;
const RETRY_DELAY_MILLISECONDS = 60_000;
const PURGE_CONCURRENCY = 5;

@Injectable()
export class RetentionService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(RetentionService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService
  ) {}

  async onModuleInit(): Promise<void> {
    await this.storage.assertProductionConfiguration();

    if (process.env.NODE_ENV === "test") {
      return;
    }
    if (process.env.RETENTION_WORKER_ENABLED === "false") {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "RETENTION_WORKER_ENABLED no puede desactivarse en producción."
        );
      }
      return;
    }

    const configuredInterval = Number(
      process.env.RETENTION_WORKER_INTERVAL_MS ??
        DEFAULT_INTERVAL_MILLISECONDS
    );
    if (
      !Number.isInteger(configuredInterval) ||
      configuredInterval < 5_000 ||
      configuredInterval > 60_000
    ) {
      throw new Error(
        "RETENTION_WORKER_INTERVAL_MS debe estar entre 5000 y 60000."
      );
    }

    this.timer = setInterval(() => {
      void this.runBatch();
    }, configuredInterval);
    this.timer.unref();
    void this.runBatch();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async runBatch(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      const databaseNow = await this.getDatabaseNow();
      const retryBefore = new Date(
        databaseNow.getTime() - RETRY_DELAY_MILLISECONDS
      );
      await this.reportRetentionLag(databaseNow);

      await this.prisma.message.deleteMany({
        where: {
          expiresAt: { lte: databaseNow },
          attachment: null
        }
      });
      await this.prisma.inAppNotification.deleteMany({
        where: {
          expiresAt: { lte: databaseNow }
        }
      });
      await this.prisma.matrixToDeviceEvent.deleteMany({
        where: {
          expiresAt: { lte: databaseNow }
        }
      });
      await this.prisma.matrixToDeviceSyncBatch.deleteMany({
        where: {
          expiresAt: { lte: databaseNow }
        }
      });
      await this.prisma.matrixDeviceRegistration.deleteMany({
        where: {
          consumedAt: null,
          expiresAt: { lte: databaseNow }
        }
      });

      const abandonedUploads =
        await this.prisma.pendingAttachmentUpload.findMany({
          where: {
            grantExpiresAt: { lte: databaseNow },
            OR: [
              { lastPurgeAttemptAt: null },
              { lastPurgeAttemptAt: { lte: retryBefore } }
            ]
          },
          orderBy: [
            {
              lastPurgeAttemptAt: {
                sort: "asc",
                nulls: "first"
              }
            },
            { grantExpiresAt: "asc" }
          ],
          take: BATCH_SIZE,
          select: {
            id: true,
            objectKey: true
          }
        });
      await this.runConcurrently(
        abandonedUploads,
        (upload) =>
          this.purgeAbandonedUpload(
            upload,
            databaseNow,
            retryBefore
          )
      );

      const abandonedEvidence =
        await this.prisma.pendingReportEvidenceUpload.findMany({
          where: {
            grantExpiresAt: { lte: databaseNow },
            OR: [
              { lastPurgeAttemptAt: null },
              { lastPurgeAttemptAt: { lte: retryBefore } }
            ]
          },
          orderBy: [
            {
              lastPurgeAttemptAt: {
                sort: "asc",
                nulls: "first"
              }
            },
            { grantExpiresAt: "asc" }
          ],
          take: BATCH_SIZE,
          select: {
            id: true,
            objectKey: true
          }
        });
      await this.runConcurrently(
        abandonedEvidence,
        (upload) =>
          this.purgeAbandonedEvidence(
            upload,
            databaseNow,
            retryBefore
          )
      );

      const expiredImages = await this.prisma.attachment.findMany({
        where: {
          message: {
            expiresAt: { lte: databaseNow }
          },
          OR: [
            { lastPurgeAttemptAt: null },
            { lastPurgeAttemptAt: { lte: retryBefore } }
          ]
        },
        orderBy: [
          {
            lastPurgeAttemptAt: {
              sort: "asc",
              nulls: "first"
            }
          },
          { createdAt: "asc" }
        ],
        take: BATCH_SIZE,
        select: {
          id: true,
          messageId: true,
          objectKey: true
        }
      });

      await this.runConcurrently(
        expiredImages,
        (attachment) =>
          this.purgeAttachment(
            attachment,
            databaseNow,
            retryBefore
          )
      );
    } catch (error) {
      this.logger.error(
        "Falló un lote de purga de contenido efímero.",
        error instanceof Error ? error.stack : undefined
      );
    } finally {
      this.running = false;
    }
  }

  private async purgeAttachment(
    attachment: {
      id: string;
      messageId: string;
      objectKey: string;
    },
    databaseNow: Date,
    retryBefore: Date
  ): Promise<void> {
    try {
      const claimed = await this.prisma.attachment.updateMany({
        where: {
          id: attachment.id,
          message: { expiresAt: { lte: databaseNow } },
          OR: [
            { lastPurgeAttemptAt: null },
            { lastPurgeAttemptAt: { lte: retryBefore } }
          ]
        },
        data: {
          status: AttachmentUploadStatus.PURGE_PENDING,
          purgeAttempts: { increment: 1 },
          lastPurgeAttemptAt: databaseNow,
          lastPurgeErrorCode: null
        }
      });
      if (claimed.count !== 1) {
        return;
      }

      // DeleteObject es idempotente: se puede repetir si el proceso cae entre
      // el borrado del objeto y el commit de PostgreSQL.
      await this.storage.delete(attachment.objectKey);
      await this.prisma.$transaction(async (transaction) => {
        const removedLedger = await transaction.attachment.deleteMany({
          where: {
            id: attachment.id,
            messageId: attachment.messageId,
            objectKey: attachment.objectKey,
            message: { expiresAt: { lte: databaseNow } }
          }
        });
        if (removedLedger.count !== 1) {
          return;
        }

        const removedMessage = await transaction.message.deleteMany({
          where: {
            id: attachment.messageId,
            expiresAt: { lte: databaseNow }
          }
        });
        if (removedMessage.count !== 1) {
          // Roll back the ledger removal so a later run still has objectKey
          // and can safely repeat the idempotent storage deletion.
          throw new Error("ATTACHMENT_MESSAGE_PURGE_RACE");
        }
      });
    } catch (error) {
      const errorCode = this.storageErrorCode(error);
      await this.prisma.attachment.updateMany({
        where: { id: attachment.id },
        data: {
          status: AttachmentUploadStatus.PURGE_FAILED,
          lastPurgeAttemptAt: databaseNow,
          lastPurgeErrorCode: errorCode
        }
      });
      this.logger.warn(
        `No se pudo purgar el adjunto ${attachment.id}: ${errorCode}`
      );
    }
  }

  private async purgeAbandonedUpload(
    upload: {
      id: string;
      objectKey: string;
    },
    databaseNow: Date,
    retryBefore: Date
  ): Promise<void> {
    try {
      const claimed = await this.prisma.pendingAttachmentUpload.updateMany({
        where: {
          id: upload.id,
          grantExpiresAt: { lte: databaseNow },
          OR: [
            { lastPurgeAttemptAt: null },
            { lastPurgeAttemptAt: { lte: retryBefore } }
          ]
        },
        data: {
          purgeAttempts: { increment: 1 },
          lastPurgeAttemptAt: databaseNow,
          lastPurgeErrorCode: null
        }
      });
      if (claimed.count !== 1) {
        return;
      }
      await this.storage.delete(upload.objectKey);
      await this.prisma.pendingAttachmentUpload.deleteMany({
        where: { id: upload.id }
      });
    } catch (error) {
      const errorCode = this.storageErrorCode(error);
      await this.prisma.pendingAttachmentUpload.updateMany({
        where: { id: upload.id },
        data: {
          lastPurgeAttemptAt: databaseNow,
          lastPurgeErrorCode: errorCode
        }
      });
      this.logger.warn(
        `No se pudo purgar la subida abandonada ${upload.id}: ${errorCode}`
      );
    }
  }

  private async purgeAbandonedEvidence(
    upload: {
      id: string;
      objectKey: string;
    },
    databaseNow: Date,
    retryBefore: Date
  ): Promise<void> {
    try {
      const claimed =
        await this.prisma.pendingReportEvidenceUpload.updateMany({
          where: {
            id: upload.id,
            grantExpiresAt: { lte: databaseNow },
            OR: [
              { lastPurgeAttemptAt: null },
              { lastPurgeAttemptAt: { lte: retryBefore } }
            ]
          },
          data: {
            purgeAttempts: { increment: 1 },
            lastPurgeAttemptAt: databaseNow,
            lastPurgeErrorCode: null
          }
        });
      if (claimed.count !== 1) {
        return;
      }
      await this.storage.delete(upload.objectKey);
      await this.prisma.pendingReportEvidenceUpload.deleteMany({
        where: { id: upload.id }
      });
    } catch (error) {
      const errorCode = this.storageErrorCode(error);
      await this.prisma.pendingReportEvidenceUpload.updateMany({
        where: { id: upload.id },
        data: {
          lastPurgeAttemptAt: databaseNow,
          lastPurgeErrorCode: errorCode
        }
      });
      this.logger.warn(
        `No se pudo purgar la evidencia abandonada ${upload.id}: ${errorCode}`
      );
    }
  }

  private async getDatabaseNow(): Promise<Date> {
    const rows = await this.prisma.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp() AS "now"
    `;
    const now = rows[0]?.now;
    if (!now) {
      throw new Error("No se pudo consultar el reloj de PostgreSQL.");
    }
    return now;
  }

  private async reportRetentionLag(databaseNow: Date): Promise<void> {
    const rows = await this.prisma.$queryRaw<
      Array<{ oldest: Date | null }>
    >`
      SELECT min(expired."expires_at") AS "oldest"
        FROM (
          SELECT m."expires_at"
            FROM "messages" m
           WHERE m."expires_at" <= ${databaseNow}
          UNION ALL
          SELECT e."expires_at"
            FROM "matrix_to_device_events" e
           WHERE e."expires_at" <= ${databaseNow}
        ) expired
    `;
    const oldest = rows[0]?.oldest;
    if (!oldest) {
      return;
    }

    const lagMilliseconds =
      databaseNow.getTime() - oldest.getTime();
    if (lagMilliseconds > 5 * 60_000) {
      this.logger.error(
        `RETENTION_SLO_BREACH lag_ms=${lagMilliseconds}`
      );
    } else if (lagMilliseconds > 60_000) {
      this.logger.warn(
        `RETENTION_SLO_WARNING lag_ms=${lagMilliseconds}`
      );
    }
  }

  private async runConcurrently<T>(
    items: T[],
    operation: (item: T) => Promise<void>
  ): Promise<void> {
    let cursor = 0;
    const workers = Array.from(
      {
        length: Math.min(PURGE_CONCURRENCY, items.length)
      },
      async () => {
        while (cursor < items.length) {
          const item = items[cursor];
          cursor += 1;
          if (item !== undefined) {
            await operation(item);
          }
        }
      }
    );
    await Promise.all(workers);
  }

  private storageErrorCode(error: unknown): string {
    if (typeof error === "object" && error !== null) {
      if ("name" in error && typeof error.name === "string") {
        return error.name.slice(0, 64);
      }
      if ("code" in error && typeof error.code === "string") {
        return error.code.slice(0, 64);
      }
    }
    return "UNKNOWN_STORAGE_ERROR";
  }
}
