import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from "@nestjs/common";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON
} from "@simplewebauthn/server";
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { Prisma } from "../generated/prisma/client";
import {
  AccountStatus,
  AdminAuditAction,
  AdminAuditTargetType,
  AdminWebAuthnChallengePurpose,
  UserRole
} from "../generated/prisma/enums";
import { PrismaService } from "../database/prisma.service";
import type { RequestMetadata, SessionPrincipal } from "./auth.types";
import {
  ADMIN_RECOVERY_CODE_PATTERN,
  hashAdminRecoveryCode,
  issueAdminRecoveryCodes,
  normalizeAdminRecoveryCode
} from "./admin-recovery-code";
import {
  ADMIN_MFA_STEP_UP_TTL_MILLISECONDS,
  ADMIN_WEBAUTHN_CHALLENGE_TTL_MILLISECONDS,
  extractWebAuthnChallenge,
  hashWebAuthnChallenge
} from "./admin-webauthn-payload";
import {
  AdminWebAuthnCrypto,
  type StoredAdminPasskey
} from "./admin-webauthn.crypto";

const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{16,1024}$/;
const MAX_ADMIN_PASSKEYS = 10;
const ALLOWED_TRANSPORTS = new Set<AuthenticatorTransportFuture>([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb"
]);

export interface AdminMfaState {
  required: true;
  enrolled: boolean;
  verified: boolean;
}

export interface AdminWebAuthnOptionsResult {
  challengeId: string;
  options: unknown;
}

export interface AdminWebAuthnRegistrationResult {
  verified: true;
  recoveryCodes: string[];
}

export interface AdminPasskeySummary {
  id: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
}

@Injectable()
export class AdminMfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webAuthn: AdminWebAuthnCrypto
  ) {}

  async state(principal: SessionPrincipal): Promise<AdminMfaState> {
    this.assertAdmin(principal);
    const enrolled =
      (await this.prisma.adminWebAuthnCredential.count({
        where: { adminUserId: principal.id, revokedAt: null }
      })) > 0;
    return {
      required: true,
      enrolled,
      verified: enrolled && principal.adminMfaVerified === true
    };
  }

  async registrationOptions(
    principal: SessionPrincipal
  ): Promise<AdminWebAuthnOptionsResult> {
    this.assertAdmin(principal);
    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        adminWebAuthnUserHandle: true,
        adminWebAuthnCredentials: {
          where: { revokedAt: null },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { credentialId: true, transports: true }
        }
      }
    });
    if (
      !user ||
      user.role !== UserRole.ADMIN ||
      user.status !== AccountStatus.ACTIVE
    ) {
      throw new ForbiddenException();
    }
    if (
      user.adminWebAuthnCredentials.length > 0 &&
      principal.adminMfaVerified !== true
    ) {
      throw this.mfaRequired();
    }
    if (user.adminWebAuthnCredentials.length >= MAX_ADMIN_PASSKEYS) {
      throw this.passkeyLimitReached();
    }
    if (user.adminWebAuthnCredentials.length > 0) {
      await this.assertRecentMfa(principal);
    }

    const userHandle = await this.ensureUserHandle(
      user.id,
      user.adminWebAuthnUserHandle
    );
    const options = await this.webAuthn.registrationOptions({
      username: user.username,
      userHandle,
      credentials: user.adminWebAuthnCredentials.map((credential) => ({
        credentialId: credential.credentialId,
        transports: this.parseTransports(credential.transports)
      }))
    });
    const challengeId = await this.persistChallenge(
      principal,
      AdminWebAuthnChallengePurpose.REGISTRATION,
      options.challenge
    );
    return { challengeId, options };
  }

  async verifyRegistration(
    principal: SessionPrincipal,
    challengeId: string,
    rawResponse: unknown,
    metadata: RequestMetadata
  ): Promise<AdminWebAuthnRegistrationResult> {
    this.assertAdmin(principal);
    const challenge = await this.readChallenge(
      principal,
      challengeId,
      AdminWebAuthnChallengePurpose.REGISTRATION,
      rawResponse
    );

    let verification: Awaited<
      ReturnType<AdminWebAuthnCrypto["verifyRegistration"]>
    >;
    try {
      verification = await this.webAuthn.verifyRegistration(
        rawResponse as RegistrationResponseJSON,
        challenge.value
      );
    } catch {
      throw this.invalidWebAuthnResponse();
    }
    if (!verification.verified || !verification.registrationInfo.userVerified) {
      throw this.invalidWebAuthnResponse();
    }

    const credential = verification.registrationInfo.credential;
    if (
      !CREDENTIAL_ID_PATTERN.test(credential.id) ||
      credential.publicKey.byteLength < 32 ||
      credential.publicKey.byteLength > 4096 ||
      !Number.isSafeInteger(credential.counter) ||
      credential.counter < 0
    ) {
      throw this.invalidWebAuthnResponse();
    }
    const recoveryCodes = issueAdminRecoveryCodes();

    try {
      return await this.mfaTransaction(
        async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${principal.id}::uuid FOR UPDATE`
          );
          const now = await this.databaseNow(tx);
          const activeCredentialCount =
            await tx.adminWebAuthnCredential.count({
              where: { adminUserId: principal.id, revokedAt: null }
            });
          if (
            activeCredentialCount > 0 &&
            principal.adminMfaVerified !== true
          ) {
            throw this.mfaRequired();
          }
          if (activeCredentialCount >= MAX_ADMIN_PASSKEYS) {
            throw this.passkeyLimitReached();
          }
          if (activeCredentialCount > 0) {
            this.assertRecentMfaAt(principal, now);
          }
          await this.consumeChallenge(
            tx,
            principal,
            challengeId,
            AdminWebAuthnChallengePurpose.REGISTRATION,
            challenge.hash,
            now
          );

          const created = await tx.adminWebAuthnCredential.create({
            data: {
              adminUserId: principal.id,
              credentialId: credential.id,
              publicKey: Buffer.from(credential.publicKey),
              counter: BigInt(credential.counter),
              transports: this.parseTransports(credential.transports ?? []),
              deviceType: verification.registrationInfo.credentialDeviceType,
              backedUp: verification.registrationInfo.credentialBackedUp,
              createdAt: now
            },
            select: { id: true }
          });
          const session = await tx.authSession.updateMany({
            where: {
              id: principal.sessionId,
              userId: principal.id,
              revokedAt: null,
              expiresAt: { gt: now }
            },
            data: { adminMfaVerifiedAt: now }
          });
          if (session.count !== 1) {
            throw new UnauthorizedException();
          }

          let codesToReturn: string[] = [];
          if (activeCredentialCount === 0) {
            await tx.adminRecoveryCode.updateMany({
              where: {
                adminUserId: principal.id,
                usedAt: null,
                revokedAt: null
              },
              data: { revokedAt: now }
            });
            await tx.adminRecoveryCode.createMany({
              data: recoveryCodes.map((code) => ({
                adminUserId: principal.id,
                codeHash: hashAdminRecoveryCode(principal.id, code),
                createdAt: now
              }))
            });
            codesToReturn = recoveryCodes;
          }

          await tx.adminAuditEvent.create({
            data: {
              actorAdminId: principal.id,
              action: AdminAuditAction.ADMIN_PASSKEY_REGISTERED,
              targetType: AdminAuditTargetType.USER,
              targetId: principal.id,
              targetUserId: principal.id,
              reasonCode:
                activeCredentialCount === 0
                  ? "ADMIN_PASSKEY_INITIAL_ENROLLMENT"
                  : "ADMIN_PASSKEY_ADDED",
              stateAfter: JSON.stringify({
                credentialId: created.id,
                firstCredential: activeCredentialCount === 0,
                backedUp: verification.registrationInfo.credentialBackedUp
              }),
              requestId: randomUUID(),
              ipHash: this.hashMetadata(metadata.ip)
            }
          });
          return { verified: true as const, recoveryCodes: codesToReturn };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 30_000
        }
      );
    } catch (error: unknown) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          "Esa passkey ya está registrada o la ceremonia fue reemplazada."
        );
      }
      throw error;
    }
  }

  async authenticationOptions(
    principal: SessionPrincipal
  ): Promise<AdminWebAuthnOptionsResult> {
    this.assertAdmin(principal);
    const credentials = await this.prisma.adminWebAuthnCredential.findMany({
      where: { adminUserId: principal.id, revokedAt: null },
      orderBy: [{ lastUsedAt: "desc" }, { createdAt: "asc" }],
      select: { credentialId: true, transports: true }
    });
    if (credentials.length === 0) {
      throw new ForbiddenException({
        code: "ADMIN_MFA_ENROLLMENT_REQUIRED",
        message: "Debes registrar una passkey administrativa."
      });
    }
    const options = await this.webAuthn.authenticationOptions(
      credentials.map((credential) => ({
        credentialId: credential.credentialId,
        transports: this.parseTransports(credential.transports)
      }))
    );
    const challengeId = await this.persistChallenge(
      principal,
      AdminWebAuthnChallengePurpose.AUTHENTICATION,
      options.challenge
    );
    return { challengeId, options };
  }

  async verifyAuthentication(
    principal: SessionPrincipal,
    challengeId: string,
    rawResponse: unknown
  ): Promise<{ verified: true }> {
    this.assertAdmin(principal);
    const responseId = this.responseCredentialId(rawResponse);
    const stored = await this.prisma.adminWebAuthnCredential.findFirst({
      where: {
        adminUserId: principal.id,
        credentialId: responseId,
        revokedAt: null
      },
      select: {
        id: true,
        credentialId: true,
        publicKey: true,
        counter: true,
        transports: true
      }
    });
    if (!stored || stored.counter > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw this.invalidWebAuthnResponse();
    }
    const challenge = await this.readChallenge(
      principal,
      challengeId,
      AdminWebAuthnChallengePurpose.AUTHENTICATION,
      rawResponse
    );
    const passkey: StoredAdminPasskey = {
      credentialId: stored.credentialId,
      publicKey: new Uint8Array(stored.publicKey),
      counter: Number(stored.counter),
      transports: this.parseTransports(stored.transports)
    };

    let verification: Awaited<
      ReturnType<AdminWebAuthnCrypto["verifyAuthentication"]>
    >;
    try {
      verification = await this.webAuthn.verifyAuthentication(
        rawResponse as AuthenticationResponseJSON,
        challenge.value,
        passkey
      );
    } catch {
      throw this.invalidWebAuthnResponse();
    }
    if (
      !verification.verified ||
      !verification.authenticationInfo.userVerified ||
      !Number.isSafeInteger(verification.authenticationInfo.newCounter) ||
      verification.authenticationInfo.newCounter < 0
    ) {
      throw this.invalidWebAuthnResponse();
    }

    await this.mfaTransaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${principal.id}::uuid FOR UPDATE`
        );
        const now = await this.databaseNow(tx);
        await this.consumeChallenge(
          tx,
          principal,
          challengeId,
          AdminWebAuthnChallengePurpose.AUTHENTICATION,
          challenge.hash,
          now
        );
        const updatedCredential =
          await tx.adminWebAuthnCredential.updateMany({
            where: {
              id: stored.id,
              adminUserId: principal.id,
              credentialId: responseId,
              counter: stored.counter,
              revokedAt: null
            },
            data: {
              counter: BigInt(verification.authenticationInfo.newCounter),
              backedUp: verification.authenticationInfo.credentialBackedUp,
              lastUsedAt: now
            }
          });
        const updatedSession = await tx.authSession.updateMany({
          where: {
            id: principal.sessionId,
            userId: principal.id,
            revokedAt: null,
            expiresAt: { gt: now }
          },
          data: { adminMfaVerifiedAt: now }
        });
        if (updatedCredential.count !== 1 || updatedSession.count !== 1) {
          throw this.invalidWebAuthnResponse();
        }
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 30_000
      }
    );
    return { verified: true };
  }

  async listPasskeys(
    principal: SessionPrincipal
  ): Promise<AdminPasskeySummary[]> {
    this.assertAdmin(principal);
    const credentials = await this.prisma.adminWebAuthnCredential.findMany({
      where: { adminUserId: principal.id, revokedAt: null },
      orderBy: [{ lastUsedAt: "desc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        createdAt: true,
        lastUsedAt: true,
        deviceType: true,
        backedUp: true
      }
    });
    return credentials.map((credential) => ({
      id: credential.id,
      createdAt: credential.createdAt,
      lastUsedAt: credential.lastUsedAt,
      deviceType: this.passkeyDeviceType(credential.deviceType),
      backedUp: credential.backedUp
    }));
  }

  async revokePasskey(
    principal: SessionPrincipal,
    credentialId: string,
    metadata: RequestMetadata
  ): Promise<{ revoked: true }> {
    this.assertAdmin(principal);
    return this.mfaTransaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${principal.id}::uuid FOR UPDATE`
        );
        const activeCredentials =
          await tx.adminWebAuthnCredential.findMany({
            where: { adminUserId: principal.id, revokedAt: null },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: {
              id: true,
              createdAt: true,
              lastUsedAt: true,
              deviceType: true,
              backedUp: true
            }
          });
        const selected = activeCredentials.find(
          (credential) => credential.id === credentialId
        );
        if (!selected) {
          throw new NotFoundException("La passkey no existe.");
        }
        if (activeCredentials.length <= 1) {
          throw new ConflictException({
            code: "ADMIN_PASSKEY_LAST_REQUIRED",
            message:
              "No puedes revocar la última passkey. Agrega otra antes de continuar."
          });
        }

        const now = await this.databaseNow(tx);
        const revoked = await tx.adminWebAuthnCredential.updateMany({
          where: {
            id: selected.id,
            adminUserId: principal.id,
            revokedAt: null
          },
          data: { revokedAt: now }
        });
        if (revoked.count !== 1) {
          throw new ConflictException(
            "La passkey cambió mientras intentabas revocarla."
          );
        }
        await tx.adminAuditEvent.create({
          data: {
            actorAdminId: principal.id,
            action: AdminAuditAction.ADMIN_PASSKEY_REVOKED,
            targetType: AdminAuditTargetType.USER,
            targetId: principal.id,
            targetUserId: principal.id,
            reasonCode: "ADMIN_PASSKEY_SELF_SERVICE_REVOCATION",
            stateBefore: JSON.stringify({
              credentialId: selected.id,
              createdAt: selected.createdAt.toISOString(),
              lastUsedAt: selected.lastUsedAt?.toISOString() ?? null,
              deviceType: this.passkeyDeviceType(selected.deviceType),
              backedUp: selected.backedUp,
              revoked: false
            }),
            stateAfter: JSON.stringify({
              credentialId: selected.id,
              revoked: true,
              revokedAt: now.toISOString()
            }),
            requestId: randomUUID(),
            ipHash: this.hashMetadata(metadata.ip)
          }
        });
        return { revoked: true as const };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 15_000
      }
    );
  }

  async recover(
    principal: SessionPrincipal,
    rawCode: string,
    metadata: RequestMetadata
  ): Promise<{ recovered: true }> {
    this.assertAdmin(principal);
    if (principal.adminMfaVerified === true) {
      throw new BadRequestException(
        "La recuperación solo está disponible antes de verificar la passkey."
      );
    }
    const recoveryCode = normalizeAdminRecoveryCode(rawCode);
    if (!ADMIN_RECOVERY_CODE_PATTERN.test(recoveryCode)) {
      throw this.invalidRecoveryCode();
    }
    const codeHash = hashAdminRecoveryCode(principal.id, recoveryCode);

    await this.mfaTransaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${principal.id}::uuid FOR UPDATE`
        );
        const now = await this.databaseNow(tx);
        const code = await tx.adminRecoveryCode.findFirst({
          where: {
            adminUserId: principal.id,
            codeHash,
            usedAt: null,
            revokedAt: null
          },
          select: { id: true }
        });
        if (!code) {
          throw this.invalidRecoveryCode();
        }
        const consumed = await tx.adminRecoveryCode.updateMany({
          where: {
            id: code.id,
            adminUserId: principal.id,
            usedAt: null,
            revokedAt: null
          },
          data: { usedAt: now }
        });
        if (consumed.count !== 1) {
          throw this.invalidRecoveryCode();
        }
        const revokedCredentials =
          await tx.adminWebAuthnCredential.updateMany({
            where: { adminUserId: principal.id, revokedAt: null },
            data: { revokedAt: now }
          });
        await tx.adminRecoveryCode.updateMany({
          where: {
            adminUserId: principal.id,
            id: { not: code.id },
            usedAt: null,
            revokedAt: null
          },
          data: { revokedAt: now }
        });
        await tx.adminWebAuthnChallenge.updateMany({
          where: {
            adminUserId: principal.id,
            consumedAt: null
          },
          data: { consumedAt: now }
        });
        await tx.authSession.updateMany({
          where: {
            userId: principal.id,
            id: { not: principal.sessionId },
            revokedAt: null
          },
          data: {
            revokedAt: now,
            revocationReason: "ADMIN_MFA_RECOVERY"
          }
        });
        const currentSession = await tx.authSession.updateMany({
          where: {
            id: principal.sessionId,
            userId: principal.id,
            revokedAt: null,
            expiresAt: { gt: now }
          },
          data: { adminMfaVerifiedAt: null }
        });
        if (currentSession.count !== 1) {
          throw new UnauthorizedException();
        }
        await tx.adminAuditEvent.create({
          data: {
            actorAdminId: principal.id,
            action: AdminAuditAction.ADMIN_MFA_RECOVERED,
            targetType: AdminAuditTargetType.USER,
            targetId: principal.id,
            targetUserId: principal.id,
            reasonCode: "ADMIN_MFA_RECOVERY_CODE_USED",
            stateAfter: JSON.stringify({
              passkeysRevoked: revokedCredentials.count,
              enrollmentRequired: true
            }),
            requestId: randomUUID(),
            ipHash: this.hashMetadata(metadata.ip)
          }
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 30_000
      }
    );
    return { recovered: true };
  }

  async assertRecentMfa(principal: SessionPrincipal): Promise<void> {
    this.assertAdmin(principal);
    const now = await this.databaseNow(this.prisma);
    this.assertRecentMfaAt(principal, now);
  }

  private assertRecentMfaAt(
    principal: SessionPrincipal,
    now: Date
  ): void {
    if (
      principal.adminMfaVerified !== true ||
      !principal.adminMfaVerifiedAt
    ) {
      throw this.stepUpRequired();
    }
    const cutoff = new Date(
      now.getTime() - ADMIN_MFA_STEP_UP_TTL_MILLISECONDS
    );
    if (
      principal.adminMfaVerifiedAt <= cutoff ||
      principal.adminMfaVerifiedAt > now
    ) {
      throw this.stepUpRequired();
    }
  }

  private async persistChallenge(
    principal: SessionPrincipal,
    purpose: AdminWebAuthnChallengePurpose,
    challenge: string
  ): Promise<string> {
    return this.mfaTransaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${principal.id}::uuid FOR UPDATE`
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "auth_sessions" WHERE "id" = ${principal.sessionId}::uuid AND "user_id" = ${principal.id}::uuid FOR UPDATE`
      );
      const now = await this.databaseNow(tx);
      await tx.adminWebAuthnChallenge.updateMany({
        where: {
          adminUserId: principal.id,
          sessionId: principal.sessionId,
          purpose,
          consumedAt: null
        },
        data: { consumedAt: now }
      });
      const created = await tx.adminWebAuthnChallenge.create({
        data: {
          adminUserId: principal.id,
          sessionId: principal.sessionId,
          purpose,
          challengeHash: hashWebAuthnChallenge(challenge),
          createdAt: now,
          expiresAt: new Date(
            now.getTime() + ADMIN_WEBAUTHN_CHALLENGE_TTL_MILLISECONDS
          )
        },
        select: { id: true }
      });
      return created.id;
    });
  }

  private async readChallenge(
    principal: SessionPrincipal,
    challengeId: string,
    purpose: AdminWebAuthnChallengePurpose,
    response: unknown
  ): Promise<{ hash: string; value: string }> {
    let challengeValue: string;
    try {
      challengeValue = extractWebAuthnChallenge(response);
    } catch {
      throw this.invalidWebAuthnResponse();
    }
    const now = await this.databaseNow(this.prisma);
    const stored = await this.prisma.adminWebAuthnChallenge.findFirst({
      where: {
        id: challengeId,
        adminUserId: principal.id,
        sessionId: principal.sessionId,
        purpose,
        consumedAt: null,
        expiresAt: { gt: now }
      },
      select: { challengeHash: true }
    });
    const suppliedHash = hashWebAuthnChallenge(challengeValue);
    if (!stored || !this.hashesEqual(stored.challengeHash, suppliedHash)) {
      throw this.invalidWebAuthnResponse();
    }
    return { hash: stored.challengeHash, value: challengeValue };
  }

  private async consumeChallenge(
    tx: Prisma.TransactionClient,
    principal: SessionPrincipal,
    challengeId: string,
    purpose: AdminWebAuthnChallengePurpose,
    challengeHash: string,
    now: Date
  ): Promise<void> {
    const claimed = await tx.adminWebAuthnChallenge.updateMany({
      where: {
        id: challengeId,
        adminUserId: principal.id,
        sessionId: principal.sessionId,
        purpose,
        challengeHash,
        consumedAt: null,
        expiresAt: { gt: now }
      },
      data: { consumedAt: now }
    });
    if (claimed.count !== 1) {
      throw this.invalidWebAuthnResponse();
    }
  }

  private async ensureUserHandle(
    adminUserId: string,
    current: Uint8Array | null
  ): Promise<Uint8Array> {
    if (current) return new Uint8Array(current);
    const candidate = randomBytes(32);
    const stored = await this.prisma.user.updateMany({
      where: {
        id: adminUserId,
        role: UserRole.ADMIN,
        status: AccountStatus.ACTIVE,
        adminWebAuthnUserHandle: null
      },
      data: { adminWebAuthnUserHandle: candidate }
    });
    if (stored.count === 1) return candidate;
    const winner = await this.prisma.user.findUnique({
      where: { id: adminUserId },
      select: { adminWebAuthnUserHandle: true }
    });
    if (!winner?.adminWebAuthnUserHandle) {
      throw new ForbiddenException();
    }
    return new Uint8Array(winner.adminWebAuthnUserHandle);
  }

  private responseCredentialId(response: unknown): string {
    if (
      typeof response !== "object" ||
      response === null ||
      Array.isArray(response) ||
      !("id" in response) ||
      typeof response.id !== "string" ||
      !CREDENTIAL_ID_PATTERN.test(response.id)
    ) {
      throw this.invalidWebAuthnResponse();
    }
    return response.id;
  }

  private parseTransports(values: readonly string[]): AuthenticatorTransportFuture[] {
    const unique = new Set<AuthenticatorTransportFuture>();
    for (const value of values) {
      if (!ALLOWED_TRANSPORTS.has(value as AuthenticatorTransportFuture)) {
        throw this.invalidWebAuthnResponse();
      }
      unique.add(value as AuthenticatorTransportFuture);
    }
    return [...unique];
  }

  private assertAdmin(principal: SessionPrincipal): void {
    if (principal.role !== UserRole.ADMIN) {
      throw new ForbiddenException();
    }
  }

  private mfaRequired(): ForbiddenException {
    return new ForbiddenException({
      code: "ADMIN_MFA_REQUIRED",
      message: "Verifica tu passkey para acceder al panel administrativo."
    });
  }

  private passkeyLimitReached(): ConflictException {
    return new ConflictException({
      code: "ADMIN_PASSKEY_LIMIT_REACHED",
      message: `Puedes registrar como máximo ${MAX_ADMIN_PASSKEYS} passkeys administrativas.`
    });
  }

  private passkeyDeviceType(
    value: string
  ): "singleDevice" | "multiDevice" {
    if (value !== "singleDevice" && value !== "multiDevice") {
      throw new Error("La passkey almacenada tiene un tipo inválido.");
    }
    return value;
  }

  private stepUpRequired(): ForbiddenException {
    return new ForbiddenException({
      code: "ADMIN_MFA_STEP_UP_REQUIRED",
      message: "Confirma nuevamente tu passkey para completar esta acción sensible."
    });
  }

  private invalidWebAuthnResponse(): BadRequestException {
    return new BadRequestException({
      code: "ADMIN_WEBAUTHN_INVALID",
      message: "No se pudo verificar la passkey. Inicia una nueva confirmación."
    });
  }

  private invalidRecoveryCode(): BadRequestException {
    return new BadRequestException({
      code: "ADMIN_MFA_RECOVERY_INVALID",
      message: "No se pudo completar la recuperación con ese código."
    });
  }

  private hashesEqual(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left, "hex");
    const rightBytes = Buffer.from(right, "hex");
    return (
      leftBytes.length === rightBytes.length &&
      timingSafeEqual(leftBytes, rightBytes)
    );
  }

  private hashMetadata(value: string | undefined): string | null {
    const secret = process.env.METADATA_HASH_SECRET;
    if (!value || !secret) return null;
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

  private async mfaTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: {
      isolationLevel?: Prisma.TransactionIsolationLevel;
      maxWait?: number;
      timeout?: number;
    }
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(operation, options);
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (
          error.code === "P2034" ||
          (error.code === "P2010" &&
            (error.meta?.code === "40001" || error.meta?.code === "40P01"))
        )
      ) {
        // Prisma puede envolver conflictos SQL de consultas raw en P2010.
        // No reintentamos una ceremonia ni reutilizamos el principal anterior.
        throw new ConflictException({
          code: "ADMIN_MFA_CONCURRENT_CHANGE",
          message:
            "La seguridad de tu cuenta cambió mientras realizabas esta acción. Actualiza la página e inténtalo de nuevo."
        });
      }
      throw error;
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    );
  }
}
