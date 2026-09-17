import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssignmentsService } from "../assignments/assignments.service";
import type { PrismaService } from "../database/prisma.service";
import {
  NotificationType,
  ReportOutcome,
  ReportStatus
} from "../generated/prisma/enums";
import type { ObjectStorageService } from "../storage/object-storage.service";
import { ReportClosureWorker } from "./report-closure.worker";

const REPORT_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const CASHIER_ID = "33333333-3333-4333-8333-333333333333";
const OBJECT_KEY = "investigations/report-evidence/ciphertext";

const startedAt = new Date("2026-08-02T12:00:00.000Z");
const finishedAt = new Date("2026-08-02T12:00:01.000Z");

describe("ReportClosureWorker", () => {
  it("no puede desactivarse en produccion", async () => {
    const previousNodeEnvironment = process.env.NODE_ENV;
    const previousEnabled = process.env.REPORT_CLOSURE_WORKER_ENABLED;
    process.env.NODE_ENV = "production";
    process.env.REPORT_CLOSURE_WORKER_ENABLED = "false";
    const storage = {
      assertProductionConfiguration: async () => undefined
    } as unknown as ObjectStorageService;

    try {
      await rejects(
        () =>
          new ReportClosureWorker(
            {} as PrismaService,
            {} as AssignmentsService,
            storage
          ).onModuleInit(),
        /no puede desactivarse/
      );
    } finally {
      if (previousNodeEnvironment === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnvironment;
      }
      if (previousEnabled === undefined) {
        delete process.env.REPORT_CLOSURE_WORKER_ENABLED;
      } else {
        process.env.REPORT_CLOSURE_WORKER_ENABLED = previousEnabled;
      }
    }
  });

  it("purga y solo despues cierra, notifica, audita y olvida el objectKey", async () => {
    const calls: string[] = [];
    let currentLeaseToken = "";
    let notificationType: string | undefined;
    const rootPrisma = {
      $queryRaw: async () => [{ now: startedAt }],
      reportClosureJob: {
        updateMany: async ({
          data
        }: {
          data: { leaseToken: string };
        }) => {
          currentLeaseToken = data.leaseToken;
          calls.push("claim");
          return { count: 1 };
        },
        findUnique: async ({ where }: { where: { reportId: string } }) => {
          calls.push("read-job");
          return {
            reportId: where.reportId,
            evidenceObjectKey: OBJECT_KEY,
            purgeNotBefore: startedAt,
            attempts: 1,
            leaseToken: currentLeaseToken
          };
        }
      },
      report: {
        findUnique: async () => {
          calls.push("read-state");
          return {
            id: REPORT_ID,
            status: ReportStatus.CLOSED,
            outcome: ReportOutcome.WARNING,
            resolutionSummary: "Advertencia documentada.",
            reviewStartedAt: startedAt,
            closeRequestedAt: startedAt,
            closedAt: finishedAt,
            evidencePurgedAt: finishedAt,
            subjectNotifiedAt: finishedAt
          };
        }
      }
    } as unknown as PrismaService;

    const tx = {
      reportClosureJob: {
        findFirst: async () => {
          calls.push("read-lease");
          return {
            reportId: REPORT_ID,
            requestedByAdminUserId: ADMIN_ID,
            evidenceObjectKey: OBJECT_KEY,
            purgeNotBefore: startedAt
          };
        },
        delete: async () => {
          calls.push("delete-job");
          return {};
        }
      },
      report: {
        findUnique: async () => {
          calls.push("read-report");
          return {
            id: REPORT_ID,
            status: ReportStatus.CLOSING,
            reviewedByAdminUserId: ADMIN_ID,
            outcome: ReportOutcome.WARNING,
            resolutionSummary: "Advertencia documentada.",
            evidence: {
              id: "evidence-id",
              objectKey: OBJECT_KEY,
              uploadAuthorizedUntil: startedAt
            },
            block: { cashierUserId: CASHIER_ID }
          };
        },
        update: async () => {
          calls.push("mark-closed");
          return {};
        }
      },
      reportEvidence: {
        delete: async () => {
          calls.push("delete-evidence");
          return {};
        }
      },
      inAppNotification: {
        create: async ({
          data
        }: {
          data: { type: string };
        }) => {
          notificationType = data.type;
          calls.push("notify");
          return {};
        }
      },
      adminAuditEvent: {
        create: async () => {
          calls.push("audit");
          return {};
        }
      },
      $queryRaw: async () => [{ now: finishedAt }]
    };
    const assignments = {
      runSerializable: async <T>(
        operation: (client: typeof tx) => Promise<T>
      ) => operation(tx)
    } as unknown as AssignmentsService;
    const storage = {
      delete: async (key: string) => {
        equal(key, OBJECT_KEY);
        calls.push("delete-object");
      }
    } as unknown as ObjectStorageService;

    const result = await new ReportClosureWorker(
      rootPrisma,
      assignments,
      storage
    ).processReport(REPORT_ID);

    equal(result?.status, ReportStatus.CLOSED);
    deepEqual(calls, [
      "claim",
      "read-job",
      "delete-object",
      "read-lease",
      "read-report",
      "delete-evidence",
      "mark-closed",
      "notify",
      "audit",
      "delete-job",
      "read-state"
    ]);
    equal(notificationType, NotificationType.REPORT_WARNING);
    equal("evidenceObjectKey" in (result ?? {}), false);
  });

  it("deja el job reintentable con backoff cuando falla storage", async () => {
    let leaseToken = "";
    let retryData: Record<string, unknown> | undefined;
    let updateCalls = 0;
    const prisma = {
      $queryRaw: async () => [{ now: startedAt }],
      reportClosureJob: {
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          updateCalls += 1;
          if (updateCalls === 1) {
            leaseToken = data.leaseToken as string;
            return { count: 1 };
          }
          retryData = data;
          return { count: 1 };
        },
        findUnique: async () => ({
          reportId: REPORT_ID,
          evidenceObjectKey: OBJECT_KEY,
          purgeNotBefore: startedAt,
          attempts: 1,
          leaseToken
        })
      },
      report: {
        findUnique: async () => ({
          id: REPORT_ID,
          status: ReportStatus.CLOSING,
          outcome: ReportOutcome.WARNING,
          resolutionSummary: "Advertencia documentada.",
          reviewStartedAt: startedAt,
          closeRequestedAt: startedAt,
          closedAt: null,
          evidencePurgedAt: null,
          subjectNotifiedAt: null
        })
      }
    } as unknown as PrismaService;
    const storage = {
      delete: async () => {
        throw new Error("provider unavailable");
      }
    } as unknown as ObjectStorageService;
    let transactionStarted = false;
    const assignments = {
      runSerializable: async () => {
        transactionStarted = true;
      }
    } as unknown as AssignmentsService;

    const result = await new ReportClosureWorker(
      prisma,
      assignments,
      storage
    ).processReport(REPORT_ID);

    equal(result?.status, ReportStatus.CLOSING);
    equal(transactionStarted, false);
    equal(retryData?.leaseToken, null);
    equal(retryData?.leasedUntil, null);
    equal(retryData?.lastErrorCode, "STORAGE_FAILED");
    ok(retryData?.nextAttemptAt instanceof Date);
    equal(
      (retryData?.nextAttemptAt as Date).getTime() -
        startedAt.getTime(),
      5_000
    );
  });

  it("solo el ganador de la lease puede borrar evidencia", async () => {
    let storageCalled = false;
    const prisma = {
      $queryRaw: async () => [{ now: startedAt }],
      reportClosureJob: {
        updateMany: async () => ({ count: 0 })
      },
      report: {
        findUnique: async () => ({
          id: REPORT_ID,
          status: ReportStatus.CLOSING,
          outcome: ReportOutcome.WARNING,
          resolutionSummary: "Advertencia documentada.",
          reviewStartedAt: startedAt,
          closeRequestedAt: startedAt,
          closedAt: null,
          evidencePurgedAt: null,
          subjectNotifiedAt: null
        })
      }
    } as unknown as PrismaService;
    const storage = {
      delete: async () => {
        storageCalled = true;
      }
    } as unknown as ObjectStorageService;

    const result = await new ReportClosureWorker(
      prisma,
      {} as AssignmentsService,
      storage
    ).processReport(REPORT_ID);

    equal(result?.status, ReportStatus.CLOSING);
    equal(storageCalled, false);
  });

  it("no reclama ni borra evidencia mientras el PUT firmado siga autorizado", async () => {
    let claimWhere: Record<string, unknown> | undefined;
    let storageCalled = false;
    const prisma = {
      $queryRaw: async () => [{ now: startedAt }],
      reportClosureJob: {
        updateMany: async ({ where }: { where: Record<string, unknown> }) => {
          claimWhere = where;
          return { count: 0 };
        }
      },
      report: {
        findUnique: async () => ({
          id: REPORT_ID,
          status: ReportStatus.CLOSING,
          outcome: ReportOutcome.WARNING,
          resolutionSummary: "Advertencia documentada.",
          reviewStartedAt: startedAt,
          closeRequestedAt: startedAt,
          closedAt: null,
          evidencePurgedAt: null,
          subjectNotifiedAt: null
        })
      }
    } as unknown as PrismaService;
    const storage = {
      delete: async () => {
        storageCalled = true;
      }
    } as unknown as ObjectStorageService;

    const result = await new ReportClosureWorker(
      prisma,
      {} as AssignmentsService,
      storage
    ).processReport(REPORT_ID);

    deepEqual(claimWhere?.purgeNotBefore, { lte: startedAt });
    equal(storageCalled, false);
    equal(result?.status, ReportStatus.CLOSING);
  });
});
