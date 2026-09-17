import { doesNotMatch, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const migration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260827000000_matrix_e2ee_transport/migration.sql"
  ),
  "utf8"
);
const adr = readFileSync(
  resolve(__dirname, "../../../../docs/ADR-001-E2EE_PROTOCOL.md"),
  "utf8"
);
const messageAdr = readFileSync(
  resolve(
    __dirname,
    "../../../../docs/ADR-002-MEGOLM_APPLICATION_MESSAGES.md"
  ),
  "utf8"
);

describe("Matrix E2EE transport migration", () => {
  it("preserva las defensas existentes y no convierte blobs genericos", () => {
    doesNotMatch(migration, /DROP INDEX|DROP TABLE|DROP COLUMN/);
    match(migration, /deliberately additive/);
    match(
      migration,
      /ALTER COLUMN "identity_public_key" DROP NOT NULL/
    );
    match(migration, /CREATE TABLE "matrix_device_keys"/);
    match(migration, /matrix device keys are immutable/);
  });

  it("reserva el UUID antes de inicializar Olm y consume al final atomico", () => {
    match(migration, /CREATE TABLE "matrix_device_registrations"/);
    match(
      migration,
      /matrix_device_registrations_open_session_key[\s\S]*WHERE "consumed_at" IS NULL/
    );
    match(
      migration,
      /consumed after atomic device publication and session binding/
    );
    match(migration, /INTERVAL '15 minutes'/);
  });

  it("mantiene OTK consumibles y fallback vigente como objetos diferentes", () => {
    match(migration, /CREATE TABLE "matrix_one_time_keys"/);
    match(migration, /CREATE TABLE "matrix_fallback_keys"/);
    match(migration, /CREATE TABLE "matrix_fallback_key_slots"/);
    match(migration, /pre-key tombstones cannot be deleted or reused/);
    match(
      migration,
      /matrix_key_claim_results_single_key_check[\s\S]*num_nonnulls/
    );
    match(
      migration,
      /matrix_key_claim_results_one_time_key[\s\S]*"one_time_key_id"/
    );
    match(migration, /empty Matrix key-claim result cannot hide an available key/);
    match(migration, /prekeys:' \|\| NEW\."recipient_device_id"/);
  });

  it("ordena por commit mediante filas bloqueables y no mediante BIGSERIAL", () => {
    match(migration, /CREATE TABLE "matrix_device_list_stream"/);
    match(migration, /NEW\."position" <> OLD\."position" \+ 1/);
    match(migration, /CREATE TABLE "matrix_to_device_cursors"/);
    match(
      migration,
      /NEW\."latest_sequence" <> OLD\."latest_sequence" \+ 1/
    );
    doesNotMatch(migration, /BIGSERIAL/);
  });

  it("hace idempotente to-device por sesion y limita su payload a 48 horas", () => {
    match(
      migration,
      /matrix_to_device_transactions_session_txn_key[\s\S]*"sender_session_id"[\s\S]*"transaction_id"/
    );
    match(
      migration,
      /matrix_to_device_events_retention_check[\s\S]*INTERVAL '48 hours'/
    );
    match(migration, /octet_length\("content"::text\) <= 65536/);
    match(migration, /m\.key\.verification\.request/);
    match(migration, /exact Olm v1 envelope/);
    match(migration, /to-device events are immutable until acknowledgement/);
  });

  it("mantiene to-device como control y el chat en sobres efimeros", () => {
    match(adr, /cola `to-device`/i);
    match(messageAdr, /MessageEnvelope/);
    match(messageAdr, /Megolm[^\n]*mensajes[^\n]*aplicaci[oó]n/i);
    match(messageAdr, /Olm[\s\S]{0,300}control|control[\s\S]{0,300}Olm/i);
  });
});
