import { doesNotMatch, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const migration = readFileSync(
  join(
    __dirname,
    "../../prisma/migrations/20260828000000_matrix_registration_replay/migration.sql"
  ),
  "utf8"
);
const baseMigration = readFileSync(
  join(
    __dirname,
    "../../prisma/migrations/20260827000000_matrix_e2ee_transport/migration.sql"
  ),
  "utf8"
);

describe("Matrix first-device completion replay migration", () => {
  it("agrega un snapshot acotado sin reescribir altas consumidas", () => {
    match(migration, /ADD COLUMN "initial_upload_sha256" CHAR\(64\)/);
    match(
      migration,
      /ADD COLUMN "initial_one_time_key_count" INTEGER/
    );
    match(migration, /"initial_upload_sha256" ~ '\^\[0-9a-f\]\{64\}\$'/);
    match(
      migration,
      /"initial_one_time_key_count" BETWEEN 0 AND 100/
    );
    match(migration, /"consumed_at" IS NOT NULL/);
    doesNotMatch(migration, /UPDATE "matrix_device_registrations"/);
    doesNotMatch(migration, /DROP (?:TABLE|COLUMN|CONSTRAINT)/);
  });

  it("hereda la inmutabilidad posterior al primer consumo", () => {
    match(baseMigration, /OLD\."consumed_at" IS NOT NULL/);
    match(
      baseMigration,
      /matrix device registration identity and consumption are immutable/
    );
  });
});
