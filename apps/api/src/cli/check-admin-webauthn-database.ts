import "../config/load-env";
import { strict as assert } from "node:assert";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { readDatabaseConfig } from "../config/runtime-config";

const REQUIRED_MIGRATIONS = [
  "20260901010000_admin_webauthn_mfa",
  "20260902000000_admin_passkey_management"
] as const;
let savepointSequence = 0;
type DatabaseFailure = { code?: unknown; message?: unknown };

async function checkAdminWebAuthnDatabase(): Promise<void> {
  const { databaseUrl } = readDatabaseConfig();
  assertLocalDatabase(databaseUrl);
  const client = new Client({
    application_name: "sinochat-admin-webauthn-db-check",
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000
  });
  const suffix = randomBytes(8).toString("hex");
  let transactionStarted = false;

  await client.connect();
  try {
    await assertMigrationApplied(client);
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");

    const adminId = await createUser(client, "ADMIN", `webauthn_admin_${suffix}`);
    const clientId = await createUser(client, "CLIENT", `webauthn_client_${suffix}`);
    const adminSessionId = await createSession(client, adminId);
    const clientSessionId = await createSession(client, clientId);
    await createCredential(client, adminId, randomBytes(24).toString("base64url"));
    await createChallenge(client, adminId, adminSessionId);
    await client.query(
      `INSERT INTO "admin_recovery_codes" ("id", "admin_user_id", "code_hash")
       VALUES ($1, $2, $3)`,
      [randomUUID(), adminId, randomBytes(32).toString("hex")]
    );
    console.log("[OK] Passkey, desafío y recuperación válidos para ADMIN.");

    await expectDatabaseRejection(
      client,
      "WEBAUTHN_NON_ADMIN_CREDENTIAL_ACCEPTED",
      new Set(["23514"]),
      () => createCredential(client, clientId, randomBytes(24).toString("base64url"))
    );
    await expectDatabaseRejection(
      client,
      "WEBAUTHN_NON_ADMIN_MFA_SESSION_ACCEPTED",
      new Set(["23514"]),
      () =>
        client.query(
          `UPDATE "auth_sessions"
              SET "admin_mfa_verified_at" = clock_timestamp()
            WHERE "id" = $1`,
          [clientSessionId]
        )
    );
    console.log("[OK] Un rol no administrativo no puede poseer passkeys ni MFA.");

    await expectDatabaseRejection(
      client,
      "WEBAUTHN_CROSS_SESSION_CHALLENGE_ACCEPTED",
      new Set(["23514"]),
      () => createChallenge(client, adminId, clientSessionId)
    );
    await expectDatabaseRejection(
      client,
      "WEBAUTHN_MULTIPLE_OPEN_CHALLENGES_ACCEPTED",
      new Set(["23505"]),
      () => createChallenge(client, adminId, adminSessionId)
    );
    console.log("[OK] El desafío queda ligado a su sesión y solo hay uno abierto.");

    await expectDatabaseRejection(
      client,
      "WEBAUTHN_LONG_CHALLENGE_ACCEPTED",
      new Set(["23514"]),
      () =>
        client.query(
          `INSERT INTO "admin_webauthn_challenges" (
             "id", "admin_user_id", "session_id", "purpose",
             "challenge_hash", "created_at", "expires_at", "consumed_at"
           ) VALUES (
             $1, $2, $3, 'AUTHENTICATION', $4,
             clock_timestamp(), clock_timestamp() + INTERVAL '11 minutes',
             clock_timestamp()
           )`,
          [randomUUID(), adminId, adminSessionId, randomBytes(32).toString("hex")]
        )
    );
    await expectDatabaseRejection(
      client,
      "WEBAUTHN_PLAINTEXT_RECOVERY_ACCEPTED",
      new Set(["23514"]),
      () =>
        client.query(
          `INSERT INTO "admin_recovery_codes" (
             "id", "admin_user_id", "code_hash"
           ) VALUES ($1, $2, $3)`,
          [randomUUID(), adminId, "SA-PLAINTEXT-NOT-A-HASH"]
        )
    );
    console.log("[OK] Ventanas y hashes inválidos fallan cerrado.");
  } finally {
    try {
      if (transactionStarted) {
        await client.query("ROLLBACK");
        const residue = await client.query<{ count: string }>(
          `SELECT count(*)::text AS "count"
             FROM "users"
            WHERE "username" LIKE 'webauthn\\_%' ESCAPE '\\'`
        );
        assert.equal(residue.rows[0]?.count, "0", "WEBAUTHN_CHECK_LEFT_FIXTURES");
        console.log("[OK] ROLLBACK confirmado: cero fixtures WebAuthn.");
      }
    } finally {
      await client.end();
    }
  }
}

async function assertMigrationApplied(client: Client): Promise<void> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS "count"
       FROM "_prisma_migrations"
      WHERE "migration_name" = ANY($1::text[])
        AND "finished_at" IS NOT NULL
        AND "rolled_back_at" IS NULL`,
    [REQUIRED_MIGRATIONS]
  );
  assert.equal(
    result.rows[0]?.count,
    String(REQUIRED_MIGRATIONS.length),
    "WEBAUTHN_MIGRATION_NOT_APPLIED"
  );
  const auditAction = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_enum AS enum_value
         JOIN pg_type AS enum_type ON enum_type.oid = enum_value.enumtypid
        WHERE enum_type.typname = 'AdminAuditAction'
          AND enum_value.enumlabel = 'ADMIN_PASSKEY_REVOKED'
     ) AS "exists"`
  );
  assert.equal(
    auditAction.rows[0]?.exists,
    true,
    "ADMIN_PASSKEY_REVOCATION_AUDIT_ACTION_MISSING"
  );
  console.log("[OK] Migraciones WebAuthn y gestión de passkeys aplicadas.");
}

async function createUser(
  client: Client,
  role: "ADMIN" | "CLIENT",
  username: string
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO "users" (
       "id", "role", "username", "normalized_username", "password_hash",
       "status", "updated_at"
     ) VALUES ($1, $2::"UserRole", $3, $3, $4, 'ACTIVE', clock_timestamp())`,
    [id, role, username, "webauthn-check-not-a-password"]
  );
  return id;
}

async function createSession(client: Client, userId: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO "auth_sessions" (
       "id", "user_id", "token_hash", "csrf_secret_hash", "session_version",
       "expires_at"
     ) VALUES (
       $1, $2, $3, $4, 1, clock_timestamp() + INTERVAL '1 hour'
     )`,
    [id, userId, randomBytes(32).toString("hex"), randomBytes(32).toString("hex")]
  );
  return id;
}

async function createCredential(
  client: Client,
  adminUserId: string,
  credentialId: string
): Promise<void> {
  await client.query(
    `INSERT INTO "admin_webauthn_credentials" (
       "id", "admin_user_id", "credential_id", "public_key", "counter",
       "transports", "device_type", "backed_up"
     ) VALUES ($1, $2, $3, $4, 0, ARRAY['internal'], 'singleDevice', false)`,
    [randomUUID(), adminUserId, credentialId, randomBytes(64)]
  );
}

async function createChallenge(
  client: Client,
  adminUserId: string,
  sessionId: string
): Promise<void> {
  await client.query(
    `INSERT INTO "admin_webauthn_challenges" (
       "id", "admin_user_id", "session_id", "purpose", "challenge_hash",
       "created_at", "expires_at"
     ) VALUES (
       $1, $2, $3, 'AUTHENTICATION', $4,
       clock_timestamp(), clock_timestamp() + INTERVAL '5 minutes'
     )`,
    [randomUUID(), adminUserId, sessionId, randomBytes(32).toString("hex")]
  );
}

async function expectDatabaseRejection(
  client: Client,
  assertionCode: string,
  expectedSqlStates: ReadonlySet<string>,
  operation: () => Promise<unknown>
): Promise<void> {
  savepointSequence += 1;
  const savepoint = `webauthn_check_${savepointSequence}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let failure: unknown;
  try {
    await operation();
  } catch (error: unknown) {
    failure = error;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  assert(failure, assertionCode);
  const sqlState = (failure as DatabaseFailure).code;
  assert(
    typeof sqlState === "string" && expectedSqlStates.has(sqlState),
    `${assertionCode}_UNEXPECTED_SQLSTATE_${String(sqlState)}`
  );
}

function assertLocalDatabase(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  assert.notEqual(process.env.NODE_ENV, "production", "PRODUCTION_FORBIDDEN");
  assert(
    new Set(["localhost", "127.0.0.1", "[::1]"]).has(parsed.hostname),
    "LOCAL_DATABASE_REQUIRED"
  );
}

void checkAdminWebAuthnDatabase().catch((error: unknown) => {
  const rawCode =
    error instanceof Error && error.message
      ? error.message
      : typeof error === "object" && error !== null && "code" in error
        ? String((error as DatabaseFailure).code)
        : "UNKNOWN";
  const code = rawCode.replace(/[^A-Za-z0-9_]/gu, "_").slice(0, 160);
  console.error(`[ERROR] Falló la comprobación WebAuthn (${code}).`);
  process.exitCode = 1;
});
