import { match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const migration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260902000000_admin_passkey_management/migration.sql"
  ),
  "utf8"
);

describe("admin passkey management migration", () => {
  it("distingue la revocación individual de una recuperación total", () => {
    match(
      migration,
      /ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_PASSKEY_REVOKED'/
    );
  });
});
