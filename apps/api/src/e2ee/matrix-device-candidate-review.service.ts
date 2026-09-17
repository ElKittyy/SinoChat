import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { matrixDeviceIdFromUuid, matrixUserIdFromUuid } from "@sinochat/contracts";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import type { SessionPrincipal } from "../auth/auth.types";
import { readMatrixServerName } from "../config/runtime-config";
import { PrismaService } from "../database/prisma.service";
import { Prisma, type MatrixDeviceCandidate } from "../generated/prisma/client";
import { parseMatrixDeviceCandidate } from "./matrix-device-candidate";
import { MatrixKeyUploadValidationError } from "./matrix-key-upload";

type Transaction = Prisma.TransactionClient;
type PublicKeys = ReturnType<typeof parseMatrixDeviceCandidate>["deviceKeys"];
export interface MatrixCandidateReviewSummary {
  candidateId: string;
  state: "PENDING";
  matrixUserId: string;
  matrixDeviceId: string;
  createdAt: string;
  expiresAt: string;
}
export interface MatrixCandidateReviewDetail extends MatrixCandidateReviewSummary { deviceKeys: PublicKeys }
export interface MatrixCandidateRejection { candidateId: string; state: "CANCELLED" | "EXPIRED" }
interface ReviewResult { candidate: MatrixCandidateReviewDetail | null; rejection: MatrixCandidateRejection | null }

/** Own bootstrap-device review only. Reading public keys is NOT a SAS ceremony or approval. */
@Injectable()
export class MatrixDeviceCandidateReviewService {
  private readonly serverName = readMatrixServerName();
  constructor(private readonly prisma: PrismaService, private readonly eligibility: ConversationEligibilityService) {}

  async pending(principal: SessionPrincipal): Promise<{ pending: MatrixCandidateReviewSummary | null }> {
    const { candidate } = await this.review(principal, null, false);
    if (!candidate) return { pending: null };
    const { deviceKeys: _keys, ...summary } = candidate;
    return { pending: summary };
  }

  async detail(principal: SessionPrincipal, candidateId: string): Promise<MatrixCandidateReviewDetail> {
    this.requireCandidateId(candidateId);
    const { candidate } = await this.review(principal, candidateId, false);
    // Outside the transaction: an observed expiration must remain committed.
    if (!candidate) throw this.unavailable();
    return candidate;
  }

  async reject(principal: SessionPrincipal, candidateId: string): Promise<MatrixCandidateRejection> {
    this.requireCandidateId(candidateId);
    const { rejection } = await this.review(principal, candidateId, true);
    if (!rejection) throw this.unavailable();
    return rejection;
  }

  private async review(principal: SessionPrincipal, candidateId: string | null, reject: boolean): Promise<ReviewResult> {
    this.requireReviewer(principal);
    const deviceId = principal.deviceId!;
    const matrixUserId = matrixUserIdFromUuid(principal.id, this.serverName);
    const empty: ReviewResult = { candidate: null, rejection: null };
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('sinochat:devices:' || ${principal.id}::text, 0))::text`;
        await this.eligibility.lockOperationalUser(tx, principal.id);
        const cashier = principal.role === "CASHIER" ? await this.eligibility.lockCurrentCashier(tx, principal.id) : null;
        const subscriptionEndsAt = cashier?.subscriptionEndsAt ?? null;
        const identity = await tx.matrixCrossSigningIdentity.findUnique({ where: { userId: principal.id } });
        if (!identity || identity.matrixUserId !== matrixUserId || identity.bootstrapDeviceId !== deviceId) {
          throw new ForbiddenException("La sesión no pertenece al dispositivo confiable de esta cuenta.");
        }
        const actor = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT s."id" FROM "auth_sessions" s
          JOIN "devices" d ON d."id" = s."device_id" AND d."user_id" = s."user_id"
          JOIN "matrix_device_keys" k ON k."device_id" = d."id" AND k."user_id" = d."user_id"
          JOIN "matrix_device_cross_signings" c ON c."device_id" = d."id" AND c."user_id" = d."user_id"
          WHERE s."id" = ${principal.sessionId}::uuid AND s."user_id" = ${principal.id}::uuid
            AND d."id" = ${deviceId}::uuid AND d."status" = 'ACTIVE' AND d."protocol_version" = 'matrix-olm-v1'
            AND k."matrix_user_id" = ${matrixUserId} AND k."matrix_device_id" = ${matrixDeviceIdFromUuid(deviceId)}
          FOR SHARE OF s, d
        `;
        if (actor.length !== 1) throw this.unauthorized();
        const before = await this.currentReviewer(tx, principal, subscriptionEndsAt);
        // Scope BEFORE retrieving public material. Lock the row even against
        // maintenance that does not acquire the per-user advisory lock.
        const ids = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT q."id" FROM "matrix_device_candidates" q
          WHERE q."user_id" = ${principal.id}::uuid AND q."trusted_device_id" = ${deviceId}::uuid
            AND ${candidateId === null ? Prisma.sql`q."status" = 'PENDING'` : Prisma.sql`q."id" = ${candidateId}::uuid`}
          FOR UPDATE OF q
        `);
        if (ids.length !== 1) {
          await this.currentReviewer(tx, principal, subscriptionEndsAt);
          return empty;
        }
        const row = await tx.matrixDeviceCandidate.findUnique({ where: { id: ids[0].id } });
        if (!row || row.userId !== principal.id || row.trustedDeviceId !== deviceId ||
          row.identityBootstrapSha256 !== identity.bootstrapSha256 || row.matrixUserId !== matrixUserId ||
          row.matrixDeviceId !== matrixDeviceIdFromUuid(row.id)) throw this.contextChanged();

        if (reject) {
          // Denial only: a trusted owner can discard even if the original
          // requester logged out. Never needs a reason, keys, or a SAS result.
          const current = await this.currentReviewer(tx, principal, subscriptionEndsAt);
          const terminal = row.status === "PENDING" ? await tx.matrixDeviceCandidate.update({ where: { id: row.id }, data: {
            status: row.expiresAt <= current.now ? "EXPIRED" : "CANCELLED", resolvedAt: current.now
          } }) : row;
          await this.currentReviewer(tx, principal, subscriptionEndsAt);
          if (terminal.status !== "CANCELLED" && terminal.status !== "EXPIRED") throw this.contextChanged();
          return { candidate: null, rejection: { candidateId: row.id, state: terminal.status } };
        }

        if (row.status !== "PENDING") {
          await this.currentReviewer(tx, principal, subscriptionEndsAt);
          return empty;
        }
        const requesterLock = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT r."id" FROM "auth_sessions" r
          WHERE r."id" = ${row.sessionId}::uuid AND r."user_id" = ${principal.id}::uuid FOR SHARE OF r
        `;
        const requester = requesterLock.length === 1 ? await tx.authSession.findUnique({ where: { id: row.sessionId }, select: {
          userId: true, deviceId: true, revokedAt: true, expiresAt: true, sessionVersion: true
        } }) : null;
        const requesterValid = requester !== null && requester.userId === principal.id && requester.deviceId === null &&
          requester.revokedAt === null && requester.sessionVersion === row.sessionVersion && row.sessionVersion === before.sessionVersion;
        // Only reconstruct public keys when the authenticated context is still
        // eligible. Recheck the clock after parsing as well as after lock waits.
        const parsed = requesterValid && row.expiresAt > before.now && requester.expiresAt > before.now ? this.publicSnapshot(row) : null;
        const after = await this.currentReviewer(tx, principal, subscriptionEndsAt);
        if (row.expiresAt <= after.now) {
          await tx.matrixDeviceCandidate.update({ where: { id: row.id }, data: { status: "EXPIRED", resolvedAt: after.now } });
          await this.currentReviewer(tx, principal, subscriptionEndsAt);
          return empty;
        }
        if (!requesterValid || !parsed || requester.expiresAt <= after.now || row.sessionVersion !== after.sessionVersion) return empty;
        return { candidate: {
          candidateId: row.id, state: "PENDING", matrixUserId: row.matrixUserId, matrixDeviceId: row.matrixDeviceId,
          createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), deviceKeys: parsed.deviceKeys
        }, rejection: null };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 30_000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (
        error.code === "P2002" || error.code === "P2034" ||
        (error.code === "P2010" && ["40001", "40P01", "23505"].includes(String(error.meta?.code)))
      )) throw new ConflictException({ code: "MATRIX_CANDIDATE_REVIEW_CONCURRENT_CHANGE", message: "La solicitud cambió. No se autorizó ningún dispositivo." });
      throw error;
    }
  }

  private publicSnapshot(row: MatrixDeviceCandidate) {
    try {
      const parsed = parseMatrixDeviceCandidate({ device_keys: row.deviceKeys }, { userId: row.matrixUserId, deviceId: row.matrixDeviceId });
      if (parsed.canonicalSha256 !== row.canonicalSha256 || parsed.ed25519Key !== row.ed25519Key || parsed.curve25519Key !== row.curve25519Key) {
        throw this.contextChanged();
      }
      return parsed;
    } catch (error) {
      if (error instanceof MatrixKeyUploadValidationError) throw this.contextChanged();
      throw error;
    }
  }

  private async currentReviewer(tx: Transaction, principal: SessionPrincipal, subscriptionEndsAt: Date | null) {
    const session = await tx.authSession.findUnique({ where: { id: principal.sessionId }, select: {
      userId: true, deviceId: true, revokedAt: true, expiresAt: true, sessionVersion: true,
      user: { select: { role: true, status: true, sessionVersion: true, passwordResetRequired: true } }
    } });
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    if (!(clock?.now instanceof Date) || !Number.isFinite(clock.now.getTime())) throw new Error("MATRIX_DATABASE_CLOCK_UNAVAILABLE");
    if (!session || session.userId !== principal.id || session.deviceId !== principal.deviceId || session.revokedAt !== null ||
      session.expiresAt <= clock.now || session.sessionVersion !== session.user.sessionVersion || session.user.role !== principal.role ||
      session.user.status !== "ACTIVE" || session.user.passwordResetRequired || (subscriptionEndsAt !== null && subscriptionEndsAt <= clock.now)) {
      throw this.unauthorized();
    }
    return { now: clock.now, sessionVersion: session.sessionVersion };
  }

  private requireReviewer(principal: SessionPrincipal): void {
    if (principal.role !== "CLIENT" && principal.role !== "CASHIER") throw new ForbiddenException("El rol no puede revisar dispositivos de chat.");
    if (!principal.deviceId || !this.canonicalId(principal.deviceId)) throw new ForbiddenException("Se necesita una sesión del dispositivo confiable.");
  }
  private canonicalId(id: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id); }
  private requireCandidateId(id: string): void {
    if (typeof id !== "string" || !this.canonicalId(id)) throw new BadRequestException("MATRIX_CANDIDATE_ID_INVALID");
  }
  private unavailable() { return new NotFoundException("Solicitud de dispositivo no disponible."); }
  private unauthorized() { return new UnauthorizedException("La sesión o el dispositivo confiable ya no están disponibles."); }
  private contextChanged() { return new ConflictException({ code: "MATRIX_CANDIDATE_REVIEW_CONTEXT_CHANGED", message: "La solicitud no coincide con su contexto original." }); }
}
