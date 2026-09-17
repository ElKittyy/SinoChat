import { match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const migration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260727014300_terms_acceptance_window/migration.sql"
  ),
  "utf8"
);
const authService = readFileSync(
  resolve(__dirname, "../auth/auth.service.js"),
  "utf8"
);
const publicationCli = readFileSync(
  resolve(__dirname, "../cli/publish-terms.js"),
  "utf8"
);

describe("terms acceptance validity migration", () => {
  it("bloquea writers viejos antes del scan y conserva el bloqueo hasta COMMIT", () => {
    const documentLock = migration.indexOf(
      'LOCK TABLE "terms_documents" IN SHARE ROW EXCLUSIVE MODE'
    );
    const acceptanceLock = migration.indexOf(
      'LOCK TABLE "terms_acceptances" IN SHARE ROW EXCLUSIVE MODE'
    );
    const consistencyScan = migration.indexOf(
      "existing terms acceptance falls outside its document validity window"
    );
    const firstTrigger = migration.indexOf(
      'CREATE TRIGGER "terms_acceptances_validity_window_trigger"'
    );
    const commit = migration.lastIndexOf("COMMIT;");

    ok(documentLock > migration.indexOf("BEGIN;"));
    ok(acceptanceLock > documentLock);
    ok(consistencyScan > acceptanceLock);
    ok(firstTrigger > consistencyScan);
    ok(commit > firstTrigger);
  });

  it("rechaza aceptaciones fuera de [effective_at, retired_at)", () => {
    match(
      migration,
      /NEW\."accepted_at" < "document_effective_at"[\s\S]*NEW\."accepted_at" >= "document_retired_at"/
    );
    match(
      migration,
      /CREATE TRIGGER "terms_acceptances_validity_window_trigger"[\s\S]*BEFORE INSERT OR UPDATE/
    );
  });

  it("impide que un cambio del documento invalide aceptaciones existentes", () => {
    match(
      migration,
      /CREATE TRIGGER "terms_documents_acceptance_window_trigger"[\s\S]*BEFORE INSERT OR UPDATE/
    );
    match(
      migration,
      /terms document change would invalidate an existing acceptance/
    );
  });

  it("comparte el mismo advisory lock entre trigger, publicación y registro", () => {
    match(migration, /sinochat:terms-lifecycle/);
    match(publicationCli, /lockTermsLifecycle[\s\S]{0,40}\(tx\)/);
    match(authService, /lockTermsLifecycle[\s\S]{0,40}\(tx\)/);
    match(authService, /TransactionIsolationLevel\.Serializable/);
    match(authService, /error[\s\S]*code[\s\S]*P2034/);
  });
});
