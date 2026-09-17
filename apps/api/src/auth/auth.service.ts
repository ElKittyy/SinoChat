import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from "@nestjs/common";
import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  AccountStatus,
  AdminAuditAction,
  AdminAuditTargetType,
  AssignmentStartReason,
  CashierApprovalStatus,
  DeviceStatus,
  SubscriptionStatus,
  UserRole
} from "../generated/prisma/enums";
import { Prisma } from "../generated/prisma/client";
import { PrismaService } from "../database/prisma.service";
import { MatrixDeviceListPublisher } from "../database/matrix-device-list.publisher";
import { readSessionConfig } from "../config/runtime-config";
import { lockTermsLifecycle } from "../legal/terms-lifecycle-lock";
import { CompleteAdminResetDto } from "./dto/complete-admin-reset.dto";
import { LoginDto } from "./dto/login.dto";
import { RegisterCashierDto } from "./dto/register-cashier.dto";
import { RegisterClientDto } from "./dto/register-client.dto";
import type { RotateRecoveryCodesDto } from "./dto/rotate-recovery-codes.dto";
import { PasswordService } from "./password.service";
import { SessionTokenService } from "./session-token.service";
import {
  CASHIER_RECOVERY_CODE_PATTERN,
  cashierPasswordResetExpiresAt,
  hashCashierRecoveryCode,
  issueCashierRecoveryCodes,
  normalizeCashierRecoveryCode,
} from "./cashier-recovery-code";
import type {
  AdminSessionSummary,
  AuthResult,
  CashierRegistrationResult,
  PublicUser,
  RequestMetadata,
  SessionPrincipal
} from "./auth.types";

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: SessionTokenService,
    private readonly deviceLists?: MatrixDeviceListPublisher
  ) {}

  async registerCashier(
    input: RegisterCashierDto,
    metadata: RequestMetadata
  ): Promise<CashierRegistrationResult> {
    if (!input.termsAccepted) {
      throw new BadRequestException("Debes aceptar los términos.");
    }
    const decisionTime = await this.databaseNow(this.prisma);
    if (!this.isAdult(input.dateOfBirth, decisionTime)) {
      throw new BadRequestException("Debes ser mayor de 18 años.");
    }

    const codeLookupHash = this.invitationLookupHash(input.invitationCode);
    const invitation = await this.prisma.cashierOnboardingInvitation.findFirst({
      where: {
        codeLookupHash,
        redeemedAt: null,
        revokedAt: null,
        expiresAt: { gt: decisionTime }
      },
      select: { id: true }
    });
    const terms = await this.acceptedTermsIdentity(input.termsVersion);

    if (!invitation || !terms) {
      throw new BadRequestException(
        "La invitación no es válida o el registro no está disponible."
      );
    }
    this.assertAcceptedTerms(
      terms,
      input.termsVersion,
      input.termsContentHash
    );

    const normalizedUsername = this.normalizeUsername(input.username);
    const normalizedEmail = input.email.trim().toLowerCase();
    const passwordHash = await this.passwords.hash(input.password);
    const dateOfBirth = new Date(`${input.dateOfBirth}T00:00:00.000Z`);
    const recovery = issueCashierRecoveryCodes(decisionTime);

    try {
      const user = await this.runRegistrationTransaction(async (tx) => {
        await lockTermsLifecycle(tx);
        const acceptedTerms = await this.currentTermsInTransaction(tx);
        this.assertAcceptedTerms(
          acceptedTerms,
          input.termsVersion,
          input.termsContentHash
        );
        const created = await tx.user.create({
          data: {
            role: UserRole.CASHIER,
            username: input.username.trim(),
            normalizedUsername,
            passwordHash,
            status: AccountStatus.PENDING,
            cashierProfile: {
              create: {
                dateOfBirth,
                declaredAdultAt: acceptedTerms.acceptedAt,
                email: input.email.trim(),
                normalizedEmail,
                phoneE164: input.phone.trim(),
                approvalStatus: CashierApprovalStatus.PENDING
              }
            },
            termsAcceptances: {
              create: {
                termsDocumentId: acceptedTerms.id,
                acceptedAt: acceptedTerms.acceptedAt,
                ipHash: this.hashMetadata(metadata.ip)
              }
            }
          }
        });

        await tx.cashierRecoveryCode.createMany({
          data: recovery.codes.map((code) => ({
            cashierUserId: created.id,
            codeHash: hashCashierRecoveryCode(created.id, code),
            createdAt: decisionTime,
            expiresAt: recovery.expiresAt,
          })),
        });

        const redemption = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          WITH "current_clock" AS (
            SELECT clock_timestamp() AS "now"
          )
          UPDATE "cashier_onboarding_invitations" AS "invitation"
             SET "redeemed_by_cashier_id" = ${created.id},
                 "redeemed_at" = "current_clock"."now"
            FROM "current_clock"
           WHERE "invitation"."id" = ${invitation.id}
             AND "invitation"."redeemed_at" IS NULL
             AND "invitation"."revoked_at" IS NULL
             AND "invitation"."expires_at" > "current_clock"."now"
          RETURNING "invitation"."id"
        `);

        if (redemption.length !== 1) {
          throw new BadRequestException("La invitación ya no está disponible.");
        }

        return created;
      });

      return {
        ...(await this.createSession(user, metadata)),
        recoveryCodes: recovery.codes,
        recoveryCodesExpireAt: recovery.expiresAt,
      };
    } catch (error: unknown) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          "El usuario, correo o teléfono ya está registrado."
        );
      }
      throw error;
    }
  }

  async registerClient(
    input: RegisterClientDto,
    metadata: RequestMetadata
  ): Promise<AuthResult> {
    if (!input.termsAccepted) {
      throw new BadRequestException("Debes aceptar los términos.");
    }
    const decisionTime = await this.databaseNow(this.prisma);
    if (!this.isAdult(input.dateOfBirth, decisionTime)) {
      throw new BadRequestException("Debes ser mayor de 18 años.");
    }

    const codeLookupHash = this.invitationLookupHash(input.invitationCode);
    const invitation = await this.prisma.cashierInvitation.findFirst({
      where: {
        codeLookupHash,
        revokedAt: null,
        cashier: {
          approvalStatus: CashierApprovalStatus.APPROVED,
          user: {
            status: AccountStatus.ACTIVE,
            passwordResetRequired: false
          },
          subscriptions: {
            some: {
              status: SubscriptionStatus.ACTIVE,
              startsAt: { lte: decisionTime },
              OR: [
                { endsAt: null },
                { endsAt: { gt: decisionTime } }
              ]
            }
          }
        }
      },
      select: {
        id: true,
        cashierUserId: true
      }
    });

    if (!invitation) {
      throw new BadRequestException(
        "El código no es válido o el cajero no está disponible."
      );
    }

    const terms = await this.acceptedTermsIdentity(input.termsVersion);

    if (!terms) {
      throw new BadRequestException(
        "El registro está temporalmente deshabilitado."
      );
    }
    this.assertAcceptedTerms(
      terms,
      input.termsVersion,
      input.termsContentHash
    );

    const normalizedUsername = this.normalizeUsername(input.username);
    const passwordHash = await this.passwords.hash(input.password);
    const dateOfBirth = new Date(`${input.dateOfBirth}T00:00:00.000Z`);

    try {
      const user = await this.runRegistrationTransaction(async (tx) => {
        await lockTermsLifecycle(tx);
        const acceptedTerms = await this.currentTermsInTransaction(tx);
        this.assertAcceptedTerms(
          acceptedTerms,
          input.termsVersion,
          input.termsContentHash
        );
        const created = await tx.user.create({
          data: {
            role: UserRole.CLIENT,
            username: input.username.trim(),
            normalizedUsername,
            passwordHash,
            status: AccountStatus.ACTIVE,
            clientProfile: {
              create: {
                dateOfBirth,
                declaredAdultAt: acceptedTerms.acceptedAt
              }
            },
            termsAcceptances: {
              create: {
                termsDocumentId: acceptedTerms.id,
                acceptedAt: acceptedTerms.acceptedAt,
                ipHash: this.hashMetadata(metadata.ip)
              }
            }
          }
        });

        await tx.assignment.create({
          data: {
            clientUserId: created.id,
            cashierUserId: invitation.cashierUserId,
            invitationId: invitation.id,
            startReason: AssignmentStartReason.INVITATION,
            conversation: {
              create: {}
            }
          }
        });

        return created;
      });

      return this.createSession(user, metadata);
    } catch (error: unknown) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException("Ese nombre de usuario ya está registrado.");
      }
      throw error;
    }
  }

  async login(
    input: LoginDto,
    metadata: RequestMetadata
  ): Promise<AuthResult> {
    const normalizedUsername = this.normalizeUsername(input.username);
    const user = await this.prisma.user.findUnique({
      where: { normalizedUsername }
    });

    if (!user) {
      await this.passwords.verifyAgainstDummy(input.password);
      throw new UnauthorizedException("Credenciales inválidas.");
    }

    const now = await this.databaseNow(this.prisma);
    if (user.lockedUntil && user.lockedUntil > now) {
      await this.passwords.verifyAgainstDummy(input.password);
      throw new UnauthorizedException("Credenciales inválidas.");
    }

    const validPassword = await this.passwords.verify(
      user.passwordHash,
      input.password
    );

    if (!validPassword) {
      await this.recordFailedLoginAttempt(user.id);
      throw new UnauthorizedException("Credenciales inválidas.");
    }

    if (
      user.status === AccountStatus.SUSPENDED ||
      user.status === AccountStatus.DELETED
    ) {
      throw new UnauthorizedException("La cuenta no está disponible.");
    }

    if (user.passwordResetRequired) {
      throw new UnauthorizedException({
        code: "ADMIN_PASSWORD_CHANGE_REQUIRED",
        message:
          "Debes completar el restablecimiento de contraseña antes de iniciar sesión."
      });
    }

    const successfulLogin = await this.prisma.user.updateMany({
      where: {
        id: user.id,
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
        passwordResetRequired: false,
        status: { notIn: [AccountStatus.SUSPENDED, AccountStatus.DELETED] }
      },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: now
      }
    });

    if (successfulLogin.count !== 1) {
      throw new UnauthorizedException("Credenciales inválidas.");
    }

    return this.createSession(user, metadata);
  }

  async completeAdminReset(input: CompleteAdminResetDto): Promise<void> {
    const normalizedUsername = this.normalizeUsername(input.username);
    const recoveryCode = normalizeCashierRecoveryCode(input.recoveryCode);
    if (!CASHIER_RECOVERY_CODE_PATTERN.test(recoveryCode)) {
      await this.passwords.verifyAgainstDummy(input.recoveryCode);
      throw this.invalidAdminReset();
    }
    const user = await this.prisma.user.findUnique({
      where: { normalizedUsername },
      select: {
        id: true,
        role: true,
        status: true,
        passwordHash: true,
        passwordResetRequired: true,
        lockedUntil: true,
      },
    });

    if (
      !user ||
      user.role !== UserRole.CASHIER ||
      !user.passwordResetRequired ||
      user.status === AccountStatus.DELETED
    ) {
      await this.passwords.verifyAgainstDummy(input.recoveryCode);
      throw this.invalidAdminReset();
    }

    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.runAdminResetTransaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${user.id}::uuid FOR UPDATE`,
      );
      const clockRows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
        SELECT clock_timestamp() AS "now"
      `);
      const changedAt = clockRows[0]?.now;
      if (!changedAt) {
        throw new Error("No se pudo consultar el reloj de PostgreSQL.");
      }

      const reset = await tx.cashierPasswordReset.findFirst({
        where: {
          cashierUserId: user.id,
          consumedAt: null,
          supersededAt: null,
          expiresAt: { gt: changedAt },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      const code = await tx.cashierRecoveryCode.findFirst({
        where: {
          cashierUserId: user.id,
          codeHash: hashCashierRecoveryCode(user.id, recoveryCode),
          usedAt: null,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: changedAt } }],
        },
        select: { id: true },
      });
      if (!reset || !code) {
        throw this.invalidAdminReset();
      }

      if (await this.passwords.verify(user.passwordHash, input.newPassword)) {
        throw new BadRequestException(
          "La nueva contraseña debe ser diferente de la anterior."
        );
      }

      const claimedCode = await tx.cashierRecoveryCode.updateMany({
        where: {
          id: code.id,
          cashierUserId: user.id,
          usedAt: null,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: changedAt } }],
        },
        data: { usedAt: changedAt },
      });
      const consumedReset = await tx.cashierPasswordReset.updateMany({
        where: {
          id: reset.id,
          cashierUserId: user.id,
          consumedAt: null,
          supersededAt: null,
          expiresAt: { gt: changedAt },
        },
        data: {
          consumedAt: changedAt,
          recoveryCodeId: code.id,
        },
      });
      if (claimedCode.count !== 1 || consumedReset.count !== 1) {
        throw this.invalidAdminReset();
      }

      const changed = await tx.user.updateMany({
        where: {
          id: user.id,
          role: UserRole.CASHIER,
          passwordHash: user.passwordHash,
          passwordResetRequired: true,
          status: { not: AccountStatus.DELETED },
          OR: [{ lockedUntil: null }, { lockedUntil: { lte: changedAt } }]
        },
        data: {
          passwordHash,
          passwordChangedAt: changedAt,
          passwordResetRequired: false,
          sessionVersion: { increment: 1 },
          failedLoginAttempts: 0,
          lockedUntil: null
        }
      });

      if (changed.count !== 1) {
        throw this.invalidAdminReset();
      }

      await tx.authSession.updateMany({
        where: {
          userId: user.id,
          revokedAt: null
        },
        data: {
          revokedAt: changedAt,
          revocationReason: "ADMIN_PASSWORD_CHANGE_COMPLETED"
        }
      });
      await this.deviceLists?.publishCurrentRelationshipsForUser(
        tx,
        user.id,
        "CHANGED",
        changedAt
      );
    });
  }

  async rotateCashierRecoveryCodes(
    principal: SessionPrincipal,
    input: RotateRecoveryCodesDto
  ): Promise<{ recoveryCodes: string[]; recoveryCodesExpireAt: Date | null }> {
    if (principal.role !== UserRole.CASHIER) {
      throw new ForbiddenException("Acción disponible solo para cajeros.");
    }

    const current = await this.prisma.user.findUnique({
      where: { id: principal.id },
      select: {
        id: true,
        role: true,
        status: true,
        passwordHash: true,
        passwordResetRequired: true,
      },
    });
    if (
      !current ||
      current.role !== UserRole.CASHIER ||
      current.status === AccountStatus.DELETED ||
      current.status === AccountStatus.SUSPENDED ||
      current.passwordResetRequired ||
      !(await this.passwords.verify(current.passwordHash, input.currentPassword))
    ) {
      throw new UnauthorizedException("No se pudo verificar la contraseña actual.");
    }

    const issuedAt = await this.databaseNow(this.prisma);
    const recovery = issueCashierRecoveryCodes(issuedAt);
    await this.runAdminResetTransaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${current.id}::uuid FOR UPDATE`,
      );
      const lockedUser = await tx.user.findUnique({
        where: { id: current.id },
        select: {
          role: true,
          status: true,
          passwordHash: true,
          passwordResetRequired: true,
        },
      });
      if (
        !lockedUser ||
        lockedUser.role !== UserRole.CASHIER ||
        lockedUser.status === AccountStatus.DELETED ||
        lockedUser.status === AccountStatus.SUSPENDED ||
        lockedUser.passwordResetRequired ||
        lockedUser.passwordHash !== current.passwordHash
      ) {
        throw new UnauthorizedException("No se pudo rotar los códigos de recuperación.");
      }

      const rotatedAt = await this.databaseNow(tx);
      await tx.cashierRecoveryCode.updateMany({
        where: {
          cashierUserId: current.id,
          usedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: rotatedAt },
      });
      await tx.cashierRecoveryCode.createMany({
        data: recovery.codes.map((code) => ({
          cashierUserId: current.id,
          codeHash: hashCashierRecoveryCode(current.id, code),
          createdAt: issuedAt,
          expiresAt: recovery.expiresAt,
        })),
      });
    });

    return {
      recoveryCodes: recovery.codes,
      recoveryCodesExpireAt: recovery.expiresAt,
    };
  }

  async getSessionUser(rawToken: string | undefined): Promise<PublicUser> {
    const principal = await this.getSessionPrincipal(rawToken);
    return {
      id: principal.id,
      username: principal.username,
      role: principal.role,
      status: principal.status
    };
  }

  async getSessionPrincipal(
    rawToken: string | undefined
  ): Promise<SessionPrincipal> {
    if (!rawToken) {
      throw new UnauthorizedException();
    }

    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash: this.tokens.hash(rawToken) },
      include: {
        user: true,
        device: {
          select: {
            userId: true,
            status: true
          }
        }
      }
    });

    if (!session) {
      throw new UnauthorizedException();
    }

    if (session.user.role === UserRole.ADMIN) {
      await this.refreshAdminSessionActivity(session);
    } else if (this.isSessionInvalid(session, new Date())) {
      throw new UnauthorizedException();
    }

    return {
      ...this.toPublicUser(session.user),
      sessionId: session.id,
      deviceId: session.deviceId,
      sessionExpiresAt: session.expiresAt,
      adminMfaVerified:
        session.user.role !== UserRole.ADMIN ||
        session.adminMfaVerifiedAt instanceof Date,
      adminMfaVerifiedAt: session.adminMfaVerifiedAt ?? null
    };
  }

  async listOwnAdminSessions(
    principal: SessionPrincipal
  ): Promise<AdminSessionSummary[]> {
    this.assertAdminPrincipal(principal);
    const now = await this.databaseNow(this.prisma);
    const idleCutoff = this.adminIdleCutoff(now);
    const sessions = await this.prisma.authSession.findMany({
      where: {
        userId: principal.id,
        revokedAt: null,
        expiresAt: { gt: now },
        lastSeenAt: { gt: idleCutoff, lte: now }
      },
      orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true
      }
    });

    return sessions.map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      isCurrent: session.id === principal.sessionId
    }));
  }

  async revokeOwnAdminSession(
    principal: SessionPrincipal,
    sessionId: string,
    metadata: RequestMetadata
  ): Promise<{ revoked: boolean; currentSession: boolean }> {
    this.assertAdminPrincipal(principal);

    return this.runSessionManagementTransaction(async (tx) => {
      const ownedSession = await tx.authSession.findFirst({
        where: {
          id: sessionId,
          userId: principal.id
        },
        select: {
          id: true,
          revokedAt: true
        }
      });

      if (!ownedSession) {
        throw new NotFoundException("La sesión no existe.");
      }

      const revokedAt = await this.databaseNow(tx);
      const revoked = await tx.authSession.updateMany({
        where: {
          id: sessionId,
          userId: principal.id,
          revokedAt: null
        },
        data: {
          revokedAt,
          revocationReason: "ADMIN_SELF_SERVICE_REVOCATION"
        }
      });

      if (revoked.count === 1) {
        await tx.adminAuditEvent.create({
          data: {
            actorAdminId: principal.id,
            action: AdminAuditAction.ADMIN_SESSION_REVOKED,
            targetType: AdminAuditTargetType.AUTH_SESSION,
            targetId: sessionId,
            targetUserId: principal.id,
            reasonCode: "ADMIN_SELF_SERVICE_REVOCATION",
            stateBefore: JSON.stringify({ revoked: false }),
            stateAfter: JSON.stringify({
              revoked: true,
              currentSession: sessionId === principal.sessionId
            }),
            requestId: randomUUID(),
            ipHash: this.hashMetadata(metadata.ip)
          }
        });
      }

      return {
        revoked: revoked.count === 1,
        currentSession: sessionId === principal.sessionId
      };
    });
  }

  async revokeOtherAdminSessions(
    principal: SessionPrincipal,
    metadata: RequestMetadata
  ): Promise<{ revokedCount: number }> {
    this.assertAdminPrincipal(principal);

    return this.runSessionManagementTransaction(async (tx) => {
      const revokedAt = await this.databaseNow(tx);
      const revoked = await tx.authSession.updateMany({
        where: {
          userId: principal.id,
          id: { not: principal.sessionId },
          revokedAt: null
        },
        data: {
          revokedAt,
          revocationReason: "ADMIN_REVOKED_OTHER_SESSIONS"
        }
      });

      if (revoked.count > 0) {
        await tx.adminAuditEvent.create({
          data: {
            actorAdminId: principal.id,
            action: AdminAuditAction.ADMIN_OTHER_SESSIONS_REVOKED,
            targetType: AdminAuditTargetType.USER,
            targetId: principal.id,
            targetUserId: principal.id,
            reasonCode: "ADMIN_REVOKED_OTHER_SESSIONS",
            stateAfter: JSON.stringify({ revokedCount: revoked.count }),
            requestId: randomUUID(),
            ipHash: this.hashMetadata(metadata.ip)
          }
        });
      }

      return { revokedCount: revoked.count };
    });
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) {
      return;
    }

    await this.prisma.authSession.updateMany({
      where: {
        tokenHash: this.tokens.hash(rawToken),
        revokedAt: null
      },
      data: {
        revokedAt: new Date(),
        revocationReason: "USER_LOGOUT"
      }
    });
  }

  async assertCsrf(
    rawSessionToken: string | undefined,
    rawCsrfToken: string | undefined
  ): Promise<void> {
    if (!rawSessionToken || !rawCsrfToken) {
      throw new UnauthorizedException();
    }

    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash: this.tokens.hash(rawSessionToken) },
      select: {
        csrfSecretHash: true,
        expiresAt: true,
        revokedAt: true,
        sessionVersion: true,
        user: {
          select: {
            sessionVersion: true,
            passwordResetRequired: true,
            status: true
          }
        }
      }
    });

    const suppliedHash = this.tokens.hash(rawCsrfToken);
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.sessionVersion !== session.user.sessionVersion ||
      session.user.passwordResetRequired ||
      session.user.status === AccountStatus.SUSPENDED ||
      session.user.status === AccountStatus.DELETED ||
      !this.passwords.constantTimeEqual(
        session.csrfSecretHash,
        suppliedHash
      )
    ) {
      throw new UnauthorizedException();
    }
  }

  private async createSession(
    user: {
      id: string;
      username: string;
      role: UserRole;
      status: AccountStatus;
      sessionVersion: number;
    },
    metadata: RequestMetadata
  ): Promise<AuthResult> {
    const session = this.tokens.create();
    const csrf = this.tokens.createCsrf();
    const issuedAt =
      user.role === UserRole.ADMIN
        ? await this.databaseNow(this.prisma)
        : new Date();
    const expiresAt = this.tokens.expiresAt(issuedAt, user.role);

    await this.prisma.authSession.create({
      data: {
        userId: user.id,
        tokenHash: session.tokenHash,
        csrfSecretHash: csrf.tokenHash,
        sessionVersion: user.sessionVersion,
        ipHash: this.hashMetadata(metadata.ip),
        userAgentHash: this.hashMetadata(metadata.userAgent),
        expiresAt
      }
    });

    return {
      user: this.toPublicUser(user),
      sessionToken: session.token,
      csrfToken: csrf.token,
      expiresAt
    };
  }

  private toPublicUser(user: {
    id: string;
    username: string;
    role: UserRole;
    status: AccountStatus;
  }): PublicUser {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status
    };
  }

  private async refreshAdminSessionActivity(session: {
    id: string;
    userId: string;
    deviceId: string | null;
    lastSeenAt: Date;
    expiresAt: Date;
    revokedAt: Date | null;
    sessionVersion: number;
    user: {
      role: UserRole;
      status: AccountStatus;
      passwordResetRequired: boolean;
      sessionVersion: number;
    };
    device: { userId: string; status: DeviceStatus } | null;
  }): Promise<void> {
    const now = await this.databaseNow(this.prisma);
    const idleCutoff = this.adminIdleCutoff(now);

    if (this.isSessionInvalid(session, now)) {
      await this.revokeInvalidAdminSession(
        session.id,
        now,
        session.expiresAt <= now
          ? "ADMIN_SESSION_ABSOLUTE_TIMEOUT"
          : "ADMIN_SESSION_INVALIDATED"
      );
      throw new UnauthorizedException();
    }

    if (session.lastSeenAt > now) {
      await this.revokeInvalidAdminSession(
        session.id,
        now,
        "ADMIN_SESSION_INVALID_ACTIVITY_CLOCK"
      );
      throw new UnauthorizedException();
    }

    if (session.lastSeenAt <= idleCutoff) {
      await this.revokeInvalidAdminSession(
        session.id,
        now,
        "ADMIN_SESSION_IDLE_TIMEOUT"
      );
      throw new UnauthorizedException();
    }

    const validSessionWhere = {
      id: session.id,
      userId: session.userId,
      revokedAt: null,
      expiresAt: { gt: now },
      sessionVersion: session.user.sessionVersion,
      user: {
        is: {
          role: UserRole.ADMIN,
          passwordResetRequired: false,
          status: { notIn: [AccountStatus.SUSPENDED, AccountStatus.DELETED] },
          sessionVersion: session.user.sessionVersion
        }
      },
      ...(session.deviceId === null
        ? { deviceId: null }
        : {
            deviceId: session.deviceId,
            device: {
              is: {
                userId: session.userId,
                status: DeviceStatus.ACTIVE
              }
            }
          })
    } satisfies Prisma.AuthSessionWhereInput;

    const refreshed = await this.prisma.authSession.updateMany({
      where: {
        ...validSessionWhere,
        lastSeenAt: { gt: idleCutoff, lte: now }
      },
      data: { lastSeenAt: now }
    });

    if (refreshed.count !== 1) {
      // Otra solicitud válida del mismo navegador puede haber avanzado el
      // reloj entre el SELECT y este UPDATE. Ese ganador ya confirmó todos
      // los invariantes; no debemos convertir paralelismo normal en logout.
      const refreshedConcurrently = await this.prisma.authSession.findFirst({
        where: {
          ...validSessionWhere,
          lastSeenAt: { gt: now }
        },
        select: { id: true }
      });
      if (refreshedConcurrently) {
        return;
      }

      await this.revokeInvalidAdminSession(
        session.id,
        now,
        "ADMIN_SESSION_VALIDATION_FAILED"
      );
      throw new UnauthorizedException();
    }
  }

  private isSessionInvalid(
    session: {
      userId: string;
      deviceId: string | null;
      expiresAt: Date;
      revokedAt: Date | null;
      sessionVersion: number;
      user: {
        status: AccountStatus;
        passwordResetRequired: boolean;
        sessionVersion: number;
      };
      device: { userId: string; status: DeviceStatus } | null;
    },
    now: Date
  ): boolean {
    return Boolean(
      session.revokedAt ||
        session.expiresAt <= now ||
        session.sessionVersion !== session.user.sessionVersion ||
        session.user.passwordResetRequired ||
        session.user.status === AccountStatus.SUSPENDED ||
        session.user.status === AccountStatus.DELETED ||
        (session.deviceId !== null &&
          (!session.device ||
            session.device.userId !== session.userId ||
            session.device.status !== DeviceStatus.ACTIVE))
    );
  }

  private adminIdleCutoff(now: Date): Date {
    const minutes = readSessionConfig().adminSessionIdleTimeoutMinutes;
    return new Date(now.getTime() - minutes * 60 * 1_000);
  }

  private async revokeInvalidAdminSession(
    sessionId: string,
    revokedAt: Date,
    reason: string
  ): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt, revocationReason: reason }
    });
  }

  private assertAdminPrincipal(principal: SessionPrincipal): void {
    if (principal.role !== UserRole.ADMIN) {
      throw new ForbiddenException();
    }
  }

  private normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
  }

  private acceptedTermsIdentity(version: string) {
    return this.prisma.termsDocument.findFirst({
      where: {
        version,
        content: { not: null },
        contentType: { not: null },
        byteSize: { not: null }
      },
      select: { id: true, version: true, contentHash: true }
    });
  }

  private assertAcceptedTerms(
    current: { version: string; contentHash: string },
    acceptedVersion: string,
    acceptedContentHash: string
  ): void {
    if (
      current.version !== acceptedVersion ||
      current.contentHash !== acceptedContentHash
    ) {
      throw new ConflictException({
        code: "TERMS_DOCUMENT_CHANGED",
        message:
          "Los términos cambiaron. Carga, lee y acepta la versión vigente antes de registrarte."
      });
    }
  }

  private async currentTermsInTransaction(
    tx: Prisma.TransactionClient
  ): Promise<{
    id: string;
    version: string;
    contentHash: string;
    acceptedAt: Date;
  }> {
    const clockRows = await tx.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp() AS "now"
    `;
    const acceptedAt = clockRows[0]?.now;
    if (!acceptedAt) {
      throw new Error("No se pudo consultar el reloj de PostgreSQL.");
    }
    const terms = await tx.termsDocument.findFirst({
      where: {
        content: { not: null },
        contentType: { not: null },
        byteSize: { not: null },
        effectiveAt: { lte: acceptedAt },
        OR: [{ retiredAt: null }, { retiredAt: { gt: acceptedAt } }]
      },
      orderBy: [
        { effectiveAt: "desc" },
        { createdAt: "desc" }
      ],
      select: { id: true, version: true, contentHash: true }
    });
    if (!terms) {
      throw new BadRequestException(
        "El registro está temporalmente deshabilitado."
      );
    }
    return { ...terms, acceptedAt };
  }

  private async runRegistrationTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel:
            Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 30_000
        });
      } catch (error: unknown) {
        const retryable =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: unknown }).code === "P2034";
        if (!retryable || attempt === maxAttempts) {
          throw error;
        }
      }
    }
    throw new Error("No se pudo completar el registro serializable.");
  }

  private async runAdminResetTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel:
            Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 30_000
        });
      } catch (error: unknown) {
        const retryable =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: unknown }).code === "P2034";
        if (!retryable || attempt === maxAttempts) {
          throw error;
        }
      }
    }
    throw new Error(
      "No se pudo completar el cambio de contraseña serializable."
    );
  }

  private async runSessionManagementTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 15_000
        });
      } catch (error: unknown) {
        const retryable =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: unknown }).code === "P2034";
        if (!retryable || attempt === maxAttempts) {
          throw error;
        }
      }
    }
    throw new Error("No se pudo gestionar las sesiones del administrador.");
  }

  private async recordFailedLoginAttempt(userId: string): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      WITH "current_clock" AS (
        SELECT clock_timestamp() AS "now"
      )
      UPDATE "users" AS "account"
         SET "failed_login_attempts" = CASE
               WHEN "account"."locked_until" > "current_clock"."now"
                 THEN "account"."failed_login_attempts"
               WHEN "account"."failed_login_attempts" + 1 >= ${MAX_FAILED_LOGINS}
                 THEN 0
               ELSE "account"."failed_login_attempts" + 1
             END,
             "locked_until" = CASE
               WHEN "account"."locked_until" > "current_clock"."now"
                 THEN "account"."locked_until"
               WHEN "account"."failed_login_attempts" + 1 >= ${MAX_FAILED_LOGINS}
                 THEN "current_clock"."now"
                      + make_interval(mins => ${LOCK_MINUTES})
               ELSE NULL
             END,
             "updated_at" = "current_clock"."now"
        FROM "current_clock"
       WHERE "account"."id" = ${userId}
    `);
  }

  private invalidAdminReset(): UnauthorizedException {
    return new UnauthorizedException({
      code: "ADMIN_PASSWORD_RESET_INVALID",
      message:
        "No se pudo completar el restablecimiento con los datos proporcionados."
    });
  }

  private invitationLookupHash(code: string): string {
    return createHash("sha256")
      .update(code.trim().toUpperCase(), "utf8")
      .digest("hex");
  }

  private hashMetadata(value: string | undefined): string | null {
    const secret = process.env.METADATA_HASH_SECRET;
    if (!value || !secret) {
      return null;
    }

    return createHmac("sha256", secret).update(value, "utf8").digest("hex");
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

  private isAdult(dateInput: string, decisionTime: Date): boolean {
    const [year, month, day] = dateInput.split("-").map(Number);
    const legalTimeZone =
      process.env.LEGAL_TIME_ZONE ?? "America/Argentina/Buenos_Aires";
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: legalTimeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric"
    }).formatToParts(decisionTime);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((entry) => entry.type === type)?.value);
    const currentYear = part("year");
    const currentMonth = part("month");
    const currentDay = part("day");
    let age = currentYear - year;

    if (currentMonth < month || (currentMonth === month && currentDay < day)) {
      age -= 1;
    }

    return age >= 18;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002"
    );
  }
}
