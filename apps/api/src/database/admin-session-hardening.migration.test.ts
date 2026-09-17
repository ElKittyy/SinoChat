import { equal, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const migration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260727014800_admin_session_audit/migration.sql"
  ),
  "utf8"
);
const schema = readFileSync(
  resolve(__dirname, "../../prisma/schema.prisma"),
  "utf8"
);

describe("migración de auditoría de sesiones ADMIN", () => {
  it("incorpora acciones y target sin almacenar credenciales", () => {
    match(migration, /ADD VALUE IF NOT EXISTS 'ADMIN_SESSION_REVOKED'/);
    match(
      migration,
      /ADD VALUE IF NOT EXISTS 'ADMIN_OTHER_SESSIONS_REVOKED'/
    );
    match(migration, /ADD VALUE IF NOT EXISTS 'AUTH_SESSION'/);
    equal(/token_hash|csrf_secret_hash/i.test(migration), false);
  });

  it("mantiene lastSeenAt como reloj persistente de actividad", () => {
    match(
      schema,
      /lastSeenAt\s+DateTime\s+@default\(now\(\)\)\s+@map\("last_seen_at"\)/
    );
  });
});
