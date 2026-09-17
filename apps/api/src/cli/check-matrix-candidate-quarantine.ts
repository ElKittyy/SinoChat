import { strict as assert } from "node:assert";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { HttpException } from "@nestjs/common";
import type { Client } from "pg";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import type { SessionPrincipal } from "../auth/auth.types";
import type { PrismaService } from "../database/prisma.service";
import { MatrixDeviceCandidatesService } from "../e2ee/matrix-device-candidates.service";
import { candidateFixture } from "../e2ee/testing/matrix-candidate.fixture";
import { parseMatrixDeviceCandidate } from "../e2ee/matrix-device-candidate";

/** Called ONLY inside the existing disposable-database verifier, never standalone. */
export async function checkMatrixCandidateQuarantine(client: Client, workers: PrismaService[], owner: SessionPrincipal, matrixUserId: string): Promise<void> {
  const services = workers.map((worker) => new MatrixDeviceCandidatesService(worker, new ConversationEligibilityService(worker)));
  const [first, second] = await Promise.all([unboundSession(client, owner), unboundSession(client, owner)]);
  const fixture = candidateFixture(matrixUserId);
  const original = await operationalSnapshot(client, owner.id);
  const pending = await services[0].reserve(first, fixture.id, fixture.body);
  assert.equal(pending.state, "PENDING");
  assert.equal(new Date(pending.expiresAt).getTime() - new Date(pending.createdAt).getTime(), 600_000);
  assert.deepEqual(await services[0].reserve(first, fixture.id, fixture.body), pending);
  assert.deepEqual(await services[0].status(first, fixture.id), pending);
  assert.deepEqual(Object.keys(pending).sort(), ["candidateId", "createdAt", "expiresAt", "matrixDeviceId", "matrixUserId", "state"]);
  await assert.rejects(services[0].status(second, fixture.id), http(404));
  await assert.rejects(services[0].cancel(second, fixture.id), http(404));
  await assert.rejects(services[0].reserve(second, fixture.id, fixture.body), http(409));
  await assert.rejects(services[0].reserve({ ...first, role: "ADMIN" }, fixture.id, fixture.body), http(403));
  await assert.rejects(services[0].reserve(first, fixture.id, candidateFixture(matrixUserId, fixture.id).body), http(409));
  const another = candidateFixture(matrixUserId);
  await assert.rejects(services[0].reserve(second, another.id, another.body), http(409));
  assert.deepEqual(await operationalSnapshot(client, owner.id), original);
  console.log("[OK] Cuarentena pública: reserva/reintento exactos, sesión exclusiva y cero efectos operativos.");

  // Every invalid SQL case must hit an invariant, not merely the pending index.
  for (const update of [
    `"canonical_sha256" = repeat('a',64)`, `"session_id" = '${second.sessionId}'::uuid`,
    `"expires_at" = "expires_at" + INTERVAL '1 second'`, `"status" = 'CANCELLED'`,
    `"device_keys" = "device_keys" || '{"private_key":"synthetic"}'::jsonb`,
    `"status" = 'EXPIRED', "resolved_at" = clock_timestamp()`
  ]) await sqlRejected(client, `UPDATE "matrix_device_candidates" SET ${update} WHERE "id" = $1`, [fixture.id]);
  await sqlRejected(client, `DELETE FROM "matrix_device_candidates" WHERE "id" = $1`, [fixture.id]);
  const cancelled = await services[0].cancel(first, fixture.id);
  assert.equal(cancelled.state, "CANCELLED");
  assert.deepEqual(await services[0].cancel(first, fixture.id), cancelled);
  assert.deepEqual(await services[0].reserve(first, fixture.id, fixture.body), cancelled);
  await sqlRejected(client, `UPDATE "matrix_device_candidates" SET "status" = 'PENDING', "resolved_at" = NULL WHERE "id" = $1`, [fixture.id]);
  console.log("[OK] SQL conserva snapshot y fechas; cancelación irreversible sin motivo ni reapertura.");

  for (const patch of [
    { session_id: owner.sessionId }, { user_id: randomUUID() }, { session_version: 2 },
    { identity_bootstrap_sha256: "0".repeat(64) }, { trusted_device_id: randomUUID() },
    { canonical_sha256: "not-a-hash" }, { device_keys: { private_key: "synthetic-test-only" } },
    { device_keys: { ...fixture.body.device_keys, algorithms: null } },
    { status: "CANCELLED", resolved_at: NOW_FOR_INVALID_INSERT },
    { created_at: "2099-01-01T00:00:00Z", expires_at: "2099-01-01T00:05:00Z" }
  ]) await invalidCandidateInsert(client, first, matrixUserId, fixture.id, patch);
  console.log("[OK] INSERT SQL rechaza sesión vinculada, dueño/versión/pin ajenos, secretos, formas incompletas y fechas inválidas.");

  // Insert a short-lived, valid public fixture so the database clock really
  // crosses its deadline. No trigger is disabled and no existing row is aged.
  const short = candidateFixture(matrixUserId);
  await insertShortCandidate(client, first, short, fixture.id);
  await waitExpired(client, short.id);
  assert.equal((await services[0].status(first, short.id)).state, "EXPIRED");
  assert.equal((await services[0].reserve(first, short.id, short.body)).state, "EXPIRED");
  await services[0].reserve(second, another.id, another.body);
  const expired = await client.query<{ status: string }>(`SELECT "status" FROM "matrix_device_candidates" WHERE "id" = $1`, [short.id]);
  assert.equal(expired.rows[0].status, "EXPIRED");
  await services[0].cancel(second, another.id);
  console.log("[OK] Vencimiento real inclusivo; una reserva nueva terminaliza la anterior sin extenderla.");

  const competing = [candidateFixture(matrixUserId), candidateFixture(matrixUserId)];
  const results = await blocked(client, owner.id, [
    () => services[0].reserve(first, competing[0].id, competing[0].body),
    () => services[1].reserve(second, competing[1].id, competing[1].body)
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.equal(http(409)(failed.reason), true);
  const winner = results[0].status === "fulfilled" ? 0 : 1;
  await services[0].cancel(winner === 0 ? first : second, competing[winner].id);
  console.log("[OK] Dos reservas observadas esperando el mismo lock: una sola PENDING y un único ganador.");

  // The request has already passed the HTTP principal boundary when logout wins.
  const stale = await unboundSession(client, owner);
  const rejected = candidateFixture(matrixUserId);
  const revokedResults = await blocked(client, owner.id, [() => services[0].reserve(stale, rejected.id, rejected.body)], async () => {
    await client.query(`UPDATE "auth_sessions" SET "revoked_at" = clock_timestamp(), "revocation_reason" = 'ISOLATED_TEST' WHERE "id" = $1`, [stale.sessionId]);
  });
  assert.equal(revokedResults[0].status, "rejected");
  assert.equal(http(401)((revokedResults[0] as PromiseRejectedResult).reason), true);
  assert.equal((await client.query(`SELECT 1 FROM "matrix_device_candidates" WHERE "id" = $1`, [rejected.id])).rowCount, 0);
  // Maintenance can terminalize even after session revocation (no active authority required by SQL UPDATE).
  const maintenance = candidateFixture(matrixUserId);
  await services[0].reserve(first, maintenance.id, maintenance.body);
  await client.query(`UPDATE "auth_sessions" SET "revoked_at" = clock_timestamp(), "revocation_reason" = 'ISOLATED_TEST' WHERE "id" = $1`, [first.sessionId]);
  await assert.rejects(services[0].status(first, maintenance.id), http(401));
  await client.query(`UPDATE "matrix_device_candidates" SET "status" = 'CANCELLED', "resolved_at" = clock_timestamp() WHERE "id" = $1`, [maintenance.id]);
  assert.deepEqual(await operationalSnapshot(client, owner.id), original);
  assert.equal((await client.query(`SELECT "device_id" FROM "auth_sessions" WHERE "id" = $1`, [second.sessionId])).rows[0].device_id, null);
  console.log("[OK] Sesión revocada mientras espera no reserva; mantenimiento cancela sin revivir autoridad.");
}

const NOW_FOR_INVALID_INSERT = "2026-01-01T00:00:00Z";
async function invalidCandidateInsert(client: Client, session: SessionPrincipal, userId: string, templateId: string, patch: object) {
  const fixture = candidateFixture(userId);
  const data = parseMatrixDeviceCandidate(fixture.body, { userId, deviceId: fixture.body.device_keys.device_id });
  const replacement = { id: fixture.id, session_id: session.sessionId, matrix_device_id: data.deviceKeys.device_id,
    device_keys: data.deviceKeys, canonical_sha256: data.canonicalSha256, ed25519_key: data.ed25519Key, curve25519_key: data.curve25519Key,
    status: "PENDING", resolved_at: null, ...patch };
  await sqlRejected(client, `INSERT INTO "matrix_device_candidates"
    SELECT (jsonb_populate_record(NULL::"matrix_device_candidates", to_jsonb(c) ||
      jsonb_build_object('created_at',date_trunc('milliseconds',clock_timestamp()),'expires_at',clock_timestamp()+INTERVAL '10 seconds') || $2::jsonb)).*
    FROM "matrix_device_candidates" c WHERE "id"=$1`, [templateId, JSON.stringify(replacement)]);
}

export async function unboundSession(client: Client, owner: SessionPrincipal): Promise<SessionPrincipal> {
  const id = randomUUID();
  const { rows } = await client.query<{ expiresAt: Date }>(
    `INSERT INTO "auth_sessions" ("id", "user_id", "token_hash", "csrf_secret_hash", "session_version", "created_at", "expires_at")
      VALUES ($1,$2,$3,$4,1,clock_timestamp() - INTERVAL '1 second',clock_timestamp() + INTERVAL '1 hour') RETURNING "expires_at" AS "expiresAt"`,
    [id, owner.id, randomBytes(32).toString("hex"), randomBytes(32).toString("hex")]);
  return { ...owner, sessionId: id, deviceId: null, sessionExpiresAt: rows[0].expiresAt };
}

export async function operationalSnapshot(client: Client, userId: string) {
  const result = await client.query(`SELECT
    (SELECT count(*)::int FROM "devices" WHERE "user_id"=$1) AS devices,
    (SELECT count(*)::int FROM "matrix_device_keys" WHERE "user_id"=$1) AS keys,
    (SELECT count(*)::int FROM "matrix_device_cross_signings" WHERE "user_id"=$1) AS certificates,
    (SELECT count(*)::int FROM "matrix_device_registrations" WHERE "user_id"=$1) AS registrations,
    (SELECT count(*)::int FROM "matrix_device_list_changes" WHERE "subject_user_id"=$1) AS events,
    (SELECT "version"::text FROM "matrix_device_list_states" WHERE "user_id"=$1) AS version,
    (SELECT count(*)::int FROM "matrix_one_time_keys" k JOIN "devices" d ON d."id"=k."device_id" WHERE d."user_id"=$1) AS prekeys,
    (SELECT count(*)::int FROM "matrix_to_device_cursors" c JOIN "devices" d ON d."id"=c."device_id" WHERE d."user_id"=$1) AS cursors`, [userId]);
  return result.rows;
}

async function sqlRejected(client: Client, sql: string, params: unknown[]) {
  await assert.rejects(client.query(sql, params), (error: any) => error?.code === "23514");
}
function http(status: number): (error: unknown) => boolean {
  return (error) => error instanceof HttpException && error.getStatus() === status;
}
export async function insertShortCandidate(client: Client, session: SessionPrincipal, fixture: ReturnType<typeof candidateFixture>, templateId: string) {
  const data = parseMatrixDeviceCandidate(fixture.body, { userId: fixture.body.device_keys.user_id, deviceId: fixture.body.device_keys.device_id });
  await client.query(`INSERT INTO "matrix_device_candidates" (
    "id","user_id","session_id","session_version","matrix_user_id","matrix_device_id","trusted_device_id",
    "identity_bootstrap_sha256","device_keys","canonical_sha256","ed25519_key","curve25519_key","created_at","expires_at")
    SELECT $1,"user_id",$2,"session_version","matrix_user_id",$3,"trusted_device_id","identity_bootstrap_sha256",
      $4::jsonb,$5,$6,$7,date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp()) + INTERVAL '300 milliseconds'
    FROM "matrix_device_candidates" WHERE "id"=$8`,
  [fixture.id, session.sessionId, data.deviceKeys.device_id, JSON.stringify(data.deviceKeys), data.canonicalSha256, data.ed25519Key, data.curve25519Key, templateId]);
}
export async function waitExpired(client: Client, id: string) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if ((await client.query(`SELECT "expires_at" <= clock_timestamp() AS expired FROM "matrix_device_candidates" WHERE "id"=$1`, [id])).rows[0]?.expired) return;
    await delay(25);
  }
  throw new Error("CANDIDATE_FIXTURE_DID_NOT_EXPIRE");
}

export async function blocked<T>(client: Client, userId: string, operations: Array<() => Promise<T>>, beforeRelease?: () => Promise<void>) {
  await client.query("BEGIN");
  let outcomes: Promise<PromiseSettledResult<T>[]> | undefined;
  try {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('sinochat:devices:' || $1::text, 0))::text`, [userId]);
    outcomes = Promise.allSettled(operations.map((operation) => operation()));
    const deadline = performance.now() + 5000;
    let observed = false;
    while (performance.now() < deadline) {
      const result = await client.query(`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND application_name IN ('sinochat-cross-signing-one','sinochat-cross-signing-two')
        AND wait_event_type='Lock' AND wait_event='advisory'`);
      if (result.rows[0].count === operations.length) { observed = true; break; }
      await delay(25);
    }
    assert.equal(observed, true, "CANDIDATE_WORKERS_NOT_OBSERVED_WAITING");
    await beforeRelease?.();
    await client.query("COMMIT");
    return await outcomes;
  } finally {
    await client.query("ROLLBACK");
    await outcomes;
  }
}
