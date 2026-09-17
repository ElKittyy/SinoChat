import { strict as assert } from "node:assert";
import { HttpException } from "@nestjs/common";
import type { Client } from "pg";
import { matrixUserIdFromUuid } from "@sinochat/contracts";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import type { SessionPrincipal } from "../auth/auth.types";
import { readMatrixServerName } from "../config/runtime-config";
import type { PrismaService } from "../database/prisma.service";
import { MatrixDeviceCandidatesService } from "../e2ee/matrix-device-candidates.service";
import { MatrixDeviceCandidateReviewService } from "../e2ee/matrix-device-candidate-review.service";
import { candidateFixture } from "../e2ee/testing/matrix-candidate.fixture";
import { blocked, insertShortCandidate, operationalSnapshot, unboundSession, waitExpired } from "./check-matrix-candidate-quarantine";

/** Disposable verifier only. All owners, keys and sessions are synthetic. */
export async function checkMatrixCandidateReview(client: Client, workers: PrismaService[], owner: SessionPrincipal,
  secondReviewer: SessionPrincipal, foreign: SessionPrincipal): Promise<void> {
  const reviews = workers.map((worker) => new MatrixDeviceCandidateReviewService(worker, new ConversationEligibilityService(worker)));
  const reservations = workers.map((worker) => new MatrixDeviceCandidatesService(worker, new ConversationEligibilityService(worker)));
  const matrixUserId = matrixUserIdFromUuid(owner.id, readMatrixServerName());
  const requester = await unboundSession(client, owner);
  const candidate = candidateFixture(matrixUserId);
  const original = await operationalSnapshot(client, owner.id);
  const pending = await reservations[0].reserve(requester, candidate.id, candidate.body);
  assert.deepEqual(await reviews[0].pending(owner), { pending });
  assert.deepEqual(await reviews[0].detail(owner, candidate.id), { ...pending, deviceKeys: candidate.body.device_keys });
  assert.deepEqual(await reviews[1].detail(secondReviewer, candidate.id), { ...pending, deviceKeys: candidate.body.device_keys });
  for (const action of ["pending", "detail", "reject"] as const) {
    await assert.rejects(reviews[0][action](requester, candidate.id), http(403));
    await assert.rejects(reviews[0][action]({ ...owner, role: "ADMIN" }, candidate.id), http(403));
  }
  assert.deepEqual(await reviews[0].pending(foreign), { pending: null });
  await assert.rejects(reviews[0].detail(foreign, candidate.id), http(404));
  await assert.rejects(reviews[0].reject(foreign, candidate.id), http(404));
  await assert.rejects(reviews[0].detail({ ...owner, sessionId: foreign.sessionId }, candidate.id), http(401));
  assert.deepEqual(await operationalSnapshot(client, owner.id), original);
  console.log("[OK] Revisión: solo sesiones del bootstrap propio; ADMIN, solicitante y otra cuenta no acceden.");

  const rejected = await blocked(client, owner.id, [
    () => reviews[0].reject(owner, candidate.id), () => reviews[1].reject(secondReviewer, candidate.id)
  ]);
  for (const result of rejected) {
    assert.equal(result.status, "fulfilled");
    assert.deepEqual((result as PromiseFulfilledResult<unknown>).value, { candidateId: candidate.id, state: "CANCELLED" });
  }
  const resolved = (await client.query(`SELECT "resolved_at" FROM "matrix_device_candidates" WHERE "id"=$1`, [candidate.id])).rows[0].resolved_at;
  await reviews[0].reject(owner, candidate.id);
  assert.deepEqual((await client.query(`SELECT "resolved_at" FROM "matrix_device_candidates" WHERE "id"=$1`, [candidate.id])).rows[0].resolved_at, resolved);
  await assert.rejects(reviews[0].detail(owner, candidate.id), http(404));
  assert.equal((await reservations[0].status(requester, candidate.id)).state, "CANCELLED");
  console.log("[OK] Dos descartes concurrentes son idempotentes; solicitante observa cancelación, sin activación.");

  const short = candidateFixture(matrixUserId);
  await insertShortCandidate(client, requester, short, candidate.id);
  await waitExpired(client, short.id);
  await assert.rejects(reviews[0].detail(owner, short.id), http(404));
  assert.equal((await client.query(`SELECT "status" FROM "matrix_device_candidates" WHERE "id"=$1`, [short.id])).rows[0].status, "EXPIRED");
  assert.deepEqual(await reviews[0].pending(owner), { pending: null });
  console.log("[OK] Detalle vencido devuelve 404 y confirma EXPIRED en PostgreSQL, sin rollback de la expiración.");

  const staleRequester = await unboundSession(client, owner);
  const staleCandidate = candidateFixture(matrixUserId);
  await reservations[0].reserve(staleRequester, staleCandidate.id, staleCandidate.body);
  const revokedRequester = await blocked(client, owner.id, [() => reviews[0].detail(owner, staleCandidate.id)], async () => {
    await revokeSession(client, staleRequester.sessionId);
  });
  assert.equal(revokedRequester[0].status, "rejected");
  assert.equal(http(404)((revokedRequester[0] as PromiseRejectedResult).reason), true);
  assert.deepEqual(await reviews[0].pending(owner), { pending: null });
  assert.deepEqual(await reviews[0].reject(owner, staleCandidate.id), { candidateId: staleCandidate.id, state: "CANCELLED" });
  console.log("[OK] Solicitante revocado mientras revisión espera: no se entregan claves; dueño puede descartar sin motivo.");

  const boundRequester = await unboundSession(client, owner);
  const boundCandidate = candidateFixture(matrixUserId);
  await reservations[0].reserve(boundRequester, boundCandidate.id, boundCandidate.body);
  await client.query(`UPDATE "auth_sessions" SET "device_id"=$2 WHERE "id"=$1`, [boundRequester.sessionId, owner.deviceId]);
  assert.deepEqual(await reviews[0].pending(owner), { pending: null });
  await assert.rejects(reviews[0].detail(owner, boundCandidate.id), http(404));
  await reviews[0].reject(owner, boundCandidate.id);
  console.log("[OK] Solicitante vinculado posteriormente a otro dispositivo operativo deja de ser revisable.");

  const maintenance = candidateFixture(matrixUserId);
  await reservations[0].reserve(requester, maintenance.id, maintenance.body);
  const cancelledBeforeRead = await blocked(client, owner.id, [() => reviews[0].detail(owner, maintenance.id)], async () => {
    await client.query(`UPDATE "matrix_device_candidates" SET "status"='CANCELLED',"resolved_at"=clock_timestamp() WHERE "id"=$1`, [maintenance.id]);
  });
  assert.equal(cancelledBeforeRead[0].status, "rejected");
  assert.equal(http(404)((cancelledBeforeRead[0] as PromiseRejectedResult).reason), true);
  console.log("[OK] Cancelación confirmada durante espera impide devolver snapshot pendiente obsoleto.");

  const revokeTarget = candidateFixture(matrixUserId);
  await reservations[0].reserve(requester, revokeTarget.id, revokeTarget.body);
  const revokedReviewer = await blocked(client, owner.id, [() => reviews[0].reject(secondReviewer, revokeTarget.id)], async () => {
    await revokeSession(client, secondReviewer.sessionId);
  });
  assert.equal(revokedReviewer[0].status, "rejected");
  assert.equal(http(401)((revokedReviewer[0] as PromiseRejectedResult).reason), true);
  assert.equal((await reservations[0].status(requester, revokeTarget.id)).state, "PENDING");
  assert.equal((await reviews[0].detail(owner, revokeTarget.id)).state, "PENDING");
  // A different, still valid session cannot compensate for a revoked device.
  const revokedDevice = await blocked(client, owner.id, [() => reviews[0].detail(owner, revokeTarget.id)], async () => {
    await client.query(`UPDATE "devices" SET "status"='REVOKED',"revoked_at"=clock_timestamp() WHERE "id"=$1`, [owner.deviceId]);
  });
  assert.equal(revokedDevice[0].status, "rejected");
  assert.equal(http(401)((revokedDevice[0] as PromiseRejectedResult).reason), true);
  await assert.rejects(reviews[0].reject(owner, revokeTarget.id), http(401));
  assert.equal((await client.query(`SELECT "status" FROM "matrix_device_candidates" WHERE "id"=$1`, [revokeTarget.id])).rows[0].status, "PENDING");
  assert.deepEqual(await operationalSnapshot(client, owner.id), original);
  assert.equal((await client.query(`SELECT "device_id" FROM "auth_sessions" WHERE "id"=$1`, [requester.sessionId])).rows[0].device_id, null);
  console.log("[OK] Revisor/su dispositivo revocados durante espera no leen ni cancelan; cero altas o publicaciones operativas.");
}

async function revokeSession(client: Client, sessionId: string): Promise<void> {
  await client.query(`UPDATE "auth_sessions" SET "revoked_at"=clock_timestamp(),"revocation_reason"='ISOLATED_TEST' WHERE "id"=$1`, [sessionId]);
}
function http(status: number) { return (error: unknown) => error instanceof HttpException && error.getStatus() === status; }
