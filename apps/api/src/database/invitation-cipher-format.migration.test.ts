import { match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const migration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260727014500_invitation_aad_format/migration.sql"
  ),
  "utf8"
);
const adminService = readFileSync(
  resolve(__dirname, "../admin/admin-invitations.service.js"),
  "utf8"
);
const cashierService = readFileSync(
  resolve(__dirname, "../cashier/cashier-invitations.service.js"),
  "utf8"
);

describe("invitation AAD format migration", () => {
  it("marca filas previas/instancias antiguas como legacy y las altas nuevas declaran formato", () => {
    const addLegacyAt = migration.indexOf(
      'ADD COLUMN "cipher_format_version" INTEGER NOT NULL DEFAULT 0'
    );
    ok(addLegacyAt >= 0);
    ok(!migration.includes('SET DEFAULT 1'));
    match(migration, /CHECK \("cipher_format_version" IN \(0, 1\)\)/);
    match(adminService, /cipherFormatVersion:\s*encrypted\.formatVersion/);
    match(cashierService, /cipherFormatVersion:\s*encrypted\.formatVersion/);
  });

  it("hace inmutable la versión de formato en ambos historiales", () => {
    match(
      migration,
      /sinochat_enforce_cashier_onboarding_invitation_history[\s\S]*NEW\."cipher_format_version" <> OLD\."cipher_format_version"/
    );
    match(
      migration,
      /sinochat_enforce_invitation_history[\s\S]*NEW\."cipher_format_version" <> OLD\."cipher_format_version"/
    );
  });
});
