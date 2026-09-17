import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AssignmentsService } from "../assignments/assignments.service";
import { PasswordService } from "../auth/password.service";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import {
  AccountStatus,
  AdminAuditAction,
  AdminAuditTargetType,
  ReportOutcome,
  ReportStatus,
  UserRole
} from "../generated/prisma/enums";
import { ObjectStorageService } from "../storage/object-storage.service";
import type { AdminReportsQueryDto } from "./dto/admin-reports-query.dto";
import type {
  CloseReportDto,
  EvidenceAccessDto
} from "./dto/moderation-action.dto";
import {
  ReportClosureWorker,
  type ReportClosureState
} from "./report-closure.worker";

@Injectable()
export class AdminReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assignments: AssignmentsService,
    private readonly storage: ObjectStorageService,
    private readonly passwords: PasswordService,
    private readonly closureWorker: ReportClosureWorker
  ) {}

  async list(query: AdminReportsQueryDto) {
    const where: Prisma.ReportWhereInput = query.status
      ? { status: query.status }
      : {};
    const pendingWhere: Prisma.ReportWhereInput = {
      status: {
        in: [
          ReportStatus.OPEN,
          ReportStatus.IN_REVIEW,
          ReportStatus.CLOSING
        ]
      }
    };
    const skip = (query.page - 1) * query.pageSize;
    const [total, pendingTotal, reports] = await this.prisma.$transaction(
      async (tx) =>
        Promise.all([
          tx.report.count({ where }),
          tx.report.count({ where: pendingWhere }),
          tx.report.findMany({
            where,
            skip,
            take: query.pageSize,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: {
              id: true,
              status: true,
              outcome: true,
              resolutionSummary: true,
              createdAt: true,
              reviewStartedAt: true,
              closeRequestedAt: true,
              closedAt: true,
              evidencePurgedAt: true,
              subjectNotifiedAt: true,
              reviewedBy: {
                select: {
                  id: true,
                  username: true
                }
              },
              block: {
                select: {
                  id: true,
                  assignmentId: true,
                  reason: true,
                  createdAt: true,
                  client: {
                    select: {
                      user: {
                        select: {
                          id: true,
                          username: true,
                          status: true
                        }
                      }
                    }
                  },
                  cashier: {
                    select: {
                      user: {
                        select: {
                          id: true,
                          username: true,
                          status: true
                        }
                      }
                    }
                  }
                }
              },
              closureJob: {
                select: {
                  attempts: true,
                  nextAttemptAt: true,
                  lastAttemptAt: true,
                  lastErrorCode: true
                }
              }
            }
          })
        ]),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 5_000,
        timeout: 15_000
      }
    );

    return {
      items: reports,
      pendingTotal,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize)
      }
    };
  }

  async beginReview(adminUserId: string, reportId: string) {
    return this.assignments.runSerializable(async (tx) => {
      await this.lockReport(tx, reportId);
      const report = await tx.report.findUnique({
        where: { id: reportId },
        select: {
          id: true,
          status: true,
          reviewedByAdminUserId: true,
          reviewStartedAt: true,
          block: {
            select: { cashierUserId: true }
          }
        }
      });
      if (!report) {
        throw new NotFoundException("El reporte no existe.");
      }
      if (
        report.status === ReportStatus.IN_REVIEW &&
        report.reviewedByAdminUserId === adminUserId
      ) {
        return {
          id: report.id,
          status: report.status,
          reviewedByAdminUserId: report.reviewedByAdminUserId,
          reviewStartedAt: report.reviewStartedAt
        };
      }
      if (report.status !== ReportStatus.OPEN) {
        throw new ConflictException(
          "El reporte ya está asignado o inició su cierre."
        );
      }

      const now = await this.databaseNow(tx);
      const updated = await tx.report.update({
        where: { id: reportId },
        data: {
          status: ReportStatus.IN_REVIEW,
          reviewedByAdminUserId: adminUserId,
          reviewStartedAt: now
        },
        select: {
          id: true,
          status: true,
          reviewedByAdminUserId: true,
          reviewStartedAt: true
        }
      });
      await this.audit(tx, {
        actorAdminId: adminUserId,
        action: AdminAuditAction.REPORT_REVIEW_STARTED,
        reportId,
        targetUserId: report.block.cashierUserId,
        reasonCode: "REPORT_REVIEW_STARTED",
        stateBefore: ReportStatus.OPEN,
        stateAfter: ReportStatus.IN_REVIEW
      });
      return updated;
    });
  }

  async evidenceDownload(
    adminUserId: string,
    reportId: string,
    input: EvidenceAccessDto
  ) {
    const accessReason = input.reason.trim();
    const admin = await this.prisma.user.findFirst({
      where: {
        id: adminUserId,
        role: UserRole.ADMIN,
        status: AccountStatus.ACTIVE
      },
      select: { passwordHash: true }
    });
    const passwordValid = admin
      ? await this.passwords.verify(
          admin.passwordHash,
          input.currentPassword
        )
      : false;
    if (!admin) {
      await this.passwords.verifyAgainstDummy(input.currentPassword);
    }
    if (!passwordValid) {
      throw new UnauthorizedException(
        "La contraseña actual no es válida."
      );
    }

    return this.assignments.runSerializable(async (tx) => {
      await this.lockReport(tx, reportId);
      const report = await tx.report.findUnique({
        where: { id: reportId },
        select: {
          id: true,
          status: true,
          reviewedByAdminUserId: true,
          evidence: {
            select: {
              objectKey: true,
              ciphertextByteSize: true,
              ciphertextSha256: true,
              cipherSuite: true,
              manifestVersion: true,
              investigationKey: {
                select: {
                  id: true,
                  version: true,
                  algorithm: true,
                  publicKey: true,
                  fingerprint: true
                }
              }
            }
          },
          block: {
            select: { cashierUserId: true }
          }
        }
      });
      if (!report) {
        throw new NotFoundException("El reporte no existe.");
      }
      if (
        report.status !== ReportStatus.IN_REVIEW ||
        report.reviewedByAdminUserId !== adminUserId
      ) {
        throw new ForbiddenException(
          "Solo el administrador asignado puede abrir la evidencia durante la revisión."
        );
      }
      if (!report.evidence) {
        throw new ConflictException(
          "La evidencia cifrada ya no está disponible."
        );
      }

      const result = {
        reportId: report.id,
        downloadUrl: await this.storage.presignDownload(
          report.evidence.objectKey,
          60
        ),
        downloadExpiresInSeconds: 60,
        ciphertextByteSize:
          report.evidence.ciphertextByteSize.toString(),
        ciphertextSha256: report.evidence.ciphertextSha256,
        cipherSuite: report.evidence.cipherSuite,
        manifestVersion: report.evidence.manifestVersion,
        investigationKey: {
          id: report.evidence.investigationKey.id,
          version: report.evidence.investigationKey.version,
          algorithm: report.evidence.investigationKey.algorithm,
          publicKey: Buffer.from(
            report.evidence.investigationKey.publicKey
          ).toString("base64"),
          fingerprint:
            report.evidence.investigationKey.fingerprint
        },
        privateKeyLocation: "EXTERNAL_ADMIN_CUSTODY"
      };
      await this.audit(tx, {
        actorAdminId: adminUserId,
        action: AdminAuditAction.REPORT_EVIDENCE_ACCESSED,
        reportId,
        targetUserId: report.block.cashierUserId,
        reasonCode: accessReason,
        stateBefore: ReportStatus.IN_REVIEW,
        stateAfter: ReportStatus.IN_REVIEW
      });
      return result;
    });
  }

  async close(
    adminUserId: string,
    reportId: string,
    input: CloseReportDto
  ): Promise<ReportClosureState> {
    const resolutionSummary = input.resolutionSummary.trim();
    const intent = await this.assignments.runSerializable(async (tx) => {
      await this.lockReport(tx, reportId);
      const report = await tx.report.findUnique({
        where: { id: reportId },
        select: {
          id: true,
          status: true,
          reviewedByAdminUserId: true,
          outcome: true,
          resolutionSummary: true,
          reviewStartedAt: true,
          closeRequestedAt: true,
          closedAt: true,
          evidencePurgedAt: true,
          subjectNotifiedAt: true,
          evidence: {
            select: {
              objectKey: true,
              uploadAuthorizedUntil: true
            }
          },
          block: {
            select: {
              cashier: {
                select: {
                  user: {
                    select: { id: true, status: true }
                  }
                }
              }
            }
          },
          closureJob: {
            select: { reportId: true }
          }
        }
      });
      if (!report) {
        throw new NotFoundException("El reporte no existe.");
      }
      if (report.status === ReportStatus.OPEN) {
        throw new ConflictException(
          "El reporte debe estar en revisión antes de cerrarse."
        );
      }
      this.assertAssigned(report, adminUserId);

      if (report.status === ReportStatus.CLOSED) {
        this.assertSameClosure(report, input.outcome, resolutionSummary);
        return this.closureState(report);
      }
      if (report.status === ReportStatus.CLOSING) {
        this.assertSameClosure(report, input.outcome, resolutionSummary);
        if (!report.closureJob) {
          throw new ConflictException(
            "El cierre persistente no está disponible; requiere intervención operativa."
          );
        }
        return this.closureState(report);
      }
      if (report.status !== ReportStatus.IN_REVIEW) {
        throw new ConflictException(
          "El reporte no admite una solicitud de cierre."
        );
      }
      if (!report.evidence) {
        throw new ConflictException(
          "El reporte no conserva evidencia para eliminar."
        );
      }

      const evidenceAccess = await tx.adminAuditEvent.findFirst({
        where: {
          actorAdminId: adminUserId,
          action: AdminAuditAction.REPORT_EVIDENCE_ACCESSED,
          targetType: AdminAuditTargetType.REPORT,
          targetId: reportId
        },
        select: { id: true }
      });
      if (!evidenceAccess) {
        throw new ConflictException(
          "Revisa la evidencia cifrada antes de cerrar la investigación."
        );
      }

      this.assertOutcomeMatchesCashierState(
        input.outcome,
        report.block.cashier.user.status
      );

      const now = await this.databaseNow(tx);
      const closing = await tx.report.update({
        where: { id: reportId },
        data: {
          status: ReportStatus.CLOSING,
          outcome: input.outcome,
          resolutionSummary,
          closeRequestedAt: now
        },
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
      await tx.reportClosureJob.create({
        data: {
          reportId,
          requestedByAdminUserId: adminUserId,
          evidenceObjectKey: report.evidence.objectKey,
          purgeNotBefore: report.evidence.uploadAuthorizedUntil,
          nextAttemptAt:
            report.evidence.uploadAuthorizedUntil > now
              ? report.evidence.uploadAuthorizedUntil
              : now
        }
      });
      return closing;
    });

    if (intent.status === ReportStatus.CLOSED) {
      return intent;
    }
    try {
      return (await this.closureWorker.processReport(reportId)) ?? intent;
    } catch {
      // The intent and object key are already durable. The mandatory worker
      // resumes the job even if this best-effort immediate attempt fails.
      return intent;
    }
  }

  private assertAssigned(
    report: { reviewedByAdminUserId: string | null },
    adminUserId: string
  ): void {
    if (report.reviewedByAdminUserId !== adminUserId) {
      throw new ForbiddenException(
        "Solo el administrador asignado puede cerrar el reporte."
      );
    }
  }

  private assertSameClosure(
    report: {
      outcome: ReportOutcome | null;
      resolutionSummary: string | null;
    },
    outcome: ReportOutcome,
    resolutionSummary: string
  ): void {
    if (
      report.outcome !== outcome ||
      report.resolutionSummary !== resolutionSummary
    ) {
      throw new ConflictException(
        "El cierre ya fue solicitado con otro resultado o resumen."
      );
    }
  }

  private closureState(report: ReportClosureState): ReportClosureState {
    return {
      id: report.id,
      status: report.status,
      outcome: report.outcome,
      resolutionSummary: report.resolutionSummary,
      reviewStartedAt: report.reviewStartedAt,
      closeRequestedAt: report.closeRequestedAt,
      closedAt: report.closedAt,
      evidencePurgedAt: report.evidencePurgedAt,
      subjectNotifiedAt: report.subjectNotifiedAt
    };
  }

  private assertOutcomeMatchesCashierState(
    outcome: ReportOutcome,
    cashierStatus: AccountStatus
  ): void {
    if (
      outcome === ReportOutcome.CASHIER_SUSPENDED &&
      cashierStatus !== AccountStatus.SUSPENDED
    ) {
      throw new ConflictException(
        "Suspende al cajero antes de cerrar el reporte con ese resultado."
      );
    }
    if (
      outcome === ReportOutcome.CASHIER_DELETED &&
      cashierStatus !== AccountStatus.DELETED
    ) {
      throw new ConflictException(
        "Elimina al cajero antes de cerrar el reporte con ese resultado."
      );
    }
  }

  private async lockReport(
    tx: Prisma.TransactionClient,
    reportId: string
  ): Promise<void> {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "reports" WHERE "id" = CAST(${reportId} AS UUID) FOR UPDATE`
    );
  }

  private async databaseNow(
    tx: Prisma.TransactionClient
  ): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>(
      Prisma.sql`SELECT clock_timestamp() AS "now"`
    );
    const now = rows[0]?.now;
    if (!(now instanceof Date)) {
      throw new Error("DATABASE_CLOCK_UNAVAILABLE");
    }
    return now;
  }

  private async audit(
    tx: Prisma.TransactionClient,
    input: {
      actorAdminId: string;
      action: AdminAuditAction;
      reportId: string;
      targetUserId: string;
      reasonCode: string;
      stateBefore: string;
      stateAfter: string;
    }
  ): Promise<void> {
    await tx.adminAuditEvent.create({
      data: {
        actorAdminId: input.actorAdminId,
        action: input.action,
        targetType: AdminAuditTargetType.REPORT,
        targetId: input.reportId,
        targetUserId: input.targetUserId,
        reasonCode: input.reasonCode,
        stateBefore: input.stateBefore,
        stateAfter: input.stateAfter,
        requestId: randomUUID()
      }
    });
  }
}
