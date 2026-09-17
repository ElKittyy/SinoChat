import { match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const migration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260727012000_pre_key_claims_and_db_invariants/migration.sql"
  ),
  "utf8"
);

describe("database hardening migration", () => {
  it("persiste un claim único por solicitante, conversación y destinatario", () => {
    match(
      migration,
      /CREATE UNIQUE INDEX "one_time_pre_key_claims_request_key"[\s\S]*"requester_device_id"[\s\S]*"conversation_id"[\s\S]*"recipient_device_id"/
    );
    match(
      migration,
      /CREATE UNIQUE INDEX "one_time_pre_key_claims_pre_key_key"/
    );
    match(
      migration,
      /one-time pre-key claims are immutable/
    );
  });

  it("protege las reservas pendientes con unicidad y borrado restrictivo", () => {
    match(
      migration,
      /CREATE UNIQUE INDEX "pending_report_evidence_uploads_assignment_key"/
    );
    match(
      migration,
      /ALTER TABLE "pending_attachment_uploads"[\s\S]*ON DELETE RESTRICT[\s\S]*ON DELETE RESTRICT/
    );
    match(
      migration,
      /ALTER TABLE "pending_report_evidence_uploads"[\s\S]*ON DELETE RESTRICT[\s\S]*ON DELETE RESTRICT[\s\S]*ON DELETE RESTRICT/
    );
  });

  it("impide retrocesos y cronologías incoherentes de recibos", () => {
    match(migration, /"new_rank" < "old_rank"/);
    match(
      migration,
      /message receipt status cannot move backwards/
    );
    match(
      migration,
      /NEW\."delivered_at" < "message_created_at"/
    );
    match(migration, /NEW\."read_at" < NEW\."delivered_at"/);
    match(migration, /NEW\."updated_at" := "database_now"/);
  });
});
