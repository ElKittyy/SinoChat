import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { matrixDeviceIdFromUuid, matrixUserIdFromUuid } from "@sinochat/contracts";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import type { SessionPrincipal } from "../auth/auth.types";
import { readMatrixServerName } from "../config/runtime-config";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import { parseMatrixDeviceCandidate } from "./matrix-device-candidate";
import { MatrixKeyUploadValidationError } from "./matrix-key-upload";
import { MatrixSasValidationError, parseMatrixSasToDeviceRequest } from "./matrix-sas-to-device";

type Transaction = Prisma.TransactionClient;
const TEN_MINUTES = 600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FLOW = /^[A-Za-z0-9._~-]{1,255}$/;
export interface MatrixVerificationAdmission {
  candidateId: string; flowId: string; state: "PENDING"; createdAt: string; expiresAt: string;
}

/** Admission only: bind a bootstrap-initiated SDK request to two exact sessions.
 * No delivery, SAS confirmation, signature publication, Device or session binding.
 */
@Injectable()
export class MatrixDeviceVerificationService {
  private readonly serverName = readMatrixServerName();
  constructor(private readonly prisma: PrismaService, private readonly eligibility: ConversationEligibilityService) {}

  async open(principal: SessionPrincipal, candidateId: string, flowId: string, transactionId: string,
    body: unknown): Promise<MatrixVerificationAdmission> {
    if (principal.role !== "CLIENT" && principal.role !== "CASHIER") throw new ForbiddenException("El rol no puede verificar dispositivos de chat.");
    if (typeof principal.deviceId !== "string" || !UUID.test(principal.deviceId)) throw new ForbiddenException("Se necesita el dispositivo confiable.");
    if (typeof candidateId !== "string" || !UUID.test(candidateId) || typeof flowId !== "string" || !FLOW.test(flowId) ||
      typeof transactionId !== "string" || !FLOW.test(transactionId)) throw new BadRequestException("MATRIX_VERIFICATION_ID_INVALID");
    const deviceId = principal.deviceId, matrixUserId = matrixUserIdFromUuid(principal.id, this.serverName);
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('sinochat:devices:' || ${principal.id}::text, 0))::text`;
        await this.eligibility.lockOperationalUser(tx, principal.id);
        const cashier = principal.role === "CASHIER" ? await this.eligibility.lockCurrentCashier(tx, principal.id) : null;
        const subscriptionEnd = cashier?.subscriptionEndsAt ?? null;
        const identity = await tx.matrixCrossSigningIdentity.findUnique({ where: { userId: principal.id } });
        if (!identity || identity.bootstrapDeviceId !== deviceId || identity.matrixUserId !== matrixUserId) throw this.unavailable();
        const reviewerLock = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT s."id" FROM "auth_sessions" s
          JOIN "devices" d ON d."id"=s."device_id" AND d."user_id"=s."user_id"
          JOIN "matrix_device_keys" k ON k."device_id"=d."id" AND k."user_id"=d."user_id"
          JOIN "matrix_device_cross_signings" c ON c."device_id"=d."id" AND c."user_id"=d."user_id"
          WHERE s."id"=${principal.sessionId}::uuid AND s."user_id"=${principal.id}::uuid
            AND d."id"=${deviceId}::uuid AND d."status"='ACTIVE' AND d."protocol_version"='matrix-olm-v1'
            AND k."matrix_user_id"=${matrixUserId} AND k."matrix_device_id"=${matrixDeviceIdFromUuid(deviceId)}
          FOR SHARE OF s,d
        `;
        if (reviewerLock.length !== 1) throw this.unauthorized();
        await this.reviewer(tx, principal, subscriptionEnd);
        const ids = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT q."id" FROM "matrix_device_candidates" q WHERE q."id"=${candidateId}::uuid
            AND q."user_id"=${principal.id}::uuid AND q."trusted_device_id"=${deviceId}::uuid FOR UPDATE OF q
        `;
        if (ids.length !== 1) throw this.unavailable();
        const candidate = await tx.matrixDeviceCandidate.findUniqueOrThrow({ where: { id: candidateId } });
        if (candidate.userId !== principal.id || candidate.trustedDeviceId !== deviceId || candidate.matrixUserId !== matrixUserId ||
          candidate.identityBootstrapSha256 !== identity.bootstrapSha256 || candidate.matrixDeviceId !== matrixDeviceIdFromUuid(candidateId)) throw this.conflict();
        const requesterLock = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT r."id" FROM "auth_sessions" r WHERE r."id"=${candidate.sessionId}::uuid
            AND r."user_id"=${principal.id}::uuid FOR SHARE OF r
        `;
        if (requesterLock.length !== 1 || candidate.sessionId === principal.sessionId) throw this.unavailable();
        const requester = await tx.authSession.findUniqueOrThrow({ where: { id: candidate.sessionId } });
        // The flow ID is explicitly a NEW untrusted proposal at this admission
        // boundary. Sender, recipient, owner and root come only from locked DB
        // context. Later transport must load the stored flow, not repeat admission.
        const request = parseMatrixSasToDeviceRequest("m.key.verification.request", transactionId, body, {
          userId: matrixUserId, senderDeviceId: matrixDeviceIdFromUuid(deviceId), recipientDeviceId: candidate.matrixDeviceId,
          flowId, pinnedMasterKey: identity.masterKey
        });
        const content = request.messages[matrixUserId][candidate.matrixDeviceId];
        const snapshot = parseMatrixDeviceCandidate({ device_keys: candidate.deviceKeys }, { userId: matrixUserId, deviceId: candidate.matrixDeviceId });
        if (snapshot.canonicalSha256 !== candidate.canonicalSha256 || snapshot.ed25519Key !== candidate.ed25519Key ||
          snapshot.curve25519Key !== candidate.curve25519Key) throw this.conflict();
        await tx.$queryRaw`SELECT f."candidate_id" FROM "matrix_device_verification_flows" f
          WHERE f."candidate_id"=${candidateId}::uuid FOR UPDATE OF f`;
        const existing = await tx.matrixDeviceVerificationFlow.findUnique({ where: { candidateId } });
        const current = await this.reviewer(tx, principal, subscriptionEnd);
        if (requester.userId !== principal.id || requester.deviceId !== null || requester.revokedAt !== null ||
          requester.sessionVersion !== candidate.sessionVersion || candidate.sessionVersion !== current.sessionVersion || requester.expiresAt <= current.now) throw this.unavailable();
        if (candidate.status !== "PENDING") return null;
        if (candidate.expiresAt <= current.now || (existing?.status === "PENDING" && existing.expiresAt <= current.now)) {
          // Parent-before-flow ordering; SQL cascades the terminal state. A new
          // ceremony needs a new candidate, never a recycled request/flow ID.
          await tx.matrixDeviceCandidate.update({ where: { id: candidateId }, data: {
            status: candidate.expiresAt <= current.now ? "EXPIRED" : "CANCELLED", resolvedAt: current.now
          } });
          await this.reviewer(tx, principal, subscriptionEnd);
          return null; // Throw OUTSIDE transaction, retaining observed expiration.
        }
        if (existing) {
          if (existing.status !== "PENDING" || existing.userId !== principal.id || existing.flowId !== flowId ||
            existing.reviewerSessionId !== principal.sessionId || existing.reviewerSessionVersion !== current.sessionVersion ||
            existing.requestTransactionId !== transactionId || existing.requestSha256 !== request.canonicalSha256) throw this.conflict();
          return this.summary(existing);
        }
        const timestamp = content.timestamp as number;
        if (timestamp < current.now.getTime() - TEN_MINUTES || timestamp > current.now.getTime() + 300_000) {
          throw new BadRequestException("MATRIX_VERIFICATION_TIMESTAMP_STALE");
        }
        const expiresAt = new Date(Math.min(candidate.expiresAt.getTime(), requester.expiresAt.getTime(), current.expiresAt.getTime(),
          subscriptionEnd?.getTime() ?? Infinity, current.now.getTime() + TEN_MINUTES, timestamp + TEN_MINUTES));
        if (expiresAt <= current.now) throw this.conflict();
        const created = await tx.matrixDeviceVerificationFlow.create({ data: {
          candidateId, userId: principal.id, flowId, reviewerSessionId: principal.sessionId,
          reviewerSessionVersion: current.sessionVersion, requestTransactionId: transactionId,
          requestContent: content as Prisma.InputJsonValue, requestSha256: request.canonicalSha256,
          status: "PENDING", createdAt: current.now, expiresAt
        } });
        const after = await this.reviewer(tx, principal, subscriptionEnd);
        if (expiresAt <= after.now || requester.expiresAt <= after.now) throw this.conflict();
        return this.summary(created);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 30_000 });
      if (!result) throw this.conflict();
      return result;
    } catch (error) {
      if (error instanceof MatrixSasValidationError) throw new BadRequestException(error.code);
      if (error instanceof MatrixKeyUploadValidationError) throw this.conflict();
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034" ||
        (error.code === "P2010" && ["40001", "40P01", "23505"].includes(String(error.meta?.code))))) throw this.conflict();
      throw error;
    }
  }

  private async reviewer(tx: Transaction, principal: SessionPrincipal, subscriptionEnd: Date | null) {
    const session = await tx.authSession.findUnique({ where: { id: principal.sessionId }, select: {
      userId: true, deviceId: true, revokedAt: true, expiresAt: true, sessionVersion: true,
      user: { select: { role: true, status: true, sessionVersion: true, passwordResetRequired: true } }
    } });
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    if (!(clock?.now instanceof Date) || !Number.isFinite(clock.now.getTime())) throw new Error("MATRIX_DATABASE_CLOCK_UNAVAILABLE");
    if (!session || session.userId !== principal.id || session.deviceId !== principal.deviceId || session.revokedAt !== null ||
      session.expiresAt <= clock.now || session.sessionVersion !== session.user.sessionVersion || session.user.role !== principal.role ||
      session.user.status !== "ACTIVE" || session.user.passwordResetRequired || (subscriptionEnd !== null && subscriptionEnd <= clock.now)) throw this.unauthorized();
    return { now: clock.now, expiresAt: session.expiresAt, sessionVersion: session.sessionVersion };
  }
  private summary(row: { candidateId: string; flowId: string; createdAt: Date; expiresAt: Date }): MatrixVerificationAdmission {
    return { candidateId: row.candidateId, flowId: row.flowId, state: "PENDING", createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString() };
  }
  private unavailable() { return new NotFoundException("Solicitud de verificación no disponible."); }
  private unauthorized() { return new UnauthorizedException("La sesión o el dispositivo confiable ya no están disponibles."); }
  private conflict() { return new ConflictException({ code: "MATRIX_VERIFICATION_CONTEXT_CHANGED", message: "La verificación cambió o terminó. No se autorizó ningún dispositivo." }); }
}
