import "../config/load-env";
import { strict as assert } from "node:assert";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { readDatabaseConfig } from "../config/runtime-config";

const REQUIRED_MIGRATIONS = [
  "20260827000000_matrix_e2ee_transport",
  "20260827001000_owned_device_reference_record_fix",
  "20260827002000_matrix_pre_key_record_fix",
  "20260827003000_matrix_claim_selection_hardening",
  "20260827004000_matrix_sync_chain_hardening",
  "20260827005000_matrix_device_idempotency_and_sync_lineage",
  "20260827006000_matrix_sync_replay_window",
  "20260827007000_matrix_sync_crypto_snapshot",
  "20260828000000_matrix_registration_replay",
  "20260830000000_message_olm_envelope_hardening",
  "20260831001000_message_megolm_envelope_profile"
] as const;
const SIGNED_CURVE_ALGORITHM = "signed_curve25519";
const OLM_ALGORITHM = "m.olm.v1.curve25519-aes-sha2";

type DatabaseFailure = {
  code?: unknown;
  message?: unknown;
};

let savepointSequence = 0;

async function checkMatrixDatabase(): Promise<void> {
  const { databaseUrl } = readDatabaseConfig();
  assertLocalDatabase(databaseUrl);

  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    application_name: "sinochat-matrix-db-check"
  });

  await client.connect();
  let transactionStarted = false;

  try {
    await assertMigrationApplied(client);
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await checkMessageEnvelopeHardening(client);

    const fixture = await createPublishedMatrixDevice(client);
    await checkOwnedDeviceReferences(client, fixture);
    await checkDeviceScopedToDeviceIdempotency(client, fixture);
    await checkCommitOrderedCursors(client, fixture.userId, fixture.deviceId);
    await checkSyncChain(client, fixture.deviceId);
    await checkKeyTombstones(client, fixture);
    await checkKeyClaimSelection(client, fixture.deviceId);
    await checkExactRetention(client, fixture);

    console.log(
      "[OK] Invariantes Matrix verificadas en PostgreSQL; los datos de prueba se revierten."
    );
  } finally {
    try {
      if (transactionStarted) {
        await client.query("ROLLBACK");
        const residue = await client.query<{ count: string }>(
          `SELECT count(*)::text AS "count"
             FROM "users"
            WHERE "username" LIKE 'matrix\\_db\\_check\\_%' ESCAPE '\\'
               OR "username" LIKE 'matrix\\_owner\\_check\\_%' ESCAPE '\\'`
        );
        assert.equal(
          residue.rows[0]?.count,
          "0",
          "MATRIX_CHECK_LEFT_FIXTURES"
        );
        console.log("[OK] ROLLBACK confirmado: cero fixtures Matrix persistentes.");
      }
    } finally {
      await client.end();
    }
  }
}

async function checkMessageEnvelopeHardening(client: Client): Promise<void> {
  const constraintNames = [
    "message_envelopes_protocol_version_check",
    "message_envelopes_cipher_suite_check",
    "attachments_cipher_suite_check"
  ] as const;
  const result = await client.query<{
    definition: string;
    name: string;
  }>(
    `SELECT conname AS "name", pg_get_constraintdef(oid) AS "definition"
       FROM pg_constraint
      WHERE conname = ANY($1::text[])
      ORDER BY conname`,
    [constraintNames]
  );
  assert.deepEqual(
    new Set(result.rows.map((row) => row.name)),
    new Set(constraintNames),
    "MESSAGE_ENVELOPE_CONSTRAINTS_MISSING"
  );
  const definitions = new Map(
    result.rows.map((row) => [row.name, row.definition])
  );
  assert.match(
    definitions.get("message_envelopes_protocol_version_check") ?? "",
    /protocol_version[^]*matrix-megolm-v1/,
    "MESSAGE_PROTOCOL_CONSTRAINT_INVALID"
  );
  assert.match(
    definitions.get("message_envelopes_cipher_suite_check") ?? "",
    /cipher_suite[^]*m\.megolm\.v1\.aes-sha2/,
    "MESSAGE_CIPHER_CONSTRAINT_INVALID"
  );
  assert.match(
    definitions.get("attachments_cipher_suite_check") ?? "",
    /cipher_suite[^]*A256CTR/,
    "ATTACHMENT_CIPHER_CONSTRAINT_INVALID"
  );
  console.log(
    "[OK] MessageEnvelope Megolm y adjuntos rechazan perfiles alternativos."
  );
}

async function assertMigrationApplied(client: Client): Promise<void> {
  const result = await client.query<{ migrationName: string }>(
    `SELECT "migration_name" AS "migrationName"
       FROM "_prisma_migrations"
      WHERE "migration_name" = ANY($1::text[])
        AND "finished_at" IS NOT NULL
        AND "rolled_back_at" IS NULL`,
    [REQUIRED_MIGRATIONS]
  );

  assert.deepEqual(
    new Set(result.rows.map((row) => row.migrationName)),
    new Set(REQUIRED_MIGRATIONS),
    "MATRIX_MIGRATIONS_NOT_APPLIED"
  );
  console.log("[OK] Migraciones Matrix y hardening forward aplicados.");
}

async function createPublishedMatrixDevice(client: Client): Promise<{
  userId: string;
  deviceId: string;
  sessionId: string;
  matrixUserId: string;
  matrixDeviceId: string;
  deviceCurveKey: string;
}> {
  const userId = randomUUID();
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const matrixUserId = `@u${userId.replaceAll("-", "")}:sinochat.invalid`;
  const matrixDeviceId = `D${deviceId.replaceAll("-", "").toUpperCase()}`;
  const deviceCurveKey = matrixCurveKey();
  const deviceSigningKey = matrixCurveKey();
  const deviceKeys = {
    algorithms: [OLM_ALGORITHM, "m.megolm.v1.aes-sha2"],
    device_id: matrixDeviceId,
    keys: {
      [`curve25519:${matrixDeviceId}`]: deviceCurveKey,
      [`ed25519:${matrixDeviceId}`]: deviceSigningKey
    },
    signatures: {
      [matrixUserId]: {
        [`ed25519:${matrixDeviceId}`]: randomBytes(64)
          .toString("base64")
          .replace(/=+$/u, "")
      }
    },
    user_id: matrixUserId
  };

  await client.query(
    `INSERT INTO "users" (
       "id", "role", "username", "normalized_username", "password_hash",
       "status", "updated_at"
     ) VALUES ($1, 'CLIENT', $2, $2, $3, 'ACTIVE', clock_timestamp())`,
    [userId, `matrix_db_check_${suffix}`, "matrix-db-check-not-a-password"]
  );
  console.log("[OK] Fixture Matrix: usuario local creado.");
  await client.query(
    `INSERT INTO "devices" (
       "id", "user_id", "binding_secret_hash", "protocol_version", "status"
     ) VALUES ($1, $2, $3, 'matrix-olm-v1', 'ACTIVE')`,
    [deviceId, userId, sha256(`binding:${suffix}`)]
  );
  console.log("[OK] Fixture Matrix: dispositivo base creado.");
  await client.query(
    `INSERT INTO "matrix_device_list_states" (
       "user_id", "matrix_user_id"
     ) VALUES ($1, $2)`,
    [userId, matrixUserId]
  );
  console.log("[OK] Fixture Matrix: estado de lista creado.");
  await client.query(
    `INSERT INTO "matrix_device_keys" (
       "device_id", "user_id", "matrix_user_id", "matrix_device_id",
       "curve25519_key", "ed25519_key", "device_keys", "canonical_sha256"
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      deviceId,
      userId,
      matrixUserId,
      matrixDeviceId,
      deviceCurveKey,
      deviceSigningKey,
      JSON.stringify(deviceKeys),
      sha256(JSON.stringify(deviceKeys))
    ]
  );
  console.log("[OK] Fixture Matrix: claves de dispositivo publicadas.");
  await client.query(
    `INSERT INTO "matrix_to_device_cursors" ("device_id") VALUES ($1)`,
    [deviceId]
  );
  console.log("[OK] Fixture Matrix: cursor de recepcion creado.");
  await client.query(
    `INSERT INTO "auth_sessions" (
       "id", "user_id", "device_id", "token_hash", "csrf_secret_hash",
       "session_version", "expires_at"
     ) VALUES (
       $1, $2, $3, $4, $5, 1, clock_timestamp() + INTERVAL '1 hour'
     )`,
    [
      sessionId,
      userId,
      deviceId,
      sha256(`token:${suffix}`),
      sha256(`csrf:${suffix}`)
    ]
  );
  console.log("[OK] Fixture Matrix: sesion vinculada creada.");

  return {
    userId,
    deviceId,
    sessionId,
    matrixUserId,
    matrixDeviceId,
    deviceCurveKey
  };
}

async function checkOwnedDeviceReferences(
  client: Client,
  fixture: { userId: string; deviceId: string }
): Promise<void> {
  const otherUserId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  await client.query(
    `INSERT INTO "users" (
       "id", "role", "username", "normalized_username", "password_hash",
       "status", "updated_at"
     ) VALUES ($1, 'CLIENT', $2, $2, $3, 'ACTIVE', clock_timestamp())`,
    [otherUserId, `matrix_owner_check_${suffix}`, "matrix-db-check-not-a-password"]
  );

  await expectDatabaseRejection(
    client,
    "FOREIGN_DEVICE_SESSION_ACCEPTED",
    "active device must belong to the same user",
    () =>
      client.query(
        `INSERT INTO "auth_sessions" (
           "id", "user_id", "device_id", "token_hash", "csrf_secret_hash",
           "session_version", "expires_at"
         ) VALUES (
           $1, $2, $3, $4, $5, 1, clock_timestamp() + INTERVAL '1 hour'
         )`,
        [
          randomUUID(),
          otherUserId,
          fixture.deviceId,
          sha256(`foreign-token:${suffix}`),
          sha256(`foreign-csrf:${suffix}`)
        ]
      )
  );
  await expectDatabaseRejection(
    client,
    "EXPIRED_BOUND_SESSION_ACCEPTED",
    "only a current session may be linked",
    () =>
      client.query(
        `INSERT INTO "auth_sessions" (
           "id", "user_id", "device_id", "token_hash", "csrf_secret_hash",
           "session_version", "expires_at"
         ) VALUES (
           $1, $2, $3, $4, $5, 1, clock_timestamp() - INTERVAL '1 second'
         )`,
        [
          randomUUID(),
          fixture.userId,
          fixture.deviceId,
          sha256(`expired-token:${suffix}`),
          sha256(`expired-csrf:${suffix}`)
        ]
      )
  );

  await insertRecoveryBundle(client, fixture.userId, fixture.deviceId, 1);
  await expectDatabaseRejection(
    client,
    "FOREIGN_DEVICE_RECOVERY_BUNDLE_ACCEPTED",
    "active device must belong to the same user",
    () => insertRecoveryBundle(client, otherUserId, fixture.deviceId, 1)
  );

  console.log(
    "[OK] Sesiones y bundles solo aceptan dispositivos propios; una sesion vinculada debe estar vigente."
  );
}

async function checkDeviceScopedToDeviceIdempotency(
  client: Client,
  fixture: {
    userId: string;
    deviceId: string;
    sessionId: string;
  }
): Promise<void> {
  const secondSessionId = randomUUID();
  const suffix = randomUUID();
  await client.query(
    `INSERT INTO "auth_sessions" (
       "id", "user_id", "device_id", "token_hash", "csrf_secret_hash",
       "session_version", "expires_at"
     ) VALUES (
       $1, $2, $3, $4, $5, 1, clock_timestamp() + INTERVAL '1 hour'
     )`,
    [
      secondSessionId,
      fixture.userId,
      fixture.deviceId,
      sha256(`second-token:${suffix}`),
      sha256(`second-csrf:${suffix}`)
    ]
  );
  const transactionId = `device-scope-${suffix}`;
  await client.query(
    `INSERT INTO "matrix_to_device_transactions" (
       "id", "sender_session_id", "sender_device_id", "transaction_id",
       "event_type", "request_sha256"
     ) VALUES ($1, $2, $3, $4, 'm.room.encrypted', $5)`,
    [
      randomUUID(),
      fixture.sessionId,
      fixture.deviceId,
      transactionId,
      sha256("same-request")
    ]
  );
  await expectDatabaseRejection(
    client,
    "TO_DEVICE_TXN_REPLAYED_AFTER_SESSION_RENEWAL",
    "matrix_to_device_transactions_device_endpoint_txn_key",
    () =>
      client.query(
        `INSERT INTO "matrix_to_device_transactions" (
           "id", "sender_session_id", "sender_device_id", "transaction_id",
           "event_type", "request_sha256"
         ) VALUES ($1, $2, $3, $4, 'm.room.encrypted', $5)`,
        [
          randomUUID(),
          secondSessionId,
          fixture.deviceId,
          transactionId,
          sha256("same-request")
        ]
      )
  );
  await client.query(
    `INSERT INTO "matrix_to_device_transactions" (
       "id", "sender_session_id", "sender_device_id", "transaction_id",
       "event_type", "request_sha256"
     ) VALUES ($1, $2, $3, $4, 'm.secret.request', $5)`,
    [
      randomUUID(),
      secondSessionId,
      fixture.deviceId,
      transactionId,
      sha256("different-endpoint")
    ]
  );
  console.log(
    "[OK] sendToDevice conserva idempotencia por dispositivo y eventType al renovar sesion."
  );
}

async function checkCommitOrderedCursors(
  client: Client,
  userId: string,
  deviceId: string
): Promise<void> {
  const startingStream = await client.query<{ position: string }>(
    `SELECT "position"::text AS "position"
       FROM "matrix_device_list_stream"
      WHERE "id" = 1
      FOR UPDATE`
  );
  const initialPosition = BigInt(startingStream.rows[0]?.position ?? "-1");
  assert(initialPosition >= 0n, "MATRIX_STREAM_SINGLETON_MISSING");

  const advancedStream = await client.query<{ position: string }>(
    `UPDATE "matrix_device_list_stream"
        SET "position" = "position" + 1
      WHERE "id" = 1
      RETURNING "position"::text AS "position"`
  );
  assert.equal(
    BigInt(advancedStream.rows[0]?.position ?? "-1"),
    initialPosition + 1n
  );
  await expectDatabaseRejection(
    client,
    "DEVICE_LIST_STREAM_GAP_ACCEPTED",
    "advances exactly one position",
    () =>
      client.query(
        `UPDATE "matrix_device_list_stream"
            SET "position" = "position" + 2
          WHERE "id" = 1`
      )
  );

  const advancedState = await client.query<{ version: string }>(
    `UPDATE "matrix_device_list_states"
        SET "version" = "version" + 1
      WHERE "user_id" = $1
      RETURNING "version"::text AS "version"`,
    [userId]
  );
  assert.equal(advancedState.rows[0]?.version, "1");
  await expectDatabaseRejection(
    client,
    "DEVICE_LIST_VERSION_GAP_ACCEPTED",
    "version must advance exactly once",
    () =>
      client.query(
        `UPDATE "matrix_device_list_states"
            SET "version" = "version" + 2
          WHERE "user_id" = $1`,
        [userId]
      )
  );

  const advancedRecipient = await client.query<{ latestSequence: string }>(
    `UPDATE "matrix_to_device_cursors"
        SET "latest_sequence" = "latest_sequence" + 1
      WHERE "device_id" = $1
      RETURNING "latest_sequence"::text AS "latestSequence"`,
    [deviceId]
  );
  assert.equal(advancedRecipient.rows[0]?.latestSequence, "1");
  await expectDatabaseRejection(
    client,
    "TO_DEVICE_CURSOR_GAP_ACCEPTED",
    "sequence advances exactly once",
    () =>
      client.query(
        `UPDATE "matrix_to_device_cursors"
            SET "latest_sequence" = "latest_sequence" + 2
          WHERE "device_id" = $1`,
        [deviceId]
      )
  );

  console.log(
    "[OK] Cursores global, por usuario y por dispositivo solo avanzan +1."
  );
}

async function checkSyncChain(
  client: Client,
  deviceId: string
): Promise<void> {
  await expectDatabaseRejection(
    client,
    "SYNC_TOKEN_OUTLIVES_RETENTION",
    "cannot outlive its replayable 48-hour event range",
    () =>
      insertSyncBatch(
        client,
        deviceId,
        null,
        0n,
        1n,
        0n,
        1n,
        "48 hours 1 microsecond"
      )
  );
  await expectDatabaseRejection(
    client,
    "NONZERO_INITIAL_SYNC_ACCEPTED",
    "initial Matrix sync batch must start at zero",
    () => insertSyncBatch(client, deviceId, null, 1n, 1n, 0n, 0n)
  );

  const invalidParentId = await insertSyncBatch(
    client,
    deviceId,
    null,
    0n,
    1n,
    0n,
    1n
  );
  await expectDatabaseRejection(
    client,
    "SYNC_RANGE_GAP_ACCEPTED",
    "current unacknowledged predecessor range",
    () =>
      insertSyncBatch(
        client,
        deviceId,
        invalidParentId,
        0n,
        1n,
        1n,
        1n
      )
  );
  await client.query(
    `DELETE FROM "matrix_to_device_sync_batches" WHERE "id" = $1`,
    [invalidParentId]
  );

  const parentId = await insertSyncBatch(
    client,
    deviceId,
    null,
    0n,
    1n,
    0n,
    1n
  );
  const childId = await insertSyncBatch(
    client,
    deviceId,
    parentId,
    1n,
    1n,
    1n,
    1n
  );
  await expectDatabaseRejection(
    client,
    "SYNC_PREDECESSOR_FORK_ACCEPTED",
    "matrix_to_device_sync_batches_previous_key",
    () =>
      insertSyncBatch(
        client,
        deviceId,
        parentId,
        1n,
        1n,
        1n,
        1n
      )
  );
  await expectDatabaseRejection(
    client,
    "SYNC_RANGE_MUTATION_ACCEPTED",
    "identity, lineage and acknowledgement are immutable",
    () =>
      client.query(
        `UPDATE "matrix_to_device_sync_batches"
            SET "up_to_sequence" = "up_to_sequence" + 1
          WHERE "id" = $1`,
        [childId]
      )
  );
  await expectDatabaseRejection(
    client,
    "SYNC_CRYPTO_SNAPSHOT_MUTATION_ACCEPTED",
    "sync cryptographic snapshot is immutable",
    () =>
      client.query(
        `UPDATE "matrix_to_device_sync_batches"
            SET "one_time_key_count" = "one_time_key_count" + 1
          WHERE "id" = $1`,
        [childId]
      )
  );
  await client.query(
    `UPDATE "matrix_to_device_sync_batches"
        SET "acknowledged_at" = clock_timestamp()
      WHERE "id" = $1`,
    [parentId]
  );
  await client.query(
    `DELETE FROM "matrix_to_device_sync_batches" WHERE "id" = $1`,
    [parentId]
  );
  const child = await client.query<{
    previousBatchId: string | null;
    fromSequence: string;
    fromDeviceListPosition: string;
  }>(
    `SELECT "previous_batch_id" AS "previousBatchId",
            "from_sequence"::text AS "fromSequence",
            "from_device_list_position"::text AS "fromDeviceListPosition"
       FROM "matrix_to_device_sync_batches"
      WHERE "id" = $1`,
    [childId]
  );
  assert.equal(child.rows[0]?.previousBatchId, parentId);
  assert.equal(child.rows[0]?.fromSequence, "1");
  assert.equal(child.rows[0]?.fromDeviceListPosition, "1");
  console.log(
    "[OK] Sync conserva rangos y linaje logico, evita forks y sobrevive a la purga del predecesor."
  );
}

async function insertSyncBatch(
  client: Client,
  deviceId: string,
  previousBatchId: string | null,
  fromSequence: bigint,
  upToSequence: bigint,
  fromDeviceListPosition: bigint,
  deviceListPosition: bigint,
  expiresAfter = "1 hour"
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `WITH stamp AS (SELECT clock_timestamp() AS created_at)
     INSERT INTO "matrix_to_device_sync_batches" (
       "id", "device_id", "previous_batch_id", "token_hash",
       "from_sequence", "up_to_sequence", "from_device_list_position",
       "device_list_position", "created_at", "expires_at"
     )
     SELECT $1, $2, $3, $4, $5, $6, $7, $8,
            stamp.created_at, stamp.created_at + $9::interval
       FROM stamp`,
    [
      id,
      deviceId,
      previousBatchId,
      sha256(`sync:${id}`),
      fromSequence.toString(),
      upToSequence.toString(),
      fromDeviceListPosition.toString(),
      deviceListPosition.toString(),
      expiresAfter
    ]
  );
  return id;
}

async function checkKeyClaimSelection(
  client: Client,
  requesterDeviceId: string
): Promise<void> {
  const relationship = await createClaimRelationship(client, requesterDeviceId);
  const claimRequestId = await insertClaimRequest(
    client,
    requesterDeviceId,
    relationship.conversationId
  );

  const olderOneTimeKeyId = randomUUID();
  await insertOneTimeKey(
    client,
    relationship.recipientDeviceId,
    "claim-older-batch",
    matrixCurveKey(),
    olderOneTimeKeyId
  );
  const newerOneTimeKeyId = randomUUID();
  await insertOneTimeKey(
    client,
    relationship.recipientDeviceId,
    "claim-newer-batch",
    matrixCurveKey(),
    newerOneTimeKeyId,
    olderOneTimeKeyId
  );
  const fallbackKeyId = await insertFallbackKey(
    client,
    relationship.recipientDeviceId,
    "claim-fallback",
    matrixCurveKey()
  );
  await client.query(
    `INSERT INTO "matrix_fallback_key_slots" (
       "device_id", "algorithm", "current_fallback_key_id"
     ) VALUES ($1, $2, $3)`,
    [relationship.recipientDeviceId, SIGNED_CURVE_ALGORITHM, fallbackKeyId]
  );

  await expectDatabaseRejection(
    client,
    "FALLBACK_CLAIM_WITH_OTK_AVAILABLE_ACCEPTED",
    "fallback cannot be claimed while a one-time key is available",
    () =>
      claimFallbackKey(
        client,
        claimRequestId,
        relationship.recipientDeviceId,
        fallbackKeyId
      )
  );
  await expectDatabaseRejection(
    client,
    "NEWER_OTK_BATCH_CLAIMED_FIRST",
    "oldest uploaded batch",
    () =>
      claimOneTimeKey(
        client,
        claimRequestId,
        relationship.recipientDeviceId,
        newerOneTimeKeyId
      )
  );

  await claimOneTimeKey(
    client,
    claimRequestId,
    relationship.recipientDeviceId,
    olderOneTimeKeyId
  );
  const newerClaimRequestId = await insertClaimRequest(
    client,
    requesterDeviceId,
    relationship.conversationId
  );
  await claimOneTimeKey(
    client,
    newerClaimRequestId,
    relationship.recipientDeviceId,
    newerOneTimeKeyId
  );
  const fallbackClaimRequestId = await insertClaimRequest(
    client,
    requesterDeviceId,
    relationship.conversationId
  );
  await claimFallbackKey(
    client,
    fallbackClaimRequestId,
    relationship.recipientDeviceId,
    fallbackKeyId
  );
  const fallbackReplayRequestId = await insertClaimRequest(
    client,
    requesterDeviceId,
    relationship.conversationId
  );
  await reuseFallbackKey(
    client,
    fallbackReplayRequestId,
    relationship.recipientDeviceId,
    fallbackKeyId
  );
  const claimState = await client.query<{
    olderClaimed: boolean;
    newerClaimed: boolean;
    fallbackClaimed: boolean;
    fallbackResultCount: string;
  }>(
    `SELECT older."claimed_at" IS NOT NULL AS "olderClaimed",
            newer."claimed_at" IS NOT NULL AS "newerClaimed",
            fallback."first_claimed_at" IS NOT NULL AS "fallbackClaimed",
            (
              SELECT count(*)::text
                FROM "matrix_key_claim_results" result
               WHERE result."fallback_key_id" = fallback."id"
            ) AS "fallbackResultCount"
       FROM "matrix_one_time_keys" older
       JOIN "matrix_one_time_keys" newer ON newer."id" = $2
       JOIN "matrix_fallback_keys" fallback ON fallback."id" = $3
      WHERE older."id" = $1`,
    [olderOneTimeKeyId, newerOneTimeKeyId, fallbackKeyId]
  );
  assert.equal(claimState.rows[0]?.olderClaimed, true);
  assert.equal(claimState.rows[0]?.newerClaimed, true);
  assert.equal(claimState.rows[0]?.fallbackClaimed, true);
  assert.equal(claimState.rows[0]?.fallbackResultCount, "2");
  console.log(
    "[OK] keys/claim agota OTK por antiguedad antes de fallback y permite reutilizar la fallback vigente."
  );
}

async function insertClaimRequest(
  client: Client,
  requesterDeviceId: string,
  conversationId: string
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO "matrix_key_claim_requests" (
       "id", "requester_device_id", "conversation_id", "request_id",
       "request_sha256"
     ) VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      requesterDeviceId,
      conversationId,
      `db-check-${randomUUID()}`,
      sha256(`claim:${id}`)
    ]
  );
  return id;
}

async function createClaimRelationship(
  client: Client,
  requesterDeviceId: string
): Promise<{ conversationId: string; recipientDeviceId: string }> {
  const requester = await client.query<{ userId: string }>(
    `SELECT "user_id" AS "userId" FROM "devices" WHERE "id" = $1`,
    [requesterDeviceId]
  );
  const clientUserId = requester.rows[0]?.userId;
  assert(clientUserId, "REQUESTER_USER_NOT_FOUND");

  const adminUserId = randomUUID();
  const cashierUserId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  await client.query(
    `INSERT INTO "users" (
       "id", "role", "username", "normalized_username", "password_hash",
       "status", "updated_at"
     ) VALUES
       ($1, 'ADMIN', $2, $2, $3, 'ACTIVE', clock_timestamp()),
       ($4, 'CASHIER', $5, $5, $3, 'ACTIVE', clock_timestamp())`,
    [
      adminUserId,
      `matrix_admin_check_${suffix}`,
      "matrix-db-check-not-a-password",
      cashierUserId,
      `matrix_cashier_check_${suffix}`
    ]
  );
  console.log("[OK] Fixture claim: cuentas administrativa y cajero creadas.");
  await client.query(
    `INSERT INTO "client_profiles" (
       "user_id", "date_of_birth", "declared_adult_at", "updated_at"
     ) VALUES ($1, DATE '1990-01-01', clock_timestamp(), clock_timestamp())`,
    [clientUserId]
  );
  await client.query(
    `INSERT INTO "cashier_profiles" (
       "user_id", "date_of_birth", "declared_adult_at", "email",
       "normalized_email", "phone_e164", "email_verified_at",
       "phone_verified_at", "approval_status", "approved_at",
       "approved_by_admin_id", "updated_at"
     ) VALUES (
       $1, DATE '1990-01-01', clock_timestamp(), $2, $2, $3,
       clock_timestamp(), clock_timestamp(), 'APPROVED', clock_timestamp(),
       $4, clock_timestamp()
     )`,
    [
      cashierUserId,
      `matrix-${suffix}@sinochat.invalid`,
      `+54911${numericSuffix()}`,
      adminUserId
    ]
  );
  console.log("[OK] Fixture claim: perfiles de cliente y cajero creados.");
  await client.query(
    `INSERT INTO "cashier_subscriptions" (
       "id", "cashier_user_id", "status", "starts_at",
       "managed_by_admin_user_id", "updated_at"
     ) VALUES (
       $1, $2, 'ACTIVE', clock_timestamp() - INTERVAL '1 day', $3,
       clock_timestamp()
     )`,
    [randomUUID(), cashierUserId, adminUserId]
  );
  console.log("[OK] Fixture claim: suscripcion activa creada.");

  const invitationId = randomUUID();
  await client.query(
    `INSERT INTO "cashier_invitations" (
       "id", "cashier_user_id", "code_lookup_hash", "code_ciphertext",
       "code_nonce", "encryption_key_version", "cipher_format_version"
     ) VALUES ($1, $2, $3, $4, $5, 1, 1)`,
    [
      invitationId,
      cashierUserId,
      sha256(`invitation:${suffix}`),
      randomBytes(32),
      randomBytes(12)
    ]
  );
  console.log("[OK] Fixture claim: invitacion de asignacion creada.");
  const assignmentId = randomUUID();
  const conversationId = randomUUID();
  await client.query(
    `INSERT INTO "assignments" (
       "id", "client_user_id", "cashier_user_id", "invitation_id",
       "start_reason"
     ) VALUES ($1, $2, $3, $4, 'INVITATION')`,
    [assignmentId, clientUserId, cashierUserId, invitationId]
  );
  await client.query(
    `INSERT INTO "conversations" ("id", "assignment_id", "status")
     VALUES ($1, $2, 'ACTIVE')`,
    [conversationId, assignmentId]
  );
  console.log("[OK] Fixture claim: asignacion y conversacion creadas.");
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  await client.query("SET CONSTRAINTS ALL DEFERRED");
  console.log("[OK] Fixture claim: constraints diferidas verificadas.");

  const recipientDeviceId = await publishMatrixDeviceForUser(
    client,
    cashierUserId
  );
  console.log("[OK] Fixture claim: dispositivo receptor publicado.");
  return { conversationId, recipientDeviceId };
}

async function publishMatrixDeviceForUser(
  client: Client,
  userId: string
): Promise<string> {
  const deviceId = randomUUID();
  const matrixUserId = `@u${userId.replaceAll("-", "")}:sinochat.invalid`;
  const matrixDeviceId = `D${deviceId.replaceAll("-", "").toUpperCase()}`;
  const deviceCurveKey = matrixCurveKey();
  const deviceSigningKey = matrixCurveKey();
  const deviceKeys = {
    algorithms: [OLM_ALGORITHM, "m.megolm.v1.aes-sha2"],
    device_id: matrixDeviceId,
    keys: {
      [`curve25519:${matrixDeviceId}`]: deviceCurveKey,
      [`ed25519:${matrixDeviceId}`]: deviceSigningKey
    },
    signatures: {
      [matrixUserId]: {
        [`ed25519:${matrixDeviceId}`]: randomBytes(64)
          .toString("base64")
          .replace(/=+$/u, "")
      }
    },
    user_id: matrixUserId
  };
  await client.query(
    `INSERT INTO "devices" (
       "id", "user_id", "binding_secret_hash", "protocol_version", "status"
     ) VALUES ($1, $2, $3, 'matrix-olm-v1', 'ACTIVE')`,
    [deviceId, userId, sha256(`binding:${deviceId}`)]
  );
  await client.query(
    `INSERT INTO "matrix_device_list_states" (
       "user_id", "matrix_user_id"
     ) VALUES ($1, $2)`,
    [userId, matrixUserId]
  );
  await client.query(
    `INSERT INTO "matrix_device_keys" (
       "device_id", "user_id", "matrix_user_id", "matrix_device_id",
       "curve25519_key", "ed25519_key", "device_keys", "canonical_sha256"
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      deviceId,
      userId,
      matrixUserId,
      matrixDeviceId,
      deviceCurveKey,
      deviceSigningKey,
      JSON.stringify(deviceKeys),
      sha256(JSON.stringify(deviceKeys))
    ]
  );
  return deviceId;
}

async function checkKeyTombstones(
  client: Client,
  fixture: {
    deviceId: string;
    deviceCurveKey: string;
  }
): Promise<void> {
  await expectDatabaseRejection(
    client,
    "DEVICE_KEY_MUTATION_ACCEPTED",
    "device keys are immutable",
    () =>
      client.query(
        `UPDATE "matrix_device_keys"
            SET "canonical_sha256" = $2
          WHERE "device_id" = $1`,
        [fixture.deviceId, sha256("mutated-device-key")]
      )
  );
  await expectDatabaseRejection(
    client,
    "DEVICE_CURVE_KEY_REUSED_AS_OTK",
    "cannot be reused",
    () =>
      insertOneTimeKey(
        client,
        fixture.deviceId,
        "device-key-reuse",
        fixture.deviceCurveKey
      )
  );

  const oneTimeKeyId = randomUUID();
  const oneTimeCurveKey = matrixCurveKey();
  await insertOneTimeKey(
    client,
    fixture.deviceId,
    "otk-tombstone",
    oneTimeCurveKey,
    oneTimeKeyId
  );
  await client.query(
    `UPDATE "matrix_one_time_keys"
        SET "claimed_at" = clock_timestamp()
      WHERE "id" = $1`,
    [oneTimeKeyId]
  );
  await expectDatabaseRejection(
    client,
    "ONE_TIME_KEY_SECOND_CLAIM_ACCEPTED",
    "claim transition are immutable",
    () =>
      client.query(
        `UPDATE "matrix_one_time_keys"
            SET "claimed_at" = "claimed_at" + INTERVAL '1 microsecond'
          WHERE "id" = $1`,
        [oneTimeKeyId]
      )
  );
  await expectDatabaseRejection(
    client,
    "ONE_TIME_KEY_TOMBSTONE_DELETED",
    "tombstones cannot be deleted",
    () =>
      client.query(`DELETE FROM "matrix_one_time_keys" WHERE "id" = $1`, [
        oneTimeKeyId
      ])
  );
  await expectDatabaseRejection(
    client,
    "ONE_TIME_KEY_ID_REUSED_AS_FALLBACK",
    "cannot be reused",
    () =>
      insertFallbackKey(
        client,
        fixture.deviceId,
        "otk-tombstone",
        matrixCurveKey()
      )
  );
  await expectDatabaseRejection(
    client,
    "ONE_TIME_CURVE_KEY_REUSED_AS_FALLBACK",
    "cannot be reused",
    () =>
      insertFallbackKey(
        client,
        fixture.deviceId,
        "fallback-curve-reuse",
        oneTimeCurveKey
      )
  );

  const firstFallbackId = await insertFallbackKey(
    client,
    fixture.deviceId,
    "fallback-current-a",
    matrixCurveKey()
  );
  await client.query(
    `INSERT INTO "matrix_fallback_key_slots" (
       "device_id", "algorithm", "current_fallback_key_id"
     ) VALUES ($1, $2, $3)`,
    [fixture.deviceId, SIGNED_CURVE_ALGORITHM, firstFallbackId]
  );
  await client.query(
    `UPDATE "matrix_fallback_keys"
        SET "first_claimed_at" = clock_timestamp()
      WHERE "id" = $1`,
    [firstFallbackId]
  );
  await expectDatabaseRejection(
    client,
    "FALLBACK_SECOND_FIRST_CLAIM_ACCEPTED",
    "claim transition are immutable",
    () =>
      client.query(
        `UPDATE "matrix_fallback_keys"
            SET "first_claimed_at" = "first_claimed_at" + INTERVAL '1 microsecond'
          WHERE "id" = $1`,
        [firstFallbackId]
      )
  );

  const secondFallbackId = await insertFallbackKey(
    client,
    fixture.deviceId,
    "fallback-current-b",
    matrixCurveKey(),
    undefined,
    firstFallbackId
  );
  await client.query(
    `UPDATE "matrix_fallback_key_slots"
        SET "current_fallback_key_id" = $2
      WHERE "device_id" = $1
        AND "algorithm" = $3`,
    [fixture.deviceId, secondFallbackId, SIGNED_CURVE_ALGORITHM]
  );
  await expectDatabaseRejection(
    client,
    "FALLBACK_ROTATED_BACKWARDS",
    "rotation must move to a newer key",
    () =>
      client.query(
        `UPDATE "matrix_fallback_key_slots"
            SET "current_fallback_key_id" = $2
          WHERE "device_id" = $1
            AND "algorithm" = $3`,
        [fixture.deviceId, firstFallbackId, SIGNED_CURVE_ALGORITHM]
      )
  );
  await expectDatabaseRejection(
    client,
    "FALLBACK_SLOT_DELETED",
    "fallback slots cannot be deleted",
    () =>
      client.query(
        `DELETE FROM "matrix_fallback_key_slots"
          WHERE "device_id" = $1
            AND "algorithm" = $2`,
        [fixture.deviceId, SIGNED_CURVE_ALGORITHM]
      )
  );

  const fallbackState = await client.query<{
    currentFallbackKeyId: string;
    firstClaimed: boolean;
  }>(
    `SELECT s."current_fallback_key_id" AS "currentFallbackKeyId",
            old_key."first_claimed_at" IS NOT NULL AS "firstClaimed"
       FROM "matrix_fallback_key_slots" s
       JOIN "matrix_fallback_keys" old_key ON old_key."id" = $2
      WHERE s."device_id" = $1
        AND s."algorithm" = $3`,
    [fixture.deviceId, firstFallbackId, SIGNED_CURVE_ALGORITHM]
  );
  assert.equal(fallbackState.rows[0]?.currentFallbackKeyId, secondFallbackId);
  assert.equal(fallbackState.rows[0]?.firstClaimed, true);

  const tombstone = await client.query<{ claimed: boolean }>(
    `SELECT "claimed_at" IS NOT NULL AS "claimed"
       FROM "matrix_one_time_keys"
      WHERE "id" = $1`,
    [oneTimeKeyId]
  );
  assert.equal(tombstone.rows[0]?.claimed, true);
  console.log(
    "[OK] OTK/fallback son tombstones de primer uso; fallback rota solo hacia una clave mas nueva."
  );
}

async function checkExactRetention(
  client: Client,
  fixture: {
    userId: string;
    deviceId: string;
    sessionId: string;
  }
): Promise<void> {
  await expectDatabaseRejection(
    client,
    "NON_EXACT_48H_RETENTION_ACCEPTED",
    "matrix_to_device_events_retention_check",
    async () => {
      const transactionId = await insertToDeviceTransaction(
        client,
        fixture,
        "bad-retention"
      );
      await client.query(
        `WITH "stamp" AS (
           SELECT clock_timestamp() - INTERVAL '49 hours' AS "created_at"
         )
         INSERT INTO "matrix_to_device_events" (
           "id", "transaction_row_id", "recipient_user_id",
           "recipient_device_id", "recipient_sequence", "content",
           "content_sha256", "created_at", "expires_at"
         )
         SELECT $1, $2, $3, $4, 1, $5::jsonb, $6,
                "stamp"."created_at",
                "stamp"."created_at" + INTERVAL '48 hours 1 microsecond'
           FROM "stamp"`,
        [
          randomUUID(),
          transactionId,
          fixture.userId,
          fixture.deviceId,
          JSON.stringify(olmControlContent()),
          sha256("bad-retention-content")
        ]
      );
    }
  );

  const transactionId = await insertToDeviceTransaction(
    client,
    fixture,
    "expired-retention"
  );
  const eventId = randomUUID();
  const content = olmControlContent();
  const inserted = await client.query<{
    retentionSeconds: string;
    alreadyExpired: boolean;
  }>(
    `WITH "stamp" AS (
       SELECT clock_timestamp() - INTERVAL '49 hours' AS "created_at"
     )
     INSERT INTO "matrix_to_device_events" (
       "id", "transaction_row_id", "recipient_user_id",
       "recipient_device_id", "recipient_sequence", "content",
       "content_sha256", "created_at", "expires_at"
     )
     SELECT $1, $2, $3, $4, 1, $5::jsonb, $6,
            "stamp"."created_at",
            "stamp"."created_at" + INTERVAL '48 hours'
       FROM "stamp"
     RETURNING
       EXTRACT(EPOCH FROM ("expires_at" - "created_at"))::text
         AS "retentionSeconds",
       "expires_at" <= clock_timestamp() AS "alreadyExpired"`,
    [
      eventId,
      transactionId,
      fixture.userId,
      fixture.deviceId,
      JSON.stringify(content),
      sha256(JSON.stringify(content))
    ]
  );
  assert.equal(inserted.rows[0]?.retentionSeconds, "172800.000000");
  assert.equal(inserted.rows[0]?.alreadyExpired, true);

  const purged = await client.query<{ id: string }>(
    `DELETE FROM "matrix_to_device_events"
      WHERE "id" = $1
        AND "expires_at" <= clock_timestamp()
      RETURNING "id"`,
    [eventId]
  );
  assert.equal(purged.rowCount, 1, "EXPIRED_TO_DEVICE_EVENT_NOT_PURGED");
  const remaining = await client.query<{ count: string }>(
    `SELECT count(*)::text AS "count"
       FROM "matrix_to_device_events"
      WHERE "id" = $1`,
    [eventId]
  );
  assert.equal(remaining.rows[0]?.count, "0");
  console.log(
    "[OK] La base exige TTL exacto de 48 horas y permite purga fisica de eventos vencidos."
  );
}

async function insertOneTimeKey(
  client: Client,
  deviceId: string,
  keyId: string,
  curveKey: string,
  id = randomUUID(),
  newerThanOneTimeKeyId?: string
): Promise<void> {
  const signedKey = {
    key: curveKey,
    signatures: { check: { ed25519: "signature" } }
  };
  const values = [
    id,
    deviceId,
    SIGNED_CURVE_ALGORITHM,
    keyId,
    curveKey,
    JSON.stringify(signedKey),
    sha256(JSON.stringify(signedKey))
  ];
  if (newerThanOneTimeKeyId) {
    await client.query(
      `INSERT INTO "matrix_one_time_keys" (
         "id", "device_id", "algorithm", "key_id", "curve25519_key",
         "signed_key", "canonical_sha256", "uploaded_at"
       )
       SELECT $1, $2, $3, $4, $5, $6::jsonb, $7,
              previous."uploaded_at" + INTERVAL '1 microsecond'
         FROM "matrix_one_time_keys" previous
        WHERE previous."id" = $8`,
      [...values, newerThanOneTimeKeyId]
    );
  } else {
    await client.query(
      `INSERT INTO "matrix_one_time_keys" (
         "id", "device_id", "algorithm", "key_id", "curve25519_key",
         "signed_key", "canonical_sha256"
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      values
    );
  }
}

async function claimOneTimeKey(
  client: Client,
  claimRequestId: string,
  recipientDeviceId: string,
  oneTimeKeyId: string
): Promise<void> {
  await client.query(
    `WITH claimed AS (
       UPDATE "matrix_one_time_keys"
          SET "claimed_at" = clock_timestamp()
        WHERE "id" = $4
          AND "claimed_at" IS NULL
       RETURNING "claimed_at"
     )
     INSERT INTO "matrix_key_claim_results" (
       "id", "claim_request_id", "recipient_device_id", "algorithm",
       "one_time_key_id", "claimed_at"
     )
     SELECT $1, $2, $3, $5, $4, claimed."claimed_at"
       FROM claimed`,
    [
      randomUUID(),
      claimRequestId,
      recipientDeviceId,
      oneTimeKeyId,
      SIGNED_CURVE_ALGORITHM
    ]
  );
}

async function claimFallbackKey(
  client: Client,
  claimRequestId: string,
  recipientDeviceId: string,
  fallbackKeyId: string
): Promise<void> {
  await client.query(
    `WITH claimed AS (
       UPDATE "matrix_fallback_keys"
          SET "first_claimed_at" = clock_timestamp()
        WHERE "id" = $4
          AND "first_claimed_at" IS NULL
       RETURNING "first_claimed_at"
     )
     INSERT INTO "matrix_key_claim_results" (
       "id", "claim_request_id", "recipient_device_id", "algorithm",
       "fallback_key_id", "claimed_at"
     )
     SELECT $1, $2, $3, $5, $4, claimed."first_claimed_at"
       FROM claimed`,
    [
      randomUUID(),
      claimRequestId,
      recipientDeviceId,
      fallbackKeyId,
      SIGNED_CURVE_ALGORITHM
    ]
  );
}

async function reuseFallbackKey(
  client: Client,
  claimRequestId: string,
  recipientDeviceId: string,
  fallbackKeyId: string
): Promise<void> {
  await client.query(
    `INSERT INTO "matrix_key_claim_results" (
       "id", "claim_request_id", "recipient_device_id", "algorithm",
       "fallback_key_id", "claimed_at"
     ) VALUES ($1, $2, $3, $4, $5, clock_timestamp())`,
    [
      randomUUID(),
      claimRequestId,
      recipientDeviceId,
      SIGNED_CURVE_ALGORITHM,
      fallbackKeyId
    ]
  );
}

async function insertRecoveryBundle(
  client: Client,
  userId: string,
  sourceDeviceId: string,
  version: number
): Promise<void> {
  await client.query(
    `INSERT INTO "encrypted_key_bundles" (
       "id", "user_id", "source_device_id", "version", "protection",
       "cipher_suite", "ciphertext", "nonce"
     ) VALUES ($1, $2, $3, $4, 'TRUSTED_DEVICE', $5, $6, $7)`,
    [
      randomUUID(),
      userId,
      sourceDeviceId,
      version,
      "matrix-db-check-v1",
      randomBytes(32),
      randomBytes(24)
    ]
  );
}

async function insertFallbackKey(
  client: Client,
  deviceId: string,
  keyId: string,
  curveKey: string,
  id = randomUUID(),
  newerThanFallbackId?: string
): Promise<string> {
  const signedKey = {
    fallback: true,
    key: curveKey,
    signatures: { check: { ed25519: "signature" } }
  };
  const values = [
    id,
    deviceId,
    SIGNED_CURVE_ALGORITHM,
    keyId,
    curveKey,
    JSON.stringify(signedKey),
    sha256(JSON.stringify(signedKey))
  ];
  if (newerThanFallbackId) {
    await client.query(
      `INSERT INTO "matrix_fallback_keys" (
         "id", "device_id", "algorithm", "key_id", "curve25519_key",
         "signed_key", "canonical_sha256", "uploaded_at"
       )
       SELECT $1, $2, $3, $4, $5, $6::jsonb, $7,
              previous."uploaded_at" + INTERVAL '1 microsecond'
         FROM "matrix_fallback_keys" previous
        WHERE previous."id" = $8`,
      [...values, newerThanFallbackId]
    );
  } else {
    await client.query(
      `INSERT INTO "matrix_fallback_keys" (
         "id", "device_id", "algorithm", "key_id", "curve25519_key",
         "signed_key", "canonical_sha256"
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      values
    );
  }
  return id;
}

async function insertToDeviceTransaction(
  client: Client,
  fixture: { deviceId: string; sessionId: string },
  label: string
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO "matrix_to_device_transactions" (
       "id", "sender_session_id", "sender_device_id", "transaction_id",
       "event_type", "request_sha256"
     ) VALUES ($1, $2, $3, $4, 'm.room.encrypted', $5)`,
    [id, fixture.sessionId, fixture.deviceId, `${label}-${randomUUID()}`, sha256(label)]
  );
  return id;
}

async function expectDatabaseRejection(
  client: Client,
  assertionCode: string,
  expectedMessageFragment: string,
  operation: () => Promise<unknown>
): Promise<void> {
  savepointSequence += 1;
  const savepoint = `matrix_check_${savepointSequence}`;
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

  const databaseFailure = failure as DatabaseFailure;
  assert(
    databaseFailure.code === "23505" || databaseFailure.code === "23514",
    `${assertionCode}_UNEXPECTED_SQLSTATE_${
      typeof databaseFailure.code === "string"
        ? databaseFailure.code.replace(/[^A-Za-z0-9]/gu, "_")
        : "MISSING"
    }`
  );
  assert(
    typeof databaseFailure.message === "string" &&
      databaseFailure.message
        .toLowerCase()
        .includes(expectedMessageFragment.toLowerCase()),
    `${assertionCode}_UNEXPECTED_MESSAGE`
  );
}

function olmControlContent(): Record<string, unknown> {
  const recipientCurveKey = matrixCurveKey();
  return {
    algorithm: OLM_ALGORITHM,
    ciphertext: {
      [recipientCurveKey]: {
        body: randomBytes(32).toString("base64"),
        type: 0
      }
    },
    sender_key: matrixCurveKey()
  };
}

function matrixCurveKey(): string {
  const value = randomBytes(32).toString("base64").replace(/=+$/u, "");
  assert.equal(value.length, 43);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function numericSuffix(): string {
  const numeric = BigInt(`0x${randomBytes(6).toString("hex")}`) % 10_000_000_000n;
  return numeric.toString().padStart(10, "0");
}

function assertLocalDatabase(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  assert.notEqual(process.env.NODE_ENV, "production", "PRODUCTION_FORBIDDEN");
  assert(localHosts.has(parsed.hostname), "LOCAL_DATABASE_REQUIRED");
}

function safeErrorSummary(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "UNKNOWN";
  }
  const candidate = error as DatabaseFailure & { name?: unknown };
  const messageCode =
    typeof candidate.message === "string"
      ? candidate.message.match(/^[A-Z][A-Z0-9_]+/u)?.[0]
      : undefined;
  const missingColumnMatch =
    typeof candidate.message === "string"
      ? candidate.message.match(
          /(?:column "([a-z0-9_]+)" does not exist|record "new" has no field "([a-z0-9_]+)")/iu
        )
      : undefined;
  const missingColumn = missingColumnMatch?.[1] ?? missingColumnMatch?.[2];
  const name = typeof candidate.name === "string" ? candidate.name : "Error";
  const sqlState = typeof candidate.code === "string" ? candidate.code : undefined;
  return `${messageCode ?? name}${sqlState ? `_SQLSTATE_${sqlState}` : ""}${
    missingColumn ? `_COLUMN_${missingColumn}` : ""
  }`;
}

void checkMatrixDatabase().catch((error: unknown) => {
  console.error(
    `[ERROR] Fallo la comprobacion Matrix de PostgreSQL (${safeErrorSummary(error)}).`
  );
  process.exitCode = 1;
});
