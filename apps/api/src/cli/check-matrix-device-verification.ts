import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { HttpException } from "@nestjs/common";
import type { Client } from "pg";
import { matrixDeviceIdFromUuid, matrixUserIdFromUuid } from "@sinochat/contracts";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import type { SessionPrincipal } from "../auth/auth.types";
import { readMatrixServerName } from "../config/runtime-config";
import type { PrismaService } from "../database/prisma.service";
import { MatrixDeviceCandidatesService } from "../e2ee/matrix-device-candidates.service";
import { MatrixDeviceCandidateReviewService } from "../e2ee/matrix-device-candidate-review.service";
import { MatrixDeviceVerificationService } from "../e2ee/matrix-device-verification.service";
import { candidateFixture } from "../e2ee/testing/matrix-candidate.fixture";
import { blocked, operationalSnapshot, unboundSession } from "./check-matrix-candidate-quarantine";

/** Called exclusively with synthetic fixtures in the disposable local verifier. */
export async function checkMatrixDeviceVerification(client: Client, workers: PrismaService[], owner: SessionPrincipal,
  secondReviewer: SessionPrincipal, foreign: SessionPrincipal): Promise<void> {
  const flows = workers.map((worker) => new MatrixDeviceVerificationService(worker, new ConversationEligibilityService(worker)));
  const candidates = new MatrixDeviceCandidatesService(workers[0], new ConversationEligibilityService(workers[0]));
  const reviews = new MatrixDeviceCandidateReviewService(workers[0], new ConversationEligibilityService(workers[0]));
  const user = matrixUserIdFromUuid(owner.id, readMatrixServerName());
  const requester = await unboundSession(client, owner);
  const original = await operationalSnapshot(client, owner.id);
  async function reserve(session = requester) {
    const candidate = candidateFixture(user);
    await candidates.reserve(session, candidate.id, candidate.body);
    return candidate;
  }
  async function request(id: string, timestampOffset = 0, flowId = randomUUID(), transactionId = randomUUID()) {
    const timestamp = Number((await client.query(`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS "ms"`)).rows[0].ms) + timestampOffset;
    const content = { from_device: matrixDeviceIdFromUuid(owner.deviceId!), methods: ["m.sas.v1"], timestamp, transaction_id: flowId };
    return { flowId, transactionId, content, body: { messages: { [user]: { [matrixDeviceIdFromUuid(id)]: content } } } };
  }
  const first = await reserve(), initial = await request(first.id);
  const pending = await flows[0].open(owner, first.id, initial.flowId, initial.transactionId, initial.body);
  assert.deepEqual(await flows[1].open(owner, first.id, initial.flowId, initial.transactionId, initial.body), pending);
  assert.deepEqual(Object.keys(pending).sort(), ["candidateId", "createdAt", "expiresAt", "flowId", "state"]);
  const persisted = (await client.query(`SELECT f.*,q."session_id" AS "requester_session_id" FROM "matrix_device_verification_flows" f
    JOIN "matrix_device_candidates" q ON q."id"=f."candidate_id" WHERE f."candidate_id"=$1`, [first.id])).rows[0];
  assert.equal(persisted.reviewer_session_id, owner.sessionId); assert.equal(persisted.requester_session_id, requester.sessionId);
  assert.deepEqual(persisted.request_content, initial.content);
  assert.deepEqual(await operationalSnapshot(client, owner.id), original);
  for (const actor of [requester, { ...owner, role: "ADMIN" as const }]) {
    await assert.rejects(flows[0].open(actor, first.id, initial.flowId, initial.transactionId, initial.body), http(403));
  }
  await assert.rejects(flows[0].open(foreign, first.id, initial.flowId, initial.transactionId, initial.body), http(404));
  await assert.rejects(flows[0].open(secondReviewer, first.id, initial.flowId, initial.transactionId, initial.body), http(409));
  await assert.rejects(flows[0].open({ ...owner, sessionId: foreign.sessionId }, first.id, initial.flowId, initial.transactionId, initial.body), http(401));
  const changed = await request(first.id);
  await assert.rejects(flows[0].open(owner, first.id, changed.flowId, changed.transactionId, changed.body), http(409));
  console.log("[OK] Admisión SAS fija candidato, flujo y ambas sesiones; replay exacto sin renovar ni habilitar dispositivos.");

  for (const update of [
    `"reviewer_session_id"='${secondReviewer.sessionId}'::uuid`, `"reviewer_session_version"=2`,
    `"flow_id"='changed'`, `"request_transaction_id"='changed'`, `"request_sha256"=repeat('a',64)`,
    `"request_content"="request_content" || '{"private_key":"synthetic"}'::jsonb`,
    `"expires_at"="expires_at"+INTERVAL '1 second'`, `"status"='CANCELLED'`,
    `"status"='EXPIRED',"resolved_at"=clock_timestamp()`,
    `"status"='CANCELLED',"resolved_at"=clock_timestamp()+INTERVAL '1 second'`
  ]) await sqlRejected(client, `UPDATE "matrix_device_verification_flows" SET ${update} WHERE "candidate_id"=$1`, [first.id]);
  await sqlRejected(client, `DELETE FROM "matrix_device_verification_flows" WHERE "candidate_id"=$1`, [first.id]);
  await candidates.cancel(requester, first.id);
  assert.equal((await client.query(`SELECT "status" FROM "matrix_device_verification_flows" WHERE "candidate_id"=$1`, [first.id])).rows[0].status, "CANCELLED");
  await assert.rejects(flows[0].open(owner, first.id, initial.flowId, initial.transactionId, initial.body), http(409));
  await sqlRejected(client, `UPDATE "matrix_device_verification_flows" SET "status"='PENDING',"resolved_at"=NULL WHERE "candidate_id"=$1`, [first.id]);
  console.log("[OK] SQL rechaza sustitución, extensión, borrado y reapertura; cancelar candidato terminaliza flujo atómicamente.");

  const next = await reserve();
  const reusedFlow = await request(next.id, 0, initial.flowId);
  const reusedTxn = await request(next.id, 0, randomUUID(), initial.transactionId);
  for (const attempt of [reusedFlow, reusedTxn]) await assert.rejects(flows[0].open(owner, next.id, attempt.flowId, attempt.transactionId, attempt.body), http(409));
  for (const offset of [-600_001, 301_000]) {
    const stale = await request(next.id, offset);
    await assert.rejects(flows[0].open(owner, next.id, stale.flowId, stale.transactionId, stale.body), http(400));
  }
  assert.equal((await client.query(`SELECT count(*)::int AS "n" FROM "matrix_device_verification_flows" WHERE "candidate_id"=$1`, [next.id])).rows[0].n, 0);
  // Exercise SQL independently of the service with a currently valid candidate.
  const validRequest = await request(next.id);
  for (const patch of [
    { user_id: foreign.id }, { reviewer_session_id: requester.sessionId }, { reviewer_session_id: foreign.sessionId },
    { reviewer_session_version: 2 }, { flow_id: "not a flow" }, { request_transaction_id: "" }, { request_sha256: "invalid" },
    { request_content: { ...validRequest.content, methods: null } },
    { request_content: { ...validRequest.content, methods: ["m.sas.v1", "m.qr_code.show.v1"] } },
    { request_content: { ...validRequest.content, from_device: matrixDeviceIdFromUuid(next.id) } },
    { request_content: { ...validRequest.content, timestamp: validRequest.content.timestamp - 600_001 } },
    { request_content: { ...validRequest.content, timestamp: validRequest.content.timestamp + 301_000 } },
    { request_content: { ...validRequest.content, timestamp: 1.5 } },
    { request_content: { ...validRequest.content, secret: "synthetic-test-only" } },
    { created_at: "2099-01-01T00:00:00Z" }, { expires_at: "2099-01-01T00:00:00Z" },
    { status: "CANCELLED", resolved_at: new Date().toISOString() }
  ]) {
    const replacement = { candidate_id: next.id, flow_id: validRequest.flowId, request_transaction_id: validRequest.transactionId,
      request_content: validRequest.content, status: "PENDING", resolved_at: null, ...patch };
    await sqlRejected(client, `INSERT INTO "matrix_device_verification_flows"
      SELECT (jsonb_populate_record(NULL::"matrix_device_verification_flows",to_jsonb(f) ||
        jsonb_build_object('created_at',date_trunc('milliseconds',clock_timestamp()),'expires_at',clock_timestamp()+INTERVAL '2 seconds') || $2::jsonb)).*
      FROM "matrix_device_verification_flows" f WHERE "candidate_id"=$1`, [first.id, JSON.stringify(replacement)]);
  }
  console.log("[OK] Unicidad histórica de flow/txn; SQL independiente exige dueño, sesiones, perfil y ventana de tiempo.");

  const concurrentRequest = await request(next.id);
  const competing = await blocked(client, owner.id, [
    () => flows[0].open(owner, next.id, concurrentRequest.flowId, concurrentRequest.transactionId, concurrentRequest.body),
    () => flows[1].open(secondReviewer, next.id, concurrentRequest.flowId, concurrentRequest.transactionId, concurrentRequest.body)
  ]);
  assert.equal(competing.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const lost = competing.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
  assert.equal(http(409)(lost.reason), true);
  await reviews.reject(owner, next.id);
  assert.equal((await client.query(`SELECT "status" FROM "matrix_device_verification_flows" WHERE "candidate_id"=$1`, [next.id])).rows[0].status, "CANCELLED");
  console.log("[OK] Dos sesiones revisoras esperan el lock: una sola gana; revisión puede descartar sin motivo.");

  const repeated = await reserve(), repeatRequest = await request(repeated.id);
  const identical = await blocked(client, owner.id, [
    () => flows[0].open(owner, repeated.id, repeatRequest.flowId, repeatRequest.transactionId, repeatRequest.body),
    () => flows[1].open(owner, repeated.id, repeatRequest.flowId, repeatRequest.transactionId, repeatRequest.body)
  ]);
  assert.equal(identical.every((outcome) => outcome.status === "fulfilled"), true);
  assert.deepEqual((identical[0] as PromiseFulfilledResult<unknown>).value, (identical[1] as PromiseFulfilledResult<unknown>).value);
  assert.equal((await client.query(`SELECT count(*)::int AS "n" FROM "matrix_device_verification_flows" WHERE "candidate_id"=$1`, [repeated.id])).rows[0].n, 1);
  await candidates.cancel(requester, repeated.id);
  console.log("[OK] Dos reintentos idénticos concurrentes conservan una sola fila y el mismo vencimiento.");

  // A real short deadline derived from the original SDK timestamp. Never age an
  // existing immutable row or disable a trigger to simulate expiration.
  const expiring = await reserve(), short = await request(expiring.id, -599_000);
  await flows[0].open(owner, expiring.id, short.flowId, short.transactionId, short.body);
  await waitFlowExpired(client, expiring.id);
  await assert.rejects(flows[0].open(owner, expiring.id, short.flowId, short.transactionId, short.body), http(409));
  assert.equal((await client.query(`SELECT "status" FROM "matrix_device_verification_flows" WHERE "candidate_id"=$1`, [expiring.id])).rows[0].status, "EXPIRED");
  assert.equal((await candidates.status(requester, expiring.id)).state, "CANCELLED");
  console.log("[OK] Expiración real del flow se conserva pese a 409; se descarta también el candidato para no reciclarlo.");

  const waiting = await reserve(), waitingRequest = await request(waiting.id, -598_500);
  await flows[0].open(owner, waiting.id, waitingRequest.flowId, waitingRequest.transactionId, waitingRequest.body);
  // Lock the flow only, as terminal maintenance may do. The candidate's AFTER
  // trigger must read a fresh clock AFTER waiting for this lock, not on entry.
  await invalidateAfterFlowWait(client, waiting.id, () => reviews.reject(owner, waiting.id));
  const waitingState = (await client.query(`SELECT f."status",f."resolved_at">=f."expires_at" AS "expired_resolution",
    q."status" AS "candidate_status" FROM "matrix_device_verification_flows" f
    JOIN "matrix_device_candidates" q ON q."id"=f."candidate_id" WHERE f."candidate_id"=$1`, [waiting.id])).rows[0];
  assert.deepEqual(waitingState, { status: "EXPIRED", expired_resolution: true, candidate_status: "CANCELLED" });
  console.log("[OK] Descarte espera un lock real del flujo; SQL clasifica EXPIRED con reloj posterior a esa espera.");

  const delayed = await reserve(), delayedRequest = await request(delayed.id, -599_000);
  const delayedResult = await blocked(client, owner.id, [() => flows[0].open(owner, delayed.id,
    delayedRequest.flowId, delayedRequest.transactionId, delayedRequest.body)], async () => {
    await delay(1100);
  });
  assert.equal(delayedResult[0].status, "rejected");
  assert.equal(http(400)((delayedResult[0] as PromiseRejectedResult).reason), true);
  assert.equal((await client.query(`SELECT 1 FROM "matrix_device_verification_flows" WHERE "candidate_id"=$1`, [delayed.id])).rowCount, 0);
  await reviews.reject(owner, delayed.id);
  console.log("[OK] Request vencido mientras espera el lock no inicia una nueva ventana al obtenerlo.");

  const staleRequester = await unboundSession(client, owner), staleCandidate = await reserve(staleRequester), staleRequest = await request(staleCandidate.id);
  const revoked = await blocked(client, owner.id, [() => flows[0].open(owner, staleCandidate.id, staleRequest.flowId, staleRequest.transactionId, staleRequest.body)], async () => {
    await revokeSession(client, staleRequester.sessionId);
  });
  assert.equal(revoked[0].status, "rejected"); assert.equal(http(404)((revoked[0] as PromiseRejectedResult).reason), true);
  assert.equal((await client.query(`SELECT 1 FROM "matrix_device_verification_flows" WHERE "candidate_id"=$1`, [staleCandidate.id])).rowCount, 0);
  await reviews.reject(owner, staleCandidate.id);
  const staleReviewerCandidate = await reserve(), staleReviewerRequest = await request(staleReviewerCandidate.id);
  const reviewerRevoked = await blocked(client, owner.id, [() => flows[0].open(secondReviewer, staleReviewerCandidate.id,
    staleReviewerRequest.flowId, staleReviewerRequest.transactionId, staleReviewerRequest.body)], async () => { await revokeSession(client, secondReviewer.sessionId); });
  assert.equal(reviewerRevoked[0].status, "rejected"); assert.equal(http(401)((reviewerRevoked[0] as PromiseRejectedResult).reason), true);
  const activeFlow = await flows[0].open(owner, staleReviewerCandidate.id, staleReviewerRequest.flowId, staleReviewerRequest.transactionId, staleReviewerRequest.body);
  assert.equal(activeFlow.state, "PENDING");
  await revokeSession(client, requester.sessionId);
  // Denial requires no surviving requester authority and cascades to the flow.
  await reviews.reject(owner, staleReviewerCandidate.id);
  assert.equal((await client.query(`SELECT "status" FROM "matrix_device_verification_flows" WHERE "candidate_id"=$1`, [staleReviewerCandidate.id])).rows[0].status, "CANCELLED");
  assert.deepEqual(await operationalSnapshot(client, owner.id), original);
  assert.equal((await client.query(`SELECT "device_id" FROM "auth_sessions" WHERE "id"=$1`, [requester.sessionId])).rows[0].device_id, null);
  console.log("[OK] Revocación durante espera impide admisión; mantenimiento terminaliza sin autoridad solicitante, cero efectos operativos.");
}

function http(status: number) { return (error: unknown) => error instanceof HttpException && error.getStatus() === status; }
async function sqlRejected(client: Client, sql: string, params: unknown[]) {
  await assert.rejects(client.query(sql, params), (error: { code?: string }) => error?.code === "23514");
}
async function revokeSession(client: Client, id: string) {
  await client.query(`UPDATE "auth_sessions" SET "revoked_at"=clock_timestamp(),"revocation_reason"='ISOLATED_TEST' WHERE "id"=$1`, [id]);
}
async function waitFlowExpired(client: Client, id: string) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if ((await client.query(`SELECT "expires_at"<=clock_timestamp() AS "expired" FROM "matrix_device_verification_flows" WHERE "candidate_id"=$1`, [id])).rows[0].expired) return;
    await delay(25);
  }
  throw new Error("VERIFICATION_FIXTURE_DID_NOT_EXPIRE");
}

async function invalidateAfterFlowWait(client: Client, id: string, invalidate: () => Promise<unknown>) {
  await client.query("BEGIN");
  let outcomes: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await client.query(`SELECT "candidate_id" FROM "matrix_device_verification_flows" WHERE "candidate_id"=$1 FOR UPDATE`, [id]);
    const blockerPid = (await client.query(`SELECT pg_backend_pid() AS "pid"`)).rows[0].pid;
    outcomes = Promise.allSettled([invalidate()]);
    const deadline = performance.now() + 5000;
    let observed = false;
    while (performance.now() < deadline) {
      const result = await client.query(`SELECT count(*)::int AS "n" FROM pg_stat_activity
        WHERE datname=current_database() AND application_name='sinochat-cross-signing-one'
          AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))`, [blockerPid]);
      if (result.rows[0].n === 1) { observed = true; break; }
      await delay(25);
    }
    assert.equal(observed, true, "VERIFICATION_INVALIDATION_NOT_OBSERVED_WAITING");
    await waitFlowExpired(client, id);
    await client.query("COMMIT");
    assert.equal((await outcomes)[0].status, "fulfilled");
  } finally {
    await client.query("ROLLBACK");
    await outcomes;
  }
}
