import { createHash } from "node:crypto";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_CLIENT_DATA_BYTES = 8 * 1024;

export const ADMIN_WEBAUTHN_CHALLENGE_TTL_MILLISECONDS = 5 * 60_000;
export const ADMIN_MFA_STEP_UP_TTL_MILLISECONDS = 5 * 60_000;

export function hashWebAuthnChallenge(challenge: string): string {
  return createHash("sha256")
    .update("sinochat:admin-webauthn-challenge:v1\0", "utf8")
    .update(challenge, "utf8")
    .digest("hex");
}

export function extractWebAuthnChallenge(response: unknown): string {
  if (!isRecord(response) || !isRecord(response.response)) {
    throw new Error("WEBAUTHN_RESPONSE_INVALID");
  }
  const encoded = response.response.clientDataJSON;
  if (
    typeof encoded !== "string" ||
    encoded.length < 16 ||
    encoded.length > MAX_CLIENT_DATA_BYTES * 2 ||
    !BASE64URL_PATTERN.test(encoded)
  ) {
    throw new Error("WEBAUTHN_CLIENT_DATA_INVALID");
  }

  const bytes = Buffer.from(encoded, "base64url");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_CLIENT_DATA_BYTES ||
    bytes.toString("base64url") !== encoded
  ) {
    throw new Error("WEBAUTHN_CLIENT_DATA_INVALID");
  }

  let decoded: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    decoded = JSON.parse(text);
  } catch {
    throw new Error("WEBAUTHN_CLIENT_DATA_INVALID");
  }
  if (!isRecord(decoded)) {
    throw new Error("WEBAUTHN_CLIENT_DATA_INVALID");
  }
  if (
    ("crossOrigin" in decoded && decoded.crossOrigin !== false) ||
    "topOrigin" in decoded
  ) {
    throw new Error("WEBAUTHN_CROSS_ORIGIN_FORBIDDEN");
  }
  const challenge = decoded.challenge;
  if (
    typeof challenge !== "string" ||
    challenge.length < 32 ||
    challenge.length > 512 ||
    !BASE64URL_PATTERN.test(challenge)
  ) {
    throw new Error("WEBAUTHN_CHALLENGE_INVALID");
  }
  return challenge;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
