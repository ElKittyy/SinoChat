import { doesNotThrow, rejects, throws } from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { describe, it } from "node:test";
import type { PrismaService } from "../database/prisma.service";
import { InvitationCryptoService } from "./invitation-crypto.service";
import { InvitationKeyringAuditService } from "./invitation-keyring-audit.service";

const KEY = Buffer.alloc(32, 7).toString("base64");
const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";

describe("InvitationCryptoService", () => {
  it("liga el ciphertext al registro y propietario mediante AAD", async () => {
    await withKeyring(() => {
      const service = new InvitationCryptoService();
      const encrypted = service.encrypt("SINO-ABCDEFGHIJKLMNOP", {
        kind: "client",
        invitationId: FIRST_ID,
        ownerUserId: OWNER_ID
      });

      doesNotThrow(() =>
        service.decrypt(
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.keyVersion,
          encrypted.formatVersion,
          {
            kind: "client",
            invitationId: FIRST_ID,
            ownerUserId: OWNER_ID
          }
        )
      );
      throws(() =>
        service.decrypt(
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.keyVersion,
          encrypted.formatVersion,
          {
            kind: "client",
            invitationId: SECOND_ID,
            ownerUserId: OWNER_ID
          }
        )
      );
    });
  });

  it("frena el arranque si falta una versión aún usada", async () => {
    await withKeyring(async () => {
      const service = new InvitationCryptoService();
      const code = "SINO-ABCDEFGHIJKLMNOP";
      const encrypted = service.encrypt(code, {
        kind: "client",
        invitationId: FIRST_ID,
        ownerUserId: OWNER_ID
      });
      const prisma = {
        cashierInvitation: {
          findMany: async () => [
            {
              id: FIRST_ID,
              cashierUserId: OWNER_ID,
              codeLookupHash: service.lookupHash(code),
              codeCiphertext: encrypted.ciphertext,
              codeNonce: encrypted.nonce,
              encryptionKeyVersion: 2,
              cipherFormatVersion: encrypted.formatVersion
            }
          ]
        }
      } as unknown as PrismaService;
      const audit = new InvitationKeyringAuditService(
        prisma,
        service
      );

      await rejects(
        audit.onApplicationBootstrap(),
        /clave de invitaciones versión 2/
      );
    });
  });

  it("descifra legacy solo cuando la fila declara formato 0", async () => {
    await withKeyring(() => {
      const service = new InvitationCryptoService();
      const code = "SINO-LEGACYCODE1234";
      const nonce = Buffer.alloc(12, 4);
      const cipher = createCipheriv("aes-256-gcm", Buffer.from(KEY, "base64"), nonce);
      const body = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
      const ciphertext = Buffer.concat([body, cipher.getAuthTag()]);
      const context = {
        kind: "client" as const,
        invitationId: FIRST_ID,
        ownerUserId: OWNER_ID
      };

      doesNotThrow(() => service.decrypt(ciphertext, nonce, 1, 0, context));
      throws(() => service.decrypt(ciphertext, nonce, 1, 1, context));
    });
  });
});

async function withKeyring<T>(operation: () => T | Promise<T>): Promise<T> {
  const previousKey = process.env.INVITATION_ENCRYPTION_KEY;
  const previousVersion = process.env.INVITATION_ENCRYPTION_KEY_VERSION;
  const previousKeys = process.env.INVITATION_ENCRYPTION_PREVIOUS_KEYS;
  process.env.INVITATION_ENCRYPTION_KEY = KEY;
  process.env.INVITATION_ENCRYPTION_KEY_VERSION = "1";
  delete process.env.INVITATION_ENCRYPTION_PREVIOUS_KEYS;
  try {
    return await operation();
  } finally {
    restore("INVITATION_ENCRYPTION_KEY", previousKey);
    restore("INVITATION_ENCRYPTION_KEY_VERSION", previousVersion);
    restore("INVITATION_ENCRYPTION_PREVIOUS_KEYS", previousKeys);
  }
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
