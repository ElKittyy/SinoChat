import {
  deepEqual,
  doesNotMatch,
  equal
} from "node:assert/strict";
import { describe, it } from "node:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { AssignmentsService } from "../assignments/assignments.service";
import { PasswordService } from "../auth/password.service";
import { PrismaService } from "../database/prisma.service";
import {
  AccountStatus,
  AssignmentStartReason,
  CashierApprovalStatus,
  SubscriptionStatus
} from "../generated/prisma/enums";
import { RealtimeService } from "../realtime/realtime.service";
import { AdminUsersService } from "./admin-users.service";
import {
  AdminAssignmentsQueryDto,
  AdminSubscriptionsQueryDto
} from "./dto/admin-directory-query.dto";

describe("directorios administrativos paginados", () => {
  it("pagina asignaciones activas sin seleccionar conversación ni contenido", async () => {
    let countWhere: unknown;
    let findQuery: any;
    const prisma = {
      assignment: {
        count: async (query: any) => {
          countWhere = query.where;
          return 21;
        },
        findMany: async (query: any) => {
          findQuery = query;
          return [
            {
              id: "asignacion",
              startReason: AssignmentStartReason.INVITATION,
              startedAt: new Date("2026-08-01T00:00:00.000Z"),
              client: {
                user: {
                  id: "cliente",
                  username: "cliente",
                  status: AccountStatus.ACTIVE
                }
              },
              cashier: {
                user: {
                  id: "cajero",
                  username: "cajero",
                  status: AccountStatus.ACTIVE
                }
              }
            }
          ];
        }
      },
      $transaction: async (operations: Promise<unknown>[]) =>
        Promise.all(operations)
    } as unknown as PrismaService;
    const service = createService(prisma);

    const result = await service.listAssignments({
      page: 2,
      pageSize: 10,
      search: " Cliente "
    } as AdminAssignmentsQueryDto);

    equal(result.pagination.page, 2);
    equal(result.pagination.total, 21);
    equal(result.pagination.totalPages, 3);
    equal(findQuery.skip, 10);
    equal(findQuery.take, 10);
    deepEqual(countWhere, findQuery.where);
    equal(findQuery.where.endedAt, null);
    equal(findQuery.where.OR.length, 2);
    doesNotMatch(
      JSON.stringify(findQuery.select),
      /conversation|message|envelope|attachment|ciphertext/i
    );
  });

  it("pagina todos los cajeros y calcula el total activo con el reloj DB", async () => {
    const now = new Date("2026-08-02T16:15:00.000Z");
    let countCalls = 0;
    let transactionOptions: Record<string, unknown> | undefined;
    let findQuery: any;
    const tx = {
      $queryRaw: async () => [{ now }],
      user: {
        count: async () => {
          countCalls += 1;
          return countCalls === 1 ? 2 : 1;
        },
        findMany: async (query: any) => {
          findQuery = query;
          return [
            {
              id: "cajero-1",
              username: "cajero1",
              status: AccountStatus.ACTIVE,
              cashierProfile: {
                approvalStatus: CashierApprovalStatus.APPROVED,
                subscriptions: [
                  {
                    id: "suscripcion",
                    status: SubscriptionStatus.ACTIVE,
                    startsAt: new Date("2026-08-01T00:00:00.000Z"),
                    endsAt: now
                  }
                ]
              }
            },
            {
              id: "cajero-2",
              username: "cajero2",
              status: AccountStatus.PENDING,
              cashierProfile: null
            }
          ];
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
    const service = createService(prisma);

    const result = await service.listSubscriptions({
      page: 1,
      pageSize: 20
    } as AdminSubscriptionsQueryDto);

    equal(result.pagination.total, 2);
    equal(result.activeTotal, 1);
    equal(
      result.items[0]?.subscription?.effectiveStatus,
      "EXPIRED_PENDING"
    );
    equal(result.items[1]?.subscription, null);
    equal(transactionOptions?.isolationLevel, "RepeatableRead");
    doesNotMatch(
      JSON.stringify(findQuery.select),
      /conversation|message|envelope|attachment|ciphertext/i
    );
  });

  it("rechaza páginas abusivas e identificadores de cajero inválidos", async () => {
    const invalidAssignments = plainToInstance(
      AdminAssignmentsQueryDto,
      { cashierId: "no-es-un-uuid", page: 0, pageSize: 101 }
    );
    const invalidSubscriptions = plainToInstance(
      AdminSubscriptionsQueryDto,
      { page: 1.5, pageSize: 0 }
    );

    equal((await validate(invalidAssignments)).length, 3);
    equal((await validate(invalidSubscriptions)).length, 2);
  });
});

function createService(prisma: PrismaService) {
  return new AdminUsersService(
    prisma,
    {} as AssignmentsService,
    {} as PasswordService,
    {} as RealtimeService
  );
}
