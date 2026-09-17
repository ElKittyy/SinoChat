import {
  deepEqual,
  equal,
  match,
  ok,
  rejects
} from "node:assert/strict";
import { describe, it } from "node:test";
import { AssignmentsService } from "../assignments/assignments.service";
import { PasswordService } from "../auth/password.service";
import { PrismaService } from "../database/prisma.service";
import type { MatrixDeviceListPublisher } from "../database/matrix-device-list.publisher";
import {
  AccountStatus,
  AdminAuditAction,
  AssignmentEndReason,
  CashierApprovalStatus,
  NotificationType,
  SubscriptionStatus,
  UserRole
} from "../generated/prisma/enums";
import { RealtimeService } from "../realtime/realtime.service";
import { AdminUsersQueryDto } from "./dto/admin-users-query.dto";
import { ADMIN_AUTOMATIC_REASON } from "./admin-automatic-reason";
import { AdminUsersService } from "./admin-users.service";

describe("AdminUsersService", () => {
  it("edita datos permitidos del cajero, normaliza únicos y audita antes/después", async () => {
    let userUpdate: unknown;
    let profileUpdate: any;
    let auditData: any;
    const tx = {
      user: {
        findUnique: async () => ({
          id: "cajero",
          username: "CajeroViejo",
          role: UserRole.CASHIER,
          status: AccountStatus.ACTIVE,
          clientProfile: null,
          cashierProfile: {
            approvalStatus: CashierApprovalStatus.APPROVED,
            email: "viejo@example.com",
            phoneE164: "+5491100000000"
          }
        }),
        update: async (query: any) => {
          userUpdate = query.data;
          return { username: query.data.username };
        }
      },
      cashierProfile: {
        update: async (query: any) => {
          profileUpdate = query.data;
          return {
            email: query.data.email,
            phoneE164: query.data.phoneE164
          };
        }
      },
      adminAuditEvent: {
        create: async (query: any) => {
          auditData = query.data;
          return {};
        }
      }
    };
    const service = serviceWithTransaction(tx);

    const result = await service.update("admin", "cajero", {
      username: "CajeroNuevo",
      email: "Nuevo@Example.com",
      phone: "+5491199999999"
    });

    deepEqual(userUpdate, {
      username: "CajeroNuevo",
      normalizedUsername: "cajeronuevo"
    });
    equal(profileUpdate.normalizedEmail, "nuevo@example.com");
    equal(profileUpdate.phoneE164, "+5491199999999");
    ok(profileUpdate.emailVerifiedAt instanceof Date);
    ok(profileUpdate.phoneVerifiedAt instanceof Date);
    equal(auditData.action, AdminAuditAction.USER_UPDATED);
    equal(auditData.reasonCode, ADMIN_AUTOMATIC_REASON.USER_UPDATED);
    deepEqual(JSON.parse(auditData.stateBefore), {
      username: "CajeroViejo",
      email: "viejo@example.com",
      phone: "+5491100000000"
    });
    deepEqual(JSON.parse(auditData.stateAfter), {
      username: "CajeroNuevo",
      email: "Nuevo@Example.com",
      phone: "+5491199999999"
    });
    equal(result.username, "CajeroNuevo");
  });

  it("rechaza correo o teléfono para un cliente", async () => {
    const tx = {
      user: {
        findUnique: async () => ({
          id: "cliente",
          username: "cliente",
          role: UserRole.CLIENT,
          status: AccountStatus.ACTIVE,
          clientProfile: { userId: "cliente" },
          cashierProfile: null
        })
      }
    };
    const service = serviceWithTransaction(tx);

    await rejects(
      service.update("admin", "cliente", {
        email: "cliente@example.com"
      }),
      /solo corresponden a cuentas de cajero/
    );
  });

  it("no permite modificar ni eliminar cuentas administradoras", async () => {
    const tx = {
      user: {
        findUnique: async () => ({
          id: "otro-admin",
          username: "otro-admin",
          role: UserRole.ADMIN,
          status: AccountStatus.ACTIVE,
          clientProfile: null,
          cashierProfile: null
        })
      }
    };
    const service = serviceWithTransaction(tx);

    await rejects(
      service.update("admin", "otro-admin", {
        username: "nuevo-admin"
      }),
      /no modifica cuentas administradoras/
    );
    await rejects(
      service.deleteUser("admin", "otro-admin"),
      /no modifica cuentas administradoras/
    );
    await rejects(
      service.resetPassword(
        "admin",
        "otro-admin"
      ),
      /no modifica cuentas administradoras/
    );
  });

  it("elimina lógicamente un cliente, cierra relaciones y revoca sesiones", async () => {
    let relationshipCall: unknown;
    let userUpdate: any;
    let sessionUpdate: any;
    let auditData: any;
    const tx = {
      user: {
        findUnique: async () => ({
          id: "cliente",
          username: "cliente",
          role: UserRole.CLIENT,
          status: AccountStatus.SUSPENDED,
          clientProfile: { userId: "cliente" },
          cashierProfile: null
        }),
        update: async (query: any) => {
          userUpdate = query.data;
          return {};
        }
      },
      authSession: {
        updateMany: async (query: any) => {
          sessionUpdate = query;
          return { count: 2 };
        }
      },
      adminAuditEvent: {
        create: async (query: any) => {
          auditData = query.data;
          return {};
        }
      }
    };
    const assignments = {
      runSerializable: async (operation: (transaction: typeof tx) => unknown) =>
        operation(tx),
      endClientRelationshipsForDeletionInTransaction: async (
        _transaction: unknown,
        userId: string
      ) => {
        relationshipCall = userId;
        return {
          assignmentsClosed: 1,
          conversationsClosed: 1,
          pendingReassignmentsCancelled: 1
        };
      },
      reassignCashierClientsInTransaction: async () => []
    } as unknown as AssignmentsService;
    const service = new AdminUsersService(
      {} as PrismaService,
      assignments,
      passwordService(),
      realtimeService()
    );

    const result = await service.deleteUser("admin", "cliente");

    equal(relationshipCall, "cliente");
    equal(userUpdate.status, AccountStatus.DELETED);
    ok(userUpdate.deletedAt instanceof Date);
    equal(userUpdate.suspendedAt, null);
    deepEqual(userUpdate.sessionVersion, { increment: 1 });
    equal(sessionUpdate.data.revocationReason, "ADMIN_ACCOUNT_DELETION");
    equal(auditData.action, AdminAuditAction.USER_DELETED);
    equal(auditData.reasonCode, ADMIN_AUTOMATIC_REASON.USER_DELETED);
    equal(result.sessionsRevoked, 2);
    equal(result.clientRelationships?.conversationsClosed, 1);
  });

  it("al eliminar un cajero reasigna clientes, cancela acceso y conserva registros", async () => {
    let reassignmentInput: any;
    let subscriptionUpdate: any;
    let invitationUpdate: any;
    let profileUpdate: any;
    const tx = {
      user: {
        findUnique: async () => ({
          id: "cajero",
          username: "cajero",
          role: UserRole.CASHIER,
          status: AccountStatus.ACTIVE,
          clientProfile: null,
          cashierProfile: {
            approvalStatus: CashierApprovalStatus.APPROVED,
            email: "cajero@example.com",
            phoneE164: "+5491100000000"
          }
        }),
        update: async () => ({})
      },
      cashierSubscription: {
        findMany: async () => [
          {
            id: "suscripcion",
            startsAt: new Date(Date.now() - 60_000)
          }
        ],
        update: async (query: any) => {
          subscriptionUpdate = query;
          return {};
        }
      },
      cashierInvitation: {
        updateMany: async (query: any) => {
          invitationUpdate = query;
          return { count: 1 };
        }
      },
      cashierProfile: {
        update: async (query: any) => {
          profileUpdate = query;
          return {};
        }
      },
      authSession: {
        updateMany: async () => ({ count: 1 })
      },
      adminAuditEvent: {
        create: async () => ({})
      }
    };
    const assignments = {
      runSerializable: async (operation: (transaction: typeof tx) => unknown) =>
        operation(tx),
      endClientRelationshipsForDeletionInTransaction: async () => ({
        assignmentsClosed: 0,
        conversationsClosed: 0,
        pendingReassignmentsCancelled: 0
      }),
      reassignCashierClientsInTransaction: async (
        _transaction: unknown,
        input: unknown
      ) => {
        reassignmentInput = input;
        return [
          {
            status: "PENDING_REASSIGNMENT",
            requestId: "solicitud",
            clientUserId: "cliente",
            previousCashierUserId: "cajero"
          }
        ];
      }
    } as unknown as AssignmentsService;
    const service = new AdminUsersService(
      {} as PrismaService,
      assignments,
      passwordService(),
      realtimeService()
    );

    const result = await service.deleteUser("admin", "cajero");

    equal(
      reassignmentInput.assignmentEndReason,
      AssignmentEndReason.ACCOUNT_DELETED
    );
    equal(
      reassignmentInput.reasonCode,
      ADMIN_AUTOMATIC_REASON.USER_DELETED
    );
    equal(subscriptionUpdate.data.status, SubscriptionStatus.CANCELLED);
    equal(subscriptionUpdate.data.reasonCode, "ACCOUNT_DELETED");
    equal(invitationUpdate.data.revokedAt instanceof Date, true);
    equal(
      profileUpdate.data.approvalStatus,
      CashierApprovalStatus.REVOKED
    );
    equal(result.cashierReassignments.pending, 1);
    equal(result.subscriptionsCancelled, 1);
  });

  it("inicia una recuperación sin cambiar ni exponer la contraseña y revoca todas las sesiones", async () => {
    let userUpdate: any;
    let auditData: any;
    let supersededReset: any;
    let createdReset: any;
    let notificationData: any;
    const databaseNow = new Date("2026-08-02T15:30:00.000Z");
    const tx = {
      $queryRaw: async () => [{ now: databaseNow }],
      user: {
        findUnique: async () => ({
          id: "cajero",
          username: "cajero",
          role: UserRole.CASHIER,
          status: AccountStatus.ACTIVE,
          passwordResetRequired: false,
          clientProfile: null,
          cashierProfile: {
            approvalStatus: CashierApprovalStatus.APPROVED,
            email: "cajero@example.com",
            phoneE164: "+5491112345678"
          }
        }),
        update: async (query: any) => {
          userUpdate = query.data;
          return {
            id: "cajero"
          };
        }
      },
      cashierPasswordReset: {
        updateMany: async (query: any) => {
          supersededReset = query;
          return { count: 0 };
        },
        create: async (query: any) => {
          createdReset = query.data;
          return {
            id: "reset-id",
            createdAt: query.data.createdAt,
            expiresAt: query.data.expiresAt
          };
        }
      },
      authSession: {
        updateMany: async () => ({ count: 3 })
      },
      adminAuditEvent: {
        create: async (query: any) => {
          auditData = query.data;
          return {};
        }
      },
      inAppNotification: {
        create: async (query: any) => {
          notificationData = query.data;
          return {};
        }
      }
    };
    const passwords = {
      hash: async () => {
        throw new Error("El administrador no debe calcular contraseñas");
      }
    } as unknown as PasswordService;
    let transactionCompleted = false;
    let disconnectedAfterCommit = false;
    let relationshipPublication:
      | { userId: string; changeType: string; createdAt: Date }
      | undefined;
    const assignments = {
      runSerializable: async (
        operation: (transaction: typeof tx) => Promise<unknown>
      ) => {
        const result = await operation(tx);
        transactionCompleted = true;
        return result;
      }
    } as unknown as AssignmentsService;
    const realtime = {
      disconnectUser: () => {
        disconnectedAfterCommit = transactionCompleted;
      }
    } as unknown as RealtimeService;
    const service = new AdminUsersService(
      {} as PrismaService,
      assignments,
      passwords,
      realtime,
      {
        publishCurrentRelationshipsForUser: async (
          _transaction: unknown,
          userId: string,
          changeType: string,
          createdAt: Date
        ) => {
          relationshipPublication = {
            userId,
            changeType,
            createdAt
          };
        }
      } as unknown as MatrixDeviceListPublisher
    );

    const result = await service.resetPassword("admin", "cajero");

    equal("passwordHash" in userUpdate, false);
    equal("passwordChangedAt" in userUpdate, false);
    equal(userUpdate.passwordResetRequired, true);
    equal(createdReset.cashierUserId, "cajero");
    equal(createdReset.initiatedByAdminUserId, "admin");
    equal(
      createdReset.expiresAt.getTime() - createdReset.createdAt.getTime(),
      24 * 60 * 60 * 1_000
    );
    equal(supersededReset.data.supersededAt, databaseNow);
    deepEqual(userUpdate.sessionVersion, { increment: 1 });
    equal(auditData.action, AdminAuditAction.PASSWORD_RESET);
    equal(notificationData.userId, "cajero");
    equal(notificationData.type, NotificationType.ACCOUNT_STATUS_CHANGED);
    equal(
      auditData.reasonCode,
      ADMIN_AUTOMATIC_REASON.CASHIER_PASSWORD_RESET
    );
    equal(JSON.stringify(auditData).includes("passwordHash"), false);
    equal(JSON.stringify(result).includes("temporaryPassword"), false);
    equal(JSON.stringify(result).includes("passwordHash"), false);
    equal(result.sessionsRevoked, 3);
    equal(disconnectedAfterCommit, true);
    deepEqual(relationshipPublication, {
      userId: "cajero",
      changeType: "LEFT",
      createdAt: databaseNow
    });
    equal(result.resetRequestId, "reset-id");
    match(result.resetExpiresAt.toISOString(), /^\d{4}-\d{2}-\d{2}T/);
  });

  it("rechaza el restablecimiento administrativo de una cuenta cliente", async () => {
    let updated = false;
    const tx = {
      user: {
        findUnique: async () => ({
          id: "cliente",
          username: "cliente",
          role: UserRole.CLIENT,
          status: AccountStatus.ACTIVE,
          clientProfile: { userId: "cliente" },
          cashierProfile: null
        }),
        update: async () => {
          updated = true;
          return {};
        }
      }
    };
    const service = serviceWithTransaction(tx);

    await rejects(
      service.resetPassword(
        "admin",
        "cliente"
      ),
      /Solo las cuentas de cajero/
    );
    equal(updated, false);
  });

  it("no renueva antes de que el worker concilie el periodo vencido", async () => {
    const databaseNow = new Date("2026-08-02T16:00:00.000Z");
    const statements: string[] = [];
    let subscriptionsCreated = 0;
    let subscriptionsUpdated = 0;
    const tx = {
      $queryRaw: async (query: unknown) => {
        const sql = renderedSql(query);
        statements.push(sql);
        if (sql.includes("pg_try_advisory_xact_lock")) {
          return [{ acquired: true }];
        }
        return [{ now: databaseNow }];
      },
      cashierProfile: {
        findFirst: async () => ({ userId: "cajero" })
      },
      cashierSubscription: {
        findMany: async () => [
          {
            id: "suscripcion-vencida",
            status: SubscriptionStatus.ACTIVE,
            startsAt: new Date("2026-07-02T16:00:00.000Z"),
            endsAt: databaseNow
          }
        ],
        update: async () => {
          subscriptionsUpdated += 1;
          return {};
        },
        create: async () => {
          subscriptionsCreated += 1;
          return {};
        }
      }
    };
    const service = serviceWithTransaction(tx);

    await rejects(
      service.activateSubscription("admin", "cajero"),
      /aún está conciliando su clientela/
    );

    equal(subscriptionsUpdated, 0);
    equal(subscriptionsCreated, 0);
    match(statements.join("\n"), /pg_try_advisory_xact_lock/);
    match(statements.join("\n"), /clock_timestamp/);
  });

  it("activa tras la conciliacion sin alterar passwordResetRequired", async () => {
    const databaseNow = new Date("2026-08-02T16:05:00.000Z");
    let subscriptionData: any;
    let userWrites = 0;
    const tx = {
      $queryRaw: async (query: unknown) =>
        renderedSql(query).includes("pg_try_advisory_xact_lock")
          ? [{ acquired: true }]
          : [{ now: databaseNow }],
      cashierProfile: {
        findFirst: async () => ({
          userId: "cajero",
          user: { passwordResetRequired: true }
        })
      },
      user: {
        update: async () => {
          userWrites += 1;
          return {};
        }
      },
      cashierSubscription: {
        findMany: async () => [],
        create: async (query: any) => {
          subscriptionData = query.data;
          return {
            id: "suscripcion-nueva",
            status: query.data.status,
            startsAt: query.data.startsAt,
            endsAt: query.data.endsAt
          };
        }
      },
      adminAuditEvent: {
        create: async () => ({})
      }
    };
    const service = serviceWithTransaction(tx);

    const result = await service.activateSubscription("admin", "cajero");

    equal(result.status, SubscriptionStatus.ACTIVE);
    equal(subscriptionData.startsAt, databaseNow);
    equal(
      subscriptionData.reasonCode,
      ADMIN_AUTOMATIC_REASON.SUBSCRIPTION_ACTIVATED
    );
    equal(userWrites, 0);
  });

  it("expone EXPIRED_PENDING cuando endsAt coincide con el reloj DB", async () => {
    const databaseNow = new Date("2026-08-02T16:10:00.000Z");
    const countQueries: any[] = [];
    let transactionOptions: Record<string, unknown> | undefined;
    const tx = {
      $queryRaw: async () => [{ now: databaseNow }],
      user: {
        count: async (query: any) => {
          countQueries.push(query);
          return [1, 8, 4][countQueries.length - 1] ?? 0;
        },
        findMany: async () => [
          {
            id: "cajero",
            username: "cajero",
            role: UserRole.CASHIER,
            status: AccountStatus.ACTIVE,
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
            lastLoginAt: null,
            suspendedAt: null,
            suspensionReasonCode: null,
            clientProfile: null,
            cashierProfile: {
              email: "cajero@example.com",
              phoneE164: "+5491112345678",
              approvalStatus: CashierApprovalStatus.APPROVED,
              emailVerifiedAt: databaseNow,
              phoneVerifiedAt: databaseNow,
              subscriptions: [
                {
                  id: "suscripcion",
                  status: SubscriptionStatus.ACTIVE,
                  startsAt: new Date("2026-07-02T16:10:00.000Z"),
                  endsAt: databaseNow
                }
              ],
              _count: { assignments: 25 }
            }
          }
        ]
      }
    };
    const prisma = {
      $transaction: async <T>(
        operation: (transaction: typeof tx) => Promise<T>,
        options: Record<string, unknown>
      ) => {
        transactionOptions = options;
        return operation(tx);
      }
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      prisma,
      {} as AssignmentsService,
      passwordService(),
      realtimeService()
    );

    const result = await service.list({
      page: 1,
      pageSize: 20
    } as AdminUsersQueryDto);
    const subscription = result.items[0]?.cashierProfile
      ?.subscriptions[0] as
      | {
          status: SubscriptionStatus;
          effectiveStatus: string;
        }
      | undefined;

    equal(subscription?.status, SubscriptionStatus.ACTIVE);
    equal(subscription?.effectiveStatus, "EXPIRED_PENDING");
    deepEqual(result.overview, {
      inactiveSubscriptions: 4,
      pendingUsers: 8
    });
    equal(transactionOptions?.isolationLevel, "RepeatableRead");
    deepEqual(countQueries[0]?.where?.role, {
      not: UserRole.ADMIN
    });
    deepEqual(countQueries[1]?.where, {
      status: AccountStatus.PENDING
    });
    equal(
      countQueries[2]?.where?.OR?.[1]?.cashierProfile?.is
        ?.subscriptions?.none?.startsAt?.lte,
      databaseNow
    );
  });

  it("desactiva con advisory, reloj DB y version optimista en el boundary", async () => {
    const databaseNow = new Date("2026-08-02T16:15:00.000Z");
    const updatedAt = new Date("2026-08-01T10:00:00.000Z");
    const statements: string[] = [];
    let updateQuery: any;
    const tx = {
      $queryRaw: async (query: unknown) => {
        const sql = renderedSql(query);
        statements.push(sql);
        if (sql.includes("pg_try_advisory_xact_lock")) {
          return [{ acquired: true }];
        }
        if (sql.includes('FROM "cashier_subscriptions" cs')) {
          return [
            {
              id: "suscripcion",
              startsAt: new Date("2026-07-02T16:15:00.000Z"),
              endsAt: databaseNow,
              updatedAt
            }
          ];
        }
        return [{ now: databaseNow }];
      },
      cashierProfile: {
        findFirst: async () => ({ userId: "cajero" })
      },
      cashierSubscription: {
        count: async () => 1,
        updateMany: async (query: any) => {
          updateQuery = query;
          return { count: 1 };
        }
      },
      adminAuditEvent: {
        create: async () => ({})
      }
    };
    const service = serviceWithTransaction(tx);

    const result = await service.deactivateSubscription("admin", "cajero");

    equal(updateQuery.where.id, "suscripcion");
    equal(updateQuery.where.cashierUserId, "cajero");
    equal(updateQuery.where.status, SubscriptionStatus.ACTIVE);
    equal(updateQuery.where.updatedAt, updatedAt);
    equal(updateQuery.data.endsAt, databaseNow);
    equal(updateQuery.data.updatedAt, databaseNow);
    equal(updateQuery.data.status, SubscriptionStatus.INACTIVE);
    equal(
      updateQuery.data.reasonCode,
      ADMIN_AUTOMATIC_REASON.SUBSCRIPTION_DEACTIVATED
    );
    equal(result.effectiveStatus, "INACTIVE");
    match(statements.join("\n"), /pg_try_advisory_xact_lock/);
    match(statements.join("\n"), /clock_timestamp/);
    match(statements.join("\n"), /FOR UPDATE OF cs SKIP LOCKED/);
  });

  it("no sobrescribe la fila si el worker ya la reclamo", async () => {
    const databaseNow = new Date("2026-08-02T16:16:00.000Z");
    let updates = 0;
    const tx = {
      $queryRaw: async (query: unknown) => {
        const sql = renderedSql(query);
        if (sql.includes("pg_try_advisory_xact_lock")) {
          return [{ acquired: true }];
        }
        if (sql.includes('FROM "cashier_subscriptions" cs')) {
          return [];
        }
        return [{ now: databaseNow }];
      },
      cashierProfile: {
        findFirst: async () => ({ userId: "cajero" })
      },
      cashierSubscription: {
        count: async () => 1,
        updateMany: async () => {
          updates += 1;
          return { count: 1 };
        }
      }
    };
    const service = serviceWithTransaction(tx);

    await rejects(
      service.deactivateSubscription("admin", "cajero"),
      /está siendo conciliada/
    );
    equal(updates, 0);
  });
});

function serviceWithTransaction(
  tx: unknown,
  passwords = passwordService()
) {
  const assignments = {
    runSerializable: async (
      operation: (transaction: unknown) => Promise<unknown>
    ) => operation(tx),
    endClientRelationshipsForDeletionInTransaction: async () => ({
      assignmentsClosed: 0,
      conversationsClosed: 0,
      pendingReassignmentsCancelled: 0
    }),
    reassignCashierClientsInTransaction: async () => [],
    retryPendingInTransaction: async () => []
  } as unknown as AssignmentsService;
  return new AdminUsersService(
    {} as PrismaService,
    assignments,
    passwords,
    realtimeService()
  );
}

function passwordService() {
  return {
    hash: async () => "hash"
  } as unknown as PasswordService;
}

function realtimeService() {
  return {
    disconnectUser: () => undefined
  } as unknown as RealtimeService;
}

function renderedSql(value: unknown): string {
  if (value && typeof value === "object" && "sql" in value) {
    return String(value.sql);
  }
  return String(value);
}
