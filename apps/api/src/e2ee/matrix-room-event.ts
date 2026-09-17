const MATRIX_DEVICE_ID_PATTERN = /^D[0-9A-F]{32}$/;
const MAX_MEGOLM_CONTENT_BYTES = 128 * 1024;
const MIN_MEGOLM_CIPHERTEXT_BYTES = 16;

export const MATRIX_MEGOLM_ALGORITHM = "m.megolm.v1.aes-sha2";

export interface MatrixMegolmRoomContent {
  algorithm: typeof MATRIX_MEGOLM_ALGORITHM;
  ciphertext: string;
  device_id: string;
  sender_key: string;
  session_id: string;
}

export class MatrixRoomEventValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MatrixRoomEventValidationError";
  }
}

/**
 * Valida la forma exacta emitida por encryptRoomEvent en Rust Crypto 18.6.0.
 * Esto no descifra ni autentica el plaintext: el receptor debe comparar los
 * bindings interiores despues de decryptRoomEvent.
 */
export function parseMatrixMegolmRoomContent(
  value: unknown
): MatrixMegolmRoomContent {
  const content = record(value, "MATRIX_MEGOLM_CONTENT_INVALID");
  exactKeys(
    content,
    [
      "algorithm",
      "ciphertext",
      "device_id",
      "sender_key",
      "session_id"
    ],
    "MATRIX_MEGOLM_CONTENT_FIELDS_INVALID"
  );
  if (
    content.algorithm !== MATRIX_MEGOLM_ALGORITHM ||
    typeof content.device_id !== "string" ||
    !MATRIX_DEVICE_ID_PATTERN.test(content.device_id) ||
    typeof content.sender_key !== "string" ||
    !isCanonicalUnpaddedBase64(content.sender_key, 32) ||
    typeof content.session_id !== "string" ||
    !isCanonicalUnpaddedBase64(content.session_id, 32) ||
    typeof content.ciphertext !== "string" ||
    !isCanonicalUnpaddedBase64(
      content.ciphertext,
      undefined,
      MIN_MEGOLM_CIPHERTEXT_BYTES
    )
  ) {
    fail("MATRIX_MEGOLM_ENVELOPE_INVALID");
  }
  if (Buffer.byteLength(JSON.stringify(content), "utf8") > MAX_MEGOLM_CONTENT_BYTES) {
    fail("MATRIX_MEGOLM_CONTENT_TOO_LARGE");
  }
  return {
    algorithm: MATRIX_MEGOLM_ALGORITHM,
    ciphertext: content.ciphertext,
    device_id: content.device_id,
    sender_key: content.sender_key,
    session_id: content.session_id
  };
}

function isCanonicalUnpaddedBase64(
  value: string,
  expectedBytes?: number,
  minimumBytes = 1
): boolean {
  if (!/^[A-Za-z0-9+/]+$/.test(value) || value.length % 4 === 1) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength < minimumBytes ||
    (expectedBytes !== undefined && decoded.byteLength !== expectedBytes)
  ) {
    return false;
  }
  return decoded.toString("base64").replace(/=+$/u, "") === value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: string
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    fail(code);
  }
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    fail(code);
  }
  return value as Record<string, unknown>;
}

function fail(code: string): never {
  throw new MatrixRoomEventValidationError(code);
}
