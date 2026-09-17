import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AssignmentsService } from "../assignments/assignments.service";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import {
  AdminAuditAction,
  AdminAuditTargetType,
  NotificationType,
  ReportOutcome,
  ReportStatus
} from "../generated/prisma/enums";
import { ObjectStorageService } from "../storage/object-storage.service";

const DEFAULT_INTERVAL_MILLISECONDS = 15_000;
const MIN_INTERVAL_MILLISECONDS = 5_000;
const MAX_INTERVAL_MILLISECONDS = 60_000;
const LEASE_MILLISECONDS = 120_000;
const INITIAL_RETRY_MILLISECONDS = 5_000;
const MAX_RETRY_MILLISECONDS = 5 * 60_000;
const BATCH_SIZE = 50;
const PURGE_CONCURRENCY = 5;

export interface ReportClosureState {
  id: string;
  status: ReportStatus;
  outcome: string | null;
  resolutionSummary: string | null;
  reviewStartedAt: Date | null;
  closeRequestedAt: Date | null;
  closedAt: Date | null;
  evidencePurgedAt: Date | null;
  subjectNotifiedAt: Date | null;
}

@Injectable()
export class ReportClosureWorker
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(ReportClosureWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly assignments: AssignmentsService,
    private readonly storage: ObjectStorageService
  ) {}

  async onModuleInit(): Promise<void> {
    await this.storage.assertProductionConfiguration();

    if (process.env.NODE_ENV === "test") {
      return;
    }
    if (process.env.REPORT_CLOSURE_WORKER_ENABLED === "false") {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "REPORT_CLOSURE_WORKER_ENABLED no puede desactivarse en producción."
        );
      }
      return;
    }

    const interval = Number(
      process.env.REPORT_CLOSURE_WORKER_INTERVAL_MS ??
        DEFAULT_INTERVAL_MILLISECONDS
    );
    if (
      !Number.isInteger(interval) ||
      interval < MIN_INTERVAL_MILLISECONDS ||
      interval > MAX_INTERVAL_MILLISECONDS
    ) {
      throw new Error(
        "REPORT_CLOSURE_WORKER_INTERVAL_MS debe estar entre 5000 y 60000."
      );
    }

    this.timer = setInterval(() => {
      void this.runBatch();
    }, interval);
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
      const databaseNow = await this.getDatabaseNow(this.prisma);
      const jobs = await this.prisma.reportClosureJob.findMany({
        where: {
          nextAttemptAt: { lte: databaseNow },
          purgeNotBefore: { lte: databaseNow },
          OR: [
            { leasedUntil: null },
            { leasedUntil: { lte: databaseNow } }
          ]
        },
        orderBy: [
          { nextAttemptAt: "asc" },
          { createdAt: "asc" }
        ],
        take: BATCH_SIZE,
        select: { reportId: true }
      });

      await this.runConcurrently(jobs, (job) =>
        this.processReport(job.reportId)
      );
    } catch {
      this.logger.error(
        "Falló el lote de cierres de reportes; los jobs persistentes se reintentarán."
      );
    } finally {
      this.running = false;
    }
  }

  async processReport(
    reportId: string
  ): Promise<ReportClosureState | null> {
    const leaseToken = randomUUID();
    let claimedAttempts: number | null = null;
    let attemptStartedAt: Date | null = null;
    let phase: "CLAIM" | "STORAGE" | "FINALIZE" = "CLAIM";

    try {
      attemptStartedAt = await this.getDatabaseNow(this.prisma);
      const leasedUntil = new Date(
        attemptStartedAt.getTime() + LEASE_MILLISECONDS
      );
      const claim = await this.prisma.reportClosureJob.updateMany({
        where: {
          reportId,
          nextAttemptAt: { lte: attemptStartedAt },
          purgeNotBefore: { lte: attemptStartedAt },
          OR: [
            { leasedUntil: null },
            { leasedUntil: { lte: attemptStartedAt } }
          ]
        },
        data: {
          leaseToken,
          leasedUntil,
          lastAttemptAt: attemptStartedAt,
          lastErrorCode: null,
          attempts: { increment: 1 }
        }
      });
      if (claim.count !== 1) {
        return this.getState(reportId);
      }

      const job = await this.prisma.reportClosureJob.findUnique({
        where: { reportId },
        select: {
          reportId: true,
          evidenceObjectKey: true,
          purgeNotBefore: true,
          attempts: true,
          leaseToken: true
        }
      });
      if (!job || job.leaseToken !== leaseToken) {
        return this.getState(reportId);
      }
      claimedAttempts = job.attempts;

      phase = "STORAGE";
      await this.storage.delete(job.evidenceObjectKey);

      phase = "FINALIZE";
      await this.finalize(job.reportId, job.evidenceObjectKey, leaseToken);
    } catch {
      if (claimedAttempts !== null && attemptStartedAt) {
        await this.scheduleRetry(
          reportId,
          leaseToken,
          claimedAttempts,
          attemptStartedAt,
          `${phase}_FAILED`
        );
      }
      this.logger.error(
        `Cierre de reporte reintentable falló (${phase}_FAILED), reportId=${reportId}.`
      );
    }

    return this.getState(reportId);
  }

  private async finalize(
    reportId: string,
    evidenceObjectKey: string,
    leaseToken: string
  ): Promise<void> {
    await this.assignments.runSerializable(async (tx) => {
      const job = await tx.reportClosureJob.findFirst({
        where: { reportId, leaseToken },
        select: {
          reportId: true,
          requestedByAdminUserId: true,
          evidenceObjectKey: true,
          purgeNotBefore: true
        }
      });
      if (!job) {
        return;
      }
      if (job.evidenceObjectKey !== evidenceObjectKey) {
        throw new Error("REPORT_CLOSURE_OBJECT_MISMATCH");
      }

      const now = await this.getDatabaseNow(tx);
      if (job.purgeNotBefore > now) {
        throw new Error("REPORT_CLOSURE_UPLOAD_STILL_AUTHORIZED");
      }

      const report = await tx.report.findUnique({
        where: { id: reportId },
        select: {
          id: true,
          status: true,
          reviewedByAdminUserId: true,
          outcome: true,
          resolutionSummary: true,
          evidence: {
            select: {
              id: true,
              objectKey: true,
              uploadAuthorizedUntil: true
            }
          },
          block: {
            select: { cashierUserId: true }
          }
        }
      });
      if (
        !report ||
        report.status !== ReportStatus.CLOSING ||
        report.reviewedByAdminUserId !== job.requestedByAdminUserId ||
        !report.outcome ||
        !report.resolutionSummary
      ) {
        throw new Error("REPORT_CLOSURE_STATE_MISMATCH");
      }
      if (
        report.evidence &&
        report.evidence.objectKey !== evidenceObjectKey
      ) {
        throw new Error("REPORT_CLOSURE_EVIDENCE_MISMATCH");
      }
      if (
        report.evidence &&
        report.evidence.uploadAuthorizedUntil > now
      ) {
        throw new Error("REPORT_CLOSURE_UPLOAD_STILL_AUTHORIZED");
      }
      if (report.evidence) {
        await tx.reportEvidence.delete({
          where: { id: report.evidence.id }
        });
      }

      await tx.report.update({
        where: { id: reportId },
        data: {
          status: ReportStatus.CLOSED,
          closedAt: now,
          evidencePurgedAt: now,
          subjectNotifiedAt: now
        }
      });
      await tx.inAppNotification.create({
        data: {
          userId: report.block.cashierUserId,
          type:
            report.outcome === ReportOutcome.WARNING
              ? NotificationType.REPORT_WARNING
              : NotificationType.REPORT_RESOLVED,
          relatedEntityId: reportId
        }
      });
      await tx.adminAuditEvent.create({
        data: {
          actorAdminId: job.requestedByAdminUserId,
          action: AdminAuditAction.REPORT_CLOSED,
          targetType: AdminAuditTargetType.REPORT,
          targetId: reportId,
          targetUserId: report.block.cashierUserId,
          reasonCode: `REPORT_CLOSED_${report.outcome}`,
          stateBefore: ReportStatus.CLOSING,
          stateAfter: ReportStatus.CLOSED,
          requestId: randomUUID()
        }
      });
      await tx.reportClosureJob.delete({
        where: { reportId }
      });
    });
  }

  private async scheduleRetry(
    reportId: string,
    leaseToken: string,
    attempts: number,
    attemptStartedAt: Date,
    errorCode: string
  ): Promise<void> {
    const exponent = Math.min(Math.max(attempts - 1, 0), 16);
    const delay = Math.min(
      MAX_RETRY_MILLISECONDS,
      INITIAL_RETRY_MILLISECONDS * 2 ** exponent
    );
    try {
      let retryBase = attemptStartedAt;
      try {
        retryBase = await this.getDatabaseNow(this.prisma);
      } catch {
        // The claim timestamp is a safe database-clock fallback if a second
        // clock query fails while the update itself remains available.
      }
      const nextAttemptAt = new Date(retryBase.getTime() + delay);
      await this.prisma.reportClosureJob.updateMany({
        where: { reportId, leaseToken },
        data: {
          leaseToken: null,
          leasedUntil: null,
          nextAttemptAt,
          lastErrorCode: errorCode
        }
      });
    } catch {
      // The bounded lease lets another worker reclaim the durable job after
      // expiry without losing the intent or the object key.
      this.logger.error(
        `No se pudo liberar la lease de cierre, reportId=${reportId}.`
      );
    }
  }

  private getState(reportId: string): Promise<ReportClosureState | null> {
    return this.prisma.report.findUnique({
      where: { id: reportId },
      select: {
        id: true,
        status: true,
        outcome: true,
        resolutionSummary: true,
        reviewStartedAt: true,
        closeRequestedAt: true,
        closedAt: true,
        evidencePurgedAt: true,
        subjectNotifiedAt: true
      }
    });
  }

  private async getDatabaseNow(
    client: PrismaService | Prisma.TransactionClient
  ): Promise<Date> {
    const rows = await client.$queryRaw<Array<{ now: Date }>>(
      Prisma.sql`SELECT clock_timestamp() AS "now"`
    );
    const now = rows[0]?.now;
    if (!(now instanceof Date)) {
      throw new Error("DATABASE_CLOCK_UNAVAILABLE");
    }
    return now;
  }

  private async runConcurrently<T>(
    items: T[],
    operation: (item: T) => Promise<unknown>
  ): Promise<void> {
    for (let index = 0; index < items.length; index += PURGE_CONCURRENCY) {
      await Promise.all(
        items
          .slice(index, index + PURGE_CONCURRENCY)
          .map((item) => operation(item))
      );
    }
  }
}
