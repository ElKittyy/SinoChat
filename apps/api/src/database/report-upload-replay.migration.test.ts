import { match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const migration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260727014200_report_upload_replay_guard/migration.sql"
  ),
  "utf8"
);

describe("report evidence upload replay migration", () => {
  it("conserva el fin de autorización y difiere la purga durable", () => {
    match(migration, /"upload_authorized_until" TIMESTAMPTZ\(6\)/);
    match(migration, /"purge_not_before" TIMESTAMPTZ\(6\)/);
    match(
      migration,
      /CHECK \("next_attempt_at" >= "purge_not_before"\)/
    );
    match(
      migration,
      /"upload_authorized_until" IS DISTINCT FROM NEW\."purge_not_before"/
    );
  });

  it("suspende el trigger inmutable solo durante el backfill y lo restaura", () => {
    const dropAt = migration.indexOf(
      'DROP TRIGGER "report_evidence_history_trigger"'
    );
    const backfillAt = migration.indexOf(
      'UPDATE "report_evidence"'
    );
    const restoreAt = migration.indexOf(
      'CREATE TRIGGER "report_evidence_history_trigger"'
    );

    ok(dropAt >= 0, "debe retirar el trigger previo");
    ok(backfillAt > dropAt, "debe retirar el trigger antes del backfill");
    ok(restoreAt > backfillAt, "debe restaurarlo después del backfill");
    match(
      migration.slice(restoreAt),
      /BEFORE UPDATE OR DELETE ON "report_evidence"[\s\S]*sinochat_enforce_report_evidence_history/
    );
  });
});
