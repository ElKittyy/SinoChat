import { doesNotMatch, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const migration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260901010000_admin_webauthn_mfa/migration.sql"
  ),
  "utf8"
);

describe("admin WebAuthn MFA migration", () => {
  it("persiste únicamente clave pública, contador y metadatos permitidos", () => {
    match(migration, /CREATE TABLE "admin_webauthn_credentials"/);
    match(migration, /"public_key" BYTEA NOT NULL/);
    match(migration, /"counter" BIGINT NOT NULL DEFAULT 0/);
    match(migration, /admin_webauthn_credentials_counter_check/);
    doesNotMatch(migration, /private_key|client_data_json|attestation_object/);
  });

  it("hace los desafíos de un solo uso, acotados y ligados a sesión", () => {
    match(migration, /"challenge_hash" CHAR\(64\) NOT NULL/);
    match(
      migration,
      /admin_webauthn_challenges_one_open_per_session_key[\s\S]*WHERE "consumed_at" IS NULL/
    );
    match(migration, /"expires_at" <= "created_at" \+ INTERVAL '10 minutes'/);
    match(migration, /ADMIN_WEBAUTHN_SESSION_OWNER_MISMATCH/);
  });

  it("restringe passkeys, recuperación y sesiones MFA al rol ADMIN", () => {
    match(migration, /ADMIN_WEBAUTHN_OWNER_REQUIRED/);
    match(migration, /ADMIN_MFA_SESSION_ROLE_REQUIRED/);
    match(migration, /ADMIN_WEBAUTHN_HANDLE_ROLE_REQUIRED/);
    match(migration, /CREATE TABLE "admin_recovery_codes"/);
    match(migration, /"code_hash" CHAR\(64\) NOT NULL/);
    doesNotMatch(migration, /"recovery_code"\s+VARCHAR/);
  });
});
