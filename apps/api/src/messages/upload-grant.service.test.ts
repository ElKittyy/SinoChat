import {
  deepEqual,
  equal,
  throws
} from "node:assert/strict";
import { describe, it } from "node:test";
import { UploadGrantService } from "./upload-grant.service";

describe("UploadGrantService", () => {
  it("firma y valida un permiso limitado a usuario y conversación", () => {
    const previousSecret = process.env.ATTACHMENT_GRANT_SECRET;
    process.env.ATTACHMENT_GRANT_SECRET = "x".repeat(32);

    try {
      const service = new UploadGrantService();
      const grantNow = new Date(Date.now());
      const created = service.create(
        "8cb41251-55ad-4d90-acab-f412298f0406",
        "d63d70be-5ef6-469b-b51d-5d4a861e3f37",
        {
          declaredMimeType: "image/webp",
          plaintextByteSize: 1_024,
          ciphertextByteSize: 1_088,
          ciphertextSha256: "a".repeat(64)
        },
        grantNow
      );

      deepEqual(service.verify(created.token), created.grant);
      equal(
        created.grant.expiresAt,
        grantNow.getTime() + 10 * 60_000
      );
      service.assertMatches(
        created.grant,
        created.grant.userId,
        created.grant.conversationId
      );
    } finally {
      restore("ATTACHMENT_GRANT_SECRET", previousSecret);
    }
  });

  it("rechaza alteraciones y reutilización en otra conversación", () => {
    const previousSecret = process.env.ATTACHMENT_GRANT_SECRET;
    process.env.ATTACHMENT_GRANT_SECRET = "y".repeat(32);

    try {
      const service = new UploadGrantService();
      const created = service.create("usuario", "chat-a", {
        declaredMimeType: "image/png",
        plaintextByteSize: 100,
        ciphertextByteSize: 150,
        ciphertextSha256: "b".repeat(64)
      });
      const finalCharacter = created.token.at(-1);
      const tampered = `${created.token.slice(0, -1)}${
        finalCharacter === "A" ? "B" : "A"
      }`;

      throws(() => service.verify(tampered));
      throws(() =>
        service.assertMatches(created.grant, "usuario", "chat-b")
      );
      equal(service.verify(created.token).conversationId, "chat-a");
    } finally {
      restore("ATTACHMENT_GRANT_SECRET", previousSecret);
    }
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
