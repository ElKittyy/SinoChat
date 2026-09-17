import { doesNotMatch, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const migration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260827004000_matrix_sync_chain_hardening/migration.sql"
  ),
  "utf8"
);
const lineageFix = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260827005000_matrix_device_idempotency_and_sync_lineage/migration.sql"
  ),
  "utf8"
);
const replayWindow = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260827006000_matrix_sync_replay_window/migration.sql"
  ),
  "utf8"
);
const cryptoSnapshot = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260827007000_matrix_sync_crypto_snapshot/migration.sql"
  ),
  "utf8"
);

describe("Matrix sync chain hardening migration", () => {
  it("fija rangos inmutables y un unico sucesor por token since", () => {
    match(migration, /ADD COLUMN "previous_batch_id" UUID/);
    match(migration, /ADD COLUMN "from_sequence" BIGINT NOT NULL DEFAULT 0/);
    match(migration, /ADD COLUMN "from_device_list_position" BIGINT NOT NULL DEFAULT 0/);
    match(
      migration,
      /CREATE UNIQUE INDEX "matrix_to_device_sync_batches_previous_key"/
    );
    match(migration, /up_to_sequence" >= "from_sequence/);
    match(
      migration,
      /device_list_position" >= "from_device_list_position/
    );
  });

  it("exige continuidad, mismo dispositivo y predecesor vigente", () => {
    match(migration, /previous_device_id" IS DISTINCT FROM NEW\."device_id/);
    match(
      migration,
      /previous_up_to_sequence" IS DISTINCT FROM NEW\."from_sequence/
    );
    match(
      migration,
      /previous_device_list_position" IS DISTINCT FROM NEW\."from_device_list_position/
    );
    match(migration, /previous_expires_at" <= NEW\."created_at/);
    match(migration, /previous_acknowledged_at" IS NOT NULL/);
    match(migration, /initial Matrix sync batch must start at zero/);
  });

  it("conserva el UUID de linaje aunque el padre sea purgado", () => {
    match(migration, /ON DELETE SET NULL/);
    match(
      lineageFix,
      /DROP CONSTRAINT "matrix_to_device_sync_batches_previous_fkey"/
    );
    match(
      lineageFix,
      /previous_batch_id" IS DISTINCT FROM OLD\."previous_batch_id"/
    );
    doesNotMatch(lineageFix, /ON DELETE SET NULL/);
    doesNotMatch(migration, /DROP (?:TABLE|COLUMN|INDEX)/);
  });

  it("lleva la idempotencia sendToDevice del token de sesion al dispositivo", () => {
    match(
      lineageFix,
      /DROP INDEX "matrix_to_device_transactions_session_txn_key"/
    );
    match(
      lineageFix,
      /sender_device_id", "event_type", "transaction_id"/
    );
  });

  it("no deja que un token sobreviva al contenido necesario para reintentar", () => {
    match(replayWindow, /INTERVAL '48 hours'/);
    match(replayWindow, /min\(e\."expires_at"\)/);
    match(
      replayWindow,
      /recipient_sequence" > NEW\."from_sequence"[\s\S]*recipient_sequence" <= NEW\."up_to_sequence"/
    );
    match(replayWindow, /cannot outlive its replayable 48-hour event range/);
  });

  it("congela los contadores criptograficos que devuelve cada batch", () => {
    match(cryptoSnapshot, /ADD COLUMN "one_time_key_count" INTEGER/);
    match(cryptoSnapshot, /ADD COLUMN "unused_fallback_key" BOOLEAN/);
    match(cryptoSnapshot, /one_time_key_count" BETWEEN 0 AND 100/);
    match(cryptoSnapshot, /sync cryptographic snapshot is immutable/);
  });
});
