import { doesNotMatch, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const migration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260830000000_message_olm_envelope_hardening/migration.sql"
  ),
  "utf8"
);
const megolmMigration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260831001000_message_megolm_envelope_profile/migration.sql"
  ),
  "utf8"
);
const service = readFileSync(
  resolve(__dirname, "../../src/messages/messages.service.ts"),
  "utf8"
);
const dto = readFileSync(
  resolve(__dirname, "../../src/messages/dto/message-envelope.dto.ts"),
  "utf8"
);
const databaseCheck = readFileSync(
  resolve(__dirname, "../../src/cli/check-matrix-database.ts"),
  "utf8"
);

describe("message Olm envelope hardening", () => {
  it("falla ante datos legacy en vez de declararlos Matrix", () => {
    match(
      migration,
      /MESSAGE_ENVELOPE_LEGACY_DATA_REQUIRES_EXPLICIT_PURGE/
    );
    match(
      migration,
      /ATTACHMENT_LEGACY_DATA_REQUIRES_EXPLICIT_PURGE/
    );
    doesNotMatch(migration, /UPDATE|DELETE FROM|DROP (?:TABLE|COLUMN)/);
  });

  it("evoluciona de Olm a Megolm sin convertir ciphertext existente", () => {
    match(
      migration,
      /"protocol_version" = 'matrix-olm-v1'/
    );
    match(
      migration,
      /"cipher_suite" = 'm\.olm\.v1\.curve25519-aes-sha2'/
    );
    match(
      migration,
      /attachments_cipher_suite_check[\s\S]*"cipher_suite" = 'A256CTR'/
    );
    match(megolmMigration, /MESSAGE_OLM_DATA_BLOCKS_MEGOLM_PROFILE/);
    match(
      megolmMigration,
      /DROP CONSTRAINT "message_envelopes_protocol_version_check"/
    );
    match(megolmMigration, /"protocol_version" = 'matrix-megolm-v1'/);
    match(megolmMigration, /"cipher_suite" = 'm\.megolm\.v1\.aes-sha2'/);
    doesNotMatch(megolmMigration, /UPDATE|DELETE FROM|DROP (?:TABLE|COLUMN)/);
    match(dto, /@Equals\("matrix-megolm-v1"\)/);
    match(dto, /@Equals\(MATRIX_MEGOLM_ALGORITHM\)/);
    match(
      databaseCheck,
      /20260831001000_message_megolm_envelope_profile/
    );
    match(databaseCheck, /checkMessageEnvelopeHardening/);
  });

  it("liga el exterior Megolm al dispositivo emisor y duplica bytes exactos", () => {
    match(service, /parseMatrixMegolmRoomContent/);
    match(service, /ciphertextBytes\.toString\("base64"\)/);
    match(service, /content\.sender_key !== senderDevice\.curve25519Key/);
    match(service, /content\.device_id !== senderDevice\.matrixDeviceId/);
    match(service, /canonicalCiphertext !== envelope\.ciphertext/);
    match(service, /JOIN "matrix_device_keys" matrix_key/);
    match(service, /cipherSuite: MATRIX_ATTACHMENT_CIPHER_SUITE/);
  });
});
