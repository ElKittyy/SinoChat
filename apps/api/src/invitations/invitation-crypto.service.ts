import { Injectable } from "@nestjs/common";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { readInvitationEncryptionKeyring } from "../config/invitation-encryption-keyring";

export type InvitationCipherContext =
  | {
      kind: "cashier-onboarding";
      invitationId: string;
      ownerUserId: string;
    }
  | {
      kind: "client";
      invitationId: string;
      ownerUserId: string;
    };

export const CURRENT_INVITATION_CIPHER_FORMAT_VERSION = 1;
export const LEGACY_INVITATION_CIPHER_FORMAT_VERSION = 0;

@Injectable()
export class InvitationCryptoService {
  generateCode(): string {
    return `SINO-${randomBytes(16).toString("hex").toUpperCase()}`;
  }

  lookupHash(code: string): string {
    return createHash("sha256")
      .update(code.trim().toUpperCase(), "utf8")
      .digest("hex");
  }

  encrypt(code: string, context: InvitationCipherContext): {
    ciphertext: Buffer;
    nonce: Buffer;
    keyVersion: number;
    formatVersion: number;
  } {
    const keyring = readInvitationEncryptionKeyring();
    const key = keyring.keys.get(keyring.currentVersion);
    if (!key) {
      throw new Error("La clave actual de invitaciones no está disponible.");
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(this.additionalAuthenticatedData(context));
    const body = Buffer.concat([
      cipher.update(code, "utf8"),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    return {
      ciphertext: Buffer.concat([body, authTag]),
      nonce,
      keyVersion: keyring.currentVersion,
      formatVersion: CURRENT_INVITATION_CIPHER_FORMAT_VERSION
    };
  }

  decrypt(
    ciphertextWithTag: Uint8Array,
    nonce: Uint8Array,
    keyVersion: number,
    formatVersion: number,
    context: InvitationCipherContext
  ): string {
    const ciphertext = Buffer.from(ciphertextWithTag);
    if (ciphertext.length <= 16) {
      throw new Error("Código cifrado inválido.");
    }

    const body = ciphertext.subarray(0, -16);
    const authTag = ciphertext.subarray(-16);
    const key = readInvitationEncryptionKeyring().keys.get(keyVersion);
    if (!key) {
      throw new Error(
        `No está configurada la clave de invitaciones versión ${keyVersion}.`
      );
    }
    if (
      formatVersion !== LEGACY_INVITATION_CIPHER_FORMAT_VERSION &&
      formatVersion !== CURRENT_INVITATION_CIPHER_FORMAT_VERSION
    ) {
      throw new Error(
        `Formato cifrado de invitación ${formatVersion} no compatible.`
      );
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(nonce)
    );
    if (formatVersion === CURRENT_INVITATION_CIPHER_FORMAT_VERSION) {
      decipher.setAAD(this.additionalAuthenticatedData(context));
    }
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(body), decipher.final()]).toString(
      "utf8"
    );
  }

  matchesLookupHash(code: string, expectedHash: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
      return false;
    }
    return timingSafeEqual(
      Buffer.from(this.lookupHash(code), "hex"),
      Buffer.from(expectedHash, "hex")
    );
  }

  assertKeyVersionsAvailable(versions: Iterable<number>): void {
    const keys = readInvitationEncryptionKeyring().keys;
    for (const version of versions) {
      if (!keys.has(version)) {
        throw new Error(
          `La base usa la clave de invitaciones versión ${version}, pero no está configurada.`
        );
      }
    }
  }

  private additionalAuthenticatedData(
    context: InvitationCipherContext
  ): Buffer {
    const { kind, invitationId, ownerUserId } = context;
    if (!invitationId || !ownerUserId) {
      throw new Error("El contexto cifrado de la invitación está incompleto.");
    }
    return Buffer.from(
      `sinochat:invitation:v1\u0000${kind}\u0000${invitationId}\u0000${ownerUserId}`,
      "utf8"
    );
  }
}
