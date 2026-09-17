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
import { MatrixDeviceVerificationInboxService } from "../e2ee/matrix-device-verification-inbox.service";
import { candidateFixture } from "../e2ee/testing/matrix-candidate.fixture";
import { blocked, insertShortCandidate, operationalSnapshot, unboundSession, waitExpired } from "./check-matrix-candidate-quarantine";

/** Called only by the isolated verifier, with synthetic owners and sessions. */
export async function checkMatrixVerificationInbox(client: Client, workers: PrismaService[], owner: SessionPrincipal,
  secondReviewer: SessionPrincipal, foreign: SessionPrincipal): Promise<void> {
  const inboxes = workers.map((worker) => new MatrixDeviceVerificationInboxService(worker, new ConversationEligibilityService(worker)));
  const openings = workers.map((worker) => new MatrixDeviceVerificationService(worker, new ConversationEligibilityService(worker)));
  const candidates = new MatrixDeviceCandidatesService(workers[0], new ConversationEligibilityService(workers[0]));
  const reviews = new MatrixDeviceCandidateReviewService(workers[0], new ConversationEligibilityService(workers[0]));
  const matrixUser = matrixUserIdFromUuid(owner.id, readMatrixServerName());
  const requester = await unboundSession(client, owner), otherRequester = await unboundSession(client, owner);
  const foreignRequester = await unboundSession(client, foreign);
  const before = await operationalSnapshot(client, owner.id);
  async function reserve(session = requester) {
    const fixture = candidateFixture(matrixUser);
    await candidates.reserve(session, fixture.id, fixture.body);
    return fixture;
  }
  async function request(candidateId: string, offset = 0) {
    const flowId = randomUUID(), transactionId = randomUUID();
    const timestamp = Number((await client.query(`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS "ms"`)).rows[0].ms) + offset;
    const content = { from_device: matrixDeviceIdFromUuid(owner.deviceId!), methods: ["m.sas.v1"], timestamp, transaction_id: flowId };
    return { flowId, transactionId, content, body: { messages: { [matrixUser]: { [matrixDeviceIdFromUuid(candidateId)]: content } } } };
  }
  async function open(candidateId: string, offset = 0, reviewer = owner) {
    const event = await request(candidateId, offset);
    const admission = await openings[0].open(reviewer, candidateId, event.flowId, event.transactionId, event.body);
    return { ...event, admission };
  }
  const first = await reserve();
  assert.deepEqual(await inboxes[0].poll(requester, first.id), { request: null });
  for (const actor of [otherRequester, foreignRequester]) await assert.rejects(inboxes[0].poll(actor, first.id), http(404));
  for (const actor of [owner, secondReviewer, { ...requester, role: "ADMIN" as const }]) {
    await assert.rejects(inboxes[0].poll(actor, first.id), http(403));
  }
  const initial = await open(first.id);
  const expected = { request: {
    candidateId: first.id, flowId: initial.flowId, transactionId: initial.transactionId,
    senderDeviceId: matrixDeviceIdFromUuid(owner.deviceId!), recipientDeviceId: matrixDeviceIdFromUuid(first.id),
    createdAt: initial.admission.createdAt, expiresAt: initial.admission.expiresAt,
    event: { sender: matrixUser, type: "m.key.verification.request", content: initial.content }
  } };
  const stored = await quarantineSnapshot(client, first.id);
  assert.deepEqual(await inboxes[0].poll(requester, first.id), expected);
  assert.deepEqual(await inboxes[1].poll(requester, first.id), expected);
  const together = await blocked(client, owner.id, [() => inboxes[0].poll(requester, first.id), () => inboxes[1].poll(requester, first.id)]);
  for (const outcome of together) {
    assert.equal(outcome.status, "fulfilled"); assert.deepEqual((outcome as PromiseFulfilledResult<unknown>).value, expected);
  }
  assert.deepEqual(await quarantineSnapshot(client, first.id), stored);
  assert.deepEqual(await operationalSnapshot(client, owner.id), before);
  console.log("[OK] Inbox: solo sesión solicitante exacta, entrega original repetible y dos polls concurrentes sin ACK ni escrituras.");

  const cancelled = await blocked(client, owner.id, [() => inboxes[0].poll(requester, first.id)], async () => {
    await client.query(`UPDATE "matrix_device_candidates" SET "status"='CANCELLED',"resolved_at"=clock_timestamp() WHERE "id"=$1`, [first.id]);
  });
  assert.equal(cancelled[0].status, "fulfilled"); assert.deepEqual((cancelled[0] as PromiseFulfilledResult<unknown>).value, { request: null });
  assert.deepEqual(await inboxes[0].poll(requester, first.id), { request: null });
  console.log("[OK] Cancelación confirmada mientras espera impide entregar el request y conserva terminales.");

  const openingRace = await reserve(), openingRequest = await request(openingRace.id);
  const openingResults = await blocked<unknown>(client, owner.id, [
    () => openings[0].open(owner, openingRace.id, openingRequest.flowId, openingRequest.transactionId, openingRequest.body),
    () => inboxes[1].poll(requester, openingRace.id)
  ]);
  assert.equal(openingResults.every((result) => result.status === "fulfilled"), true);
  const afterOpening = await inboxes[0].poll(requester, openingRace.id);
  assert.equal(afterOpening.request?.flowId, openingRequest.flowId);
  const racedPoll = (openingResults[1] as PromiseFulfilledResult<{ request: unknown }>).value;
  if (racedPoll.request !== null) assert.deepEqual(racedPoll, afterOpening);
  await candidates.cancel(requester, openingRace.id);
  console.log("[OK] Apertura y poll serializados: vacío antes del alta o exactamente el request fijado después, sin estado parcial.");

  const shortCandidate = candidateFixture(matrixUser);
  await insertShortCandidate(client, requester, shortCandidate, first.id);
  await waitExpired(client, shortCandidate.id);
  assert.deepEqual(await inboxes[0].poll(requester, shortCandidate.id), { request: null });
  assert.equal((await candidates.status(requester, shortCandidate.id)).state, "EXPIRED");
  const shortFlow = await reserve(); await open(shortFlow.id, -598_500);
  await pollAcrossFlowDeadline(client, shortFlow.id, () => inboxes[0].poll(requester, shortFlow.id));
  const terminal = await quarantineSnapshot(client, shortFlow.id);
  assert.equal(terminal.candidate.status, "CANCELLED"); assert.equal(terminal.flow.status, "EXPIRED");
  assert.deepEqual(await inboxes[0].poll(requester, shortFlow.id), { request: null });
  assert.deepEqual(await quarantineSnapshot(client, shortFlow.id), terminal);
  console.log("[OK] Vencimiento de reserva o flujo observado tras lock persiste; polls posteriores no entregan ni renuevan.");

  const revokedRequester = await unboundSession(client, owner), revokedCandidate = await reserve(revokedRequester);
  await open(revokedCandidate.id);
  const requesterResult = await blocked(client, owner.id, [() => inboxes[0].poll(revokedRequester, revokedCandidate.id)], async () => {
    await revoke(client, revokedRequester.sessionId);
  });
  assert.equal(requesterResult[0].status, "rejected"); assert.equal(http(401)((requesterResult[0] as PromiseRejectedResult).reason), true);
  await reviews.reject(owner, revokedCandidate.id);

  const rebound = await unboundSession(client, owner), reboundCandidate = await reserve(rebound);
  await open(reboundCandidate.id);
  await client.query(`UPDATE "auth_sessions" SET "device_id"=$2 WHERE "id"=$1`, [rebound.sessionId, owner.deviceId]);
  await assert.rejects(inboxes[0].poll(rebound, reboundCandidate.id), http(401));
  await reviews.reject(owner, reboundCandidate.id);
  console.log("[OK] Logout durante espera y vínculo posterior de la sesión solicitante bloquean entrega con 401.");

  const reviewerCandidate = await reserve(); await open(reviewerCandidate.id);
  const reviewerResult = await blocked(client, owner.id, [() => inboxes[0].poll(requester, reviewerCandidate.id)], async () => {
    await revoke(client, owner.sessionId);
  });
  assert.equal(reviewerResult[0].status, "fulfilled"); assert.deepEqual((reviewerResult[0] as PromiseFulfilledResult<unknown>).value, { request: null });
  // There remains another live session on the same device. It cannot replace
  // the revoked session fixed at admission, even though it may deny the request.
  assert.deepEqual(await inboxes[0].poll(requester, reviewerCandidate.id), { request: null });
  await reviews.reject(secondReviewer, reviewerCandidate.id);
  const deviceCandidate = await reserve(); await open(deviceCandidate.id, 0, secondReviewer);
  const deviceResult = await blocked(client, owner.id, [() => inboxes[0].poll(requester, deviceCandidate.id)], async () => {
    await client.query(`UPDATE "devices" SET "status"='REVOKED',"revoked_at"=clock_timestamp() WHERE "id"=$1`, [owner.deviceId]);
  });
  assert.equal(deviceResult[0].status, "fulfilled"); assert.deepEqual((deviceResult[0] as PromiseFulfilledResult<unknown>).value, { request: null });
  assert.deepEqual(await operationalSnapshot(client, owner.id), before);
  assert.equal((await client.query(`SELECT "device_id" FROM "auth_sessions" WHERE "id"=$1`, [requester.sessionId])).rows[0].device_id, null);
  console.log("[OK] Revisor o bootstrap revocados durante espera no entregan; otra sesión confiable no hereda flujo, sin alta operativa.");
}

function http(status: number) { return (error: unknown) => error instanceof HttpException && error.getStatus() === status; }
async function revoke(client: Client, id: string) {
  await client.query(`UPDATE "auth_sessions" SET "revoked_at"=clock_timestamp(),"revocation_reason"='ISOLATED_TEST' WHERE "id"=$1`, [id]);
}
async function quarantineSnapshot(client: Client, id: string) {
  return (await client.query(`SELECT to_jsonb(q) AS "candidate",to_jsonb(f) AS "flow"
    FROM "matrix_device_candidates" q LEFT JOIN "matrix_device_verification_flows" f ON f."candidate_id"=q."id" WHERE q."id"=$1`, [id])).rows[0];
}
async function pollAcrossFlowDeadline(client: Client, id: string, poll: () => Promise<unknown>) {
  await client.query("BEGIN");
  let outcomes: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await client.query(`SELECT "candidate_id" FROM "matrix_device_verification_flows" WHERE "candidate_id"=$1 FOR UPDATE`, [id]);
    const blocker = (await client.query(`SELECT pg_backend_pid() AS "pid"`)).rows[0].pid;
    outcomes = Promise.allSettled([poll()]);
    let observed = false;
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const waiting = await client.query(`SELECT count(*)::int AS "n" FROM pg_stat_activity
        WHERE datname=current_database() AND application_name='sinochat-cross-signing-one'
          AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))`, [blocker]);
      if (waiting.rows[0].n === 1) { observed = true; break; }
      await delay(25);
    }
    assert.equal(observed, true, "INBOX_FLOW_LOCK_NOT_OBSERVED");
    let expired = false;
    while (performance.now() < deadline) {
      if ((await client.query(`SELECT "expires_at"<=clock_timestamp() AS "expired" FROM "matrix_device_verification_flows" WHERE "candidate_id"=$1`, [id])).rows[0].expired) {
        expired = true; break;
      }
      await delay(25);
    }
    assert.equal(expired, true, "INBOX_FLOW_DID_NOT_EXPIRE");
    await client.query("COMMIT");
    const [outcome] = await outcomes;
    assert.equal(outcome.status, "fulfilled"); assert.deepEqual((outcome as PromiseFulfilledResult<unknown>).value, { request: null });
  } finally {
    await client.query("ROLLBACK"); await outcomes;
  }
}
