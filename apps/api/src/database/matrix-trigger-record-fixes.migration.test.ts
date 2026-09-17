import { doesNotMatch, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const ownedDeviceFix = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260827001000_owned_device_reference_record_fix/migration.sql"
  ),
  "utf8"
);
const preKeyFix = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260827002000_matrix_pre_key_record_fix/migration.sql"
  ),
  "utf8"
);
const claimSelectionHardening = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260827003000_matrix_claim_selection_hardening/migration.sql"
  ),
  "utf8"
);

describe("polymorphic PostgreSQL trigger record fixes", () => {
  it("resuelve el campo de dispositivo sin acceder a columnas ajenas al record", () => {
    match(ownedDeviceFix, /to_jsonb\(NEW\)->>'device_id'/);
    match(ownedDeviceFix, /to_jsonb\(NEW\)->>'source_device_id'/);
    doesNotMatch(ownedDeviceFix, /NEW\."source_device_id"/);
  });

  it("unifica la transicion de claim OTK/fallback sin campos inexistentes", () => {
    match(preKeyFix, /"claim_field" := CASE/);
    match(preKeyFix, /to_jsonb\(NEW\)->>"claim_field"/);
    match(preKeyFix, /to_jsonb\(OLD\)->>"claim_field"/);
    doesNotMatch(preKeyFix, /NEW\."first_claimed_at"|OLD\."claimed_at"/);
    match(preKeyFix, /pre-key tombstones cannot be deleted or reused/);
  });

  it("obliga a consumir el lote OTK mas antiguo antes del fallback", () => {
    match(
      claimSelectionHardening,
      /k\."uploaded_at" < "key_uploaded_at"/
    );
    match(
      claimSelectionHardening,
      /oldest uploaded batch first/
    );
    match(
      claimSelectionHardening,
      /fallback cannot be claimed while a one-time key is available/
    );
    match(
      claimSelectionHardening,
      /pg_advisory_xact_lock[\s\S]*sinochat:matrix:prekeys:/
    );
    doesNotMatch(
      claimSelectionHardening,
      /DROP (?:TABLE|COLUMN|INDEX)/
    );
  });
});
