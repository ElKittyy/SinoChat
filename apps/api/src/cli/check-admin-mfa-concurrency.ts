import "../config/load-env";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { AdminMfaService } from "../auth/admin-mfa.service";
import type { AdminWebAuthnCrypto } from "../auth/admin-webauthn.crypto";
import { hashWebAuthnChallenge } from "../auth/admin-webauthn-payload";
import type { SessionPrincipal } from "../auth/auth.types";
import { readDatabaseConfig } from "../config/runtime-config";
import { PrismaService } from "../database/prisma.service";
import { AccountStatus, UserRole } from "../generated/prisma/enums";

const DATABASE_PATTERN = /^sinochat_mfa_concurrency_[a-f0-9]{24}$/;
const WORKER_NAMES = ["sinochat-mfa-race-one", "sinochat-mfa-race-two"];
type DatabaseIdentity = { oid: string; owner: string };
type Fixture = {
  adminId: string;
  credentials: string[];
  principals: [SessionPrincipal, SessionPrincipal];
};

/**
 * Prueba los servicios reales y sus transacciones PostgreSQL en una base vacía
 * exclusiva. Solo se sustituye la verificación criptográfica del registro: esta
 * comprobación NO certifica WebAuthn ni reemplaza el recorrido en navegador.
 * Nunca deshabilita triggers, borra auditoría de desarrollo ni copia sus datos.
 */
async function checkAdminMfaConcurrency(): Promise<void> {
  const { databaseUrl } = readDatabaseConfig();
  assertLocalDatabase(databaseUrl);
  const configuredUrl = new URL(databaseUrl);
  const databaseName = `sinochat_mfa_concurrency_${randomBytes(12).toString("hex")}`;
  assert(DATABASE_PATTERN.test(databaseName), "SCRATCH_DATABASE_NAME_INVALID");
  assert.notEqual(
    configuredUrl.pathname.slice(1),
    databaseName,
    "CONFIGURED_DATABASE_MUST_NOT_BE_SCRATCH"
  );
  const maintenanceUrl = new URL(databaseUrl);
  maintenanceUrl.pathname = "/postgres";
  maintenanceUrl.searchParams.delete("schema");
  const scratchUrl = new URL(maintenanceUrl);
  scratchUrl.pathname = `/${databaseName}`;
  const maintenance = new Client({
    connectionString: maintenanceUrl.toString(),
    application_name: "sinochat-mfa-race-maintenance",
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
      `SELECT rolcreatedb OR rolsuper AS "allowed"
         FROM pg_roles WHERE rolname = current_user`
    );
    assert.equal(
      permission.rows[0]?.allowed,
      true,
      "LOCAL_CREATEDB_PERMISSION_REQUIRED_NO_DEVELOPMENT_DATABASE_FALLBACK"
    );
    // El identificador proviene únicamente del generador y regex anteriores.
    await maintenance.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    databaseCreated = true;
    identity = await databaseIdentity(maintenance, databaseName);
    console.log("[OK] Base temporal aislada creada con identidad verificada.");
    await migrateScratchDatabase(scratchUrl.toString());
    console.log("[OK] Migraciones aplicadas en la base temporal vacía.");

    scratch = new Client({
      connectionString: scratchUrl.toString(),
      application_name: "sinochat-mfa-race-blocker",
      connectionTimeoutMillis: 5_000
    });
    await scratch.connect();
    const actualDatabase = await scratch.query<{ name: string }>(
      `SELECT current_database() AS "name"`
    );
    assert.equal(actualDatabase.rows[0]?.name, databaseName, "SCRATCH_DATABASE_MISMATCH");

    for (const applicationName of WORKER_NAMES) {
      const workerUrl = new URL(scratchUrl);
      workerUrl.searchParams.set("application_name", applicationName);
      // Cambio limitado a este proceso CLI; cada constructor captura su URL.
      process.env.DATABASE_URL = workerUrl.toString();
      const prisma = new PrismaService();
      workers.push(prisma);
      await prisma.onModuleInit();
    }
    restoreDatabaseUrl(originalDatabaseUrl);

    await checkConcurrentRevocations(scratch, maintenance, databaseName, workers);
    await checkConcurrentRegistrations(scratch, maintenance, databaseName, workers);
    console.log("[OK] Ambas carreras usaron dos transacciones bloqueadas simultáneamente.");
    console.log("[OK] Verificación criptográfica sustituida únicamente en esta prueba de concurrencia.");
  } finally {
    restoreDatabaseUrl(originalDatabaseUrl);
    const disconnected = await Promise.allSettled(
      workers.map((worker) => worker.onApplicationShutdown())
    );
    try {
      await scratch?.end();
    } finally {
      try {
        if (databaseCreated) {
          assert(identity, "SCRATCH_IDENTITY_MISSING_REFUSING_DROP");
          assert(DATABASE_PATTERN.test(databaseName), "SCRATCH_DROP_NAME_INVALID");
          const existing = await databaseIdentity(maintenance, databaseName);
          assert.deepEqual(existing, identity, "SCRATCH_IDENTITY_CHANGED_REFUSING_DROP");
          // FORCE se limita a la base creada por esta ejecución y verificada por OID.
          await maintenance.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
          const residue = await maintenance.query<{ count: string }>(
            `SELECT count(*)::text AS "count" FROM pg_database WHERE datname = $1`,
            [databaseName]
          );
          assert.equal(residue.rows[0]?.count, "0", "SCRATCH_DATABASE_LEFT_BEHIND");
          console.log("[OK] Base temporal eliminada; datos y auditoría habituales intactos.");
        }
      } finally {
        await maintenance.end();
      }
    }
    assert(
      disconnected.every((result) => result.status === "fulfilled"),
      "SCRATCH_PRISMA_DISCONNECT_FAILED"
    );
  }
}

async function checkConcurrentRevocations(
  scratch: Client,
  observer: Client,
  databaseName: string,
  workers: PrismaService[]
): Promise<void> {
  const fixture = await createFixture(scratch, 2);
  const services = workers.map(
    (worker) => new AdminMfaService(worker, registrationCryptoDouble())
  );
  const outcomes = await raceOnUserLock(
    scratch,
    observer,
    databaseName,
    fixture.adminId,
    services.map((service, index) => () =>
      service.revokePasskey(fixture.principals[index], fixture.credentials[index], {})
    )
  );
  const winner = assertOneWinner(outcomes, "ADMIN_PASSKEY_LAST_REQUIRED");
  const persisted = await scratch.query<{ id: string; revoked: boolean }>(
    `SELECT "id", "revoked_at" IS NOT NULL AS "revoked"
       FROM "admin_webauthn_credentials" WHERE "admin_user_id" = $1`,
    [fixture.adminId]
  );
  assert.equal(persisted.rows.filter((row) => !row.revoked).length, 1, "LAST_PASSKEY_LOST");
  assert.equal(
    persisted.rows.find((row) => row.id === fixture.credentials[winner])?.revoked,
    true,
    "REVOCATION_WINNER_NOT_PERSISTED"
  );
  await assertAuditCount(scratch, fixture.adminId, "ADMIN_PASSKEY_REVOKED");

  const otherAdmin = await createFixture(scratch, 1);
  await assert.rejects(
    services[0].revokePasskey(fixture.principals[0], otherAdmin.credentials[0], {}),
    (error: unknown) => httpFailure(error).status === 404,
    "ANOTHER_ADMIN_PASSKEY_ACCEPTED"
  );
  await assertAuditCount(scratch, fixture.adminId, "ADMIN_PASSKEY_REVOKED");
  console.log("[OK] Dos revocaciones sobre dos passkeys: queda una, un conflicto y una auditoría.");
  console.log("[OK] La passkey de otro administrador no puede revocarse.");
}

async function checkConcurrentRegistrations(
  scratch: Client,
  observer: Client,
  databaseName: string,
  workers: PrismaService[]
): Promise<void> {
  const fixture = await createFixture(scratch, 9);
  const ceremonies = await Promise.all(
    fixture.principals.map(async (principal) => {
      const challenge = randomBytes(32).toString("base64url");
      const id = randomUUID();
      const credentialId = randomBytes(32).toString("base64url");
      await scratch.query(
        `INSERT INTO "admin_webauthn_challenges" (
           "id", "admin_user_id", "session_id", "purpose", "challenge_hash",
           "created_at", "expires_at"
         ) VALUES (
           $1, $2, $3, 'REGISTRATION', $4,
           date_trunc('milliseconds', clock_timestamp()) - INTERVAL '1 second',
           clock_timestamp() + INTERVAL '4 minutes'
         )`,
        [id, fixture.adminId, principal.sessionId, hashWebAuthnChallenge(challenge)]
      );
      return {
        id,
        credentialId,
        response: {
          id: credentialId,
          response: {
            clientDataJSON: Buffer.from(
              JSON.stringify({ type: "webauthn.create", challenge, origin: "http://localhost:5173" })
            ).toString("base64url")
          }
        }
      };
    })
  );
  const services = workers.map(
    (worker) => new AdminMfaService(worker, registrationCryptoDouble())
  );
  const outcomes = await raceOnUserLock(
    scratch,
    observer,
    databaseName,
    fixture.adminId,
    services.map((service, index) => () =>
      service.verifyRegistration(
        fixture.principals[index],
        ceremonies[index].id,
        ceremonies[index].response,
        {}
      )
    )
  );
  const winner = assertOneWinner(outcomes, "ADMIN_PASSKEY_LIMIT_REACHED");
  const credentials = await scratch.query<{ credentialId: string }>(
    `SELECT "credential_id" AS "credentialId" FROM "admin_webauthn_credentials"
      WHERE "admin_user_id" = $1 AND "revoked_at" IS NULL`,
    [fixture.adminId]
  );
  assert.equal(credentials.rows.length, 10, "ADMIN_PASSKEY_LIMIT_EXCEEDED");
  assert(
    credentials.rows.some((row) => row.credentialId === ceremonies[winner].credentialId),
    "REGISTRATION_WINNER_NOT_PERSISTED"
  );
  assert.equal(
    credentials.rows.some((row) => row.credentialId === ceremonies[1 - winner].credentialId),
    false,
    "REGISTRATION_LOSER_PERSISTED"
  );
  const challenges = await scratch.query<{ id: string; consumed: boolean }>(
    `SELECT "id", "consumed_at" IS NOT NULL AS "consumed"
       FROM "admin_webauthn_challenges" WHERE "admin_user_id" = $1`,
    [fixture.adminId]
  );
  assert.equal(challenges.rows.find((row) => row.id === ceremonies[winner].id)?.consumed, true);
  assert.equal(
    challenges.rows.find((row) => row.id === ceremonies[1 - winner].id)?.consumed,
    false,
    "REGISTRATION_LOSER_CHALLENGE_CONSUMED"
  );
  await assertAuditCount(scratch, fixture.adminId, "ADMIN_PASSKEY_REGISTERED");
  console.log("[OK] Dos altas sobre nueve passkeys: quedan diez y el desafío perdedor no se consume.");
}

async function raceOnUserLock(
  blocker: Client,
  observer: Client,
  databaseName: string,
  adminId: string,
  operations: Array<() => Promise<unknown>>
): Promise<PromiseSettledResult<unknown>[]> {
  assert.equal(operations.length, 2);
  await blocker.query("BEGIN");
  let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
  let waitFailure: unknown;
  try {
    await blocker.query(`SELECT "id" FROM "users" WHERE "id" = $1::uuid FOR UPDATE`, [adminId]);
    pending = Promise.allSettled(operations.map((operation) => operation()));
    const deadline = Date.now() + 8_000;
    let bothBlocked = false;
    while (Date.now() < deadline) {
      const waiting = await observer.query<{ applicationName: string }>(
        `SELECT DISTINCT application_name AS "applicationName"
           FROM pg_stat_activity
          WHERE datname = $1 AND application_name = ANY($2::text[])
            AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'`,
        [databaseName, WORKER_NAMES]
      );
      bothBlocked = WORKER_NAMES.every((name) =>
        waiting.rows.some((row) => row.applicationName === name)
      );
      if (bothBlocked) break;
      await delay(25);
    }
    assert(bothBlocked, "CONCURRENCY_NOT_OBSERVED_REFUSING_SEQUENTIAL_PASS");
  } catch (error: unknown) {
    waitFailure = error;
  } finally {
    await blocker.query("ROLLBACK");
  }
  const outcomes = pending ? await pending : [];
  if (waitFailure) throw waitFailure;
  return outcomes;
}

function assertOneWinner(
  outcomes: PromiseSettledResult<unknown>[],
  businessConflictCode: string
): number {
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1, "RACE_EXPECTED_ONE_SUCCESS");
  const loser = outcomes.find((result) => result.status === "rejected");
  assert(loser?.status === "rejected", "RACE_EXPECTED_ONE_CONFLICT");
  const failure = httpFailure(loser.reason);
  assert.equal(failure.status, 409, "RACE_MUST_RETURN_HTTP_CONFLICT");
  assert(
    new Set(["ADMIN_MFA_CONCURRENT_CHANGE", businessConflictCode]).has(failure.code),
    "RACE_UNEXPECTED_CONFLICT_CODE"
  );
  return outcomes.findIndex((result) => result.status === "fulfilled");
}

function httpFailure(error: unknown): { status: unknown; code: string } {
  if (typeof error !== "object" || error === null) return { status: undefined, code: "" };
  const failure = error as { status?: unknown; response?: { code?: unknown } };
  return {
    status: failure.status,
    code: typeof failure.response?.code === "string" ? failure.response.code : ""
  };
}

async function createFixture(client: Client, credentialCount: number): Promise<Fixture> {
  const adminId = randomUUID();
  const username = `mfa_${randomBytes(10).toString("hex")}`;
  await client.query(
    `INSERT INTO "users" (
       "id", "role", "username", "normalized_username", "password_hash", "status", "updated_at"
     ) VALUES ($1, 'ADMIN', $2, $2, 'isolated-concurrency-fixture-not-a-password', 'ACTIVE', clock_timestamp())`,
    [adminId, username]
  );
  const principals: SessionPrincipal[] = [];
  for (let index = 0; index < 2; index += 1) {
    const sessionId = randomUUID();
    const session = await client.query<{ verifiedAt: Date; expiresAt: Date }>(
      `INSERT INTO "auth_sessions" (
         "id", "user_id", "token_hash", "csrf_secret_hash", "session_version",
         "created_at", "expires_at", "admin_mfa_verified_at"
       ) VALUES (
         $1, $2, $3, $4, 1,
         date_trunc('milliseconds', clock_timestamp()) - INTERVAL '1 second',
         clock_timestamp() + INTERVAL '1 hour', date_trunc('milliseconds', clock_timestamp())
       ) RETURNING "admin_mfa_verified_at" AS "verifiedAt", "expires_at" AS "expiresAt"`,
      [sessionId, adminId, randomBytes(32).toString("hex"), randomBytes(32).toString("hex")]
    );
    principals.push({
      id: adminId,
      username,
      role: UserRole.ADMIN,
      status: AccountStatus.ACTIVE,
      sessionId,
      deviceId: null,
      sessionExpiresAt: session.rows[0].expiresAt,
      adminMfaVerified: true,
      adminMfaVerifiedAt: session.rows[0].verifiedAt
    });
  }
  const credentials: string[] = [];
  for (let index = 0; index < credentialCount; index += 1) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO "admin_webauthn_credentials" (
         "id", "admin_user_id", "credential_id", "public_key", "counter", "transports",
         "device_type", "backed_up", "created_at"
       ) VALUES (
         $1, $2, $3, $4, 0, ARRAY['internal'], 'singleDevice', false,
         date_trunc('milliseconds', clock_timestamp()) - INTERVAL '1 second'
       )`,
      [id, adminId, randomBytes(32).toString("base64url"), randomBytes(64)]
    );
    credentials.push(id);
  }
  return { adminId, credentials, principals: [principals[0], principals[1]] };
}

async function assertAuditCount(client: Client, adminId: string, action: string): Promise<void> {
  const audit = await client.query<{ count: string; expectedCount: string }>(
    `SELECT count(*)::text AS "count",
            count(*) FILTER (WHERE "action"::text = $2)::text AS "expectedCount"
       FROM "admin_audit_events" WHERE "actor_admin_id" = $1`,
    [adminId, action]
  );
  assert.equal(audit.rows[0]?.count, "1", "RACE_AUDIT_NOT_EXACTLY_ONCE");
  assert.equal(audit.rows[0]?.expectedCount, "1", "RACE_AUDIT_ACTION_UNEXPECTED");
}

function registrationCryptoDouble(): AdminWebAuthnCrypto {
  return {
    async verifyRegistration(response: { id: string }) {
      return {
        verified: true,
        registrationInfo: {
          userVerified: true,
          credential: {
            id: response.id,
            publicKey: randomBytes(64),
            counter: 0,
            transports: ["internal"]
          },
          credentialDeviceType: "singleDevice",
          credentialBackedUp: false
        }
      };
    }
  } as unknown as AdminWebAuthnCrypto;
}

async function databaseIdentity(client: Client, name: string): Promise<DatabaseIdentity> {
  const result = await client.query<DatabaseIdentity>(
    `SELECT oid::text AS "oid", datdba::text AS "owner" FROM pg_database WHERE datname = $1`,
    [name]
  );
  assert.equal(result.rowCount, 1, "SCRATCH_DATABASE_IDENTITY_MISSING");
  return result.rows[0];
}

async function migrateScratchDatabase(databaseUrl: string): Promise<void> {
  await new Promise<void>((done, reject) => {
    const child = spawn(
      process.execPath,
      [require.resolve("prisma/build/index.js"), "migrate", "deploy", "--config", "prisma.config.ts"],
      {
        cwd: resolve(__dirname, "../.."),
        env: { ...process.env, DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: databaseUrl },
        windowsHide: true,
        stdio: "ignore"
      }
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("SCRATCH_MIGRATION_TIMEOUT"));
    }, 120_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("SCRATCH_MIGRATION_PROCESS_FAILED"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) done();
      else reject(new Error("SCRATCH_MIGRATION_FAILED"));
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

void checkAdminMfaConcurrency().catch((error: unknown) => {
  const candidate = error instanceof Error ? error.message : "UNKNOWN";
  const databaseCode = typeof error === "object" && error !== null && "code" in error
    ? String(error.code) : "";
  const code = /^[A-Z][A-Z0-9_]{0,160}$/.test(candidate) ? candidate
    : /^[A-Z0-9_]{1,40}$/.test(databaseCode) ? databaseCode
    : "UNEXPECTED_CONCURRENCY_CHECK_FAILURE";
  console.error(`[ERROR] Falló la comprobación de concurrencia MFA (${code}).`);
  process.exitCode = 1;
});
