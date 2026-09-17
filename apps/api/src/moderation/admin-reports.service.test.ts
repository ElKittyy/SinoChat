import { UnauthorizedException } from "@nestjs/common";
import {
  deepEqual,
  equal,
  rejects
} from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssignmentsService } from "../assignments/assignments.service";
import type { PasswordService } from "../auth/password.service";
import type { PrismaService } from "../database/prisma.service";
import {
  AccountStatus,
  ReportOutcome,
  ReportStatus
} from "../generated/prisma/enums";
import type { ObjectStorageService } from "../storage/object-storage.service";
import { AdminReportsService } from "./admin-reports.service";
import type { ReportClosureWorker } from "./report-closure.worker";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const REPORT_ID = "22222222-2222-4222-8222-222222222222";
const CASHIER_ID = "33333333-3333-4333-8333-333333333333";

describe("AdminReportsService", () => {
  it("devuelve el total pendiente global desde el mismo snapshot que la pagina", async () => {
    const countCalls: Array<{ where?: unknown }> = [];
    let findManyArgs: Record<string, unknown> | undefined;
    let transactionOptions: Record<string, unknown> | undefined;
    const tx = {
      report: {
        count: async (args: { where?: unknown }) => {
          countCalls.push(args);
          return countCalls.length === 1 ? 7 : 5;
        },
        findMany: async (args: Record<string, unknown>) => {
          findManyArgs = args;
          return [];
        }
      }
    };
    const prisma = {
      $transaction: async <T>(
        operation: (client: typeof tx) => Promise<T>,
        options: Record<string, unknown>
      ) => {
        transactionOptions = options;
        return operation(tx);
      }
    } as unknown as PrismaService;
    const service = new AdminReportsService(
      prisma,
      {} as AssignmentsService,
      {} as ObjectStorageService,
      {} as PasswordService,
      {} as ReportClosureWorker
    );

    const result = await service.list({
      page: 2,
      pageSize: 3,
      status: ReportStatus.CLOSED
    });

    deepEqual(result, {
      items: [],
      pendingTotal: 5,
      pagination: {
        page: 2,
        pageSize: 3,
        total: 7,
        totalPages: 3
      }
    });
    deepEqual(countCalls, [
      { where: { status: ReportStatus.CLOSED } },
      {
        where: {
          status: {
            in: [
              ReportStatus.OPEN,
              ReportStatus.IN_REVIEW,
              ReportStatus.CLOSING
            ]
          }
        }
      }
    ]);
    equal(transactionOptions?.isolationLevel, "RepeatableRead");
    equal(findManyArgs?.skip, 3);
    equal(findManyArgs?.take, 3);
    equal(
      "evidence" in
        ((findManyArgs?.select ?? {}) as Record<string, unknown>),
      false
    );
  });

  it("no entrega evidencia si falla la reautenticacion", async () => {
    let transactionStarted = false;
    const prisma = {
      user: {
        findFirst: async () => ({ passwordHash: "argon-hash" })
      }
    } as unknown as PrismaService;
    const assignments = {
      runSerializable: async () => {
        transactionStarted = true;
      }
    } as unknown as AssignmentsService;
    const passwords = {
      verify: async () => false
    } as unknown as PasswordService;
    const service = new AdminReportsService(
      prisma,
      assignments,
      {} as ObjectStorageService,
      passwords,
      {} as ReportClosureWorker
    );

    await rejects(
      () =>
        service.evidenceDownload(ADMIN_ID, REPORT_ID, {
          currentPassword: "incorrect-password",
          reason: "Necesito revisar este caso reportado."
        }),
      UnauthorizedException
    );
    equal(transactionStarted, false);
  });

  it("audita la justificacion antes de devolver una URL corta", async () => {
    const calls: string[] = [];
    let auditData: Record<string, unknown> | undefined;
    const tx = {
      $queryRaw: async () => {
        calls.push("lock");
        return [];
      },
      report: {
        findUnique: async () => ({
          id: REPORT_ID,
          status: ReportStatus.IN_REVIEW,
          reviewedByAdminUserId: ADMIN_ID,
          block: { cashierUserId: CASHIER_ID },
          evidence: {
            objectKey: "investigations/evidence-1",
            ciphertextByteSize: 42n,
            ciphertextSha256: "a".repeat(64),
            cipherSuite: "HPKE-v1",
            manifestVersion: 1,
            investigationKey: {
              id: "44444444-4444-4444-8444-444444444444",
              version: 1,
              algorithm: "X25519",
              publicKey: Buffer.from("public-key"),
              fingerprint: "b".repeat(64)
            }
          }
        })
      },
      adminAuditEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          calls.push("audit");
          auditData = data;
          return data;
        }
      }
    };
    const prisma = {
      user: {
        findFirst: async () => ({ passwordHash: "argon-hash" })
      }
    } as unknown as PrismaService;
    const assignments = {
      runSerializable: async <T>(
        operation: (client: typeof tx) => Promise<T>
      ) => operation(tx)
    } as unknown as AssignmentsService;
    const storage = {
      presignDownload: async () => {
        calls.push("presign");
        return "https://storage.invalid/short-lived";
      }
    } as unknown as ObjectStorageService;
    const passwords = {
      verify: async () => true
    } as unknown as PasswordService;
    const service = new AdminReportsService(
      prisma,
      assignments,
      storage,
      passwords,
      {} as ReportClosureWorker
    );

    const result = await service.evidenceDownload(
      ADMIN_ID,
      REPORT_ID,
      {
        currentPassword: "correct-password",
        reason: "  Revision necesaria por riesgo documentado.  "
      }
    );

    equal(result.downloadExpiresInSeconds, 60);
    equal(
      auditData?.reasonCode,
      "Revision necesaria por riesgo documentado."
    );
    deepEqual(calls, ["lock", "presign", "audit"]);
  });

  it("persiste CLOSING y el job antes del intento inmediato", async () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    const uploadAuthorizedUntil = new Date(
      "2026-08-02T12:07:00.000Z"
    );
    const calls: string[] = [];
    let closureJobData: Record<string, unknown> | undefined;
    let queryCount = 0;
    const closingState = {
      id: REPORT_ID,
      status: ReportStatus.CLOSING,
      outcome: ReportOutcome.WARNING,
      resolutionSummary: "Se emitira una advertencia administrativa.",
      reviewStartedAt: new Date("2026-08-02T11:00:00.000Z"),
      closeRequestedAt: now,
      closedAt: null,
      evidencePurgedAt: null,
      subjectNotifiedAt: null
    };
    const tx = {
      $queryRaw: async () => {
        queryCount += 1;
        return queryCount === 1 ? [] : [{ now }];
      },
      report: {
        findUnique: async () => ({
          ...closingState,
          status: ReportStatus.IN_REVIEW,
          outcome: null,
          resolutionSummary: null,
          closeRequestedAt: null,
          reviewedByAdminUserId: ADMIN_ID,
          evidence: {
            objectKey: "investigations/evidence-2",
            uploadAuthorizedUntil
          },
          block: {
            cashier: { user: { id: CASHIER_ID, status: AccountStatus.ACTIVE } }
          },
          closureJob: null
        }),
        update: async () => {
          calls.push("save-intent");
          return closingState;
        }
      },
      reportClosureJob: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          calls.push("save-job");
          closureJobData = data;
          return {};
        }
      },
      adminAuditEvent: {
        findFirst: async () => ({ id: "evidence-access-audit" })
      }
    };
    const assignments = {
      runSerializable: async <T>(
        operation: (client: typeof tx) => Promise<T>
      ) => operation(tx)
    } as unknown as AssignmentsService;
    const worker = {
      processReport: async () => {
        calls.push("immediate-attempt");
        throw new Error("storage unavailable");
      }
    } as unknown as ReportClosureWorker;
    const service = new AdminReportsService(
      {} as PrismaService,
      assignments,
      {} as ObjectStorageService,
      {} as PasswordService,
      worker
    );

    const result = await service.close(ADMIN_ID, REPORT_ID, {
      outcome: ReportOutcome.WARNING,
      resolutionSummary:
        "Se emitira una advertencia administrativa."
    });

    equal(result.status, ReportStatus.CLOSING);
    equal(closureJobData?.purgeNotBefore, uploadAuthorizedUntil);
    equal(closureJobData?.nextAttemptAt, uploadAuthorizedUntil);
    deepEqual(calls, [
      "save-intent",
      "save-job",
      "immediate-attempt"
    ]);
  });

  it("una repeticion CLOSING nunca expone evidence ni objectKey", async () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    const tx = {
      $queryRaw: async () => [],
      report: {
        findUnique: async () => ({
          id: REPORT_ID,
          status: ReportStatus.CLOSING,
          reviewedByAdminUserId: ADMIN_ID,
          outcome: ReportOutcome.WARNING,
          resolutionSummary: "Advertencia administrativa documentada.",
          reviewStartedAt: now,
          closeRequestedAt: now,
          closedAt: null,
          evidencePurgedAt: null,
          subjectNotifiedAt: null,
          evidence: {
            objectKey: "must-never-leave-service",
            uploadAuthorizedUntil: now
          },
          block: {
            cashier: { user: { id: CASHIER_ID, status: AccountStatus.ACTIVE } }
          },
          closureJob: { reportId: REPORT_ID }
        })
      }
    };
    const assignments = {
      runSerializable: async <T>(
        operation: (client: typeof tx) => Promise<T>
      ) => operation(tx)
    } as unknown as AssignmentsService;
    const worker = {
      processReport: async () => null
    } as unknown as ReportClosureWorker;
    const service = new AdminReportsService(
      {} as PrismaService,
      assignments,
      {} as ObjectStorageService,
      {} as PasswordService,
      worker
    );

    const result = await service.close(ADMIN_ID, REPORT_ID, {
      outcome: ReportOutcome.WARNING,
      resolutionSummary: "Advertencia administrativa documentada."
    });

    equal("evidence" in result, false);
    equal("objectKey" in result, false);
  });

  it("no registra una suspensión inexistente como resultado inmutable", async () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    const tx = {
      $queryRaw: async () => [],
      report: {
        findUnique: async () => ({
          id: REPORT_ID,
          status: ReportStatus.IN_REVIEW,
          reviewedByAdminUserId: ADMIN_ID,
          outcome: null,
          resolutionSummary: null,
          reviewStartedAt: now,
          closeRequestedAt: null,
          closedAt: null,
          evidencePurgedAt: null,
          subjectNotifiedAt: null,
          evidence: {
            objectKey: "investigations/evidence-3",
            uploadAuthorizedUntil: now
          },
          block: {
            cashier: { user: { id: CASHIER_ID, status: AccountStatus.ACTIVE } }
          },
          closureJob: null
        })
      },
      adminAuditEvent: {
        findFirst: async () => ({ id: "evidence-access-audit" })
      }
    };
    const assignments = {
      runSerializable: async <T>(
        operation: (client: typeof tx) => Promise<T>
      ) => operation(tx)
    } as unknown as AssignmentsService;
    const service = new AdminReportsService(
      {} as PrismaService,
      assignments,
      {} as ObjectStorageService,
      {} as PasswordService,
      {} as ReportClosureWorker
    );

    await rejects(
      () =>
        service.close(ADMIN_ID, REPORT_ID, {
          outcome: ReportOutcome.CASHIER_SUSPENDED,
          resolutionSummary: "El reporte requiere una suspensión administrativa."
        }),
      /Suspende al cajero antes/
    );
  });

  it("no permite borrar la evidencia sin una revisión auditada", async () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    const tx = {
      $queryRaw: async () => [],
      report: {
        findUnique: async () => ({
          id: REPORT_ID,
          status: ReportStatus.IN_REVIEW,
          reviewedByAdminUserId: ADMIN_ID,
          outcome: null,
          resolutionSummary: null,
          reviewStartedAt: now,
          closeRequestedAt: null,
          closedAt: null,
          evidencePurgedAt: null,
          subjectNotifiedAt: null,
          evidence: {
            objectKey: "investigations/evidence-4",
            uploadAuthorizedUntil: now
          },
          block: {
            cashier: { user: { id: CASHIER_ID, status: AccountStatus.ACTIVE } }
          },
          closureJob: null
        })
      },
      adminAuditEvent: {
        findFirst: async () => null
      }
    };
    const assignments = {
      runSerializable: async <T>(
        operation: (client: typeof tx) => Promise<T>
      ) => operation(tx)
    } as unknown as AssignmentsService;
    const service = new AdminReportsService(
      {} as PrismaService,
      assignments,
      {} as ObjectStorageService,
      {} as PasswordService,
      {} as ReportClosureWorker
    );

    await rejects(
      () =>
        service.close(ADMIN_ID, REPORT_ID, {
          outcome: ReportOutcome.NO_ACTION,
          resolutionSummary: "No se requieren medidas después de la revisión."
        }),
      /Revisa la evidencia cifrada antes/
    );
  });
});
