import {
  equal,
  match,
  notEqual,
  ok,
  throws
} from "node:assert/strict";
import { describe, it } from "node:test";
import { PasswordService } from "./password.service";
import { SessionTokenService } from "./session-token.service";
import { InvitationCryptoService } from "../invitations/invitation-crypto.service";
import { UserRole } from "../generated/prisma/enums";

describe("PasswordService", () => {
  it("genera Argon2id y rechaza otra contraseña", async () => {
    const service = new PasswordService();
    const hash = await service.hash("contraseña-de-prueba-segura");

    match(hash, /^\$argon2id\$/);
    equal(
      await service.verify(hash, "contraseña-de-prueba-segura"),
      true
    );
    equal(await service.verify(hash, "otra-contraseña"), false);
  });

  it("trata un hash corrupto como credencial inválida", async () => {
    const service = new PasswordService();
    equal(await service.verify("hash-inválido", "contraseña"), false);
  });
});

describe("SessionTokenService", () => {
  it("genera secretos distintos y solo conserva su hash", () => {
    const service = new SessionTokenService();
    const first = service.create();
    const second = service.create();

    notEqual(first.token, second.token);
    notEqual(first.token, first.tokenHash);
    equal(service.hash(first.token), first.tokenHash);
    equal(first.tokenHash.length, 64);
  });

  it("calcula una expiración futura", () => {
    withEnvironmentVariable("NODE_ENV", "test", () => {
      const service = new SessionTokenService();
      const now = new Date("2026-07-26T00:00:00.000Z");
      ok(service.expiresAt(now) > now);
    });
  });

  it("aplica un TTL absoluto corto solo al administrador", () => {
    withEnvironmentVariable("NODE_ENV", "test", () =>
      withEnvironmentVariable("SESSION_TTL_HOURS", "168", () =>
        withEnvironmentVariable("ADMIN_SESSION_TTL_HOURS", "12", () =>
          withEnvironmentVariable(
            "ADMIN_SESSION_IDLE_TIMEOUT_MINUTES",
            "30",
            () => {
              const service = new SessionTokenService();
              const now = new Date("2026-08-26T00:00:00.000Z");

              equal(
                service.expiresAt(now, UserRole.ADMIN).toISOString(),
                "2026-08-26T12:00:00.000Z"
              );
              equal(
                service.expiresAt(now, UserRole.CLIENT).toISOString(),
                "2026-09-02T00:00:00.000Z"
              );
              equal(
                service.expiresAt(now, UserRole.CASHIER).toISOString(),
                "2026-09-02T00:00:00.000Z"
              );
            }
          )
        )
      )
    );
  });
});

function withEnvironmentVariable<T>(
  name: string,
  value: string,
  action: () => T
): T {
  const previous = process.env[name];
  process.env[name] = value;

  try {
    return action();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

describe("InvitationCryptoService", () => {
  const cipherContext = {
    kind: "client" as const,
    invitationId: "11111111-1111-4111-8111-111111111111",
    ownerUserId: "22222222-2222-4222-8222-222222222222"
  };

  it("genera 128 bits aleatorios y recupera el código autenticado", () => {
    withInvitationEnvironment(
      {
        currentKey: Buffer.alloc(32, 7).toString("base64"),
        currentVersion: "3"
      },
      () => {
        const service = new InvitationCryptoService();
        const firstCode = service.generateCode();
        const secondCode = service.generateCode();
        const encrypted = service.encrypt(firstCode, cipherContext);

        match(firstCode, /^SINO-[A-F0-9]{32}$/);
        notEqual(firstCode, secondCode);
        equal(encrypted.keyVersion, 3);
        equal(
          service.decrypt(
            encrypted.ciphertext,
            encrypted.nonce,
            encrypted.keyVersion,
            encrypted.formatVersion,
            cipherContext
          ),
          firstCode
        );
        equal(service.lookupHash(firstCode).length, 64);
      }
    );
  });

  it("rechaza un código cifrado alterado", () => {
    withInvitationEnvironment(
      { currentKey: Buffer.alloc(32, 9).toString("base64") },
      () => {
        const service = new InvitationCryptoService();
        const encrypted = service.encrypt(
          service.generateCode(),
          cipherContext
        );
        encrypted.ciphertext[0] ^= 1;

        throws(() =>
          service.decrypt(
            encrypted.ciphertext,
            encrypted.nonce,
            encrypted.keyVersion,
            encrypted.formatVersion,
            cipherContext
          )
        );
      }
    );
  });

  it("descifra invitaciones anteriores mediante su versión después de rotar", () => {
    const oldKey = Buffer.alloc(32, 11).toString("base64");
    const newKey = Buffer.alloc(32, 12).toString("base64");
    let oldCiphertext!: ReturnType<InvitationCryptoService["encrypt"]>;
    let oldCode = "";

    withInvitationEnvironment(
      { currentKey: oldKey, currentVersion: "1" },
      () => {
        const service = new InvitationCryptoService();
        oldCode = service.generateCode();
        oldCiphertext = service.encrypt(oldCode, cipherContext);
      }
    );

    withInvitationEnvironment(
      {
        currentKey: newKey,
        currentVersion: "2",
        previousKeys: JSON.stringify({ 1: oldKey })
      },
      () => {
        const service = new InvitationCryptoService();
        equal(
          service.decrypt(
            oldCiphertext.ciphertext,
            oldCiphertext.nonce,
            oldCiphertext.keyVersion,
            oldCiphertext.formatVersion,
            cipherContext
          ),
          oldCode
        );
        const current = service.encrypt(
          service.generateCode(),
          cipherContext
        );
        equal(current.keyVersion, 2);
      }
    );

    withInvitationEnvironment(
      { currentKey: newKey, currentVersion: "2" },
      () => {
        throws(
          () =>
            new InvitationCryptoService().decrypt(
              oldCiphertext.ciphertext,
              oldCiphertext.nonce,
              oldCiphertext.keyVersion,
              oldCiphertext.formatVersion,
              cipherContext
            ),
          /versión 1/
        );
      }
    );
  });
});

function withInvitationEnvironment<T>(
  input: {
    currentKey: string;
    currentVersion?: string;
    previousKeys?: string;
  },
  action: () => T
): T {
  const names = [
    "INVITATION_ENCRYPTION_KEY",
    "INVITATION_ENCRYPTION_KEY_VERSION",
    "INVITATION_ENCRYPTION_PREVIOUS_KEYS"
  ] as const;
  const previous = new Map(
    names.map((name) => [name, process.env[name]])
  );
  process.env.INVITATION_ENCRYPTION_KEY = input.currentKey;
  process.env.INVITATION_ENCRYPTION_KEY_VERSION =
    input.currentVersion ?? "1";
  if (input.previousKeys === undefined) {
    delete process.env.INVITATION_ENCRYPTION_PREVIOUS_KEYS;
  } else {
    process.env.INVITATION_ENCRYPTION_PREVIOUS_KEYS = input.previousKeys;
  }

  try {
    return action();
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
