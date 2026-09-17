import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { matrixDeviceIdFromUuid, matrixUserIdFromUuid } from "@sinochat/contracts";
import type { SessionPrincipal } from "../auth/auth.types";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import { readMatrixServerName } from "../config/runtime-config";
import { PrismaService } from "../database/prisma.service";
import { Prisma, type MatrixDeviceCandidate, type MatrixCrossSigningIdentity } from "../generated/prisma/client";
import { parseMatrixDeviceCandidate } from "./matrix-device-candidate";
import { MatrixKeyUploadValidationError } from "./matrix-key-upload";

type Transaction = Prisma.TransactionClient;
interface CandidateContext {
  identity: MatrixCrossSigningIdentity;
  now: Date;
  sessionVersion: number;
  sessionExpiresAt: Date;
  subscriptionEndsAt: Date | null;
}
export interface MatrixDeviceCandidateStatus {
  candidateId: string;
  state: "PENDING" | "CANCELLED" | "EXPIRED";
  matrixUserId: string;
  matrixDeviceId: string;
  createdAt: string;
  expiresAt: string;
}

/** Public quarantine only. No approval, device activation, SAS relay or key publication. */
@Injectable()
export class MatrixDeviceCandidatesService {
  private readonly serverName = readMatrixServerName();
  constructor(private readonly prisma: PrismaService, private readonly eligibility: ConversationEligibilityService) {}

  async reserve(principal: SessionPrincipal, candidateId: string, value: unknown): Promise<MatrixDeviceCandidateStatus> {
    this.requireRequester(principal);
    this.requireCandidateId(candidateId);
    const matrixUserId = matrixUserIdFromUuid(principal.id, this.serverName);
    const matrixDeviceId = matrixDeviceIdFromUuid(candidateId);
    let parsed;
    try { parsed = parseMatrixDeviceCandidate(value, { userId: matrixUserId, deviceId: matrixDeviceId }); }
    catch (error) {
      if (error instanceof MatrixKeyUploadValidationError) {
        throw new BadRequestException({ code: error.code, message: "No se pudieron validar las claves públicas del dispositivo pendiente." });
      }
      throw error;
    }
    return this.withContext(principal, async (tx, context) => {
      const previous = await tx.matrixDeviceCandidate.findUnique({ where: { id: candidateId } });
      if (previous) {
        if (previous.userId !== principal.id || previous.sessionId !== principal.sessionId ||
          previous.sessionVersion !== context.sessionVersion || previous.canonicalSha256 !== parsed.canonicalSha256 ||
          previous.identityBootstrapSha256 !== context.identity.bootstrapSha256 ||
          previous.trustedDeviceId !== context.identity.bootstrapDeviceId) {
          throw this.conflict("MATRIX_CANDIDATE_REPLAY_MISMATCH");
        }
        // A terminal/expired ID is never reopened, including after a lost response.
        return previous;
      }
      if (await tx.device.findUnique({ where: { id: candidateId }, select: { id: true } }) ||
        await tx.matrixDeviceRegistration.findUnique({ where: { id: candidateId }, select: { id: true } })) {
        throw this.conflict("MATRIX_CANDIDATE_ID_UNAVAILABLE");
      }
      const keys = [parsed.ed25519Key, parsed.curve25519Key];
      if (parsed.ed25519Key === parsed.curve25519Key ||
        [context.identity.masterKey, context.identity.selfSigningKey, context.identity.userSigningKey].some((key) => keys.includes(key)) ||
        await tx.matrixDeviceKey.findFirst({ where: { OR: [
          { ed25519Key: { in: keys } }, { curve25519Key: { in: keys } }
        ] }, select: { deviceId: true } })) {
        throw this.conflict("MATRIX_CANDIDATE_KEY_REUSED");
      }
      // The partial unique index cannot contain a moving clock. Expire old rows
      // explicitly under the same per-user lock; never extend their deadline.
      await tx.matrixDeviceCandidate.updateMany({
        where: { userId: principal.id, status: "PENDING", expiresAt: { lte: context.now } },
        data: { status: "EXPIRED", resolvedAt: context.now }
      });
      if (await tx.matrixDeviceCandidate.findFirst({ where: { userId: principal.id, status: "PENDING" }, select: { id: true } })) {
        throw this.conflict("MATRIX_CANDIDATE_ALREADY_PENDING");
      }
      const expiresAt = new Date(Math.min(context.now.getTime() + 600_000,
        context.sessionExpiresAt.getTime(), context.subscriptionEndsAt?.getTime() ?? Infinity));
      return tx.matrixDeviceCandidate.create({ data: {
        id: candidateId, userId: principal.id, sessionId: principal.sessionId,
        sessionVersion: context.sessionVersion, matrixUserId, matrixDeviceId,
        trustedDeviceId: context.identity.bootstrapDeviceId,
        identityBootstrapSha256: context.identity.bootstrapSha256,
        deviceKeys: parsed.deviceKeys as unknown as Prisma.InputJsonValue,
        canonicalSha256: parsed.canonicalSha256, ed25519Key: parsed.ed25519Key,
        curve25519Key: parsed.curve25519Key, status: "PENDING", createdAt: context.now, expiresAt
      } });
    }, true);
  }

  async status(principal: SessionPrincipal, candidateId: string): Promise<MatrixDeviceCandidateStatus> {
    this.requireCandidateId(candidateId);
    return this.withContext(principal, (tx, context) => this.ownCandidate(tx, principal, candidateId, context));
  }

  async cancel(principal: SessionPrincipal, candidateId: string): Promise<MatrixDeviceCandidateStatus> {
    this.requireCandidateId(candidateId);
    return this.withContext(principal, async (tx, context) => {
      const candidate = await this.ownCandidate(tx, principal, candidateId, context);
      if (candidate.status !== "PENDING") return candidate;
      // Cancellation never needs a free-text reason. Expired beats cancelled.
      return tx.matrixDeviceCandidate.update({ where: { id: candidateId }, data: {
        status: candidate.expiresAt <= context.now ? "EXPIRED" : "CANCELLED", resolvedAt: context.now
      } });
    });
  }

  private async ownCandidate(tx: Transaction, principal: SessionPrincipal, id: string, context: CandidateContext) {
    const candidate = await tx.matrixDeviceCandidate.findFirst({ where: { id, userId: principal.id, sessionId: principal.sessionId } });
    if (!candidate) throw new NotFoundException("Solicitud de dispositivo no disponible.");
    if (candidate.sessionVersion !== context.sessionVersion || candidate.identityBootstrapSha256 !== context.identity.bootstrapSha256 ||
      candidate.trustedDeviceId !== context.identity.bootstrapDeviceId) throw this.conflict("MATRIX_CANDIDATE_CONTEXT_CHANGED");
    return candidate;
  }

  private async withContext(principal: SessionPrincipal,
    operation: (tx: Transaction, context: CandidateContext) => Promise<MatrixDeviceCandidate>,
    requireLiveResult = false): Promise<MatrixDeviceCandidateStatus> {
    this.requireRequester(principal);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('sinochat:devices:' || ${principal.id}::text, 0))::text`;
        await this.eligibility.lockOperationalUser(tx, principal.id);
        const cashier = principal.role === "CASHIER" ? await this.eligibility.lockCurrentCashier(tx, principal.id) : null;
        const identity = await tx.matrixCrossSigningIdentity.findUnique({ where: { userId: principal.id } });
        if (!identity || identity.matrixUserId !== matrixUserIdFromUuid(principal.id, this.serverName)) {
          throw this.conflict("MATRIX_CANDIDATE_EXISTING_IDENTITY_REQUIRED");
        }
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT s."id" FROM "auth_sessions" s
          JOIN "devices" d ON d."user_id" = s."user_id" AND d."id" = ${identity.bootstrapDeviceId}::uuid
          JOIN "matrix_device_cross_signings" c ON c."device_id" = d."id" AND c."user_id" = d."user_id"
          WHERE s."id" = ${principal.sessionId}::uuid AND s."user_id" = ${principal.id}::uuid
            AND s."device_id" IS NULL AND d."status" = 'ACTIVE' AND d."protocol_version" = 'matrix-olm-v1'
          FOR SHARE OF s, d
        `;
        if (locked.length !== 1) throw new UnauthorizedException("La sesión o el dispositivo confiable ya no están disponibles.");
        const subscriptionEndsAt = cashier?.subscriptionEndsAt ?? null;
        const current = await this.currentSession(tx, principal, subscriptionEndsAt);
        const context: CandidateContext = { identity, now: current.now, sessionVersion: current.sessionVersion,
          sessionExpiresAt: current.expiresAt, subscriptionEndsAt };
        let result = await operation(tx, context);
        // Locks prevent state changes, not passage of time. Recheck before commit.
        const after = await this.currentSession(tx, principal, subscriptionEndsAt);
        if (after.sessionVersion !== context.sessionVersion) throw new UnauthorizedException("La sesión cambió durante la operación.");
        if (requireLiveResult && result.status === "PENDING" && result.expiresAt > context.now && result.expiresAt <= after.now) {
          throw this.conflict("MATRIX_CANDIDATE_EXPIRED_DURING_OPERATION");
        }
        if (result.status === "PENDING" && result.expiresAt <= after.now) {
          // Latch an observed expiration, including during a status poll. A
          // subsequent database-clock rollback must not revive this request.
          result = await tx.matrixDeviceCandidate.update({ where: { id: result.id }, data: { status: "EXPIRED", resolvedAt: after.now } });
          await this.currentSession(tx, principal, subscriptionEndsAt);
        }
        return this.response(result, after.now);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 30_000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (
        error.code === "P2002" || error.code === "P2034" ||
        (error.code === "P2010" && ["40001", "40P01", "23505"].includes(String(error.meta?.code)))
      )) throw this.conflict("MATRIX_CANDIDATE_CONCURRENT_CHANGE");
      throw error;
    }
  }

  private async currentSession(tx: Transaction, principal: SessionPrincipal, subscriptionEndsAt: Date | null) {
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    if (!(clock?.now instanceof Date) || !Number.isFinite(clock.now.getTime())) throw new Error("MATRIX_DATABASE_CLOCK_UNAVAILABLE");
    const session = await tx.authSession.findUnique({ where: { id: principal.sessionId }, select: {
      userId: true, deviceId: true, revokedAt: true, expiresAt: true, sessionVersion: true,
      user: { select: { role: true, status: true, sessionVersion: true, passwordResetRequired: true } }
    } });
    if (!session || session.userId !== principal.id || session.deviceId !== null || session.revokedAt !== null ||
      session.expiresAt <= clock.now || session.sessionVersion !== session.user.sessionVersion ||
      session.user.role !== principal.role || session.user.status !== "ACTIVE" || session.user.passwordResetRequired ||
      (subscriptionEndsAt !== null && subscriptionEndsAt <= clock.now)) {
      throw new UnauthorizedException("La sesión o la suscripción ya no están vigentes.");
    }
    return { now: clock.now, sessionVersion: session.sessionVersion, expiresAt: session.expiresAt };
  }

  private response(row: MatrixDeviceCandidate, now: Date): MatrixDeviceCandidateStatus {
    return { candidateId: row.id, state: row.status === "PENDING" && row.expiresAt <= now ? "EXPIRED" : row.status,
      matrixUserId: row.matrixUserId, matrixDeviceId: row.matrixDeviceId,
      createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString() };
  }
  private requireRequester(principal: SessionPrincipal): void {
    if (principal.role !== "CLIENT" && principal.role !== "CASHIER") throw new ForbiddenException("El rol no puede solicitar dispositivos de chat.");
    if (principal.deviceId !== null) throw new ForbiddenException("La sesión ya tiene un dispositivo vinculado.");
  }
  private requireCandidateId(id: string): void {
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
      throw new BadRequestException("MATRIX_CANDIDATE_ID_INVALID");
    }
  }
  private conflict(code: string): ConflictException {
    return new ConflictException({ code, message: "La solicitud no está disponible o cambió. No se activó ningún dispositivo." });
  }
}
