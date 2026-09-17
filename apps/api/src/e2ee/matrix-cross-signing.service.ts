import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { matrixDeviceIdFromUuid, matrixUserIdFromUuid } from "@sinochat/contracts";
import type { SessionPrincipal } from "../auth/auth.types";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import { readMatrixServerName } from "../config/runtime-config";
import { MatrixDeviceListPublisher } from "../database/matrix-device-list.publisher";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import { MatrixCrossSigningValidationError, parseMatrixCrossSigningBootstrap } from "./matrix-cross-signing";
import { hashMatrixCanonicalJson } from "./matrix-key-upload";

type Transaction = Prisma.TransactionClient;
export interface IdentityStatus {
  state: "UNINITIALIZED" | "PINNED";
  matrixUserId: string;
  matrixDeviceId: string;
  identity: { masterKey: string; selfSigningKey: string; userSigningKey: string } | null;
}
interface IdentityContext {
  deviceId: string;
  matrixUserId: string;
  matrixDeviceId: string;
  deviceKeys: Prisma.JsonValue;
  now: Date;
  subscriptionEndsAt: Date | null;
}

/** Initial identity only. No root resets, extra devices or private-key recovery. */
@Injectable()
export class MatrixCrossSigningService {
  private readonly matrixServerName = readMatrixServerName();

  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: ConversationEligibilityService,
    private readonly deviceLists: MatrixDeviceListPublisher
  ) {}

  async status(principal: SessionPrincipal): Promise<IdentityStatus> {
    return this.withContext(principal, async (tx, context) => {
      const stored = await tx.matrixCrossSigningIdentity.findUnique({ where: { userId: principal.id } });
      if (!stored) return this.response(context, null);
      await this.requireStoredCertificate(tx, principal.id, context.deviceId, stored.bootstrapDeviceId);
      return this.response(context, stored);
    });
  }

  async bootstrap(principal: SessionPrincipal, value: unknown): Promise<IdentityStatus> {
    this.requireParticipant(principal);
    const body = this.parseBody(value);
    return this.withContext(principal, async (tx, context) => {
      // The original first-device-only rule is retained until there is an
      // independent, visible authorization ceremony for additional devices.
      if (await tx.device.count({ where: { userId: principal.id } }) !== 1) {
        throw this.conflict("MATRIX_CROSS_SIGNING_INITIAL_DEVICE_REQUIRED");
      }
      const stored = await tx.matrixCrossSigningIdentity.findUnique({ where: { userId: principal.id } });
      const parsed = this.parseBootstrap(body, context, stored ? {
        userId: stored.matrixUserId,
        masterKey: stored.masterKey,
        selfSigningKey: stored.selfSigningKey,
        userSigningKey: stored.userSigningKey
      } : null);
      const bootstrapSha256 = hashMatrixCanonicalJson({
        signingKeys: parsed.signingKeys,
        signedDeviceKeys: parsed.signedDeviceKeys
      });
      const canonicalSha256 = hashMatrixCanonicalJson(parsed.signedDeviceKeys);
      if (stored) {
        const certificate = await this.requireStoredCertificate(tx, principal.id, context.deviceId, stored.bootstrapDeviceId);
        if (stored.bootstrapSha256 !== bootstrapSha256 || certificate.canonicalSha256 !== canonicalSha256) {
          throw this.conflict("MATRIX_CROSS_SIGNING_REPLAY_MISMATCH");
        }
        // No new certificate, device-list version or notification on a retry.
        return this.response(context, stored);
      }

      const identity = await tx.matrixCrossSigningIdentity.create({ data: {
        userId: principal.id,
        matrixUserId: context.matrixUserId,
        bootstrapDeviceId: context.deviceId,
        masterKey: parsed.identity.masterKey,
        selfSigningKey: parsed.identity.selfSigningKey,
        userSigningKey: parsed.identity.userSigningKey,
        signingKeys: parsed.signingKeys as unknown as Prisma.InputJsonValue,
        bootstrapSha256,
        createdAt: context.now
      } });
      await tx.matrixDeviceCrossSigning.create({ data: {
        deviceId: context.deviceId,
        userId: principal.id,
        signedDeviceKeys: parsed.signedDeviceKeys as unknown as Prisma.InputJsonValue,
        canonicalSha256,
        createdAt: context.now
      } });
      await this.deviceLists.publishDeviceSetChanged(tx, principal.id, context.deviceId, context.now);
      return this.response(context, identity);
    });
  }

  private async withContext<T>(principal: SessionPrincipal, operation: (tx: Transaction, context: IdentityContext) => Promise<T>): Promise<T> {
    this.requireParticipant(principal);
    const deviceId = principal.deviceId;
    if (!deviceId) throw new ForbiddenException("La sesión no tiene un dispositivo vinculado.");
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(hashtextextended('sinochat:devices:' || ${principal.id}::text, 0))::text
        `;
        await this.eligibility.lockOperationalUser(tx, principal.id);
        const cashier = principal.role === "CASHIER"
          ? await this.eligibility.lockCurrentCashier(tx, principal.id) : null;
        // Lock the actual session as well as the device. A principal checked by
        // an HTTP guard before a concurrent logout/revocation is not authority.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT d."id" FROM "devices" d
          JOIN "auth_sessions" s ON s."device_id" = d."id"
          WHERE d."id" = ${deviceId}::uuid AND d."user_id" = ${principal.id}::uuid
            AND d."status" = 'ACTIVE' AND d."protocol_version" = 'matrix-olm-v1'
            AND s."id" = ${principal.sessionId}::uuid AND s."user_id" = ${principal.id}::uuid
          FOR SHARE OF d, s
        `;
        if (locked.length !== 1) throw new UnauthorizedException("El dispositivo o la sesión ya no están disponibles.");
        const now = await this.requireCurrentSession(tx, principal, deviceId, cashier?.subscriptionEndsAt ?? null);
        const original = await tx.matrixDeviceKey.findUnique({ where: { deviceId } });
        const matrixUserId = matrixUserIdFromUuid(principal.id, this.matrixServerName);
        const matrixDeviceId = matrixDeviceIdFromUuid(deviceId);
        if (!original || original.userId !== principal.id || original.matrixUserId !== matrixUserId || original.matrixDeviceId !== matrixDeviceId) {
          throw new ForbiddenException("La identidad original del dispositivo no está disponible.");
        }
        const context: IdentityContext = {
          deviceId, matrixUserId, matrixDeviceId, deviceKeys: original.deviceKeys,
          now, subscriptionEndsAt: cashier?.subscriptionEndsAt ?? null
        };
        const result = await operation(tx, context);
        // Locks protect changes, but the session/subscription clock can still
        // expire during cryptographic verification or publication. Roll back.
        await this.requireCurrentSession(tx, principal, deviceId, context.subscriptionEndsAt);
        return result;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 30_000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (
        error.code === "P2002" || error.code === "P2034" ||
        (error.code === "P2010" && ["40001", "40P01", "23505"].includes(String(error.meta?.code)))
      )) throw this.conflict("MATRIX_CROSS_SIGNING_CONCURRENT_CHANGE");
      throw error;
    }
  }

  private async requireCurrentSession(tx: Transaction, principal: SessionPrincipal, deviceId: string, subscriptionEndsAt: Date | null): Promise<Date> {
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    if (!(clock?.now instanceof Date) || !Number.isFinite(clock.now.getTime())) throw new Error("MATRIX_DATABASE_CLOCK_UNAVAILABLE");
    const session = await tx.authSession.findUnique({
      where: { id: principal.sessionId },
      select: {
        userId: true, deviceId: true, revokedAt: true, expiresAt: true, sessionVersion: true,
        user: { select: { role: true, status: true, sessionVersion: true, passwordResetRequired: true } }
      }
    });
    if (!session || session.userId !== principal.id || session.deviceId !== deviceId ||
      session.revokedAt !== null || session.expiresAt <= clock.now ||
      session.sessionVersion !== session.user.sessionVersion || session.user.role !== principal.role ||
      session.user.status !== "ACTIVE" || session.user.passwordResetRequired ||
      (subscriptionEndsAt !== null && subscriptionEndsAt <= clock.now)) {
      throw new UnauthorizedException("La sesión o la suscripción ya no están vigentes.");
    }
    return clock.now;
  }

  private async requireStoredCertificate(tx: Transaction, userId: string, deviceId: string, bootstrapDeviceId: string) {
    if (deviceId !== bootstrapDeviceId) throw this.conflict("MATRIX_CROSS_SIGNING_INITIAL_DEVICE_REQUIRED");
    const certificate = await tx.matrixDeviceCrossSigning.findUnique({ where: { deviceId } });
    if (!certificate || certificate.userId !== userId) throw this.conflict("MATRIX_CROSS_SIGNING_IDENTITY_INCOMPLETE");
    return certificate;
  }

  private response(context: IdentityContext, identity: IdentityStatus["identity"]): IdentityStatus {
    return {
      state: identity ? "PINNED" : "UNINITIALIZED",
      matrixUserId: context.matrixUserId,
      matrixDeviceId: context.matrixDeviceId,
      identity: identity ? { masterKey: identity.masterKey, selfSigningKey: identity.selfSigningKey, userSigningKey: identity.userSigningKey } : null
    };
  }

  private requireParticipant(principal: SessionPrincipal): void {
    if (principal.role !== "CLIENT" && principal.role !== "CASHIER") throw new ForbiddenException("El rol no puede publicar identidades de chat.");
  }

  private parseBody(value: unknown): { signing_keys: unknown; device_signatures: unknown } {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new BadRequestException("MATRIX_CROSS_SIGNING_BODY_INVALID");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes("signing_keys") || !keys.includes("device_signatures")) throw new BadRequestException("MATRIX_CROSS_SIGNING_BODY_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of ["signing_keys", "device_signatures"]) {
      if (!descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], "value")) throw new BadRequestException("MATRIX_CROSS_SIGNING_BODY_INVALID");
    }
    return { signing_keys: descriptors.signing_keys.value, device_signatures: descriptors.device_signatures.value };
  }

  private parseBootstrap(body: { signing_keys: unknown; device_signatures: unknown }, context: IdentityContext, pinnedIdentity: Parameters<typeof parseMatrixCrossSigningBootstrap>[2]["pinnedIdentity"]) {
    try {
      return parseMatrixCrossSigningBootstrap(body.signing_keys, body.device_signatures, {
        userId: context.matrixUserId, deviceId: context.matrixDeviceId, registeredDeviceKeys: context.deviceKeys, pinnedIdentity
      });
    } catch (error) {
      if (error instanceof MatrixCrossSigningValidationError) {
        if (error.code === "MATRIX_CROSS_SIGNING_IDENTITY_CHANGE_FORBIDDEN") throw this.conflict(error.code);
        throw new BadRequestException({ code: error.code, message: "No se pudo validar la identidad del dispositivo." });
      }
      throw error;
    }
  }

  private conflict(code: string): ConflictException {
    return new ConflictException({ code, message: "La identidad del dispositivo no coincide o cambió durante la operación. No se reemplazaron las claves." });
  }
}
