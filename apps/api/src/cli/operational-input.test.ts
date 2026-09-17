import {
  equal,
  match,
  throws
} from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import {
  parseInvestigationKeyInput,
  parseStrictInstant,
  parseTermsPublicationInput,
  sha256Hex,
  validateTermsDocument
} from "./operational-input";

describe("entrada operativa de términos", () => {
  it("acepta argumentos completos y fecha ISO con offset", () => {
    const input = parseTermsPublicationInput(
      [
        "--file",
        "legal/terminos.md",
        "--version=v2.0",
        "--type",
        "text/markdown",
        "--effective-at",
        "2026-08-01T12:00:00-03:00"
      ],
      {}
    );

    equal(input.file, "legal/terminos.md");
    equal(input.version, "v2.0");
    equal(input.sourceType, "text/markdown");
    equal(input.effectiveAt.toISOString(), "2026-08-01T15:00:00.000Z");
  });

  it("falla ante valores ausentes, desconocidos o contradictorios", () => {
    throws(
      () => parseTermsPublicationInput([], {}),
      /Debes indicar --file/
    );
    throws(
      () =>
        parseTermsPublicationInput(
          ["--desconocido", "valor"],
          {}
        ),
      /Argumento desconocido/
    );
    throws(
      () =>
        parseTermsPublicationInput(
          [
            "--file",
            "a.md",
            "--version",
            "v2",
            "--type",
            "text/markdown",
            "--effective-at",
            "2026-08-01T12:00:00Z"
          ],
          {
            TERMS_DOCUMENT_FILE: "otro.md"
          }
        ),
      /contienen valores diferentes/
    );
  });

  it("rechaza calendarios normalizados silenciosamente", () => {
    throws(
      () =>
        parseStrictInstant(
          "2026-02-30T12:00:00Z",
          "La fecha"
        ),
      /fecha u hora inválida/
    );
    throws(
      () =>
        parseStrictInstant(
          "2026-08-01T12:00:00",
          "La fecha"
        ),
      /offset explícito/
    );
  });

  it("valida UTF-8 y calcula el hash de los bytes exactos", () => {
    const bytes = Buffer.from("# Términos\r\n", "utf8");
    const result = validateTermsDocument(
      bytes,
      "text/markdown"
    );

    equal(result.byteSize, bytes.byteLength);
    equal(result.sha256, sha256Hex(bytes));
    throws(
      () =>
        validateTermsDocument(
          Buffer.from([0xc3, 0x28]),
          "text/plain"
        ),
      /UTF-8 válido/
    );
    throws(
      () =>
        validateTermsDocument(
          Buffer.from(" \n\t", "utf8"),
          "text/plain"
        ),
      /no puede estar vacío/
    );
  });
});

describe("entrada operativa de InvestigationKey", () => {
  it("acepta exclusivamente material público con fingerprint verificable", () => {
    const publicKey = x25519PublicSpki();
    const input = parseInvestigationKeyInput(
      [],
      {
        INVESTIGATION_PUBLIC_KEY_BASE64:
          publicKey.toString("base64"),
        INVESTIGATION_KEY_ALGORITHM: "X25519",
        INVESTIGATION_KEY_FINGERPRINT: sha256Hex(publicKey),
        INVESTIGATION_KEY_VERSION: "3"
      }
    );

    equal(input.publicKey.byteLength, publicKey.byteLength);
    equal(input.algorithm, "X25519");
    equal(input.version, 3);
    equal(input.fingerprint, sha256Hex(publicKey));
  });

  it("rechaza fingerprint incorrecto, Base64 no canónico y versión inválida", () => {
    const publicKey = x25519PublicSpki();
    const baseEnvironment = {
      INVESTIGATION_PUBLIC_KEY_BASE64:
        publicKey.toString("base64"),
      INVESTIGATION_KEY_ALGORITHM: "X25519",
      INVESTIGATION_KEY_FINGERPRINT: sha256Hex(publicKey),
      INVESTIGATION_KEY_VERSION: "1"
    };

    throws(
      () =>
        parseInvestigationKeyInput([], {
          ...baseEnvironment,
          INVESTIGATION_KEY_FINGERPRINT: "a".repeat(64)
        }),
      /no coincide/
    );
    throws(
      () =>
        parseInvestigationKeyInput([], {
          ...baseEnvironment,
          INVESTIGATION_PUBLIC_KEY_BASE64: " YWJjZA=="
        }),
      /espacios exteriores|Base64 canónico/
    );
    throws(
      () =>
        parseInvestigationKeyInput([], {
          ...baseEnvironment,
          INVESTIGATION_KEY_VERSION: "1.5"
        }),
      /debe ser un entero/
    );
  });

  it("rechaza cualquier intento conocido de introducir clave privada", () => {
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    const publicSpki = publicKey.export({
      format: "der",
      type: "spki"
    });
    const privatePkcs8 = privateKey.export({
      format: "der",
      type: "pkcs8"
    });
    const environment = {
      INVESTIGATION_PUBLIC_KEY_BASE64:
        publicSpki.toString("base64"),
      INVESTIGATION_KEY_ALGORITHM: "X25519",
      INVESTIGATION_KEY_FINGERPRINT: sha256Hex(publicSpki),
      INVESTIGATION_KEY_VERSION: "1",
      INVESTIGATION_PRIVATE_KEY_BASE64: "no-debe-entrar"
    };

    throws(
      () => parseInvestigationKeyInput([], environment),
      /rechaza material privado/
    );
    throws(
      () =>
        parseInvestigationKeyInput(
          ["--private-key", "no-debe-entrar"],
          {
            ...environment,
            INVESTIGATION_PRIVATE_KEY_BASE64: undefined
          }
        ),
      /Argumento desconocido/
    );
    throws(
      () =>
        parseInvestigationKeyInput([], {
          ...environment,
          INVESTIGATION_PRIVATE_KEY_BASE64: undefined,
          INVESTIGATION_PUBLIC_KEY_BASE64:
            privatePkcs8.toString("base64"),
          INVESTIGATION_KEY_FINGERPRINT:
            sha256Hex(privatePkcs8)
        }),
      /clave pública DER SPKI/
    );
  });

  it("no incluye material público en mensajes de validación", () => {
    const keyText = x25519PublicSpki().toString("base64");
    let message = "";
    try {
      parseInvestigationKeyInput([], {
        INVESTIGATION_PUBLIC_KEY_BASE64: keyText,
        INVESTIGATION_KEY_ALGORITHM: "algoritmo con espacios",
        INVESTIGATION_KEY_FINGERPRINT: "a".repeat(64),
        INVESTIGATION_KEY_VERSION: "1"
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    match(message, /algoritmo|fingerprint/);
    equal(message.includes(keyText), false);
  });
});

function x25519PublicSpki(): Buffer {
  const { publicKey } = generateKeyPairSync("x25519");
  return publicKey.export({
    format: "der",
    type: "spki"
  });
}
