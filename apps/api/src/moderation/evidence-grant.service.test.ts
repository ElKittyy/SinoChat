import {
  equal,
  match,
  throws
} from "node:assert/strict";
import { describe, it } from "node:test";
import { EvidenceGrantService } from "./evidence-grant.service";

const input = {
  investigationKeyId: "77aa329b-f312-4b00-ae22-8b959829a132",
  ciphertextByteSize: 42_000,
  ciphertextSha256: "A".repeat(64),
  cipherSuite: "HPKE-X25519-HKDF-SHA256-AES256GCM",
  manifestVersion: 1
};

describe("EvidenceGrantService", () => {
  it("firma un permiso ligado a cliente, asignación y conversación", () => {
    const service = configuredService();
    const { grant, token } = service.create(
      "client-1",
      "assignment-1",
      "conversation-1",
      input
    );
    const verified = service.verify(token);

    equal(verified.clientUserId, "client-1");
    equal(verified.assignmentId, "assignment-1");
    equal(verified.conversationId, "conversation-1");
    equal(verified.ciphertextSha256, "a".repeat(64));
    match(verified.objectKey, /^investigations\/report-evidence\//);
    equal(verified.objectKey, grant.objectKey);
  });

  it("rechaza alteraciones y el uso por otro cliente", () => {
    const service = configuredService();
    const { token, grant } = service.create(
      "client-1",
      "assignment-1",
      "conversation-1",
      input
    );
    const [payload, signature] = token.split(".");
    const alteredSignature = `${signature.startsWith("a") ? "b" : "a"}${signature.slice(1)}`;

    throws(
      () => service.verify(`${payload}.${alteredSignature}`),
      /permiso de evidencia es inválido/
    );
    throws(
      () => service.assertOwnedBy(grant, "client-2"),
      /no pertenece a este cliente/
    );
  });

  it("rechaza permisos vencidos", () => {
    const service = configuredService();
    const originalNow = Date.now;
    try {
      Date.now = () => 1_000_000;
      const { token } = service.create(
        "client-1",
        "assignment-1",
        "conversation-1",
        input
      );
      Date.now = () => 1_000_000 + 10 * 60_000 + 1;

      throws(
        () => service.verify(token),
        /venció o es inválido/
      );
    } finally {
      Date.now = originalNow;
    }
  });
});

function configuredService(): EvidenceGrantService {
  process.env.EVIDENCE_UPLOAD_GRANT_SECRET =
    "test-evidence-secret-with-at-least-32-bytes";
  return new EvidenceGrantService();
}
