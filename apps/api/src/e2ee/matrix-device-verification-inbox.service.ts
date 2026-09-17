import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { matrixDeviceIdFromUuid, matrixUserIdFromUuid } from "@sinochat/contracts";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import type { SessionPrincipal } from "../auth/auth.types";
import { readMatrixServerName } from "../config/runtime-config";
import { PrismaService } from "../database/prisma.service";
import { Prisma, type MatrixDeviceCandidate, type MatrixDeviceVerificationFlow } from "../generated/prisma/client";
import { parseMatrixDeviceCandidate } from "./matrix-device-candidate";
import { MatrixKeyUploadValidationError } from "./matrix-key-upload";
import { MatrixSasValidationError, parseMatrixSasToDeviceRequest, type MatrixSasContent } from "./matrix-sas-to-device";

type Transaction = Prisma.TransactionClient;
export interface MatrixVerificationIncomingRequest {
  candidateId: string;
  flowId: string;
  transactionId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  createdAt: string;
  expiresAt: string;
  event: { sender: string; type: "m.key.verification.request"; content: MatrixSasContent };
}
export interface MatrixVerificationInbox { request: MatrixVerificationIncomingRequest | null }

/** Repeatable initial-request delivery only. No ACK, consumption, SDK trust,
 * secrets, operational transport, follow-up events or device authorization.
 */
@Injectable()
export class MatrixDeviceVerificationInboxService {
  private readonly serverName = readMatrixServerName();
  constructor(private readonly prisma: PrismaService, private readonly eligibility: ConversationEligibilityService) {}

  async poll(principal: SessionPrincipal, candidateId: string): Promise<MatrixVerificationInbox> {
    if (principal.role !== "CLIENT" && principal.role !== "CASHIER") throw new ForbiddenException("El rol no puede recibir verificaciones de chat.");
    if (principal.deviceId !== null) throw new ForbiddenException("Se necesita la sesión original del dispositivo pendiente.");
    if (typeof candidateId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidateId)) {
      throw new BadRequestException("MATRIX_CANDIDATE_ID_INVALID");
    }
    const matrixUserId = matrixUserIdFromUuid(principal.id, this.serverName);
    const empty: MatrixVerificationInbox = { request: null };
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('sinochat:devices:' || ${principal.id}::text, 0))::text`;
        await this.eligibility.lockOperationalUser(tx, principal.id);
        const cashier = principal.role === "CASHIER" ? await this.eligibility.lockCurrentCashier(tx, principal.id) : null;
        const subscriptionEnd = cashier?.subscriptionEndsAt ?? null;
        // Peek only at immutable, owner-scoped IDs to preserve the admission
        // lock order: reviewer/bootstrap -> candidate -> requester -> flow.
        // All authority and public payloads are re-read after their row locks.
        const peek = await tx.matrixDeviceCandidate.findFirst({
          where: { id: candidateId, userId: principal.id, sessionId: principal.sessionId },
          select: { trustedDeviceId: true, verificationFlow: { select: { reviewerSessionId: true } } }
        });
        if (!peek) throw this.unavailable();
        const reviewerSessionId = peek.verificationFlow?.reviewerSessionId ?? null;
        let trusted = false;
        if (reviewerSessionId) {
          const reviewers = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT s."id" FROM "auth_sessions" s
            JOIN "devices" d ON d."id"=s."device_id" AND d."user_id"=s."user_id"
            JOIN "matrix_device_keys" k ON k."device_id"=d."id" AND k."user_id"=d."user_id"
            JOIN "matrix_device_cross_signings" c ON c."device_id"=d."id" AND c."user_id"=d."user_id"
            WHERE s."id"=${reviewerSessionId}::uuid AND s."user_id"=${principal.id}::uuid
              AND d."id"=${peek.trustedDeviceId}::uuid AND d."status"='ACTIVE' AND d."protocol_version"='matrix-olm-v1'
              AND k."matrix_user_id"=${matrixUserId} AND k."matrix_device_id"=${matrixDeviceIdFromUuid(peek.trustedDeviceId)}
            FOR SHARE OF s,d
          `;
          trusted = reviewers.length === 1;
        }
        const candidates = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT q."id" FROM "matrix_device_candidates" q WHERE q."id"=${candidateId}::uuid
            AND q."user_id"=${principal.id}::uuid AND q."session_id"=${principal.sessionId}::uuid FOR UPDATE OF q
        `;
        if (candidates.length !== 1) throw this.unavailable();
        const sessions = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT r."id" FROM "auth_sessions" r WHERE r."id"=${principal.sessionId}::uuid
            AND r."user_id"=${principal.id}::uuid FOR SHARE OF r
        `;
        if (sessions.length !== 1) throw this.unauthorized();
        await this.requester(tx, principal, subscriptionEnd);
        const candidate = await tx.matrixDeviceCandidate.findUniqueOrThrow({ where: { id: candidateId } });
        if (candidate.userId !== principal.id || candidate.sessionId !== principal.sessionId || candidate.trustedDeviceId !== peek.trustedDeviceId ||
          candidate.matrixUserId !== matrixUserId || candidate.matrixDeviceId !== matrixDeviceIdFromUuid(candidateId)) throw this.conflict();
        await tx.$queryRaw`SELECT f."candidate_id" FROM "matrix_device_verification_flows" f
          WHERE f."candidate_id"=${candidateId}::uuid FOR UPDATE OF f`;
        const flow = await tx.matrixDeviceVerificationFlow.findUnique({ where: { candidateId } });
        const peer = reviewerSessionId && trusted ? await tx.authSession.findUnique({ where: { id: reviewerSessionId }, select: {
          userId: true, deviceId: true, revokedAt: true, sessionVersion: true, expiresAt: true
        } }) : null;
        const identity = flow ? await tx.matrixCrossSigningIdentity.findUnique({ where: { userId: principal.id } }) : null;
        const current = await this.requester(tx, principal, subscriptionEnd);
        if (candidate.sessionVersion !== current.sessionVersion) throw this.conflict();
        if (this.needsExpiration(candidate, flow, current.now)) {
          await this.expire(tx, principal, subscriptionEnd, candidate, current.now);
          return empty;
        }
        if (candidate.status !== "PENDING" || !flow || flow.status !== "PENDING") return empty;
        if (flow.userId !== principal.id || flow.candidateId !== candidateId || flow.reviewerSessionId !== reviewerSessionId ||
          flow.reviewerSessionId === principal.sessionId || flow.reviewerSessionVersion !== current.sessionVersion ||
          !identity || identity.matrixUserId !== matrixUserId || identity.bootstrapDeviceId !== candidate.trustedDeviceId ||
          identity.bootstrapSha256 !== candidate.identityBootstrapSha256) throw this.conflict();
        if (!peer || peer.userId !== principal.id || peer.deviceId !== candidate.trustedDeviceId || peer.revokedAt !== null ||
          peer.sessionVersion !== flow.reviewerSessionVersion || peer.expiresAt <= current.now) return empty;

        const snapshot = parseMatrixDeviceCandidate({ device_keys: candidate.deviceKeys }, {
          userId: matrixUserId, deviceId: candidate.matrixDeviceId
        });
        if (snapshot.canonicalSha256 !== candidate.canonicalSha256 || snapshot.ed25519Key !== candidate.ed25519Key ||
          snapshot.curve25519Key !== candidate.curve25519Key) throw this.conflict();
        const request = parseMatrixSasToDeviceRequest("m.key.verification.request", flow.requestTransactionId,
          { messages: { [matrixUserId]: { [candidate.matrixDeviceId]: flow.requestContent } } }, {
            userId: matrixUserId, senderDeviceId: matrixDeviceIdFromUuid(candidate.trustedDeviceId),
            recipientDeviceId: candidate.matrixDeviceId, flowId: flow.flowId, pinnedMasterKey: identity.masterKey
          });
        if (request.canonicalSha256 !== flow.requestSha256) throw this.conflict();
        const after = await this.requester(tx, principal, subscriptionEnd);
        if (this.needsExpiration(candidate, flow, after.now)) {
          await this.expire(tx, principal, subscriptionEnd, candidate, after.now);
          return empty;
        }
        if (peer.expiresAt <= after.now) return empty;
        const content = request.messages[matrixUserId][candidate.matrixDeviceId];
        // Stored dates cannot be extended. Also fail closed if a clock rollback
        // puts this request ahead of its allowed window; never rewrite timestamp.
        const timestamp = content.timestamp as number;
        if (candidate.createdAt > after.now || flow.createdAt > after.now || timestamp > after.now.getTime() + 300_000 ||
          timestamp + 600_000 <= after.now.getTime()) return empty;
        return { request: {
          candidateId, flowId: flow.flowId, transactionId: request.transactionId,
          senderDeviceId: request.senderDeviceId, recipientDeviceId: request.recipientDeviceId,
          createdAt: flow.createdAt.toISOString(), expiresAt: flow.expiresAt.toISOString(),
          event: { sender: matrixUserId, type: "m.key.verification.request", content }
        } };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 30_000 });
    } catch (error) {
      // These parsers validate stored data, not a caller-supplied body. Do not
      // expose the payload or turn corrupted server context into a 400 response.
      if (error instanceof MatrixSasValidationError || error instanceof MatrixKeyUploadValidationError) throw this.conflict();
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" ||
        (error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code))))) throw this.conflict();
      throw error;
    }
  }

  private async requester(tx: Transaction, principal: SessionPrincipal, subscriptionEnd: Date | null) {
    const session = await tx.authSession.findUnique({ where: { id: principal.sessionId }, select: {
      userId: true, deviceId: true, revokedAt: true, expiresAt: true, sessionVersion: true,
      user: { select: { role: true, status: true, sessionVersion: true, passwordResetRequired: true } }
    } });
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    if (!(clock?.now instanceof Date) || !Number.isFinite(clock.now.getTime())) throw new Error("MATRIX_DATABASE_CLOCK_UNAVAILABLE");
    if (!session || session.userId !== principal.id || session.deviceId !== null || session.revokedAt !== null ||
      session.sessionVersion !== session.user.sessionVersion || session.expiresAt <= clock.now || session.user.role !== principal.role ||
      session.user.status !== "ACTIVE" || session.user.passwordResetRequired || (subscriptionEnd !== null && subscriptionEnd <= clock.now)) throw this.unauthorized();
    return { now: clock.now, sessionVersion: session.sessionVersion };
  }

  private needsExpiration(candidate: MatrixDeviceCandidate, flow: MatrixDeviceVerificationFlow | null, now: Date) {
    return candidate.status === "PENDING" && (candidate.expiresAt <= now || (flow?.status === "PENDING" && flow.expiresAt <= now));
  }
  private async expire(tx: Transaction, principal: SessionPrincipal, subscriptionEnd: Date | null,
    candidate: MatrixDeviceCandidate, now: Date) {
    // Denial only, allowed for the original requester even after peer logout.
    // SQL invalidates the flow. No ACK, refresh or successful delivery is stored.
    await tx.matrixDeviceCandidate.update({ where: { id: candidate.id }, data: {
      status: candidate.expiresAt <= now ? "EXPIRED" : "CANCELLED", resolvedAt: now
    } });
    await this.requester(tx, principal, subscriptionEnd);
  }
  private unavailable() { return new NotFoundException("Solicitud de verificación no disponible."); }
  private unauthorized() { return new UnauthorizedException("La sesión solicitante ya no está disponible."); }
  private conflict() { return new ConflictException({ code: "MATRIX_VERIFICATION_INBOX_CONTEXT_CHANGED", message: "No se pudo entregar la verificación. No se autorizó ningún dispositivo." }); }
}
