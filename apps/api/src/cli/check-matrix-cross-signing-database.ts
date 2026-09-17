import "../config/load-env";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DeviceId, OlmMachine, RequestType, UserId, initAsync } from "@matrix-org/matrix-sdk-crypto-wasm";
import { matrixDeviceIdFromUuid, matrixUserIdFromUuid } from "@sinochat/contracts";
import { Client } from "pg";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import type { SessionPrincipal } from "../auth/auth.types";
import { readDatabaseConfig, readMatrixServerName } from "../config/runtime-config";
import { MatrixDeviceListPublisher } from "../database/matrix-device-list.publisher";
import { PrismaService } from "../database/prisma.service";
import { parseMatrixCrossSigningBootstrap } from "../e2ee/matrix-cross-signing";
import { MatrixCrossSigningService } from "../e2ee/matrix-cross-signing.service";
import { MatrixKeyDirectoryService } from "../e2ee/matrix-key-directory.service";
import { hashMatrixCanonicalJson, type MatrixDeviceKeys } from "../e2ee/matrix-key-upload";
import { AccountStatus, UserRole } from "../generated/prisma/enums";
import { checkMatrixCandidateQuarantine } from "./check-matrix-candidate-quarantine";
import { checkMatrixCandidateReview } from "./check-matrix-candidate-review";
import { checkMatrixDeviceVerification } from "./check-matrix-device-verification";
import { checkMatrixVerificationInbox } from "./check-matrix-verification-inbox";

const DATABASE_PATTERN = /^sinochat_cross_signing_[a-f0-9]{24}$/;
const WORKER_NAMES = ["sinochat-cross-signing-one", "sinochat-cross-signing-two"];
type DatabaseIdentity = { oid: string; owner: string };
type PublicBootstrap = { signing_keys: unknown; device_signatures: unknown };
type Fixture = {
  userId: string;
  deviceId: string;
  matrixUserId: string;
  matrixDeviceId: string;
  deviceKeys: MatrixDeviceKeys;
  bootstraps: [PublicBootstrap, PublicBootstrap, PublicBootstrap];
  principals: [SessionPrincipal, SessionPrincipal];
};

/**
 * Runs real SDK signatures, services and PostgreSQL constraints in an empty,
 * disposable LOCAL database. It never connects Prisma to the configured data
 * database, disables triggers, changes the release gate or exports private keys.
 */
async function checkMatrixCrossSigningDatabase(): Promise<void> {
  const { databaseUrl } = readDatabaseConfig();
  assertLocalDatabase(databaseUrl);
  const configuredUrl = new URL(databaseUrl);
  const databaseName = `sinochat_cross_signing_${randomBytes(12).toString("hex")}`;
  assert(DATABASE_PATTERN.test(databaseName), "SCRATCH_DATABASE_NAME_INVALID");
  assert.notEqual(configuredUrl.pathname.slice(1), databaseName, "CONFIGURED_DATABASE_MUST_NOT_BE_SCRATCH");
  const maintenanceUrl = new URL(databaseUrl);
  maintenanceUrl.pathname = "/postgres";
  maintenanceUrl.searchParams.delete("schema");
  const scratchUrl = new URL(maintenanceUrl);
  scratchUrl.pathname = `/${databaseName}`;
  const maintenance = new Client({
    connectionString: maintenanceUrl.toString(),
    application_name: "sinochat-cross-signing-maintenance",
    connectionTimeoutMillis: 5_000
  });
  const workers: PrismaService[] = [];
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let scratch: Client | undefined;
  let identity: DatabaseIdentity | undefined;
  let databaseCreated = false;

  await maintenance.connect();
  try {
    const permission = await maintenance.query<{ allowed: boolean }>(
      `SELECT rolcreatedb OR rolsuper AS "allowed" FROM pg_roles WHERE rolname = current_user`
    );
    assert.equal(permission.rows[0]?.allowed, true, "LOCAL_CREATEDB_PERMISSION_REQUIRED_NO_DEVELOPMENT_DATABASE_FALLBACK");
    await maintenance.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    databaseCreated = true;
    identity = await databaseIdentity(maintenance, databaseName);
    console.log("[OK] Base temporal aislada creada con identidad verificada.");
    await migrateScratchDatabase(scratchUrl.toString());
    console.log("[OK] Migraciones aplicadas exclusivamente en la base temporal vacia.");
    scratch = new Client({
      connectionString: scratchUrl.toString(),
      application_name: "sinochat-cross-signing-blocker",
      connectionTimeoutMillis: 5_000
    });
    await scratch.connect();
    const actual = await scratch.query<{ name: string }>(`SELECT current_database() AS "name"`);
    assert.equal(actual.rows[0]?.name, databaseName, "SCRATCH_DATABASE_MISMATCH");
    for (const applicationName of WORKER_NAMES) {
      const workerUrl = new URL(scratchUrl);
      workerUrl.searchParams.set("application_name", applicationName);
      process.env.DATABASE_URL = workerUrl.toString();
      const prisma = new PrismaService();
      workers.push(prisma);
      await prisma.onModuleInit();
    }
    restoreDatabaseUrl(originalDatabaseUrl);
    const services = workers.map((worker) => new MatrixCrossSigningService(
      worker, new ConversationEligibilityService(worker), new MatrixDeviceListPublisher()
    ));
    await checkPublicationAndRetry(scratch, services[0], new MatrixKeyDirectoryService(workers[0], new ConversationEligibilityService(workers[0]), new MatrixDeviceListPublisher()));
    await checkDatabaseInvariants(scratch);
    await checkConcurrentPublication(scratch, maintenance, databaseName, services);
    await checkRevocationBeforeLock(scratch, maintenance, databaseName, services[0]);
    const candidateOwner = await createFixture(scratch);
    await services[0].bootstrap(candidateOwner.principals[0], candidateOwner.bootstraps[0]);
    await checkMatrixCandidateQuarantine(scratch, workers, candidateOwner.principals[0], candidateOwner.matrixUserId);
    const reviewOwner = await createFixture(scratch);
    await services[0].bootstrap(reviewOwner.principals[0], reviewOwner.bootstraps[0]);
    await checkMatrixCandidateReview(scratch, workers, reviewOwner.principals[0], reviewOwner.principals[1], candidateOwner.principals[0]);
    const verificationOwner = await createFixture(scratch);
    await services[0].bootstrap(verificationOwner.principals[0], verificationOwner.bootstraps[0]);
    await checkMatrixDeviceVerification(scratch, workers, verificationOwner.principals[0], verificationOwner.principals[1], candidateOwner.principals[0]);
    const inboxOwner = await createFixture(scratch);
    await services[0].bootstrap(inboxOwner.principals[0], inboxOwner.bootstraps[0]);
    await checkMatrixVerificationInbox(scratch, workers, inboxOwner.principals[0], inboxOwner.principals[1], candidateOwner.principals[0]);
    console.log("[OK] Firmas del SDK, servicio real y constraints SQL verificados; E2EE sigue bloqueado.");
  } finally {
    restoreDatabaseUrl(originalDatabaseUrl);
    const disconnected = await Promise.allSettled(workers.map((worker) => worker.onApplicationShutdown()));
    try {
      await scratch?.end();
    } finally {
      try {
        if (databaseCreated) {
          assert(identity, "SCRATCH_IDENTITY_MISSING_REFUSING_DROP");
          assert(DATABASE_PATTERN.test(databaseName), "SCRATCH_DROP_NAME_INVALID");
          assert.deepEqual(await databaseIdentity(maintenance, databaseName), identity, "SCRATCH_IDENTITY_CHANGED_REFUSING_DROP");
          await maintenance.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
          const residue = await maintenance.query<{ count: string }>(
            `SELECT count(*)::text AS "count" FROM pg_database WHERE datname = $1`, [databaseName]
          );
          assert.equal(residue.rows[0]?.count, "0", "SCRATCH_DATABASE_LEFT_BEHIND");
          console.log("[OK] Base temporal eliminada; usuarios, asignaciones y auditoria habituales intactos.");
        }
      } finally {
        await maintenance.end();
      }
    }
    assert(disconnected.every((result) => result.status === "fulfilled"), "SCRATCH_PRISMA_DISCONNECT_FAILED");
  }
}

async function checkPublicationAndRetry(client: Client, service: MatrixCrossSigningService, directory: MatrixKeyDirectoryService): Promise<void> {
  const fixture = await createFixture(client);
  const before = await service.status(fixture.principals[0]);
  assert.equal(before.state, "UNINITIALIZED", "INITIAL_STATUS_NOT_UNINITIALIZED");
  assert.equal(before.identity, null, "UNINITIALIZED_IDENTITY_PRESENT");
  await service.bootstrap(fixture.principals[0], fixture.bootstraps[0]);
  const after = await service.status(fixture.principals[0]);
  assert.equal(after.state, "PINNED", "BOOTSTRAP_IDENTITY_NOT_PINNED");
  assert.equal(after.matrixUserId, fixture.matrixUserId);
  assert.equal(after.matrixDeviceId, fixture.matrixDeviceId);
  const expected = parseFixture(fixture, fixture.bootstraps[0]);
  assert.deepEqual(after.identity, publicIdentity(expected.identity));
  const firstSnapshot = await persistedSnapshot(client, fixture.userId);
  assertPublishedSnapshot(firstSnapshot, fixture, expected.identity.masterKey);
  await service.bootstrap(fixture.principals[0], fixture.bootstraps[1]);
  assert.deepEqual(await persistedSnapshot(client, fixture.userId), firstSnapshot, "RETRY_MUTATED_PIN_OR_PUBLISHED_DUPLICATE");
  await assert.rejects(
    service.bootstrap(fixture.principals[0], fixture.bootstraps[2]),
    (error: unknown) => httpFailure(error).status === 409,
    "VALID_DIFFERENT_ROOT_ACCEPTED"
  );
  assert.deepEqual(await persistedSnapshot(client, fixture.userId), firstSnapshot, "REJECTED_ROOT_MUTATED_STATE");
  console.log("[OK] Primer pin publicado; reintento exacto sin duplicados; otra raiz valida rechazada.");
  const ownQuery = await directory.queryRelatedKeys(fixture.principals[0], { device_keys: { [fixture.matrixUserId]: [] } });
  assert.deepEqual(ownQuery.device_keys[fixture.matrixUserId][fixture.matrixDeviceId], expected.signedDeviceKeys);
  assert.deepEqual(ownQuery.master_keys[fixture.matrixUserId], expected.signingKeys.master_key);
  assert.deepEqual(ownQuery.self_signing_keys[fixture.matrixUserId], expected.signingKeys.self_signing_key);
  assert.deepEqual(ownQuery.user_signing_keys[fixture.matrixUserId], expected.signingKeys.user_signing_key);
  await assert.rejects(directory.queryRelatedKeys({ ...fixture.principals[0], role: UserRole.ADMIN }, { device_keys: { [fixture.matrixUserId]: [] } }), (error: unknown) => httpFailure(error).status === 403);
  console.log("[OK] Consulta propia devuelve certificado y triplete publicados; ADMIN queda excluido.");

  for (const query of [
    `UPDATE "matrix_cross_signing_identities" SET "master_key" = "self_signing_key" WHERE "user_id" = $1`,
    `UPDATE "matrix_cross_signing_identities" SET "created_at" = "created_at" + INTERVAL '1 second' WHERE "user_id" = $1`,
    `UPDATE "matrix_device_cross_signings" SET "signed_device_keys" = '{}'::jsonb WHERE "user_id" = $1`,
    `DELETE FROM "matrix_cross_signing_identities" WHERE "user_id" = $1`,
    `DELETE FROM "matrix_device_cross_signings" WHERE "user_id" = $1`
  ]) await assertSqlRejected(client, () => client.query(query, [fixture.userId]));
  assert.deepEqual(await persistedSnapshot(client, fixture.userId), firstSnapshot, "SQL_MUTATION_CHANGED_PIN");
  console.log("[OK] SQL directo no modifica ni elimina la identidad o el certificado publicados.");
}

async function checkDatabaseInvariants(client: Client): Promise<void> {
  const helpers = await client.query(`SELECT
    sinochat_cross_signing_exact_object(NULL, ARRAY['keys']) AS "sqlNull",
    sinochat_cross_signing_exact_object('null'::jsonb, ARRAY['keys']) AS "jsonNull",
    sinochat_cross_signing_exact_object('{}'::jsonb, NULL) AS "nullExpected",
    sinochat_cross_signing_signatures_shape('{}'::jsonb, NULL, ARRAY['key']) AS "nullSigner",
    sinochat_cross_signing_key_shape('{"keys":null,"signatures":null,"usage":null,"user_id":null}'::jsonb, 'master', 'public', 'user', ARRAY['key']) AS "nullFields"`);
  assert(Object.values(helpers.rows[0]).every((value) => value === false), "SQL_SHAPE_NULL_MUST_FAIL_CLOSED");
  const fixture = await createFixture(client);
  const parsed = parseFixture(fixture, fixture.bootstraps[0]);
  await assertSqlRejected(client, () => insertIdentity(client, fixture, parsed));
  await assertSqlRejected(client, () => insertCertificate(client, fixture, parsed));
  const rows = await persistedSnapshot(client, fixture.userId);
  assert.equal(rows.identities.length, 0, "ORPHAN_ROOT_COMMITTED");
  assert.equal(rows.certificates.length, 0, "ORPHAN_CERTIFICATE_COMMITTED");
  assert.equal(rows.changes.length, 0, "ORPHAN_PUBLICATION_EVENT_COMMITTED");
  console.log("[OK] No puede confirmarse una raiz sin certificado ni un certificado sin identidad.");
}

async function checkConcurrentPublication(
  blocker: Client, observer: Client, databaseName: string, services: MatrixCrossSigningService[]
): Promise<void> {
  const fixture = await createFixture(blocker);
  const requests = [fixture.bootstraps[0], fixture.bootstraps[2]];
  assert.notEqual(parseFixture(fixture, requests[0]).identity.masterKey, parseFixture(fixture, requests[1]).identity.masterKey);
  const outcomes = await withHeldDeviceLock(blocker, observer, databaseName, fixture.userId,
    services.map((service, index) => () => service.bootstrap(fixture.principals[index], requests[index]))
  );
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1, "RACE_EXPECTED_ONE_SUCCESS");
  const loser = outcomes.find((result) => result.status === "rejected");
  assert(loser?.status === "rejected", "RACE_EXPECTED_ONE_CONFLICT");
  assert.equal(httpFailure(loser.reason).status, 409, "RACE_MUST_RETURN_HTTP_CONFLICT");
  const winner = outcomes.findIndex((result) => result.status === "fulfilled");
  const snapshot = await persistedSnapshot(blocker, fixture.userId);
  assertPublishedSnapshot(snapshot, fixture, parseFixture(fixture, requests[winner]).identity.masterKey);
  console.log("[OK] Dos bootstraps bloqueados simultaneamente: una raiz, un certificado y un CHANGED.");
}

async function checkRevocationBeforeLock(
  blocker: Client, observer: Client, databaseName: string, service: MatrixCrossSigningService
): Promise<void> {
  const fixture = await createFixture(blocker);
  const outcomes = await withHeldDeviceLock(blocker, observer, databaseName, fixture.userId,
    [() => service.bootstrap(fixture.principals[0], fixture.bootstraps[0])],
    () => blocker.query(
      `UPDATE "auth_sessions" SET "revoked_at" = clock_timestamp(), "revocation_reason" = 'ISOLATED_TEST'
        WHERE "id" = $1`, [fixture.principals[0].sessionId]
    ).then(() => undefined)
  );
  assert.equal(outcomes.length, 1);
  assert(outcomes[0].status === "rejected", "QUEUED_REVOKED_SESSION_BOOTSTRAPPED");
  assert.equal(httpFailure(outcomes[0].reason).status, 401, "QUEUED_REVOKED_SESSION_WRONG_FAILURE");
  const snapshot = await persistedSnapshot(blocker, fixture.userId);
  assert.equal(snapshot.identities.length, 0, "REVOKED_SESSION_PIN_PERSISTED");
  assert.equal(snapshot.certificates.length, 0, "REVOKED_SESSION_CERTIFICATE_PERSISTED");
  assert.equal(snapshot.changes.length, 0, "REVOKED_SESSION_EVENT_PERSISTED");
  console.log("[OK] Una sesion revocada mientras espera el lock no publica identidad ni eventos.");
}

async function withHeldDeviceLock(
  blocker: Client,
  observer: Client,
  databaseName: string,
  userId: string,
  operations: Array<() => Promise<unknown>>,
  beforeRelease?: () => Promise<void>
): Promise<PromiseSettledResult<unknown>[]> {
  assert(operations.length >= 1 && operations.length <= WORKER_NAMES.length);
  await blocker.query("BEGIN");
  let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
  let waitFailure: unknown;
  let committed = false;
  try {
    await blocker.query(`SELECT pg_advisory_xact_lock(hashtextextended('sinochat:devices:' || $1::text, 0))`, [userId]);
    pending = Promise.allSettled(operations.map((operation) => operation()));
    const expectedWorkers = WORKER_NAMES.slice(0, operations.length);
    const deadline = Date.now() + 8_000;
    let allBlocked = false;
    while (Date.now() < deadline) {
      const waiting = await observer.query<{ applicationName: string }>(
        `SELECT DISTINCT application_name AS "applicationName" FROM pg_stat_activity
          WHERE datname = $1 AND application_name = ANY($2::text[])
            AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%'`,
        [databaseName, expectedWorkers]
      );
      allBlocked = expectedWorkers.every((name) => waiting.rows.some((row) => row.applicationName === name));
      if (allBlocked) break;
      await delay(25);
    }
    assert(allBlocked, "CONCURRENCY_NOT_OBSERVED_REFUSING_SEQUENTIAL_PASS");
    if (beforeRelease) {
      await beforeRelease();
      await blocker.query("COMMIT");
      committed = true;
    }
  } catch (error: unknown) {
    waitFailure = error;
  } finally {
    if (!committed) await blocker.query("ROLLBACK");
  }
  const outcomes = pending ? await pending : [];
  if (waitFailure) throw waitFailure;
  return outcomes;
}

async function createFixture(client: Client): Promise<Fixture> {
  const userId = randomUUID();
  const deviceId = randomUUID();
  const matrixUserId = matrixUserIdFromUuid(userId, readMatrixServerName());
  const matrixDeviceId = matrixDeviceIdFromUuid(deviceId);
  const { deviceKeys, bootstraps } = await publicSdkRequests(matrixUserId, matrixDeviceId);
  const username = `cross_${randomBytes(10).toString("hex")}`;
  await client.query(
    `INSERT INTO "users" ("id", "role", "username", "normalized_username", "password_hash", "status", "updated_at")
       VALUES ($1, 'CLIENT', $2, $2, 'isolated-cross-signing-fixture-not-a-password', 'ACTIVE', clock_timestamp())`,
    [userId, username]
  );
  await client.query(
    `INSERT INTO "devices" ("id", "user_id", "binding_secret_hash", "protocol_version", "status")
       VALUES ($1, $2, $3, 'matrix-olm-v1', 'ACTIVE')`,
    [deviceId, userId, randomBytes(32).toString("hex")]
  );
  await client.query(
    `INSERT INTO "matrix_device_list_states" ("user_id", "matrix_user_id") VALUES ($1, $2)`, [userId, matrixUserId]
  );
  await client.query(
    `INSERT INTO "matrix_device_keys" (
       "device_id", "user_id", "matrix_user_id", "matrix_device_id", "curve25519_key", "ed25519_key", "device_keys", "canonical_sha256"
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [deviceId, userId, matrixUserId, matrixDeviceId,
      deviceKeys.keys[`curve25519:${matrixDeviceId}`], deviceKeys.keys[`ed25519:${matrixDeviceId}`],
      JSON.stringify(deviceKeys), hashMatrixCanonicalJson(deviceKeys)]
  );
  await client.query(`UPDATE "matrix_device_list_states" SET "version" = "version" + 1 WHERE "user_id" = $1`, [userId]);
  const principals: SessionPrincipal[] = [];
  for (let index = 0; index < 2; index += 1) {
    const sessionId = randomUUID();
    const session = await client.query<{ expiresAt: Date }>(
      `INSERT INTO "auth_sessions" (
         "id", "user_id", "device_id", "token_hash", "csrf_secret_hash", "session_version", "created_at", "expires_at"
       ) VALUES ($1, $2, $3, $4, $5, 1,
         date_trunc('milliseconds', clock_timestamp()) - INTERVAL '1 second', clock_timestamp() + INTERVAL '1 hour')
       RETURNING "expires_at" AS "expiresAt"`,
      [sessionId, userId, deviceId, randomBytes(32).toString("hex"), randomBytes(32).toString("hex")]
    );
    principals.push({ id: userId, username, role: UserRole.CLIENT, status: AccountStatus.ACTIVE,
      sessionId, deviceId, sessionExpiresAt: session.rows[0].expiresAt });
  }
  return { userId, deviceId, matrixUserId, matrixDeviceId, deviceKeys, bootstraps,
    principals: [principals[0], principals[1]] };
}

async function publicSdkRequests(matrixUserId: string, matrixDeviceId: string): Promise<{
  deviceKeys: MatrixDeviceKeys; bootstraps: [PublicBootstrap, PublicBootstrap, PublicBootstrap];
}> {
  await initAsync();
  const user = new UserId(matrixUserId);
  const device = new DeviceId(matrixDeviceId);
  let machine: OlmMachine | undefined;
  try {
    machine = await OlmMachine.initialize(user, device);
    const outgoing = await machine.outgoingRequests();
    let deviceKeys: MatrixDeviceKeys | undefined;
    try {
      const upload = outgoing.find((request) => request.type === RequestType.KeysUpload);
      assert(upload, "SDK_INITIAL_KEYS_MISSING");
      const body = JSON.parse(upload.body);
      deviceKeys = body.device_keys;
      await machine.markRequestAsSent(upload.id!, upload.type,
        JSON.stringify({ one_time_key_counts: { signed_curve25519: Object.keys(body.one_time_keys).length } }));
    } finally {
      outgoing.forEach((request) => request.free());
    }
    assert(deviceKeys, "SDK_DEVICE_KEYS_MISSING");
    const requests: PublicBootstrap[] = [];
    for (const reset of [false, false, true]) {
      // reset=true ONLY fabricates a competing root in this disposable machine.
      // It is never an available reset workflow or a request to a real server.
      const bootstrap = await machine.bootstrapCrossSigning(reset);
      const keys = bootstrap.uploadKeysRequest;
      const signing = bootstrap.uploadSigningKeysRequest;
      const signatures = bootstrap.uploadSignaturesRequest;
      try {
        requests.push({ signing_keys: JSON.parse(signing.body), device_signatures: JSON.parse(signatures.body) });
      } finally {
        keys?.free(); signing.free(); signatures.free(); bootstrap.free();
      }
    }
    return { deviceKeys, bootstraps: [requests[0], requests[1], requests[2]] };
  } finally {
    machine?.close(); user.free(); device.free();
  }
}

function parseFixture(fixture: Fixture, request: PublicBootstrap) {
  return parseMatrixCrossSigningBootstrap(request.signing_keys, request.device_signatures, {
    userId: fixture.matrixUserId, deviceId: fixture.matrixDeviceId,
    registeredDeviceKeys: fixture.deviceKeys, pinnedIdentity: null
  });
}

function publicIdentity(identity: ReturnType<typeof parseFixture>["identity"]) {
  return { masterKey: identity.masterKey, selfSigningKey: identity.selfSigningKey, userSigningKey: identity.userSigningKey };
}

async function persistedSnapshot(client: Client, userId: string) {
  const identities = await client.query(
    `SELECT * FROM "matrix_cross_signing_identities" WHERE "user_id" = $1 ORDER BY "user_id"`, [userId]
  );
  const certificates = await client.query(
    `SELECT * FROM "matrix_device_cross_signings" WHERE "user_id" = $1 ORDER BY "device_id"`, [userId]
  );
  const changes = await client.query(
    `SELECT * FROM "matrix_device_list_changes" WHERE "subject_user_id" = $1 ORDER BY "id"`, [userId]
  );
  const state = await client.query(
    `SELECT * FROM "matrix_device_list_states" WHERE "user_id" = $1`, [userId]
  );
  return { identities: identities.rows, certificates: certificates.rows, changes: changes.rows, state: state.rows };
}

function assertPublishedSnapshot(snapshot: Awaited<ReturnType<typeof persistedSnapshot>>, fixture: Fixture, masterKey: string): void {
  assert.equal(snapshot.identities.length, 1, "EXPECTED_EXACTLY_ONE_ROOT");
  assert.equal(snapshot.certificates.length, 1, "EXPECTED_EXACTLY_ONE_CERTIFICATE");
  assert.equal(snapshot.identities[0].master_key, masterKey, "WRONG_ROOT_PERSISTED");
  assert.equal(snapshot.identities[0].bootstrap_device_id, fixture.deviceId, "WRONG_BOOTSTRAP_DEVICE");
  assert.equal(snapshot.certificates[0].device_id, fixture.deviceId, "WRONG_CERTIFIED_DEVICE");
  assert.equal(snapshot.changes.length, 1, "EXPECTED_EXACTLY_ONE_DEVICE_CHANGE");
  assert.equal(snapshot.changes[0].change_type, "CHANGED", "UNEXPECTED_DEVICE_CHANGE_TYPE");
  assert.equal(snapshot.changes[0].recipient_user_id, fixture.userId, "UNEXPECTED_DEVICE_CHANGE_RECIPIENT");
  assert.equal(snapshot.changes[0].source_device_id, fixture.deviceId, "UNEXPECTED_DEVICE_CHANGE_SOURCE");
  assert.equal(snapshot.state[0].version, "2", "DEVICE_LIST_VERSION_NOT_INCREMENTED_EXACTLY_ONCE");
}

async function insertIdentity(client: Client, fixture: Fixture, parsed: ReturnType<typeof parseFixture>) {
  return client.query(
    `INSERT INTO "matrix_cross_signing_identities" (
       "user_id", "matrix_user_id", "bootstrap_device_id", "master_key", "self_signing_key", "user_signing_key", "signing_keys", "bootstrap_sha256"
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [fixture.userId, fixture.matrixUserId, fixture.deviceId, parsed.identity.masterKey,
      parsed.identity.selfSigningKey, parsed.identity.userSigningKey, JSON.stringify(parsed.signingKeys),
      hashMatrixCanonicalJson({ signingKeys: parsed.signingKeys, signedDeviceKeys: parsed.signedDeviceKeys })]
  );
}

async function insertCertificate(client: Client, fixture: Fixture, parsed: ReturnType<typeof parseFixture>) {
  return client.query(
    `INSERT INTO "matrix_device_cross_signings" ("device_id", "user_id", "signed_device_keys", "canonical_sha256")
       VALUES ($1, $2, $3::jsonb, $4)`,
    [fixture.deviceId, fixture.userId, JSON.stringify(parsed.signedDeviceKeys), hashMatrixCanonicalJson(parsed.signedDeviceKeys)]
  );
}

async function assertSqlRejected(client: Client, operation: () => Promise<unknown>): Promise<void> {
  await client.query("BEGIN");
  try {
    await assert.rejects(async () => {
      await operation();
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    }, (error: unknown) => {
      const code = sqlCode(error);
      return code === "23514" || code === "23503";
    }, "SQL_INVARIANT_NOT_ENFORCED");
  } finally {
    await client.query("ROLLBACK");
  }
}

function httpFailure(error: unknown): { status: unknown; code: string } {
  if (typeof error !== "object" || error === null) return { status: undefined, code: "" };
  const value = error as { status?: unknown; response?: { code?: unknown } };
  return { status: value.status, code: typeof value.response?.code === "string" ? value.response.code : "" };
}

function sqlCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}

async function databaseIdentity(client: Client, name: string): Promise<DatabaseIdentity> {
  const result = await client.query<DatabaseIdentity>(
    `SELECT oid::text AS "oid", datdba::text AS "owner" FROM pg_database WHERE datname = $1`, [name]
  );
  assert.equal(result.rowCount, 1, "SCRATCH_DATABASE_IDENTITY_MISSING");
  return result.rows[0];
}

async function migrateScratchDatabase(databaseUrl: string): Promise<void> {
  await new Promise<void>((done, reject) => {
    const child = spawn(process.execPath,
      [require.resolve("prisma/build/index.js"), "migrate", "deploy", "--config", "prisma.config.ts"], {
        cwd: resolve(__dirname, "../.."),
        env: { ...process.env, DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: databaseUrl },
        windowsHide: true,
        stdio: "ignore"
      });
    const timer = setTimeout(() => { child.kill(); reject(new Error("SCRATCH_MIGRATION_TIMEOUT")); }, 120_000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("SCRATCH_MIGRATION_PROCESS_FAILED")); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) done(); else reject(new Error("SCRATCH_MIGRATION_FAILED"));
    });
  });
}

function restoreDatabaseUrl(value: string | undefined): void {
  if (value === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = value;
}

function assertLocalDatabase(databaseUrl: string): void {
  assert.notEqual(process.env.NODE_ENV, "production", "PRODUCTION_FORBIDDEN");
  const parsed = new URL(databaseUrl);
  assert(new Set(["localhost", "127.0.0.1", "[::1]"]).has(parsed.hostname), "LOCAL_DATABASE_REQUIRED");
  assert(new Set(["postgres:", "postgresql:"]).has(parsed.protocol), "POSTGRESQL_REQUIRED");
}

void checkMatrixCrossSigningDatabase().catch((error: unknown) => {
  const candidate = error instanceof Error ? error.message : "UNKNOWN";
  const databaseCode = sqlCode(error);
  const code = /^[A-Z][A-Z0-9_]{0,160}$/.test(candidate) ? candidate
    : /^[A-Z0-9_]{1,40}$/.test(databaseCode) ? databaseCode : "UNEXPECTED_CROSS_SIGNING_CHECK_FAILURE";
  console.error(`[ERROR] Fallo la comprobacion de cross-signing PostgreSQL (${code}).`);
  // SQLSTATE only: never emit a connection URL, query, bind values or payload.
  const sqlState = (error as { meta?: { code?: unknown } } | null)?.meta?.code;
  if (typeof sqlState === "string" && /^[0-9A-Z]{5}$/.test(sqlState)) console.error(`[ERROR] SQLSTATE ${sqlState}.`);
  const detail = (error as { meta?: { message?: unknown } } | null)?.meta?.message;
  if (typeof detail === "string" && detail.includes("Failed to deserialize column of type 'void'")) console.error("[ERROR] POSTGRES_VOID_RESULT_UNSUPPORTED");
  process.exitCode = 1;
});
