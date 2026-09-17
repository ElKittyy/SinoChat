import { deepEqual, equal } from "node:assert/strict";
import { describe, it } from "node:test";
import { PrismaService } from "../database/prisma.service";
import type { MatrixDeviceListPublisher } from "../database/matrix-device-list.publisher";
import {
  AssignmentStartReason,
  AssignmentEndReason,
  CashierApprovalStatus,
  ConversationStatus,
  ReassignmentReason,
  ReassignmentStatus,
  SubscriptionStatus
} from "../generated/prisma/enums";
import { AssignmentsService } from "./assignments.service";

describe("AssignmentsService", () => {
  it("cierra solo la asignación solicitada y deja PENDING si no hay elegibles", async () => {
    const calls = {
      assignmentUpdates: 0,
      conversationUpdates: 0,
      assignmentCreates: 0,
      auditCreates: 0,
      candidateWhere: undefined as unknown
    };
    const tx = {
      $queryRaw: async () => [
        { now: new Date("2026-07-26T12:00:00.000Z") }
      ],
      user: {
        findFirst: async () => ({ id: "cliente" })
      },
      reassignmentRequest: {
        findFirst: async () => null,
        create: async () => ({
          id: "solicitud",
          clientUserId: "cliente",
          previousAssignmentId: "asignacion-anterior",
          excludedCashierUserId: "cajero-anterior",
          triggerBlockId: null,
          resultingAssignmentId: null,
          reason: ReassignmentReason.ADMINISTRATIVE,
          status: ReassignmentStatus.PENDING,
          requestedAt: new Date(),
          lastAttemptAt: null,
          attemptCount: 0,
          completedAt: null,
          cancellationReasonCode: null
        }),
        update: async () => ({})
      },
      assignment: {
        findFirst: async () => ({
          id: "asignacion-anterior",
          clientUserId: "cliente",
          cashierUserId: "cajero-anterior"
        }),
        update: async () => {
          calls.assignmentUpdates += 1;
          return {};
        },
        create: async () => {
          calls.assignmentCreates += 1;
          return {};
        }
      },
      conversation: {
        update: async () => {
          calls.conversationUpdates += 1;
          return {};
        }
      },
      cashierProfile: {
        findMany: async (query: { where: unknown }) => {
          calls.candidateWhere = query.where;
          return [];
        }
      },
      adminAuditEvent: {
        create: async () => {
          calls.auditCreates += 1;
          return {};
        }
      }
    };
    const prisma = {
      $transaction: async (
        operation: (transaction: typeof tx) => Promise<unknown>
      ) => operation(tx)
    } as unknown as PrismaService;
    const service = new AssignmentsService(prisma);

    const result = await service.reassignAdministrative(
      "administrador",
      "cliente",
      "SOLICITUD_ADMINISTRATIVA"
    );

    equal(result.status, "PENDING_REASSIGNMENT");
    equal(calls.assignmentUpdates, 1);
    equal(calls.conversationUpdates, 1);
    equal(calls.assignmentCreates, 0);
    equal(calls.auditCreates, 1);
    deepEqual(calls.candidateWhere, {
      userId: { not: "cajero-anterior" },
      approvalStatus: CashierApprovalStatus.APPROVED,
      emailVerifiedAt: { not: null },
      phoneVerifiedAt: { not: null },
      user: { status: "ACTIVE", passwordResetRequired: false },
      subscriptions: {
        some: {
          status: SubscriptionStatus.ACTIVE,
          startsAt: { lte: (calls.candidateWhere as any).subscriptions.some.startsAt.lte },
          OR: [{ endsAt: null }, { endsAt: { gt: (calls.candidateWhere as any).subscriptions.some.OR[1].endsAt.gt } }]
        }
      },
      blocks: {
        none: { clientUserId: "cliente" }
      }
    });
  });

  it("publica LEFT y CHANGED en orden al reasignar a un cajero elegible", async () => {
    const now = new Date("2026-08-27T18:00:00.000Z");
    const publications: Array<{
      clientUserId: string;
      cashierUserId: string;
      changeType: string;
      createdAt: Date;
    }> = [];
    const tx = {
      $queryRaw: async () => [{ now }],
      user: {
        findFirst: async () => ({ id: "cliente" })
      },
      reassignmentRequest: {
        findFirst: async () => null,
        create: async ({ data }: any) => ({
          id: "solicitud",
          ...data
        }),
        update: async () => ({})
      },
      assignment: {
        findFirst: async () => ({
          id: "asignacion-anterior",
          clientUserId: "cliente",
          cashierUserId: "cajero-anterior"
        }),
        update: async () => ({}),
        create: async () => ({
          id: "asignacion-nueva",
          cashierUserId: "cajero-nuevo"
        })
      },
      conversation: {
        update: async () => ({})
      },
      cashierProfile: {
        findMany: async () => [
          {
            userId: "cajero-nuevo",
            _count: { assignments: 2 }
          }
        ]
      },
      inAppNotification: {
        create: async () => ({})
      },
      adminAuditEvent: {
        create: async () => ({})
      }
    };
    const prisma = {
      $transaction: async (
        operation: (transaction: typeof tx) => Promise<unknown>
      ) => operation(tx)
    } as unknown as PrismaService;
    const deviceLists = {
      publishRelationshipChanged: async (
        _transaction: unknown,
        clientUserId: string,
        cashierUserId: string,
        changeType: string,
        createdAt: Date
      ) => {
        publications.push({
          clientUserId,
          cashierUserId,
          changeType,
          createdAt
        });
      }
    } as unknown as MatrixDeviceListPublisher;
    const service = new AssignmentsService(prisma, deviceLists);

    const result = await service.reassignAdministrative(
      "administrador",
      "cliente",
      "SOLICITUD_ADMINISTRATIVA"
    );

    equal(result.status, "REASSIGNED");
    equal(result.cashierUserId, "cajero-nuevo");
    deepEqual(publications, [
      {
        clientUserId: "cliente",
        cashierUserId: "cajero-anterior",
        changeType: "LEFT",
        createdAt: now
      },
      {
        clientUserId: "cliente",
        cashierUserId: "cajero-nuevo",
        changeType: "CHANGED",
        createdAt: now
      }
    ]);
  });

  it("mantiene el vencimiento reclamable cuando el lote deja asignaciones", async () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    let rawCall = 0;
    let subscriptionUpdate: any;
    const tx = {
      $queryRaw: async () => {
        rawCall += 1;
        if (rawCall === 1) {
          return [{ id: "suscripcion", cashierUserId: "cajero-vencido" }];
        }
        if (rawCall === 2) {
          return [{ pg_advisory_xact_lock: null }];
        }
        if (rawCall === 3) {
          return [
            {
              id: "asignacion",
              clientUserId: "cliente",
              cashierUserId: "cajero-vencido"
            }
          ];
        }
        return [{ now }];
      },
      assignment: {
        update: async () => ({}),
        count: async () => 1
      },
      conversation: {
        update: async () => ({})
      },
      reassignmentRequest: {
        create: async () => ({
          id: "solicitud",
          clientUserId: "cliente",
          previousAssignmentId: "asignacion",
          excludedCashierUserId: "cajero-vencido",
          reason: ReassignmentReason.CASHIER_UNAVAILABLE,
          status: ReassignmentStatus.PENDING,
          attemptCount: 0
        }),
        update: async () => ({})
      },
      user: {
        findFirst: async () => ({ id: "cliente" })
      },
      cashierProfile: {
        findMany: async () => []
      },
      cashierSubscription: {
        updateMany: async (query: any) => {
          subscriptionUpdate = query;
          return { count: 1 };
        }
      }
    };
    const prisma = {
      $transaction: async (
        operation: (transaction: typeof tx) => Promise<unknown>
      ) => operation(tx)
    } as unknown as PrismaService;
    const service = new AssignmentsService(prisma);

    const result = await service.reconcileNextExpiredSubscription(1);

    equal(result?.assignmentsProcessed, 1);
    equal(result?.pending, 1);
    equal(result?.subscriptionExpired, false);
    equal(result?.hasMore, true);
    equal(subscriptionUpdate.data.updatedAt, now);
    equal(subscriptionUpdate.data.status, undefined);
  });

  it("marca EXPIRED solo cuando ya no queda clientela activa", async () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    let rawCall = 0;
    let updateQuery: any;
    const tx = {
      $queryRaw: async () => {
        rawCall += 1;
        if (rawCall === 1) {
          return [{ id: "suscripcion", cashierUserId: "cajero-vencido" }];
        }
        if (rawCall === 2) {
          return [{ pg_advisory_xact_lock: null }];
        }
        if (rawCall === 3) {
          return [];
        }
        return [{ now }];
      },
      assignment: {
        count: async () => 0
      },
      cashierSubscription: {
        updateMany: async (query: any) => {
          updateQuery = query;
          return { count: 1 };
        }
      }
    };
    const prisma = {
      $transaction: async (
        operation: (transaction: typeof tx) => Promise<unknown>
      ) => operation(tx)
    } as unknown as PrismaService;
    const service = new AssignmentsService(prisma);

    const result = await service.reconcileNextExpiredSubscription();

    equal(result?.subscriptionExpired, true);
    equal(result?.hasMore, false);
    equal(updateQuery.data.status, SubscriptionStatus.EXPIRED);
    equal(updateQuery.data.reasonCode, undefined);
  });

  it("rota de forma durable y permite progresar a una segunda vencida", async () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    const subscriptions = [
      {
        id: "suscripcion-grande",
        cashierUserId: "cajero-grande",
        status: SubscriptionStatus.ACTIVE,
        endsAt: new Date("2026-08-01T12:00:00.000Z"),
        updatedAt: new Date("2026-07-01T12:00:00.000Z")
      },
      {
        id: "suscripcion-segunda",
        cashierUserId: "cajero-segundo",
        status: SubscriptionStatus.ACTIVE,
        endsAt: new Date("2026-08-01T13:00:00.000Z"),
        updatedAt: new Date("2026-07-02T12:00:00.000Z")
      }
    ];
    const assignments = [
      ...Array.from({ length: 26 }, (_, index) => ({
        id: `asignacion-grande-${index}`,
        clientUserId: `cliente-grande-${index}`,
        cashierUserId: "cajero-grande",
        ended: false
      })),
      {
        id: "asignacion-segunda",
        clientUserId: "cliente-segundo",
        cashierUserId: "cajero-segundo",
        ended: false
      }
    ];
    let selectedCashier = "";
    let selectionSql = "";
    const tx = {
      $queryRaw: async (query: { sql?: string }) => {
        const sql = String(query.sql ?? query);
        if (sql.includes('FROM "cashier_subscriptions" cs')) {
          selectionSql = sql;
          const selected = subscriptions
            .filter(
              (subscription) =>
                subscription.status === SubscriptionStatus.ACTIVE &&
                subscription.endsAt <= now
            )
            .sort(
              (left, right) =>
                left.updatedAt.getTime() - right.updatedAt.getTime()
            )[0];
          selectedCashier = selected?.cashierUserId ?? "";
          return selected
            ? [
                {
                  id: selected.id,
                  cashierUserId: selected.cashierUserId
                }
              ]
            : [];
        }
        if (sql.includes("pg_advisory_xact_lock")) {
          return [{ pg_advisory_xact_lock: null }];
        }
        if (sql.includes('FROM "assignments" a')) {
          return assignments
            .filter(
              (assignment) =>
                assignment.cashierUserId === selectedCashier &&
                !assignment.ended
            )
            .slice(0, 25);
        }
        return [{ now }];
      },
      assignment: {
        update: async (query: any) => {
          const assignment = assignments.find(
            (entry) => entry.id === query.where.id
          );
          if (assignment) assignment.ended = true;
          return {};
        },
        count: async (query: any) =>
          assignments.filter(
            (assignment) =>
              assignment.cashierUserId ===
                query.where.cashierUserId && !assignment.ended
          ).length
      },
      conversation: {
        update: async () => ({})
      },
      reassignmentRequest: {
        create: async (query: any) => ({
          id: `solicitud-${query.data.previousAssignmentId}`,
          ...query.data
        }),
        update: async () => ({})
      },
      user: {
        findFirst: async (query: any) => ({ id: query.where.id })
      },
      cashierProfile: {
        findMany: async () => []
      },
      cashierSubscription: {
        updateMany: async (query: any) => {
          const subscription = subscriptions.find(
            (entry) => entry.id === query.where.id
          );
          if (!subscription) return { count: 0 };
          if (query.data.updatedAt) {
            subscription.updatedAt = query.data.updatedAt;
          }
          if (query.data.status) {
            subscription.status = query.data.status;
          }
          return { count: 1 };
        }
      }
    };
    const prisma = {
      $transaction: async (
        operation: (transaction: typeof tx) => Promise<unknown>
      ) => operation(tx)
    } as unknown as PrismaService;
    const service = new AssignmentsService(prisma);

    const first = await service.reconcileNextExpiredSubscription(25);
    const second = await service.reconcileNextExpiredSubscription(25);

    equal(first?.cashierUserId, "cajero-grande");
    equal(first?.assignmentsProcessed, 25);
    equal(first?.hasMore, true);
    equal(second?.cashierUserId, "cajero-segundo");
    equal(second?.assignmentsProcessed, 1);
    equal(second?.subscriptionExpired, true);
    equal(selectionSql.includes('cs."updated_at" ASC'), true);
  });

  it("reclama pendientes con SKIP LOCKED y backoff acotado", async () => {
    let sql = "";
    const tx = {
      $queryRaw: async (query: { sql?: string }) => {
        sql = String(query.sql ?? query);
        return [];
      }
    };
    const prisma = {
      $transaction: async (
        operation: (transaction: typeof tx) => Promise<unknown>
      ) => operation(tx)
    } as unknown as PrismaService;
    const service = new AssignmentsService(prisma);

    const result = await service.reconcilePendingReassignments(50);

    equal(result.requestsProcessed, 0);
    equal(result.hasMore, false);
    equal(sql.includes("FOR UPDATE OF rr SKIP LOCKED"), true);
    equal(sql.includes("make_interval"), true);
  });

  it("mapea cada causa de reasignación al inicio equivalente", () => {
    const expected = new Map<ReassignmentReason, AssignmentStartReason>([
      [
        ReassignmentReason.CLIENT_BLOCKED_CASHIER,
        AssignmentStartReason.CLIENT_BLOCKED_CASHIER
      ],
      [
        ReassignmentReason.CLIENT_REPORTED_CASHIER,
        AssignmentStartReason.CLIENT_REPORTED_CASHIER
      ],
      [
        ReassignmentReason.CASHIER_BLOCKED_CLIENT,
        AssignmentStartReason.CASHIER_BLOCKED_CLIENT
      ],
      [
        ReassignmentReason.CASHIER_UNAVAILABLE,
        AssignmentStartReason.CASHIER_UNAVAILABLE
      ],
      [
        ReassignmentReason.ADMINISTRATIVE,
        AssignmentStartReason.ADMINISTRATIVE
      ]
    ]);
    const service = new AssignmentsService({} as PrismaService);
    const startReason = (
      service as unknown as {
        startReason(reason: ReassignmentReason): AssignmentStartReason;
      }
    ).startReason.bind(service);

    for (const [reason, assignmentReason] of expected) {
      equal(startReason(reason), assignmentReason);
    }
  });

  it("cierra relaciones de un cliente eliminado sin borrar mensajes", async () => {
    let conversationQuery: any;
    let assignmentQuery: any;
    let reassignmentQuery: any;
    let messageDeletes = 0;
    const publications: string[] = [];
    const tx = {
      assignment: {
        findMany: async () => [
          { id: "asignacion", cashierUserId: "cajero" }
        ],
        updateMany: async (query: any) => {
          assignmentQuery = query;
          return { count: 1 };
        }
      },
      conversation: {
        updateMany: async (query: any) => {
          conversationQuery = query;
          return { count: 1 };
        }
      },
      reassignmentRequest: {
        updateMany: async (query: any) => {
          reassignmentQuery = query;
          return { count: 1 };
        }
      },
      message: {
        deleteMany: async () => {
          messageDeletes += 1;
          return { count: 0 };
        }
      }
    };
    const service = new AssignmentsService(
      {} as PrismaService,
      {
        publishRelationshipChanged: async (
          _transaction: unknown,
          clientUserId: string,
          cashierUserId: string,
          changeType: string
        ) => {
          publications.push(
            `${clientUserId}:${cashierUserId}:${changeType}`
          );
        }
      } as unknown as MatrixDeviceListPublisher
    );

    const result =
      await service.endClientRelationshipsForDeletionInTransaction(
        tx as any,
        "cliente",
        new Date("2026-07-26T12:00:00.000Z")
      );

    equal(
      conversationQuery.data.status,
      ConversationStatus.CLOSED
    );
    equal(
      assignmentQuery.data.endReason,
      AssignmentEndReason.ACCOUNT_DELETED
    );
    equal(
      reassignmentQuery.data.status,
      ReassignmentStatus.CANCELLED
    );
    equal(
      reassignmentQuery.data.cancellationReasonCode,
      "ACCOUNT_DELETED"
    );
    equal(messageDeletes, 0);
    deepEqual(publications, ["cliente:cajero:LEFT"]);
    deepEqual(result, {
      assignmentsClosed: 1,
      conversationsClosed: 1,
      pendingReassignmentsCancelled: 1
    });
  });
});
