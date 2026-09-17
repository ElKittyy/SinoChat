import {
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { randomInt, randomUUID } from "node:crypto";
import { Prisma } from "../generated/prisma/client";
import {
  AccountStatus,
  AdminAuditAction,
  AdminAuditTargetType,
  AssignmentEndReason,
  AssignmentStartReason,
  CashierApprovalStatus,
  ConversationStatus,
  NotificationType,
  ReassignmentReason,
  ReassignmentStatus,
  SubscriptionStatus,
  UserRole
} from "../generated/prisma/enums";
import { PrismaService } from "../database/prisma.service";
import { MatrixDeviceListPublisher } from "../database/matrix-device-list.publisher";
import {
  selectLeastLoadedCashier,
  type CashierLoad
} from "./cashier-selection";

export interface ReassignmentOutcome {
  status: "REASSIGNED" | "PENDING_REASSIGNMENT";
  requestId: string;
  clientUserId: string;
  previousCashierUserId: string;
  cashierUserId?: string;
  assignmentId?: string;
}

export interface SubscriptionExpiryReconciliation {
  subscriptionId: string;
  cashierUserId: string;
  assignmentsProcessed: number;
  reassigned: number;
  pending: number;
  subscriptionExpired: boolean;
  hasMore: boolean;
}

export interface PendingReassignmentReconciliation {
  requestsProcessed: number;
  reassigned: number;
  stillPending: number;
  hasMore: boolean;
}

interface BeginReassignmentInput {
  assignment: {
    id: string;
    clientUserId: string;
    cashierUserId: string;
  };
  reason: ReassignmentReason;
  assignmentEndReason: AssignmentEndReason;
  adminUserId?: string;
  reasonCode?: string;
  triggerBlockId?: string;
}

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deviceLists?: MatrixDeviceListPublisher
  ) {}

  async runSerializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 30_000
        });
      } catch (error: unknown) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034";

        if (!retryable || attempt === maxAttempts) {
          throw error;
        }
      }
    }

    throw new Error("No se pudo completar la transacción serializable.");
  }

  async assertDatabaseClockAvailable(): Promise<void> {
    await this.getDatabaseNow(this.prisma);
  }

  async reconcileNextExpiredSubscription(
    assignmentBatchSize = 25
  ): Promise<SubscriptionExpiryReconciliation | null> {
    if (
      !Number.isSafeInteger(assignmentBatchSize) ||
      assignmentBatchSize < 1 ||
      assignmentBatchSize > 100
    ) {
      throw new Error("El lote de vencimientos debe estar entre 1 y 100.");
    }

    return this.runSerializable(async (tx) => {
      const subscriptions = await tx.$queryRaw<
        Array<{
          id: string;
          cashierUserId: string;
        }>
      >(Prisma.sql`
        WITH "current_clock" AS MATERIALIZED (
          SELECT clock_timestamp() AS "now"
        )
        SELECT
          cs."id",
          cs."cashier_user_id" AS "cashierUserId"
          FROM "cashier_subscriptions" cs
          CROSS JOIN "current_clock"
         WHERE cs."status" = 'ACTIVE'
           AND cs."ends_at" IS NOT NULL
           AND cs."ends_at" <= "current_clock"."now"
         -- updated_at funciona como cursor durable de ultimo servicio.
         -- Cada tanda mueve su suscripcion al final del round-robin.
         ORDER BY cs."updated_at" ASC, cs."ends_at" ASC, cs."id" ASC
         LIMIT 1
         FOR UPDATE OF cs SKIP LOCKED
      `);
      const subscription = subscriptions[0];
      if (!subscription) {
        return null;
      }

      await tx.$queryRaw(
        Prisma.sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              'sinochat:subscription-expiry:' || ${subscription.cashierUserId}::text,
              0
            )
          )
        `
      );
      const assignments = await tx.$queryRaw<
        Array<{
          id: string;
          clientUserId: string;
          cashierUserId: string;
        }>
      >(Prisma.sql`
        SELECT
          a."id",
          a."client_user_id" AS "clientUserId",
          a."cashier_user_id" AS "cashierUserId"
          FROM "assignments" a
         WHERE a."cashier_user_id" = ${subscription.cashierUserId}::uuid
           AND a."ended_at" IS NULL
         ORDER BY a."started_at" ASC, a."id" ASC
         LIMIT ${assignmentBatchSize}
         FOR UPDATE OF a SKIP LOCKED
      `);
      const now = await this.getDatabaseNow(tx);
      const outcomes: ReassignmentOutcome[] = [];
      for (const assignment of assignments) {
        outcomes.push(
          await this.beginReassignment(
            tx,
            {
              assignment,
              reason: ReassignmentReason.CASHIER_UNAVAILABLE,
              assignmentEndReason:
                AssignmentEndReason.CASHIER_UNAVAILABLE,
              reasonCode: "SUBSCRIPTION_EXPIRED"
            },
            now
          )
        );
      }

      const remaining = await tx.assignment.count({
        where: {
          cashierUserId: subscription.cashierUserId,
          endedAt: null
        }
      });
      const turnCompletedAt = await this.getDatabaseNow(tx);
      let subscriptionExpired = false;
      if (remaining === 0) {
        const expired = await tx.cashierSubscription.updateMany({
          where: {
            id: subscription.id,
            status: SubscriptionStatus.ACTIVE,
            endsAt: { lte: turnCompletedAt }
          },
          data: {
            status: SubscriptionStatus.EXPIRED
          }
        });
        if (expired.count !== 1) {
          throw new Error("El vencimiento cambio durante la conciliacion.");
        }
        subscriptionExpired = true;
      } else {
        const rotated = await tx.cashierSubscription.updateMany({
          where: {
            id: subscription.id,
            status: SubscriptionStatus.ACTIVE,
            endsAt: { lte: turnCompletedAt }
          },
          data: { updatedAt: turnCompletedAt }
        });
        if (rotated.count !== 1) {
          throw new Error(
            "El turno de conciliacion cambio durante la tanda."
          );
        }
      }

      return {
        subscriptionId: subscription.id,
        cashierUserId: subscription.cashierUserId,
        assignmentsProcessed: outcomes.length,
        reassigned: outcomes.filter(
          (outcome) => outcome.status === "REASSIGNED"
        ).length,
        pending: outcomes.filter(
          (outcome) => outcome.status === "PENDING_REASSIGNMENT"
        ).length,
        subscriptionExpired,
        hasMore: remaining > 0
      };
    });
  }

  async reconcilePendingReassignments(
    requestBatchSize = 50
  ): Promise<PendingReassignmentReconciliation> {
    if (
      !Number.isSafeInteger(requestBatchSize) ||
      requestBatchSize < 1 ||
      requestBatchSize > 100
    ) {
      throw new Error("El lote de pendientes debe estar entre 1 y 100.");
    }

    return this.runSerializable(async (tx) => {
      const requests = await tx.$queryRaw<
        Array<{
          id: string;
          clientUserId: string;
          previousAssignmentId: string;
          excludedCashierUserId: string;
          reason: ReassignmentReason;
          status: ReassignmentStatus;
          attemptCount: number;
        }>
      >(Prisma.sql`
        WITH "current_clock" AS MATERIALIZED (
          SELECT clock_timestamp() AS "now"
        )
        SELECT
          rr."id",
          rr."client_user_id" AS "clientUserId",
          rr."previous_assignment_id" AS "previousAssignmentId",
          rr."excluded_cashier_user_id" AS "excludedCashierUserId",
          rr."reason",
          rr."status",
          rr."attempt_count" AS "attemptCount"
          FROM "reassignment_requests" rr
          JOIN "users" client_user
            ON client_user."id" = rr."client_user_id"
          CROSS JOIN "current_clock"
         WHERE rr."status" = 'PENDING'
           AND client_user."role" = 'CLIENT'
           AND client_user."status" = 'ACTIVE'
           AND (
             rr."last_attempt_at" IS NULL
             OR rr."last_attempt_at" <= "current_clock"."now" -
               make_interval(
                 secs => LEAST(
                   300,
                   (5 * power(2, LEAST(rr."attempt_count", 6)))::integer
                 )
               )
         )
         ORDER BY rr."requested_at" ASC, rr."id" ASC
         LIMIT ${requestBatchSize}
         FOR UPDATE OF rr SKIP LOCKED
      `);
      if (requests.length === 0) {
        return {
          requestsProcessed: 0,
          reassigned: 0,
          stillPending: 0,
          hasMore: false
        };
      }

      const now = await this.getDatabaseNow(tx);
      const outcomes: ReassignmentOutcome[] = [];
      for (const request of requests) {
        outcomes.push(
          await this.completePending(
            tx,
            request,
            undefined,
            undefined,
            false,
            now
          )
        );
      }

      const reassigned = outcomes.filter(
        (outcome) => outcome.status === "REASSIGNED"
      ).length;
      return {
        requestsProcessed: outcomes.length,
        reassigned,
        stillPending: outcomes.length - reassigned,
        hasMore: requests.length === requestBatchSize
      };
    });
  }

  async reassignAdministrative(
    adminUserId: string,
    clientUserId: string,
    reasonCode: string
  ): Promise<ReassignmentOutcome> {
    return this.runSerializable(async (tx) => {
      const client = await tx.user.findFirst({
        where: {
          id: clientUserId,
          role: UserRole.CLIENT,
          status: AccountStatus.ACTIVE
        },
        select: { id: true }
      });

      if (!client) {
        throw new NotFoundException("El cliente activo no existe.");
      }

      const pending = await tx.reassignmentRequest.findFirst({
        where: {
          clientUserId,
          status: ReassignmentStatus.PENDING
        },
        orderBy: { requestedAt: "asc" }
      });

      if (pending) {
        return this.completePending(
          tx,
          pending,
          adminUserId,
          reasonCode,
          true
        );
      }

      const assignment = await tx.assignment.findFirst({
        where: {
          clientUserId,
          endedAt: null
        },
        select: {
          id: true,
          clientUserId: true,
          cashierUserId: true
        }
      });

      if (!assignment) {
        throw new ConflictException(
          "El cliente no tiene una asignación activa ni una reasignación pendiente."
        );
      }

      return this.beginReassignment(tx, {
        assignment,
        reason: ReassignmentReason.ADMINISTRATIVE,
        assignmentEndReason: AssignmentEndReason.ADMINISTRATIVE,
        adminUserId,
        reasonCode
      });
    });
  }

  async reassignAssignmentAdministrative(
    adminUserId: string,
    assignmentId: string,
    reasonCode: string
  ): Promise<ReassignmentOutcome> {
    return this.runSerializable(async (tx) => {
      const assignment = await tx.assignment.findFirst({
        where: {
          id: assignmentId,
          endedAt: null,
          client: {
            user: {
              status: AccountStatus.ACTIVE
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
        throw new NotFoundException("La asignación activa no existe.");
      }

      return this.beginReassignment(tx, {
        assignment,
        reason: ReassignmentReason.ADMINISTRATIVE,
        assignmentEndReason: AssignmentEndReason.ADMINISTRATIVE,
        adminUserId,
        reasonCode
      });
    });
  }

  async reassignCashierClientsInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      cashierUserId: string;
      adminUserId: string;
      reasonCode: string;
      assignmentEndReason:
        | typeof AssignmentEndReason.CASHIER_SUSPENDED
        | typeof AssignmentEndReason.CASHIER_UNAVAILABLE
        | typeof AssignmentEndReason.ACCOUNT_DELETED;
    }
  ): Promise<ReassignmentOutcome[]> {
    const now = await this.getDatabaseNow(tx);
    const assignments = await tx.assignment.findMany({
      where: {
        cashierUserId: input.cashierUserId,
        endedAt: null
      },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        clientUserId: true,
        cashierUserId: true
      }
    });

    const outcomes: ReassignmentOutcome[] = [];
    for (const assignment of assignments) {
      outcomes.push(
        await this.beginReassignment(
          tx,
          {
            assignment,
            reason: ReassignmentReason.CASHIER_UNAVAILABLE,
            assignmentEndReason: input.assignmentEndReason,
            adminUserId: input.adminUserId,
            reasonCode: input.reasonCode
          },
          now
        )
      );
    }

    return outcomes;
  }

  async endClientRelationshipsForDeletionInTransaction(
    tx: Prisma.TransactionClient,
    clientUserId: string,
    now = new Date()
  ): Promise<{
    assignmentsClosed: number;
    conversationsClosed: number;
    pendingReassignmentsCancelled: number;
  }> {
    const activeAssignments = await tx.assignment.findMany({
      where: {
        clientUserId,
        endedAt: null
      },
      select: { id: true, cashierUserId: true }
    });
    const assignmentIds = activeAssignments.map(
      (assignment) => assignment.id
    );
    let conversationsClosed = 0;
    let assignmentsClosed = 0;

    if (assignmentIds.length > 0) {
      const conversations = await tx.conversation.updateMany({
        where: {
          assignmentId: { in: assignmentIds },
          status: ConversationStatus.ACTIVE
        },
        data: {
          status: ConversationStatus.CLOSED,
          closedAt: now
        }
      });
      conversationsClosed = conversations.count;

      const assignments = await tx.assignment.updateMany({
        where: {
          id: { in: assignmentIds },
          endedAt: null
        },
        data: {
          endedAt: now,
          endReason: AssignmentEndReason.ACCOUNT_DELETED
        }
      });
      assignmentsClosed = assignments.count;
      for (const assignment of activeAssignments) {
        await this.deviceLists?.publishRelationshipChanged(
          tx,
          clientUserId,
          assignment.cashierUserId,
          "LEFT",
          now
        );
      }
    }

    const pendingReassignments = await tx.reassignmentRequest.updateMany({
      where: {
        clientUserId,
        status: ReassignmentStatus.PENDING
      },
      data: {
        status: ReassignmentStatus.CANCELLED,
        completedAt: now,
        cancellationReasonCode: "ACCOUNT_DELETED"
      }
    });

    return {
      assignmentsClosed,
      conversationsClosed,
      pendingReassignmentsCancelled: pendingReassignments.count
    };
  }

  async reassignAfterModerationInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      assignment: {
        id: string;
        clientUserId: string;
        cashierUserId: string;
      };
      reason:
        | typeof ReassignmentReason.CLIENT_REPORTED_CASHIER
        | typeof ReassignmentReason.CASHIER_BLOCKED_CLIENT;
      assignmentEndReason:
        | typeof AssignmentEndReason.CLIENT_REPORTED_CASHIER
        | typeof AssignmentEndReason.CASHIER_BLOCKED_CLIENT;
      triggerBlockId: string;
    }
  ): Promise<ReassignmentOutcome> {
    return this.beginReassignment(tx, input);
  }

  async retryPendingInTransaction(
    tx: Prisma.TransactionClient,
    adminUserId: string,
    reasonCode: string,
    limit = 100
  ): Promise<ReassignmentOutcome[]> {
    const now = await this.getDatabaseNow(tx);
    const requests = await tx.reassignmentRequest.findMany({
      where: {
        status: ReassignmentStatus.PENDING,
        client: {
          user: {
            status: AccountStatus.ACTIVE
          }
        }
      },
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
      take: limit
    });

    const outcomes: ReassignmentOutcome[] = [];
    for (const request of requests) {
      outcomes.push(
        await this.completePending(
          tx,
          request,
          adminUserId,
          reasonCode,
          false,
          now
        )
      );
    }
    return outcomes;
  }

  async retryClientPendingInTransaction(
    tx: Prisma.TransactionClient,
    clientUserId: string,
    adminUserId: string,
    reasonCode: string
  ): Promise<ReassignmentOutcome | null> {
    const now = await this.getDatabaseNow(tx);
    const request = await tx.reassignmentRequest.findFirst({
      where: {
        clientUserId,
        status: ReassignmentStatus.PENDING
      },
      orderBy: { requestedAt: "asc" }
    });

    return request
      ? this.completePending(
          tx,
          request,
          adminUserId,
          reasonCode,
          false,
          now
        )
      : null;
  }

  private async beginReassignment(
    tx: Prisma.TransactionClient,
    input: BeginReassignmentInput,
    databaseNow?: Date
  ): Promise<ReassignmentOutcome> {
    const now = databaseNow ?? (await this.getDatabaseNow(tx));

    await tx.assignment.update({
      where: { id: input.assignment.id },
      data: {
        endedAt: now,
        endReason: input.assignmentEndReason
      }
    });
    await tx.conversation.update({
      where: { assignmentId: input.assignment.id },
      data: {
        status: ConversationStatus.CLOSED,
        closedAt: now
      }
    });
    await this.deviceLists?.publishRelationshipChanged(
      tx,
      input.assignment.clientUserId,
      input.assignment.cashierUserId,
      "LEFT",
      now
    );

    const request = await tx.reassignmentRequest.create({
      data: {
        clientUserId: input.assignment.clientUserId,
        previousAssignmentId: input.assignment.id,
        excludedCashierUserId: input.assignment.cashierUserId,
        triggerBlockId: input.triggerBlockId,
        reason: input.reason,
        status: ReassignmentStatus.PENDING,
        attemptCount: 0,
        requestedAt: now
      }
    });

    return this.completePending(
      tx,
      request,
      input.adminUserId,
      input.reasonCode,
      true,
      now
    );
  }

  private async completePending(
    tx: Prisma.TransactionClient,
    request: {
      id: string;
      clientUserId: string;
      previousAssignmentId: string;
      excludedCashierUserId: string;
      reason: ReassignmentReason;
      status: ReassignmentStatus;
      attemptCount: number;
    },
    adminUserId: string | undefined,
    reasonCode: string | undefined,
    auditPending: boolean,
    databaseNow?: Date
  ): Promise<ReassignmentOutcome> {
    const now = databaseNow ?? (await this.getDatabaseNow(tx));
    const clientIsActive = await tx.user.findFirst({
      where: {
        id: request.clientUserId,
        role: UserRole.CLIENT,
        status: AccountStatus.ACTIVE
      },
      select: { id: true }
    });

    if (!clientIsActive) {
      return {
        status: "PENDING_REASSIGNMENT",
        requestId: request.id,
        clientUserId: request.clientUserId,
        previousCashierUserId: request.excludedCashierUserId
      };
    }

    const candidates = await this.findEligibleCandidates(
      tx,
      request.clientUserId,
      request.excludedCashierUserId,
      now
    );
    const candidate = selectLeastLoadedCashier(candidates, randomInt);

    if (!candidate) {
      await tx.reassignmentRequest.update({
        where: { id: request.id },
        data: {
          lastAttemptAt: now,
          attemptCount: { increment: 1 }
        }
      });

      if (auditPending && adminUserId && reasonCode) {
        await this.auditReassignment(tx, {
          adminUserId,
          clientUserId: request.clientUserId,
          targetAssignmentId: request.previousAssignmentId,
          previousCashierUserId: request.excludedCashierUserId,
          nextState: "PENDING_REASSIGNMENT",
          reasonCode
        });
      }

      return {
        status: "PENDING_REASSIGNMENT",
        requestId: request.id,
        clientUserId: request.clientUserId,
        previousCashierUserId: request.excludedCashierUserId
      };
    }

    const assignment = await tx.assignment.create({
      data: {
        clientUserId: request.clientUserId,
        cashierUserId: candidate.userId,
        previousAssignmentId: request.previousAssignmentId,
        ...(adminUserId ? { createdByAdminUserId: adminUserId } : {}),
        startReason: this.startReason(request.reason),
        startedAt: now,
        conversation: {
          create: { createdAt: now }
        }
      },
      select: {
        id: true,
        cashierUserId: true
      }
    });
    await this.deviceLists?.publishRelationshipChanged(
      tx,
      request.clientUserId,
      assignment.cashierUserId,
      "CHANGED",
      now
    );

    await tx.reassignmentRequest.update({
      where: { id: request.id },
      data: {
        status: ReassignmentStatus.COMPLETED,
        resultingAssignmentId: assignment.id,
        lastAttemptAt: now,
        attemptCount: { increment: 1 },
        completedAt: now
      }
    });
    await tx.inAppNotification.create({
      data: {
        userId: request.clientUserId,
        type: NotificationType.ASSIGNMENT_CHANGED,
        relatedEntityId: assignment.id
      }
    });
    if (adminUserId && reasonCode) {
      await this.auditReassignment(tx, {
        adminUserId,
        clientUserId: request.clientUserId,
        targetAssignmentId: assignment.id,
        previousCashierUserId: request.excludedCashierUserId,
        nextState: assignment.cashierUserId,
        reasonCode
      });
    }

    return {
      status: "REASSIGNED",
      requestId: request.id,
      clientUserId: request.clientUserId,
      previousCashierUserId: request.excludedCashierUserId,
      cashierUserId: assignment.cashierUserId,
      assignmentId: assignment.id
    };
  }

  private async findEligibleCandidates(
    tx: Prisma.TransactionClient,
    clientUserId: string,
    excludedCashierUserId: string,
    now: Date
  ): Promise<CashierLoad[]> {
    const candidates = await tx.cashierProfile.findMany({
      where: {
        userId: { not: excludedCashierUserId },
        approvalStatus: CashierApprovalStatus.APPROVED,
        emailVerifiedAt: { not: null },
        phoneVerifiedAt: { not: null },
        user: {
          status: AccountStatus.ACTIVE,
          passwordResetRequired: false
        },
        subscriptions: {
          some: {
            status: SubscriptionStatus.ACTIVE,
            startsAt: { lte: now },
            OR: [{ endsAt: null }, { endsAt: { gt: now } }]
          }
        },
        blocks: {
          none: {
            clientUserId
          }
        }
      },
      select: {
        userId: true,
        _count: {
          select: {
            assignments: {
              where: { endedAt: null }
            }
          }
        }
      }
    });

    return candidates.map((candidate) => ({
      userId: candidate.userId,
      activeClientCount: candidate._count.assignments
    }));
  }

  private async getDatabaseNow(
    client: PrismaService | Prisma.TransactionClient
  ): Promise<Date> {
    const rows = await client.$queryRaw<Array<{ now: Date }>>(
      Prisma.sql`SELECT clock_timestamp() AS "now"`
    );
    const now = rows[0]?.now;
    if (!(now instanceof Date)) {
      throw new Error("No se pudo consultar el reloj de PostgreSQL.");
    }
    return now;
  }

  private startReason(reason: ReassignmentReason): AssignmentStartReason {
    switch (reason) {
      case ReassignmentReason.CLIENT_BLOCKED_CASHIER:
        return AssignmentStartReason.CLIENT_BLOCKED_CASHIER;
      case ReassignmentReason.CLIENT_REPORTED_CASHIER:
        return AssignmentStartReason.CLIENT_REPORTED_CASHIER;
      case ReassignmentReason.CASHIER_BLOCKED_CLIENT:
        return AssignmentStartReason.CASHIER_BLOCKED_CLIENT;
      case ReassignmentReason.CASHIER_UNAVAILABLE:
        return AssignmentStartReason.CASHIER_UNAVAILABLE;
      case ReassignmentReason.ADMINISTRATIVE:
        return AssignmentStartReason.ADMINISTRATIVE;
    }
  }

  private async auditReassignment(
    tx: Prisma.TransactionClient,
    input: {
      adminUserId: string;
      clientUserId: string;
      targetAssignmentId: string;
      previousCashierUserId: string;
      nextState: string;
      reasonCode: string;
    }
  ): Promise<void> {
    await tx.adminAuditEvent.create({
      data: {
        actorAdminId: input.adminUserId,
        action: AdminAuditAction.CLIENT_REASSIGNED,
        targetType: AdminAuditTargetType.ASSIGNMENT,
        targetId: input.targetAssignmentId,
        targetUserId: input.clientUserId,
        reasonCode: input.reasonCode,
        stateBefore: input.previousCashierUserId,
        stateAfter: input.nextState,
        requestId: randomUUID()
      }
    });
  }
}
