import { doesNotMatch, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const migration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260727014600_assignment_commit_clock/migration.sql"
  ),
  "utf8"
);

describe("assignment commit clock migration", () => {
  it("valida disponibilidad contra clock_timestamp al ejecutar el trigger diferido", () => {
    match(migration, /"validation_now" TIMESTAMPTZ := clock_timestamp\(\)/);
    match(migration, /cs\."starts_at" <= "validation_now"/);
    match(migration, /cs\."ends_at" > "validation_now"/);
    doesNotMatch(
      migration,
      /cs\."starts_at" <= NEW\."started_at"|cs\."ends_at" > NEW\."started_at"/
    );
  });

  it("rechaza inserts con started_at futuro y una invitacion revocada antes del commit", () => {
    match(migration, /NEW\."started_at" > "validation_now"/);
    match(
      migration,
      /WHEN TG_OP = 'INSERT' THEN "validation_now"[\s\S]*ELSE NEW\."started_at"/
    );
  });

  it("conserva la elegibilidad de cuenta, aprobacion y reset obligatorio", () => {
    match(migration, /u\."status" = 'ACTIVE'/);
    match(migration, /u\."password_reset_required" = FALSE/);
    match(migration, /cp\."approval_status" = 'APPROVED'/);
  });
});
