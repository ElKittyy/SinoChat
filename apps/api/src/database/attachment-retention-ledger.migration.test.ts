import { equal, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const migration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260831000000_attachment_purge_ledger_hardening/migration.sql"
  ),
  "utf8"
);
const schema = readFileSync(
  resolve(__dirname, "../../prisma/schema.prisma"),
  "utf8"
);
const worker = readFileSync(
  resolve(__dirname, "../../src/retention/retention.service.ts"),
  "utf8"
);

describe("attachment retention ledger hardening", () => {
  it("impide borrar el mensaje antes que el ledger del objeto externo", () => {
    match(
      migration,
      /ALTER TABLE "attachments"[\s\S]*DROP CONSTRAINT "attachments_message_id_fkey"[\s\S]*ON DELETE RESTRICT/
    );
    match(
      schema,
      /model Attachment[\s\S]*message Message @relation\(fields: \[messageId\], references: \[id\], onDelete: Restrict\)/
    );
  });

  it("solo elimina ledger y mensaje despues de la purga fisica", () => {
    const storageDelete = worker.indexOf(
      "await this.storage.delete(attachment.objectKey)"
    );
    const transaction = worker.indexOf(
      "await this.prisma.$transaction",
      storageDelete
    );
    const ledgerDelete = worker.indexOf(
      "transaction.attachment.deleteMany",
      transaction
    );
    const messageDelete = worker.indexOf(
      "transaction.message.deleteMany",
      ledgerDelete
    );

    equal(storageDelete >= 0, true);
    equal(transaction > storageDelete, true);
    equal(ledgerDelete > transaction, true);
    equal(messageDelete > ledgerDelete, true);
    match(worker, /ATTACHMENT_MESSAGE_PURGE_RACE/);
  });
});
