import { doesNotMatch, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const migration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260901000000_cashier_recovery_codes/migration.sql"
  ),
  "utf8"
);

describe("cashier recovery codes migration", () => {
  it("persiste solo hashes y liga cada código al cajero", () => {
    match(migration, /CREATE TABLE "cashier_recovery_codes"/);
    match(migration, /"code_hash" CHAR\(64\) NOT NULL/);
    match(migration, /cashier_recovery_codes_hash_format_check/);
    match(
      migration,
      /FOREIGN KEY \("cashier_user_id"\) REFERENCES "cashier_profiles"\("user_id"\)/
    );
    doesNotMatch(migration, /temporary_password|plaintext|"code"\s/);
  });

  it("impone uso único, caducidad y una sola solicitud abierta", () => {
    match(migration, /"used_at" TIMESTAMPTZ\(6\)/);
    match(migration, /"expires_at" IS NULL OR "expires_at" > "created_at"/);
    match(migration, /cashier_password_resets_recovery_code_key/);
    match(
      migration,
      /cashier_password_resets_one_open_key[\s\S]*WHERE "consumed_at" IS NULL AND "superseded_at" IS NULL/
    );
    match(migration, /cashier_password_resets_consumption_check/);
  });

  it("impide consumir un código perteneciente a otro cajero", () => {
    match(migration, /cashier_recovery_codes_id_cashier_key/);
    match(
      migration,
      /FOREIGN KEY \("recovery_code_id", "cashier_user_id"\)[\s\S]*REFERENCES "cashier_recovery_codes"\("id", "cashier_user_id"\)/
    );
  });
});
