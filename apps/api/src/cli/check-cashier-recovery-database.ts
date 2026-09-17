import "../config/load-env";
import { strict as assert } from "node:assert";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { readDatabaseConfig } from "../config/runtime-config";

const REQUIRED_MIGRATION = "20260901000000_cashier_recovery_codes";
let savepointSequence = 0;

type DatabaseFailure = { code?: unknown; message?: unknown };

async function checkCashierRecoveryDatabase(): Promise<void> {
  const { databaseUrl } = readDatabaseConfig();
  assertLocalDatabase(databaseUrl);
  const client = new Client({
    application_name: "sinochat-cashier-recovery-db-check",
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

    const adminId = await createUser(client, "ADMIN", `recovery_admin_${suffix}`);
    const cashierOneId = await createCashier(client, suffix, "1");
    const cashierTwoId = await createCashier(client, suffix, "2");
    const codeOneId = await createRecoveryCode(client, cashierOneId);
    const codeTwoId = await createRecoveryCode(client, cashierTwoId);
    const resetOneId = await createReset(client, cashierOneId, adminId);

    await expectDatabaseRejection(
      client,
      "RECOVERY_MULTIPLE_OPEN_RESET_ACCEPTED",
      new Set(["23505"]),
      () => createReset(client, cashierOneId, adminId)
    );
    console.log("[OK] PostgreSQL admite una sola solicitud abierta por cajero.");

    // Conserva los microsegundos de PostgreSQL sin pasar por un Date de JS.
    await client.query(
      `WITH used_code AS (
         UPDATE "cashier_recovery_codes"
            SET "used_at" = clock_timestamp()
          WHERE "id" = $2
          RETURNING "used_at"
       )
       UPDATE "cashier_password_resets" reset
          SET "consumed_at" = used_code."used_at", "recovery_code_id" = $2
         FROM used_code
        WHERE reset."id" = $1`,
      [resetOneId, codeOneId]
    );

    const resetTwoId = await createReset(client, cashierOneId, adminId);
    await expectDatabaseRejection(
      client,
      "RECOVERY_CROSS_CASHIER_CODE_ACCEPTED",
      new Set(["23503"]),
      () =>
        client.query(
          `UPDATE "cashier_password_resets"
              SET "consumed_at" = clock_timestamp(), "recovery_code_id" = $2
            WHERE "id" = $1`,
          [resetTwoId, codeTwoId]
        )
    );
    console.log("[OK] Un código no puede consumirse para otro cajero.");

    await expectDatabaseRejection(
      client,
      "RECOVERY_CODE_REUSED",
      new Set(["23505"]),
      () =>
        client.query(
          `UPDATE "cashier_password_resets"
              SET "consumed_at" = clock_timestamp(), "recovery_code_id" = $2
            WHERE "id" = $1`,
          [resetTwoId, codeOneId]
        )
    );
    console.log("[OK] Cada código solo puede cerrar una solicitud.");

    await expectDatabaseRejection(
      client,
      "RECOVERY_INVALID_HASH_ACCEPTED",
      new Set(["23514"]),
      () =>
        client.query(
          `INSERT INTO "cashier_recovery_codes" (
             "id", "cashier_user_id", "code_hash", "expires_at"
           ) VALUES ($1, $2, $3, NULL)`,
          [randomUUID(), cashierOneId, "SC-PLAINTEXT-NOT-A-HASH"]
        )
    );
    // Ambas columnas deben recibir el mismo instante para probar duración cero.
    // clock_timestamp() puede avanzar entre evaluaciones dentro de la sentencia.
    await expectDatabaseRejection(
      client,
      "RECOVERY_INVALID_RESET_WINDOW_ACCEPTED",
      new Set(["23514"]),
      () =>
        client.query(
          `INSERT INTO "cashier_password_resets" (
             "id", "cashier_user_id", "initiated_by_admin_user_id",
             "created_at", "expires_at"
           ) VALUES ($1, $2, $3, statement_timestamp(), statement_timestamp())`,
          [randomUUID(), cashierTwoId, adminId]
        )
    );
    console.log("[OK] Hashes y ventanas temporales inválidos fallan cerrado.");

    const stored = await client.query<{
      codeHash: string;
      expiresAt: Date | null;
      resetHours: string;
    }>(
      `SELECT code."code_hash" AS "codeHash",
              code."expires_at" AS "expiresAt",
              extract(epoch FROM (reset."expires_at" - reset."created_at")) / 3600 AS "resetHours"
         FROM "cashier_recovery_codes" code
         JOIN "cashier_password_resets" reset
           ON reset."recovery_code_id" = code."id"
        WHERE code."id" = $1`,
      [codeOneId]
    );
    assert.match(stored.rows[0]?.codeHash ?? "", /^[0-9a-f]{64}$/u);
    assert.equal(stored.rows[0]?.expiresAt, null);
    assert.equal(Number(stored.rows[0]?.resetHours), 24);
    console.log(
      "[OK] Solo queda el hash; el código no vence y la solicitud dura 24 horas."
    );
  } finally {
    try {
      if (transactionStarted) {
        await client.query("ROLLBACK");
        const residue = await client.query<{ count: string }>(
          `SELECT count(*)::text AS "count"
             FROM "users"
            WHERE "username" LIKE 'recovery\\_%' ESCAPE '\\'`
        );
        assert.equal(residue.rows[0]?.count, "0", "RECOVERY_CHECK_LEFT_FIXTURES");
        console.log("[OK] ROLLBACK confirmado: cero fixtures de recuperación.");
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
      WHERE "migration_name" = $1
        AND "finished_at" IS NOT NULL
        AND "rolled_back_at" IS NULL`,
    [REQUIRED_MIGRATION]
  );
  assert.equal(result.rows[0]?.count, "1", "RECOVERY_MIGRATION_NOT_APPLIED");
  console.log("[OK] Migración de recuperación aplicada.");
}

async function createUser(
  client: Client,
  role: "ADMIN" | "CASHIER",
  username: string
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO "users" (
       "id", "role", "username", "normalized_username", "password_hash",
       "status", "updated_at"
     ) VALUES ($1, $2::"UserRole", $3, $3, $4, 'ACTIVE', clock_timestamp())`,
    [id, role, username, "recovery-check-not-a-password"]
  );
  return id;
}

async function createCashier(
  client: Client,
  suffix: string,
  ordinal: string
): Promise<string> {
  const id = await createUser(
    client,
    "CASHIER",
    `recovery_cashier_${ordinal}_${suffix}`
  );
  const email = `recovery-${ordinal}-${suffix}@example.invalid`;
  const phoneSuffix = BigInt(`0x${suffix}`).toString().slice(0, 10).padEnd(10, "0");
  await client.query(
    `INSERT INTO "cashier_profiles" (
       "user_id", "date_of_birth", "declared_adult_at", "email",
       "normalized_email", "phone_e164", "updated_at"
     ) VALUES ($1, DATE '1990-01-01', clock_timestamp(), $2, $2, $3, clock_timestamp())`,
    [id, email, `+54${ordinal}${phoneSuffix}`]
  );
  return id;
}

async function createRecoveryCode(
  client: Client,
  cashierUserId: string
): Promise<string> {
  const id = randomUUID();
  const codeHash = randomBytes(32).toString("hex");
  await client.query(
    `INSERT INTO "cashier_recovery_codes" (
       "id", "cashier_user_id", "code_hash", "expires_at"
     ) VALUES ($1, $2, $3, NULL)`,
    [id, cashierUserId, codeHash]
  );
  return id;
}

async function createReset(
  client: Client,
  cashierUserId: string,
  adminUserId: string
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO "cashier_password_resets" (
       "id", "cashier_user_id", "initiated_by_admin_user_id",
       "created_at", "expires_at"
     ) VALUES ($1, $2, $3, statement_timestamp(), statement_timestamp() + INTERVAL '24 hours')`,
    [id, cashierUserId, adminUserId]
  );
  return id;
}

async function expectDatabaseRejection(
  client: Client,
  assertionCode: string,
  expectedSqlStates: ReadonlySet<string>,
  operation: () => Promise<unknown>
): Promise<void> {
  savepointSequence += 1;
  const savepoint = `recovery_check_${savepointSequence}`;
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

void checkCashierRecoveryDatabase().catch((error: unknown) => {
  const rawCode =
    error instanceof Error && error.message
      ? error.message
      : typeof error === "object" && error !== null && "code" in error
        ? String((error as DatabaseFailure).code)
        : "UNKNOWN";
  const code = rawCode.replace(/[^A-Za-z0-9_]/gu, "_").slice(0, 160);
  console.error(`[ERROR] Falló la comprobación de recuperación (${code}).`);
  process.exitCode = 1;
});
