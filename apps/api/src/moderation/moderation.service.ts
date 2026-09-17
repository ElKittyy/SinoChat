import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException
} from "@nestjs/common";
import { AssignmentsService } from "../assignments/assignments.service";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import { PrismaService } from "../database/prisma.service";
import { MatrixDeviceListPublisher } from "../database/matrix-device-list.publisher";
import { Prisma } from "../generated/prisma/client";
import {
  AccountReviewReason,
  AccountReviewStatus,
  AccountStatus,
  AssignmentEndReason,
  BlockInitiator,
  ConversationStatus,
  NotificationType,
  ReassignmentReason,
  UserRole
} from "../generated/prisma/enums";
import { ObjectStorageService } from "../storage/object-storage.service";
import type { RequestEvidenceUploadDto } from "./dto/evidence-upload.dto";
import type {
  ModerationReasonDto,
  ReportCashierDto
} from "./dto/moderation-action.dto";
import {
  EvidenceGrantService,
  type EvidenceUploadGrant
} from "./evidence-grant.service";
import {
  distinctCashierBlockCount,
  isSupportedEvidenceManifestVersion,
  requiresAccountReview
} from "./moderation-policy";

const AUTOMATIC_REVIEW_REASON = "FIVE_DISTINCT_CASHIER_BLOCKS";

@Injectable()
export class ModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assignments: AssignmentsService,
    private readonly storage: ObjectStorageService,
    private readonly evidenceGrants: EvidenceGrantService,
    private readonly eligibility: ConversationEligibilityService,
    private readonly deviceLists?: MatrixDeviceListPublisher
  ) {}

  async activeInvestigationKey() {
    const key = await this.findActiveInvestigationKey();
    return this.publicInvestigationKey(key);
  }

  async requestEvidenceUpload(
    clientUserId: string,
    input: RequestEvidenceUploadDto
  ) {
    if (!isSupportedEvidenceManifestVersion(input.manifestVersion)) {
      throw new BadRequestException(
        "La versión del manifiesto de evidencia no es compatible."
      );
    }

    const now = await this.databaseNow();
    const [assignment, key] = await Promise.all([
      this.prisma.assignment.findFirst({
        where: {
          clientUserId,
          endedAt: null,
          client: {
            user: {
              role: UserRole.CLIENT,
              status: AccountStatus.ACTIVE
            }
          },
          conversation: {
            is: { status: ConversationStatus.ACTIVE }
          }
        },
        select: {
          id: true,
          conversation: {
            select: { id: true }
          }
        }
      }),
      this.prisma.investigationKey.findFirst({
        where: {
          id: input.investigationKeyId,
          activatedAt: { lte: now },
          OR: [{ retiredAt: null }, { retiredAt: { gt: now } }]
        },
        select: {
          id: true,
          version: true,
          algorithm: true,
          publicKey: true,
          fingerprint: true
        }
      })
    ]);

    if (!assignment?.conversation) {
      throw new ConflictException(
        "El cliente no tiene una conversación activa para reportar."
      );
    }
    if (!key) {
      throw new ConflictException(
        "La clave de investigación ya no está activa."
      );
    }

    const existingReservation =
      await this.prisma.pendingReportEvidenceUpload.findFirst({
        where: {
          clientUserId,
          assignmentId: assignment.id
        },
        select: {
          grantExpiresAt: true,
          lastPurgeAttemptAt: true
        }
      });
    if (existingReservation) {
      throw new ConflictException(
        existingReservation.grantExpiresAt > now &&
          !existingReservation.lastPurgeAttemptAt
          ? "Ya existe una carga de evidencia pendiente para este reporte."
          : "La carga anterior se está conciliando; inténtalo nuevamente en unos minutos."
      );
    }

    const { grant, token } = this.evidenceGrants.create(
      clientUserId,
      assignment.id,
      assignment.conversation.id,
      input,
      now
    );
    try {
      await this.prisma.pendingReportEvidenceUpload.create({
        data: {
          id: grant.reservationId,
          clientUserId,
          assignmentId: grant.assignmentId,
          conversationId: grant.conversationId,
          investigationKeyId: grant.investigationKeyId,
          objectKey: grant.objectKey,
          ciphertextByteSize: grant.ciphertextByteSize,
          ciphertextSha256: grant.ciphertextSha256,
          cipherSuite: grant.cipherSuite,
          manifestVersion: grant.manifestVersion,
          grantExpiresAt: new Date(grant.expiresAt)
        }
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          "Ya existe una carga de evidencia pendiente para este reporte."
        );
      }
      throw error;
    }
    const upload = await this.storage.presignUpload(
      grant.objectKey,
      grant.ciphertextByteSize,
      grant.ciphertextSha256,
      now
    );

    return {
      uploadUrl: upload.url,
      uploadHeaders: upload.headers,
      uploadExpiresInSeconds: upload.expiresInSeconds,
      grantToken: token,
      grantExpiresAt: new Date(grant.expiresAt),
      investigationKey: this.publicInvestigationKey(key),
      evidenceContract: {
        manifestVersion: 1,
        contentType: "application/octet-stream",
        encryptionScope: "CURRENT_CONVERSATION",
        privateKeyLocation: "EXTERNAL_ADMIN_CUSTODY"
      }
    };
  }

  async reportCashier(
    clientUserId: string,
    input: ReportCashierDto
  ) {
    const grant = this.evidenceGrants.verify(input.evidenceGrantToken);
    this.evidenceGrants.assertOwnedBy(grant, clientUserId);
    if (!isSupportedEvidenceManifestVersion(grant.manifestVersion)) {
      throw new BadRequestException(
        "La versión del manifiesto de evidencia no es compatible."
      );
    }

    const reservation =
      await this.prisma.pendingReportEvidenceUpload.findFirst({
        where: {
          id: grant.reservationId,
          clientUserId,
          assignmentId: grant.assignmentId,
          conversationId: grant.conversationId,
          investigationKeyId: grant.investigationKeyId,
          objectKey: grant.objectKey,
          ciphertextByteSize: grant.ciphertextByteSize,
          ciphertextSha256: grant.ciphertextSha256,
          cipherSuite: grant.cipherSuite,
          manifestVersion: grant.manifestVersion,
          grantExpiresAt: { gt: await this.databaseNow() },
          lastPurgeAttemptAt: null
        },
        select: { id: true }
      });
    if (!reservation) {
      throw new ConflictException(
        "El permiso de evidencia ya fue utilizado o venció."
      );
    }

    await this.storage.assertUploaded(
      grant.objectKey,
      grant.ciphertextByteSize,
      grant.ciphertextSha256
    );

    try {
      return await this.assignments.runSerializable(async (tx) => {
        const clockRows = await tx.$queryRaw<{ now: Date }[]>`
          SELECT clock_timestamp() AS "now"
        `;
        const transactionNow = clockRows[0]?.now;
        if (!transactionNow) {
          throw new Error("No se pudo consultar el reloj de PostgreSQL.");
        }
        const claimed =
          await tx.pendingReportEvidenceUpload.deleteMany({
            where: {
              id: grant.reservationId,
              clientUserId,
              assignmentId: grant.assignmentId,
              conversationId: grant.conversationId,
              objectKey: grant.objectKey,
              grantExpiresAt: { gt: transactionNow },
              lastPurgeAttemptAt: null
            }
          });
        if (claimed.count !== 1) {
          throw new ConflictException(
            "El permiso de evidencia ya fue utilizado o venció."
          );
        }

        const assignment = await tx.assignment.findFirst({
          where: {
            id: grant.assignmentId,
            clientUserId,
            endedAt: null,
            client: {
              user: {
                role: UserRole.CLIENT,
                status: AccountStatus.ACTIVE
              }
            },
            conversation: {
              is: {
                id: grant.conversationId,
                status: ConversationStatus.ACTIVE
              }
            }
          },
          select: {
            id: true,
            clientUserId: true,
            cashierUserId: true
          }
        });
        if (!assignment) {
          throw new ConflictException(
            "La asignación cambió antes de completar el reporte."
          );
        }

        const investigationKey =
          await tx.investigationKey.findUnique({
            where: { id: grant.investigationKeyId },
            select: { id: true }
          });
        if (!investigationKey) {
          throw new ConflictException(
            "La clave usada para cifrar la evidencia no existe."
          );
        }

        const block = await tx.block.create({
          data: {
            clientUserId,
            cashierUserId: assignment.cashierUserId,
            assignmentId: assignment.id,
            initiatedBy: BlockInitiator.CLIENT,
            reason: input.reason.trim()
          },
          select: { id: true }
        });
        const report = await tx.report.create({
          data: {
            blockId: block.id,
            evidence: {
              create: {
                investigationKeyId: grant.investigationKeyId,
                objectKey: grant.objectKey,
                ciphertextByteSize: BigInt(
                  grant.ciphertextByteSize
                ),
                ciphertextSha256: grant.ciphertextSha256,
                cipherSuite: grant.cipherSuite,
                manifestVersion: grant.manifestVersion,
                uploadAuthorizedUntil: new Date(grant.expiresAt)
              }
            }
          },
          select: {
            id: true,
            status: true,
            createdAt: true
          }
        });
        const reassignment =
          await this.assignments.reassignAfterModerationInTransaction(
            tx,
            {
              assignment,
              reason: ReassignmentReason.CLIENT_REPORTED_CASHIER,
              assignmentEndReason:
                AssignmentEndReason.CLIENT_REPORTED_CASHIER,
              triggerBlockId: block.id
            }
          );

        return {
          report,
          reassignment
        };
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          "Este cliente y cajero ya tienen un bloqueo equivalente."
        );
      }
      throw error;
    }
  }

  async blockClient(
    cashierUserId: string,
    clientUserId: string,
    input: ModerationReasonDto
  ) {
    try {
      return await this.assignments.runSerializable(async (tx) => {
        const access =
          await this.eligibility.lockCurrentByParticipants(
            tx,
            clientUserId,
            cashierUserId
          );
        const assignment = {
          id: access.assignmentId,
          clientUserId: access.clientUserId,
          cashierUserId: access.cashierUserId
        };
        const block = await tx.block.create({
          data: {
            clientUserId,
            cashierUserId,
            assignmentId: assignment.id,
            initiatedBy: BlockInitiator.CASHIER,
            reason: input.reason.trim()
          },
          select: { id: true }
        });
        const cashierBlocks = await tx.block.findMany({
          where: {
            clientUserId,
            initiatedBy: BlockInitiator.CASHIER
          },
          select: { cashierUserId: true }
        });
        const cashierIds = cashierBlocks.map(
          (entry) => entry.cashierUserId
        );
        const distinctBlocks = distinctCashierBlockCount(cashierIds);
        const actionNow =
          await this.eligibility.assertPeriodStillActive(
            tx,
            access.subscriptionEndsAt
          );

        if (requiresAccountReview(cashierIds)) {
          const now = actionNow;
          await tx.assignment.update({
            where: { id: assignment.id },
            data: {
              endedAt: now,
              endReason: AssignmentEndReason.CASHIER_BLOCKED_CLIENT
            }
          });
          await tx.conversation.update({
            where: { assignmentId: assignment.id },
            data: {
              status: ConversationStatus.CLOSED,
              closedAt: now
            }
          });
          await this.deviceLists?.publishRelationshipChanged(
            tx,
            clientUserId,
            cashierUserId,
            "LEFT",
            now
          );
          await tx.user.update({
            where: { id: clientUserId },
            data: {
              status: AccountStatus.SUSPENDED,
              suspendedAt: now,
              suspensionReasonCode: AUTOMATIC_REVIEW_REASON,
              sessionVersion: { increment: 1 }
            }
          });
          await tx.authSession.updateMany({
            where: {
              userId: clientUserId,
              revokedAt: null
            },
            data: {
              revokedAt: now,
              revocationReason: AUTOMATIC_REVIEW_REASON
            }
          });

          const existingReview = await tx.accountReview.findFirst({
            where: {
              clientUserId,
              status: {
                in: [
                  AccountReviewStatus.OPEN,
                  AccountReviewStatus.IN_REVIEW
                ]
              }
            },
            select: { id: true }
          });
          const accountReview =
            existingReview ??
            (await tx.accountReview.create({
              data: {
                clientUserId,
                reason:
                  AccountReviewReason.FIVE_DISTINCT_CASHIER_BLOCKS
              },
              select: { id: true }
            }));

          await tx.inAppNotification.create({
            data: {
              userId: clientUserId,
              type: NotificationType.ACCOUNT_STATUS_CHANGED,
              relatedEntityId: accountReview.id
            }
          });

          await this.eligibility.assertPeriodStillActive(
            tx,
            access.subscriptionEndsAt
          );

          return {
            status: "CLIENT_SUSPENDED_FOR_REVIEW" as const,
            blockId: block.id,
            distinctCashierBlocks: distinctBlocks,
            accountReviewId: accountReview.id
          };
        }

        const reassignment =
          await this.assignments.reassignAfterModerationInTransaction(
            tx,
            {
              assignment,
              reason: ReassignmentReason.CASHIER_BLOCKED_CLIENT,
              assignmentEndReason:
                AssignmentEndReason.CASHIER_BLOCKED_CLIENT,
              triggerBlockId: block.id
            }
          );
        await this.eligibility.assertPeriodStillActive(
          tx,
          access.subscriptionEndsAt
        );
        return {
          status: "CLIENT_BLOCKED" as const,
          blockId: block.id,
          distinctCashierBlocks: distinctBlocks,
          reassignment
        };
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          "Este cajero ya bloqueó anteriormente al cliente."
        );
      }
      throw error;
    }
  }

  private async findActiveInvestigationKey() {
    const now = new Date();
    const key = await this.prisma.investigationKey.findFirst({
      where: {
        activatedAt: { lte: now },
        OR: [{ retiredAt: null }, { retiredAt: { gt: now } }]
      },
      orderBy: [{ version: "desc" }, { activatedAt: "desc" }],
      select: {
        id: true,
        version: true,
        algorithm: true,
        publicKey: true,
        fingerprint: true
      }
    });
    if (!key) {
      throw new ServiceUnavailableException(
        "No existe una clave pública de investigación activa."
      );
    }
    return key;
  }

  private publicInvestigationKey(key: {
    id: string;
    version: number;
    algorithm: string;
    publicKey: Uint8Array;
    fingerprint: string;
  }) {
    return {
      id: key.id,
      version: key.version,
      algorithm: key.algorithm,
      publicKey: Buffer.from(key.publicKey).toString("base64"),
      fingerprint: key.fingerprint
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    );
  }

  private async databaseNow(): Promise<Date> {
    const rows = await this.prisma.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp() AS "now"
    `;
    const now = rows[0]?.now;
    if (!now) {
      throw new Error("No se pudo consultar el reloj de PostgreSQL.");
    }
    return now;
  }
}
