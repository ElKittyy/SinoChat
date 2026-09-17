import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AssignmentsService } from "../assignments/assignments.service";
import { PasswordService } from "../auth/password.service";
import { cashierPasswordResetExpiresAt } from "../auth/cashier-recovery-code";
import { Prisma } from "../generated/prisma/client";
import {
  AccountStatus,
  AdminAuditAction,
  AdminAuditTargetType,
  AssignmentEndReason,
  BlockInitiator,
  CashierApprovalStatus,
  NotificationType,
  ReassignmentStatus,
  SubscriptionStatus,
  UserRole
} from "../generated/prisma/enums";
import { PrismaService } from "../database/prisma.service";
import { MatrixDeviceListPublisher } from "../database/matrix-device-list.publisher";
import { RealtimeService } from "../realtime/realtime.service";
import { type UpdateAdminUserDto } from "./dto/admin-user-mutation.dto";
import {
  AdminAssignmentsQueryDto,
  AdminSubscriptionsQueryDto
} from "./dto/admin-directory-query.dto";
import { AdminUsersQueryDto } from "./dto/admin-users-query.dto";
import { ADMIN_AUTOMATIC_REASON } from "./admin-automatic-reason";

type EffectiveSubscriptionStatus =
  | "ACTIVE"
  | "SCHEDULED"
  | "EXPIRED_PENDING"
  | "INACTIVE"
  | "EXPIRED"
  | "CANCELLED";

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assignments: AssignmentsService,
    private readonly passwords: PasswordService,
    private readonly realtime: RealtimeService,
    private readonly deviceLists?: MatrixDeviceListPublisher
  ) {}

  async list(query: AdminUsersQueryDto) {
    const search = query.search?.trim().toLowerCase();
    const searchFilters: Prisma.UserWhereInput[] = search
      ? [
          { normalizedUsername: { contains: search } },
          {
            cashierProfile: {
              is: {
                OR: [
                  { normalizedEmail: { contains: search } },
                  { phoneE164: { contains: query.search?.trim() } }
                ]
              }
            }
          },
          ...(this.isUuid(search) ? [{ id: search }] : [])
        ]
      : [];
    const where: Prisma.UserWhereInput = {
      ...(query.role
        ? { role: query.role }
        : { role: { not: UserRole.ADMIN } }),
      ...(query.status ? { status: query.status } : {}),
      ...(query.assignedCashierId
        ? {
            clientProfile: {
              is: {
                assignments: {
                  some: {
                    cashierUserId: query.assignedCashierId,
                    endedAt: null
                  }
                }
              }
            }
          }
        : {}),
      ...(searchFilters.length > 0 ? { OR: searchFilters } : {})
    };
    const skip = (query.page - 1) * query.pageSize;

    const {
      inactiveSubscriptions,
      items,
      now,
      pendingUsers,
      total
    } = await this.prisma.$transaction(
      async (tx) => {
        const now = await this.databaseNow(tx);
        const [total, items, pendingUsers, inactiveSubscriptions] =
          await Promise.all([
            tx.user.count({ where }),
            tx.user.findMany({
        where,
        skip,
        take: query.pageSize,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          username: true,
          role: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
          suspendedAt: true,
          suspensionReasonCode: true,
          clientProfile: {
            select: {
              assignments: {
                where: { endedAt: null },
                take: 1,
                select: {
                  id: true,
                  startReason: true,
                  startedAt: true,
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
              _count: {
                select: {
                  blocks: {
                    where: { initiatedBy: BlockInitiator.CASHIER }
                  }
                }
              }
            }
          },
          cashierProfile: {
            select: {
              email: true,
              phoneE164: true,
              approvalStatus: true,
              emailVerifiedAt: true,
              phoneVerifiedAt: true,
              subscriptions: {
                orderBy: { createdAt: "desc" },
                take: 1,
                select: {
                  id: true,
                  status: true,
                  startsAt: true,
                  endsAt: true
                }
              },
              _count: {
                select: {
                  assignments: {
                    where: { endedAt: null }
                  }
                }
              }
            }
          }
              }
            }),
            tx.user.count({
              where: { status: AccountStatus.PENDING }
            }),
            tx.user.count({
              where: {
                role: UserRole.CASHIER,
                status: { not: AccountStatus.DELETED },
                OR: [
                  { cashierProfile: { is: null } },
                  {
                    cashierProfile: {
                      is: {
                        subscriptions: {
                          none: {
                            status: SubscriptionStatus.ACTIVE,
                            startsAt: { lte: now },
                            OR: [
                              { endsAt: null },
                              { endsAt: { gt: now } }
                            ]
                          }
                        }
                      }
                    }
                  }
                ]
              }
            })
          ]);
        return {
          inactiveSubscriptions,
          items,
          now,
          pendingUsers,
          total
        };
      },
      {
        isolationLevel:
          Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 5_000,
        timeout: 15_000
      }
    );

    return {
      items: items.map((item) =>
        item.cashierProfile
          ? {
              ...item,
              cashierProfile: {
                ...item.cashierProfile,
                subscriptions:
                  item.cashierProfile.subscriptions.map(
                    (subscription) => ({
                      ...subscription,
                      effectiveStatus:
                        this.effectiveSubscriptionStatus(
                          subscription,
                          now
                        )
                    })
                  )
              }
            }
          : item
      ),
      overview: {
        inactiveSubscriptions,
        pendingUsers
      },
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize)
      }
    };
  }

  async listAssignments(query: AdminAssignmentsQueryDto) {
    const search = query.search?.trim().toLowerCase();
    const searchFilters: Prisma.AssignmentWhereInput[] = search
      ? [
          {
            client: {
              user: { normalizedUsername: { contains: search } }
            }
          },
          {
            cashier: {
              user: { normalizedUsername: { contains: search } }
            }
          },
          ...(this.isUuid(search)
            ? [
                { id: search },
                { clientUserId: search },
                { cashierUserId: search }
              ]
            : [])
        ]
      : [];
    const where: Prisma.AssignmentWhereInput = {
      endedAt: null,
      ...(query.cashierId ? { cashierUserId: query.cashierId } : {}),
      ...(searchFilters.length > 0 ? { OR: searchFilters } : {})
    };
    const skip = (query.page - 1) * query.pageSize;
    const [total, items] = await this.prisma.$transaction(
      [
        this.prisma.assignment.count({ where }),
        this.prisma.assignment.findMany({
          where,
          skip,
          take: query.pageSize,
          orderBy: [{ startedAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            startReason: true,
            startedAt: true,
            client: {
              select: {
                user: {
                  select: { id: true, username: true, status: true }
                }
              }
            },
            cashier: {
              select: {
                user: {
                  select: { id: true, username: true, status: true }
                }
              }
            }
          }
        })
      ],
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      }
    );

    return {
      items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize)
      }
    };
  }

  async listSubscriptions(query: AdminSubscriptionsQueryDto) {
    const search = query.search?.trim().toLowerCase();
    const searchFilters: Prisma.UserWhereInput[] = search
      ? [
          { normalizedUsername: { contains: search } },
          {
            cashierProfile: {
              is: {
                OR: [
                  { normalizedEmail: { contains: search } },
                  { phoneE164: { contains: query.search?.trim() } }
                ]
              }
            }
          },
          ...(this.isUuid(search) ? [{ id: search }] : [])
        ]
      : [];
    const where: Prisma.UserWhereInput = {
      role: UserRole.CASHIER,
      status: { not: AccountStatus.DELETED },
      ...(searchFilters.length > 0 ? { OR: searchFilters } : {})
    };
    const skip = (query.page - 1) * query.pageSize;

    const { activeTotal, items, now, total } =
      await this.prisma.$transaction(
        async (tx) => {
          const now = await this.databaseNow(tx);
          const [total, items, activeTotal] = await Promise.all([
            tx.user.count({ where }),
            tx.user.findMany({
              where,
              skip,
              take: query.pageSize,
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              select: {
                id: true,
                username: true,
                status: true,
                cashierProfile: {
                  select: {
                    approvalStatus: true,
                    subscriptions: {
                      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                      take: 1,
                      select: {
                        id: true,
                        status: true,
                        startsAt: true,
                        endsAt: true
                      }
                    }
                  }
                }
              }
            }),
            tx.user.count({
              where: {
                role: UserRole.CASHIER,
                status: { not: AccountStatus.DELETED },
                cashierProfile: {
                  is: {
                    subscriptions: {
                      some: {
                        status: SubscriptionStatus.ACTIVE,
                        startsAt: { lte: now },
                        OR: [{ endsAt: null }, { endsAt: { gt: now } }]
                      }
                    }
                  }
                }
              }
            })
          ]);
          return { activeTotal, items, now, total };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          maxWait: 5_000,
          timeout: 15_000
        }
      );

    return {
      items: items.map((item) => {
        const subscription = item.cashierProfile?.subscriptions[0];
        return {
          cashierId: item.id,
          cashierUsername: item.username,
          accountStatus: item.status,
          approvalStatus: item.cashierProfile?.approvalStatus ?? null,
          subscription: subscription
            ? {
                ...subscription,
                effectiveStatus: this.effectiveSubscriptionStatus(
                  subscription,
                  now
                )
              }
            : null
        };
      }),
      activeTotal,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize)
      }
    };
  }

  async detail(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        lastLoginAt: true,
        suspendedAt: true,
        suspensionReasonCode: true,
        deletedAt: true,
        termsAcceptances: {
          orderBy: { acceptedAt: "desc" },
          select: {
            acceptedAt: true,
            termsDocument: {
              select: { version: true }
            }
          }
        },
        clientProfile: {
          select: {
            dateOfBirth: true,
            declaredAdultAt: true,
            assignments: {
              where: { endedAt: null },
              take: 1,
              select: {
                id: true,
                startedAt: true,
                startReason: true,
                cashier: {
                  select: {
                    email: true,
                    phoneE164: true,
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
            reassignments: {
              where: { status: ReassignmentStatus.PENDING },
              take: 1,
              orderBy: { requestedAt: "asc" },
              select: {
                id: true,
                reason: true,
                requestedAt: true,
                attemptCount: true,
                lastAttemptAt: true
              }
            },
            _count: {
              select: {
                blocks: {
                  where: { initiatedBy: BlockInitiator.CASHIER }
                }
              }
            }
          }
        },
        cashierProfile: {
          select: {
            dateOfBirth: true,
            declaredAdultAt: true,
            email: true,
            normalizedEmail: true,
            phoneE164: true,
            emailVerifiedAt: true,
            phoneVerifiedAt: true,
            approvalStatus: true,
            approvedAt: true,
            subscriptions: {
              orderBy: { createdAt: "desc" },
              take: 20,
              select: {
                id: true,
                status: true,
                startsAt: true,
                endsAt: true,
                reasonCode: true,
                createdAt: true,
                updatedAt: true
              }
            },
            _count: {
              select: {
                assignments: {
                  where: { endedAt: null }
                }
              }
            }
          }
        }
      }
    });

    if (!user) {
      throw new NotFoundException("El usuario no existe.");
    }
    const now = await this.databaseNow(this.prisma);
    return user.cashierProfile
      ? {
          ...user,
          cashierProfile: {
            ...user.cashierProfile,
            subscriptions: user.cashierProfile.subscriptions.map(
              (subscription) => ({
                ...subscription,
                effectiveStatus: this.effectiveSubscriptionStatus(
                  subscription,
                  now
                )
              })
            )
          }
        }
      : user;
  }

  async update(
    adminUserId: string,
    userId: string,
    input: UpdateAdminUserDto
  ) {
    const reason = ADMIN_AUTOMATIC_REASON.USER_UPDATED;
    const hasUsername = input.username !== undefined;
    const hasEmail = input.email !== undefined;
    const hasPhone = input.phone !== undefined;

    if (!hasUsername && !hasEmail && !hasPhone) {
      throw new BadRequestException(
        "Debes indicar al menos un dato para modificar."
      );
    }

    try {
      return await this.assignments.runSerializable(async (tx) => {
        const user = await this.getActionTarget(tx, userId);
        this.assertManageableRole(user.role);
        if (user.status === AccountStatus.DELETED) {
          throw new ConflictException("La cuenta está eliminada.");
        }
        if (
          user.role !== UserRole.CASHIER &&
          (hasEmail || hasPhone)
        ) {
          throw new BadRequestException(
            "El correo y el teléfono solo corresponden a cuentas de cajero."
          );
        }
        if (user.role === UserRole.CLIENT && !user.clientProfile) {
          throw new ConflictException("El perfil del cliente está incompleto.");
        }
        if (user.role === UserRole.CASHIER && !user.cashierProfile) {
          throw new ConflictException("El perfil del cajero está incompleto.");
        }

        const nextUsername = input.username?.trim();
        const nextEmail = input.email?.trim();
        const nextPhone = input.phone?.trim();
        const usernameChanged =
          nextUsername !== undefined && nextUsername !== user.username;
        const emailChanged =
          nextEmail !== undefined &&
          nextEmail !== user.cashierProfile?.email;
        const phoneChanged =
          nextPhone !== undefined &&
          nextPhone !== user.cashierProfile?.phoneE164;

        if (!usernameChanged && !emailChanged && !phoneChanged) {
          throw new BadRequestException(
            "Los datos indicados coinciden con los actuales."
          );
        }

        const stateBefore: Record<string, string> = {};
        const stateAfter: Record<string, string> = {};
        let username = user.username;
        let email = user.cashierProfile?.email;
        let phoneE164 = user.cashierProfile?.phoneE164;

        if (usernameChanged && nextUsername) {
          stateBefore.username = user.username;
          stateAfter.username = nextUsername;
          const updatedUser = await tx.user.update({
            where: { id: userId },
            data: {
              username: nextUsername,
              normalizedUsername: nextUsername.toLowerCase()
            },
            select: { username: true }
          });
          username = updatedUser.username;
        }

        if ((emailChanged || phoneChanged) && user.cashierProfile) {
          const now = new Date();
          if (emailChanged && nextEmail) {
            stateBefore.email = user.cashierProfile.email;
            stateAfter.email = nextEmail;
          }
          if (phoneChanged && nextPhone) {
            stateBefore.phone = user.cashierProfile.phoneE164;
            stateAfter.phone = nextPhone;
          }

          const updatedProfile = await tx.cashierProfile.update({
            where: { userId },
            data: {
              ...(emailChanged && nextEmail
                ? {
                    email: nextEmail,
                    normalizedEmail: nextEmail.toLowerCase(),
                    emailVerifiedAt:
                      user.cashierProfile.approvalStatus ===
                      CashierApprovalStatus.APPROVED
                        ? now
                        : null
                  }
                : {}),
              ...(phoneChanged && nextPhone
                ? {
                    phoneE164: nextPhone,
                    phoneVerifiedAt:
                      user.cashierProfile.approvalStatus ===
                      CashierApprovalStatus.APPROVED
                        ? now
                        : null
                  }
                : {})
            },
            select: {
              email: true,
              phoneE164: true
            }
          });
          email = updatedProfile.email;
          phoneE164 = updatedProfile.phoneE164;
        }

        await this.audit(tx, {
          actorAdminId: adminUserId,
          action: AdminAuditAction.USER_UPDATED,
          targetType: AdminAuditTargetType.USER,
          targetId: userId,
          targetUserId: userId,
          reasonCode: reason,
          stateBefore: JSON.stringify(stateBefore),
          stateAfter: JSON.stringify(stateAfter)
        });

        return {
          id: userId,
          username,
          role: user.role,
          status: user.status,
          cashierProfile:
            user.role === UserRole.CASHIER
              ? { email, phoneE164 }
              : null
        };
      });
    } catch (error: unknown) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          "El usuario, correo o teléfono ya está registrado."
        );
      }
      throw error;
    }
  }

  async deleteUser(
    adminUserId: string,
    userId: string
  ) {
    const reason = ADMIN_AUTOMATIC_REASON.USER_DELETED;

    const result = await this.assignments.runSerializable(async (tx) => {
      const user = await this.getActionTarget(tx, userId);
      this.assertManageableRole(user.role);
      if (user.status === AccountStatus.DELETED) {
        throw new ConflictException("La cuenta ya está eliminada.");
      }
      if (user.role === UserRole.CLIENT && !user.clientProfile) {
        throw new ConflictException("El perfil del cliente está incompleto.");
      }
      if (user.role === UserRole.CASHIER && !user.cashierProfile) {
        throw new ConflictException("El perfil del cajero está incompleto.");
      }

      const now = new Date();
      let relationships:
        | Awaited<
            ReturnType<
              AssignmentsService["endClientRelationshipsForDeletionInTransaction"]
            >
          >
        | undefined;
      let reassignments: Awaited<
        ReturnType<
          AssignmentsService["reassignCashierClientsInTransaction"]
        >
      > = [];
      let subscriptionsCancelled = 0;
      let invitationsRevoked = 0;

      if (user.role === UserRole.CLIENT) {
        relationships =
          await this.assignments.endClientRelationshipsForDeletionInTransaction(
            tx,
            userId,
            now
          );
      } else if (user.role === UserRole.CASHIER) {
        reassignments =
          await this.assignments.reassignCashierClientsInTransaction(tx, {
            cashierUserId: userId,
            adminUserId,
            reasonCode: reason,
            assignmentEndReason: AssignmentEndReason.ACCOUNT_DELETED
          });

        const activeSubscriptions =
          await tx.cashierSubscription.findMany({
            where: {
              cashierUserId: userId,
              status: SubscriptionStatus.ACTIVE
            },
            select: {
              id: true,
              startsAt: true
            }
          });
        for (const subscription of activeSubscriptions) {
          await tx.cashierSubscription.update({
            where: { id: subscription.id },
            data: {
              status: SubscriptionStatus.CANCELLED,
              endsAt: this.validEnd(subscription.startsAt, now),
              reasonCode: "ACCOUNT_DELETED"
            }
          });
        }
        subscriptionsCancelled = activeSubscriptions.length;

        const invitations = await tx.cashierInvitation.updateMany({
          where: {
            cashierUserId: userId,
            revokedAt: null
          },
          data: { revokedAt: now }
        });
        invitationsRevoked = invitations.count;

        await tx.cashierProfile.update({
          where: { userId },
          data: {
            approvalStatus: CashierApprovalStatus.REVOKED
          }
        });
      }

      await tx.user.update({
        where: { id: userId },
        data: {
          status: AccountStatus.DELETED,
          deletedAt: now,
          suspendedAt: null,
          suspensionReasonCode: null,
          sessionVersion: { increment: 1 }
        }
      });
      const sessions = await tx.authSession.updateMany({
        where: {
          userId,
          revokedAt: null
        },
        data: {
          revokedAt: now,
          revocationReason: "ADMIN_ACCOUNT_DELETION"
        }
      });
      await this.audit(tx, {
        actorAdminId: adminUserId,
        action: AdminAuditAction.USER_DELETED,
        targetType: AdminAuditTargetType.USER,
        targetId: userId,
        targetUserId: userId,
        reasonCode: reason,
        stateBefore: user.status,
        stateAfter: AccountStatus.DELETED
      });

      return {
        id: userId,
        status: AccountStatus.DELETED,
        sessionsRevoked: sessions.count,
        clientRelationships: relationships,
        cashierReassignments: this.summarizeReassignments(reassignments),
        subscriptionsCancelled,
        invitationsRevoked
      };
    });
    this.realtime.disconnectUser(userId);
    return result;
  }

  async resetPassword(
    adminUserId: string,
    userId: string
  ) {
    const reason = ADMIN_AUTOMATIC_REASON.CASHIER_PASSWORD_RESET;

    const result = await this.assignments.runSerializable(async (tx) => {
      const user = await this.getActionTarget(tx, userId);
      this.assertManageableRole(user.role);
      if (user.role !== UserRole.CASHIER) {
        throw new ForbiddenException(
          "Solo las cuentas de cajero admiten restablecimiento administrativo de contraseña."
        );
      }
      if (user.status === AccountStatus.DELETED) {
        throw new ConflictException(
          "No se puede restablecer la contraseña de una cuenta eliminada."
        );
      }

      const clockRows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
        SELECT clock_timestamp() AS "now"
      `);
      const now = clockRows[0]?.now;
      if (!now) {
        throw new Error("No se pudo consultar el reloj de PostgreSQL.");
      }
      const expiresAt = cashierPasswordResetExpiresAt(now);
      await tx.cashierPasswordReset.updateMany({
        where: {
          cashierUserId: userId,
          consumedAt: null,
          supersededAt: null
        },
        data: { supersededAt: now }
      });
      const resetRequest = await tx.cashierPasswordReset.create({
        data: {
          cashierUserId: userId,
          initiatedByAdminUserId: adminUserId,
          createdAt: now,
          expiresAt
        },
        select: { id: true, createdAt: true, expiresAt: true }
      });
      const updated = await tx.user.update({
        where: { id: userId },
        data: {
          passwordResetRequired: true,
          sessionVersion: { increment: 1 },
          failedLoginAttempts: 0,
          lockedUntil: null
        },
        select: {
          id: true
        }
      });
      const sessions = await tx.authSession.updateMany({
        where: {
          userId,
          revokedAt: null
        },
        data: {
          revokedAt: now,
          revocationReason: "ADMIN_PASSWORD_RESET"
        }
      });
      await this.deviceLists?.publishCurrentRelationshipsForUser(
        tx,
        userId,
        "LEFT",
        now
      );
      await this.audit(tx, {
        actorAdminId: adminUserId,
        action: AdminAuditAction.PASSWORD_RESET,
        targetType: AdminAuditTargetType.USER,
        targetId: userId,
        targetUserId: userId,
        reasonCode: reason,
        stateBefore: user.passwordResetRequired
          ? "PASSWORD_CHANGE_REQUIRED"
          : "PASSWORD_ACTIVE",
        stateAfter: "PASSWORD_CHANGE_REQUIRED"
      });
      await this.notifyAccountStatus(tx, userId);

      return {
        id: updated.id,
        resetRequestId: resetRequest.id,
        resetRequestedAt: resetRequest.createdAt,
        resetExpiresAt: resetRequest.expiresAt,
        passwordResetRequired: true,
        sessionsRevoked: sessions.count
      };
    });
    this.realtime.disconnectUser(userId);
    return result;
  }

  async approveCashier(
    adminUserId: string,
    cashierUserId: string
  ) {
    const reason = ADMIN_AUTOMATIC_REASON.CASHIER_APPROVED;

    return this.assignments.runSerializable(async (tx) => {
      const user = await this.getActionTarget(tx, cashierUserId);
      if (user.role !== UserRole.CASHIER) {
        throw new BadRequestException("El usuario no es cajero.");
      }
      if (!user.cashierProfile) {
        throw new ConflictException("El perfil del cajero está incompleto.");
      }
      if (
        user.cashierProfile?.approvalStatus ===
        CashierApprovalStatus.APPROVED
      ) {
        throw new ConflictException("El cajero ya está aprobado.");
      }
      if (
        user.status === AccountStatus.SUSPENDED ||
        user.status === AccountStatus.DELETED
      ) {
        throw new ConflictException(
          "No se puede aprobar una cuenta suspendida o eliminada."
        );
      }

      const now = new Date();
      const profile = await tx.cashierProfile.update({
        where: { userId: cashierUserId },
        data: {
          approvalStatus: CashierApprovalStatus.APPROVED,
          approvedAt: now,
          approvedByAdminId: adminUserId,
          emailVerifiedAt: now,
          phoneVerifiedAt: now
        },
        select: {
          userId: true,
          approvalStatus: true,
          approvedAt: true
        }
      });
      await tx.user.update({
        where: { id: cashierUserId },
        data: {
          status: AccountStatus.ACTIVE,
          suspendedAt: null,
          suspensionReasonCode: null
        }
      });
      await this.audit(tx, {
        actorAdminId: adminUserId,
        action: AdminAuditAction.CASHIER_APPROVED,
        targetType: AdminAuditTargetType.CASHIER_PROFILE,
        targetId: cashierUserId,
        targetUserId: cashierUserId,
        reasonCode: reason,
        stateBefore: user.status,
        stateAfter: CashierApprovalStatus.APPROVED
      });
      await this.notifyAccountStatus(tx, cashierUserId);
      const pending = await this.assignments.retryPendingInTransaction(
        tx,
        adminUserId,
        reason,
        100
      );

      return {
        ...profile,
        pendingProcessed: this.summarizeReassignments(pending)
      };
    });
  }

  async suspend(
    adminUserId: string,
    userId: string
  ) {
    const reason = ADMIN_AUTOMATIC_REASON.USER_SUSPENDED;

    const result = await this.assignments.runSerializable(async (tx) => {
      const user = await this.getActionTarget(tx, userId);
      this.assertManageableRole(user.role);
      if (user.status === AccountStatus.SUSPENDED) {
        throw new ConflictException("La cuenta ya está suspendida.");
      }
      if (user.status === AccountStatus.DELETED) {
        throw new ConflictException("La cuenta está eliminada.");
      }

      const now = new Date();
      await tx.user.update({
        where: { id: userId },
        data: {
          status: AccountStatus.SUSPENDED,
          suspendedAt: now,
          suspensionReasonCode: reason,
          sessionVersion: { increment: 1 }
        }
      });
      await tx.authSession.updateMany({
        where: {
          userId,
          revokedAt: null
        },
        data: {
          revokedAt: now,
          revocationReason: "ADMIN_SUSPENSION"
        }
      });

      if (user.role === UserRole.CLIENT) {
        await this.deviceLists?.publishCurrentRelationshipsForUser(
          tx,
          userId,
          "LEFT",
          now
        );
      }

      const reassignments =
        user.role === UserRole.CASHIER
          ? await this.assignments.reassignCashierClientsInTransaction(tx, {
              cashierUserId: userId,
              adminUserId,
              reasonCode: reason,
              assignmentEndReason: AssignmentEndReason.CASHIER_SUSPENDED
            })
          : [];

      await this.audit(tx, {
        actorAdminId: adminUserId,
        action: AdminAuditAction.USER_SUSPENDED,
        targetType: AdminAuditTargetType.USER,
        targetId: userId,
        targetUserId: userId,
        reasonCode: reason,
        stateBefore: user.status,
        stateAfter: AccountStatus.SUSPENDED
      });
      await this.notifyAccountStatus(tx, userId);

      return {
        id: userId,
        status: AccountStatus.SUSPENDED,
        reassignments: this.summarizeReassignments(reassignments)
      };
    });
    this.realtime.disconnectUser(userId);
    return result;
  }

  async reactivate(
    adminUserId: string,
    userId: string
  ) {
    const reason = ADMIN_AUTOMATIC_REASON.USER_REACTIVATED;

    return this.assignments.runSerializable(async (tx) => {
      const user = await this.getActionTarget(tx, userId);
      this.assertManageableRole(user.role);
      if (user.status !== AccountStatus.SUSPENDED) {
        throw new ConflictException("La cuenta no está suspendida.");
      }
      const restoredStatus =
        user.role === UserRole.CASHIER &&
        user.cashierProfile?.approvalStatus !==
          CashierApprovalStatus.APPROVED
          ? AccountStatus.PENDING
          : AccountStatus.ACTIVE;
      const now = await this.databaseNow(tx);

      await tx.user.update({
        where: { id: userId },
        data: {
          status: restoredStatus,
          suspendedAt: null,
          suspensionReasonCode: null,
          sessionVersion: { increment: 1 }
        }
      });
      await this.audit(tx, {
        actorAdminId: adminUserId,
        action: AdminAuditAction.USER_REACTIVATED,
        targetType: AdminAuditTargetType.USER,
        targetId: userId,
        targetUserId: userId,
        reasonCode: reason,
        stateBefore: AccountStatus.SUSPENDED,
        stateAfter: restoredStatus
      });
      await this.notifyAccountStatus(tx, userId);

      if (
        user.role === UserRole.CLIENT &&
        restoredStatus === AccountStatus.ACTIVE
      ) {
        await this.deviceLists?.publishCurrentRelationshipsForUser(
          tx,
          userId,
          "CHANGED",
          now
        );
      }

      const pending =
        user.role === UserRole.CASHIER
          ? restoredStatus === AccountStatus.ACTIVE
            ? await this.assignments.retryPendingInTransaction(
                tx,
                adminUserId,
                reason,
                100
              )
            : []
          : [
              await this.assignments.retryClientPendingInTransaction(
                tx,
                userId,
                adminUserId,
                reason
              )
            ].filter((outcome) => outcome !== null);

      return {
        id: userId,
        status: restoredStatus,
        pendingProcessed: this.summarizeReassignments(pending)
      };
    });
  }

  async activateSubscription(
    adminUserId: string,
    cashierUserId: string,
    rawEndsAt?: string
  ) {
    const reason = ADMIN_AUTOMATIC_REASON.SUBSCRIPTION_ACTIVATED;
    const endsAt = rawEndsAt ? new Date(rawEndsAt) : null;
    if (endsAt && Number.isNaN(endsAt.getTime())) {
      throw new BadRequestException(
        "El vencimiento de la suscripción no es válido."
      );
    }

    return this.assignments.runSerializable(async (tx) => {
      await this.assertCashier(tx, cashierUserId);
      await this.acquireSubscriptionExpiryLock(tx, cashierUserId);
      const now = await this.databaseNow(tx);
      if (endsAt && endsAt <= now) {
        throw new BadRequestException(
          "El vencimiento debe ser posterior al momento actual."
        );
      }

      const active = await tx.cashierSubscription.findMany({
        where: {
          cashierUserId,
          status: SubscriptionStatus.ACTIVE
        },
        orderBy: { startsAt: "desc" }
      });
      const currentlyActive = active.some(
        (subscription) =>
          subscription.startsAt <= now &&
          (!subscription.endsAt || subscription.endsAt > now)
      );
      if (currentlyActive) {
        throw new ConflictException("La suscripción ya está activa.");
      }
      const awaitingExpiryReconciliation = active.some(
        (subscription) =>
          subscription.endsAt !== null && subscription.endsAt <= now
      );
      if (awaitingExpiryReconciliation) {
        // El worker solo puede reclamar periodos vencidos que sigan ACTIVE.
        // No se cambia ese estado aquí: hacerlo antes de la conciliación
        // dejaría la clientela histórica sin reasignar.
        throw new ConflictException(
          "La suscripción vencida aún está conciliando su clientela. Espera al worker e inténtalo nuevamente."
        );
      }
      if (active.length > 0) {
        throw new ConflictException(
          "Ya existe un período de suscripción activo o programado."
        );
      }

      const subscription = await tx.cashierSubscription.create({
        data: {
          cashierUserId,
          status: SubscriptionStatus.ACTIVE,
          startsAt: now,
          endsAt,
          managedByAdminUserId: adminUserId,
          reasonCode: reason
        },
        select: {
          id: true,
          status: true,
          startsAt: true,
          endsAt: true
        }
      });
      await this.audit(tx, {
        actorAdminId: adminUserId,
        action: AdminAuditAction.SUBSCRIPTION_ACTIVATED,
        targetType: AdminAuditTargetType.SUBSCRIPTION,
        targetId: subscription.id,
        targetUserId: cashierUserId,
        reasonCode: reason,
        stateBefore: active[0]?.status ?? SubscriptionStatus.INACTIVE,
        stateAfter: SubscriptionStatus.ACTIVE
      });
      const pending = await this.assignments.retryPendingInTransaction(
        tx,
        adminUserId,
        reason,
        100
      );

      return {
        ...subscription,
        pendingProcessed: this.summarizeReassignments(pending)
      };
    });
  }

  async deactivateSubscription(
    adminUserId: string,
    cashierUserId: string
  ) {
    const reason = ADMIN_AUTOMATIC_REASON.SUBSCRIPTION_DEACTIVATED;

    return this.assignments.runSerializable(async (tx) => {
      await this.assertCashier(tx, cashierUserId);
      await this.acquireSubscriptionExpiryLock(tx, cashierUserId);
      const now = await this.databaseNow(tx);
      const active = await tx.$queryRaw<
        Array<{
          id: string;
          startsAt: Date;
          endsAt: Date | null;
          updatedAt: Date;
        }>
      >(Prisma.sql`
        SELECT
          cs."id",
          cs."starts_at" AS "startsAt",
          cs."ends_at" AS "endsAt",
          cs."updated_at" AS "updatedAt"
          FROM "cashier_subscriptions" cs
         WHERE cs."cashier_user_id" = ${cashierUserId}::uuid
           AND cs."status" = 'ACTIVE'
         ORDER BY cs."starts_at" DESC, cs."id" ASC
         FOR UPDATE OF cs SKIP LOCKED
      `);
      if (active.length === 0) {
        const activeButLocked = await tx.cashierSubscription.count({
          where: {
            cashierUserId,
            status: SubscriptionStatus.ACTIVE
          }
        });
        if (activeButLocked > 0) {
          throw new ConflictException(
            "La suscripción está siendo conciliada. Espera unos segundos e inténtalo nuevamente."
          );
        }
        throw new ConflictException("El cajero no tiene una suscripción activa.");
      }

      for (const subscription of active) {
        const proposedEnd =
          subscription.endsAt && subscription.endsAt <= now
            ? subscription.endsAt
            : now;
        const updated = await tx.cashierSubscription.updateMany({
          where: {
            id: subscription.id,
            cashierUserId,
            status: SubscriptionStatus.ACTIVE,
            updatedAt: subscription.updatedAt
          },
          data: {
            status: SubscriptionStatus.INACTIVE,
            endsAt: this.validEnd(subscription.startsAt, proposedEnd),
            reasonCode: reason,
            updatedAt: now
          }
        });
        if (updated.count !== 1) {
          throw new ConflictException(
            "La suscripción cambió durante la desactivación. Inténtalo nuevamente."
          );
        }
      }
      const reassignments =
        await this.assignments.reassignCashierClientsInTransaction(tx, {
          cashierUserId,
          adminUserId,
          reasonCode: reason,
          assignmentEndReason: AssignmentEndReason.CASHIER_UNAVAILABLE
        });
      await this.audit(tx, {
        actorAdminId: adminUserId,
        action: AdminAuditAction.SUBSCRIPTION_DEACTIVATED,
        targetType: AdminAuditTargetType.SUBSCRIPTION,
        targetId: active[0].id,
        targetUserId: cashierUserId,
        reasonCode: reason,
        stateBefore: SubscriptionStatus.ACTIVE,
        stateAfter: SubscriptionStatus.INACTIVE
      });

      return {
        cashierUserId,
        status: SubscriptionStatus.INACTIVE,
        effectiveStatus: "INACTIVE" as const,
        reassignments: this.summarizeReassignments(reassignments)
      };
    });
  }

  private async getActionTarget(
    tx: Prisma.TransactionClient,
    userId: string
  ) {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        passwordResetRequired: true,
        clientProfile: {
          select: {
            userId: true
          }
        },
        cashierProfile: {
          select: {
            approvalStatus: true,
            email: true,
            phoneE164: true
          }
        }
      }
    });
    if (!user) {
      throw new NotFoundException("El usuario no existe.");
    }
    return user;
  }

  private assertManageableRole(role: UserRole): void {
    if (role === UserRole.ADMIN) {
      throw new ForbiddenException(
        "Este endpoint no modifica cuentas administradoras."
      );
    }
  }

  private async assertCashier(
    tx: Prisma.TransactionClient,
    cashierUserId: string
  ): Promise<void> {
    const cashier = await tx.cashierProfile.findFirst({
      where: {
        userId: cashierUserId,
        user: {
          role: UserRole.CASHIER,
          status: { not: AccountStatus.DELETED }
        }
      },
      select: { userId: true }
    });
    if (!cashier) {
      throw new NotFoundException("El cajero no existe.");
    }
  }

  private async notifyAccountStatus(
    tx: Prisma.TransactionClient,
    userId: string
  ): Promise<void> {
    await tx.inAppNotification.create({
      data: {
        userId,
        type: NotificationType.ACCOUNT_STATUS_CHANGED
      }
    });
  }

  private async audit(
    tx: Prisma.TransactionClient,
    input: {
      actorAdminId: string;
      action: AdminAuditAction;
      targetType: AdminAuditTargetType;
      targetId: string;
      targetUserId: string;
      reasonCode: string;
      stateBefore: string;
      stateAfter: string;
    }
  ): Promise<void> {
    await tx.adminAuditEvent.create({
      data: {
        ...input,
        requestId: randomUUID()
      }
    });
  }

  private summarizeReassignments(
    outcomes: readonly { status: "REASSIGNED" | "PENDING_REASSIGNMENT" }[]
  ) {
    return {
      total: outcomes.length,
      reassigned: outcomes.filter(
        (outcome) => outcome.status === "REASSIGNED"
      ).length,
      pending: outcomes.filter(
        (outcome) => outcome.status === "PENDING_REASSIGNMENT"
      ).length
    };
  }

  private effectiveSubscriptionStatus(
    subscription: {
      status: SubscriptionStatus;
      startsAt: Date;
      endsAt: Date | null;
    },
    now: Date
  ): EffectiveSubscriptionStatus {
    if (subscription.status === SubscriptionStatus.ACTIVE) {
      if (subscription.startsAt > now) {
        return "SCHEDULED";
      }
      if (subscription.endsAt && subscription.endsAt <= now) {
        return "EXPIRED_PENDING";
      }
      return "ACTIVE";
    }
    return subscription.status;
  }

  private async databaseNow(
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

  private async acquireSubscriptionExpiryLock(
    tx: Prisma.TransactionClient,
    cashierUserId: string
  ): Promise<void> {
    const locks = await tx.$queryRaw<Array<{ acquired: boolean }>>(
      Prisma.sql`
        SELECT pg_try_advisory_xact_lock(
          hashtextextended(
            'sinochat:subscription-expiry:' || ${cashierUserId}::text,
            0
          )
        ) AS "acquired"
      `
    );
    if (locks[0]?.acquired !== true) {
      throw new ConflictException(
        "La suscripción está siendo conciliada. Espera unos segundos e inténtalo nuevamente."
      );
    }
  }

  private validEnd(startsAt: Date, proposed: Date): Date {
    return proposed > startsAt
      ? proposed
      : new Date(startsAt.getTime() + 1);
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    );
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      (error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002") ||
      (typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "P2002")
    );
  }
}
