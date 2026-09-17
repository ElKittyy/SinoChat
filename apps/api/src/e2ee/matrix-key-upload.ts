import {
  createHash,
  createPublicKey,
  verify as verifySignature
} from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";

export const MATRIX_OLM_ALGORITHM =
  "m.olm.v1.curve25519-aes-sha2" as const;
export const MATRIX_MEGOLM_ALGORITHM =
  "m.megolm.v1.aes-sha2" as const;
export const MATRIX_SIGNED_CURVE25519_ALGORITHM =
  "signed_curve25519" as const;

const EXPECTED_ALGORITHMS = [
  MATRIX_OLM_ALGORITHM,
  MATRIX_MEGOLM_ALGORITHM
] as const;
const ED25519_SPKI_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex"
);
const KEY_ID_PATTERN = /^[A-Za-z0-9._=-]{1,64}$/;
const MATRIX_USER_ID_PATTERN = /^@u[0-9a-f]{32}:[^\s/@]{1,255}$/;
const MATRIX_DEVICE_ID_PATTERN = /^D[0-9A-F]{32}$/;
const MAX_ONE_TIME_KEYS_PER_UPLOAD = 100;

export interface MatrixSignedCurveKey {
  key: string;
  fallback?: true;
  signatures: Record<string, Record<string, string>>;
}

export interface MatrixDeviceKeys {
  algorithms: [typeof MATRIX_OLM_ALGORITHM, typeof MATRIX_MEGOLM_ALGORITHM];
  device_id: string;
  keys: Record<string, string>;
  signatures: Record<string, Record<string, string>>;
  user_id: string;
}

export interface InitialMatrixKeyUpload {
  deviceKeys: MatrixDeviceKeys;
  oneTimeKeys: Record<string, MatrixSignedCurveKey>;
  fallbackKeys: Record<string, MatrixSignedCurveKey>;
}

export interface MatrixKeyUpload {
  deviceKeys?: MatrixDeviceKeys;
  oneTimeKeys: Record<string, MatrixSignedCurveKey>;
  fallbackKeys: Record<string, MatrixSignedCurveKey>;
}

export interface MatrixKeyUploadExpectation {
  userId: string;
  deviceId: string;
  /** Clave Ed25519 publica obtenida del directorio inmutable del dispositivo. */
  existingEd25519PublicKey?: string;
}

export class MatrixKeyUploadValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MatrixKeyUploadValidationError";
  }
}

/**
 * Valida la primera publicacion producida por OlmMachine. El resultado solo
 * contiene material publico y conserva el JSON firmado sin normalizarlo.
 */
export function parseInitialMatrixKeyUpload(
  value: unknown,
  expected: { userId: string; deviceId: string }
): InitialMatrixKeyUpload {
  const parsed = parseMatrixKeyUpload(value, expected);
  if (!parsed.deviceKeys) {
    fail("MATRIX_DEVICE_KEYS_REQUIRED");
  }
  return {
    deviceKeys: parsed.deviceKeys,
    oneTimeKeys: parsed.oneTimeKeys,
    fallbackKeys: parsed.fallbackKeys
  };
}

/**
 * Valida tanto la publicacion inicial como las reposiciones parciales emitidas
 * por OlmMachine. Sin device_keys, la firma se verifica exclusivamente contra
 * la Ed25519 que el servidor ya persiste para el dispositivo autenticado.
 */
export function parseMatrixKeyUpload(
  value: unknown,
  expected: MatrixKeyUploadExpectation
): MatrixKeyUpload {
  if (
    !MATRIX_USER_ID_PATTERN.test(expected.userId) ||
    !MATRIX_DEVICE_ID_PATTERN.test(expected.deviceId)
  ) {
    fail("MATRIX_EXPECTED_ID_INVALID");
  }

  const body = record(value, "MATRIX_UPLOAD_NOT_OBJECT");
  optionalKeys(
    body,
    ["device_keys", "fallback_keys", "one_time_keys"],
    "MATRIX_UPLOAD_FIELDS_INVALID"
  );

  const deviceKeys = Object.hasOwn(body, "device_keys")
    ? parseDeviceKeys(body.device_keys, expected.userId, expected.deviceId)
    : undefined;
  let ed25519PublicKey = expected.existingEd25519PublicKey;
  if (ed25519PublicKey !== undefined) {
    assertMatrixEd25519PublicKey(
      ed25519PublicKey,
      "MATRIX_EXISTING_ED25519_KEY_INVALID"
    );
  }

  if (deviceKeys) {
    const uploadedEd25519 =
      deviceKeys.keys[`ed25519:${expected.deviceId}`];
    if (!uploadedEd25519) {
      fail("MATRIX_ED25519_KEY_MISSING");
    }
    if (
      ed25519PublicKey !== undefined &&
      ed25519PublicKey !== uploadedEd25519
    ) {
      fail("MATRIX_DEVICE_IDENTITY_CHANGE_FORBIDDEN");
    }
    verifyMatrixSignedObject(
      deviceKeys,
      expected.userId,
      `ed25519:${expected.deviceId}`,
      uploadedEd25519,
      "MATRIX_DEVICE_SIGNATURE_INVALID"
    );
    ed25519PublicKey = uploadedEd25519;
  }

  if (!ed25519PublicKey) {
    fail("MATRIX_DEVICE_KEYS_REQUIRED");
  }

  const oneTimeKeys = parseCurveKeyMap(
    body.one_time_keys ?? {},
    false,
    expected,
    ed25519PublicKey,
    MAX_ONE_TIME_KEYS_PER_UPLOAD
  );
  const fallbackKeys = parseCurveKeyMap(
    body.fallback_keys ?? {},
    true,
    expected,
    ed25519PublicKey,
    1
  );

  const curveKeys = [
    ...Object.values(oneTimeKeys),
    ...Object.values(fallbackKeys)
  ].map((key) => key.key);
  if (new Set(curveKeys).size !== curveKeys.length) {
    fail("MATRIX_CURVE_KEY_REUSED");
  }
  const identityCurveKey =
    deviceKeys?.keys[`curve25519:${expected.deviceId}`];
  if (identityCurveKey && curveKeys.includes(identityCurveKey)) {
    fail("MATRIX_CURVE_KEY_REUSED");
  }

  return { deviceKeys, oneTimeKeys, fallbackKeys };
}

/** Matrix canonical JSON for the constrained signed objects used here. */
export function encodeMatrixCanonicalJson(value: unknown): Buffer {
  return Buffer.from(encodeCanonical(value), "utf8");
}

export function hashMatrixCanonicalJson(value: unknown): string {
  return createHash("sha256")
    .update(encodeMatrixCanonicalJson(value))
    .digest("hex");
}

/** Reject noncanonical/off-curve/small-order public points, including unsigned subkeys. */
export function assertMatrixEd25519PublicKey(value: string, errorCode: string): void {
  assertStrongEd25519Point(canonicalBase64(value, 32, errorCode), errorCode);
}

function parseDeviceKeys(
  value: unknown,
  expectedUserId: string,
  expectedDeviceId: string
): MatrixDeviceKeys {
  const input = record(value, "MATRIX_DEVICE_KEYS_NOT_OBJECT");
  exactKeys(
    input,
    ["algorithms", "device_id", "keys", "signatures", "user_id"],
    "MATRIX_DEVICE_KEYS_FIELDS_INVALID"
  );

  if (
    input.user_id !== expectedUserId ||
    input.device_id !== expectedDeviceId
  ) {
    fail("MATRIX_DEVICE_IDENTITY_MISMATCH");
  }

  if (
    !Array.isArray(input.algorithms) ||
    input.algorithms.length !== EXPECTED_ALGORITHMS.length ||
    input.algorithms.some(
      (algorithm, index) => algorithm !== EXPECTED_ALGORITHMS[index]
    )
  ) {
    fail("MATRIX_DEVICE_ALGORITHMS_INVALID");
  }

  const keys = record(input.keys, "MATRIX_DEVICE_PUBLIC_KEYS_INVALID");
  const curveKeyId = `curve25519:${expectedDeviceId}`;
  const signingKeyId = `ed25519:${expectedDeviceId}`;
  exactKeys(
    keys,
    [curveKeyId, signingKeyId],
    "MATRIX_DEVICE_PUBLIC_KEYS_INVALID"
  );
  canonicalBase64(keys[curveKeyId], 32, "MATRIX_CURVE25519_KEY_INVALID");
  canonicalBase64(keys[signingKeyId], 32, "MATRIX_ED25519_KEY_INVALID");

  const signatures = parseExactSignatureMap(
    input.signatures,
    expectedUserId,
    signingKeyId
  );

  return {
    algorithms: [...EXPECTED_ALGORITHMS],
    device_id: expectedDeviceId,
    keys: {
      [curveKeyId]: keys[curveKeyId] as string,
      [signingKeyId]: keys[signingKeyId] as string
    },
    signatures,
    user_id: expectedUserId
  };
}

function parseCurveKeyMap(
  value: unknown,
  fallback: boolean,
  expected: { userId: string; deviceId: string },
  ed25519PublicKey: string,
  maximumEntries: number
): Record<string, MatrixSignedCurveKey> {
  const input = record(value, "MATRIX_CURVE_KEY_MAP_INVALID");
  const entries = Object.entries(input);
  if (entries.length > maximumEntries) {
    fail("MATRIX_CURVE_KEY_LIMIT_EXCEEDED");
  }

  const signingKeyId = `ed25519:${expected.deviceId}`;
  const result: Record<string, MatrixSignedCurveKey> = {};
  for (const [fullKeyId, rawKey] of entries) {
    const [algorithm, keyId, extra] = fullKeyId.split(":");
    if (
      algorithm !== MATRIX_SIGNED_CURVE25519_ALGORITHM ||
      !keyId ||
      extra !== undefined ||
      !KEY_ID_PATTERN.test(keyId)
    ) {
      fail("MATRIX_CURVE_KEY_ID_INVALID");
    }

    const key = record(rawKey, "MATRIX_CURVE_KEY_INVALID");
    exactKeys(
      key,
      fallback ? ["fallback", "key", "signatures"] : ["key", "signatures"],
      "MATRIX_CURVE_KEY_FIELDS_INVALID"
    );
    if (fallback && key.fallback !== true) {
      fail("MATRIX_FALLBACK_FLAG_INVALID");
    }
    canonicalBase64(key.key, 32, "MATRIX_CURVE25519_KEY_INVALID");
    const signatures = parseExactSignatureMap(
      key.signatures,
      expected.userId,
      signingKeyId
    );

    const parsed: MatrixSignedCurveKey = {
      key: key.key as string,
      signatures
    };
    if (fallback) parsed.fallback = true;

    verifyMatrixSignedObject(
      parsed,
      expected.userId,
      signingKeyId,
      ed25519PublicKey,
      "MATRIX_CURVE_KEY_SIGNATURE_INVALID"
    );
    result[fullKeyId] = parsed;
  }
  return result;
}

function parseExactSignatureMap(
  value: unknown,
  expectedSigner: string,
  expectedKeyId: string
): Record<string, Record<string, string>> {
  const signatures = record(value, "MATRIX_SIGNATURES_INVALID");
  exactKeys(signatures, [expectedSigner], "MATRIX_SIGNATURES_INVALID");
  const signer = record(
    signatures[expectedSigner],
    "MATRIX_SIGNATURES_INVALID"
  );
  exactKeys(signer, [expectedKeyId], "MATRIX_SIGNATURES_INVALID");
  canonicalBase64(
    signer[expectedKeyId],
    64,
    "MATRIX_SIGNATURE_ENCODING_INVALID"
  );
  return {
    [expectedSigner]: {
      [expectedKeyId]: signer[expectedKeyId] as string
    }
  };
}

/** Cryptographic verification only; callers must first validate the object schema. */
export function verifyMatrixSignedObject(
  value: object,
  signer: string,
  keyId: string,
  publicKeyBase64: string,
  errorCode: string
): void {
  const signedRecord = value as Record<string, unknown>;
  const signatures = record(
    signedRecord.signatures,
    "MATRIX_SIGNATURES_INVALID"
  );
  const signerSignatures = record(
    signatures[signer],
    "MATRIX_SIGNATURES_INVALID"
  );
  const signature = canonicalBase64(
    signerSignatures[keyId],
    64,
    "MATRIX_SIGNATURE_ENCODING_INVALID"
  );
  const publicKey = canonicalBase64(
    publicKeyBase64,
    32,
    "MATRIX_ED25519_KEY_INVALID"
  );
  // OpenSSL alone accepts some small-order public keys with signatures that
  // require no secret. Match the SDK's strict point policy for both A and R,
  // while retaining native signature verification (not Noble's default ZIP215).
  assertStrongEd25519Point(publicKey, errorCode);
  assertStrongEd25519Point(signature.subarray(0, 32), errorCode);
  const signedValue = { ...signedRecord };
  delete signedValue.signatures;
  delete signedValue.unsigned;

  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
    format: "der",
    type: "spki"
  });
  if (
    !verifySignature(
      null,
      encodeMatrixCanonicalJson(signedValue),
      key,
      signature
    )
  ) {
    fail(errorCode);
  }
}

function assertStrongEd25519Point(bytes: Uint8Array, errorCode: string): void {
  let smallOrder: boolean;
  try {
    smallOrder = ed25519.Point.fromBytes(bytes, false).isSmallOrder();
  } catch {
    fail(errorCode);
  }
  if (smallOrder) fail(errorCode);
}

function canonicalBase64(
  value: unknown,
  expectedBytes: number,
  errorCode: string
): Buffer {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2,3})?$/.test(value) ||
    value.includes("=")
  ) {
    fail(errorCode);
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength !== expectedBytes ||
    decoded.toString("base64").replace(/=+$/u, "") !== value
  ) {
    fail(errorCode);
  }
  return decoded;
}

function encodeCanonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      fail("MATRIX_CANONICAL_JSON_NUMBER_INVALID");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(encodeCanonical).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareUnicodeCodePoints)
      .map(
        (key) => `${JSON.stringify(key)}:${encodeCanonical(value[key])}`
      )
      .join(",")}}`;
  }
  fail("MATRIX_CANONICAL_JSON_TYPE_INVALID");
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference =
      (a[index]?.codePointAt(0) ?? 0) - (b[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  errorCode: string
): void {
  const actual = Object.keys(value).sort(compareUnicodeCodePoints);
  const allowed = [...expected].sort(compareUnicodeCodePoints);
  if (
    actual.length !== allowed.length ||
    actual.some((key, index) => key !== allowed[index])
  ) {
    fail(errorCode);
  }
}

function optionalKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  errorCode: string
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    fail(errorCode);
  }
}

function record(value: unknown, errorCode: string): Record<string, unknown> {
  if (!isRecord(value)) fail(errorCode);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function fail(code: string): never {
  throw new MatrixKeyUploadValidationError(code);
}
