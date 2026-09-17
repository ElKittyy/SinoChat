import { types } from "node:util";
import {
  MatrixKeyUploadValidationError,
  hashMatrixCanonicalJson,
  parseInitialMatrixKeyUpload,
  type MatrixDeviceKeys
} from "./matrix-key-upload";

export interface MatrixDeviceCandidateExpectation {
  /** Internal Matrix identifiers derived by the server, never from this body. */
  userId: string;
  deviceId: string;
}

export interface MatrixDeviceCandidate {
  deviceKeys: MatrixDeviceKeys;
  /** Digest of the complete canonical public object, including its self-signature. */
  canonicalSha256: string;
  ed25519Key: string;
  curve25519Key: string;
}

/**
 * A public, self-signed candidate snapshot only. This neither proves an existing
 * user's approval nor creates a Device, publishes keys or authorizes any chat.
 * Prekeys, cross-signing roots and private material are deliberately excluded.
 * The entire result is frozen and shares no object references with the input.
 */
export function parseMatrixDeviceCandidate(
  value: unknown,
  expected: MatrixDeviceCandidateExpectation
): MatrixDeviceCandidate {
  const scope = dataRecord(expected, ["userId", "deviceId"], "MATRIX_EXPECTED_ID_INVALID");
  if (
    typeof scope.userId !== "string" || typeof scope.deviceId !== "string" ||
    !/^@u[0-9a-f]{32}:[^\s/@]{1,255}$/.test(scope.userId) ||
    !/^D[0-9A-F]{32}$/.test(scope.deviceId)
  ) {
    fail("MATRIX_EXPECTED_ID_INVALID");
  }
  const context = { userId: scope.userId, deviceId: scope.deviceId };
  const body = dataRecord(value, ["device_keys"], "MATRIX_CANDIDATE_BODY_INVALID");
  const device = dataRecord(
    body.device_keys,
    ["algorithms", "device_id", "keys", "signatures", "user_id"],
    "MATRIX_DEVICE_KEYS_NOT_OBJECT",
    "MATRIX_DEVICE_KEYS_FIELDS_INVALID"
  );
  const curveId = `curve25519:${context.deviceId}`;
  const signingId = `ed25519:${context.deviceId}`;
  const publicKeys = dataRecord(device.keys, [curveId, signingId], "MATRIX_DEVICE_PUBLIC_KEYS_INVALID");
  const signatures = dataRecord(device.signatures, [context.userId], "MATRIX_SIGNATURES_INVALID");
  const ownSignatures = dataRecord(signatures[context.userId], [signingId], "MATRIX_SIGNATURES_INVALID");

  // The shared upload parser consumes ordinary JSON. Reconstruct all containers
  // using data descriptors first, so its field reads cannot invoke accessors or
  // silently discard properties excluded from Object.keys / Array.prototype.some.
  const parsed = parseInitialMatrixKeyUpload({
    device_keys: {
      algorithms: algorithmArray(device.algorithms),
      device_id: device.device_id,
      keys: { [curveId]: publicKeys[curveId], [signingId]: publicKeys[signingId] },
      signatures: { [context.userId]: { [signingId]: ownSignatures[signingId] } },
      user_id: device.user_id
    }
  }, context);
  const deviceKeys = parsed.deviceKeys;
  const result: MatrixDeviceCandidate = {
    deviceKeys,
    canonicalSha256: hashMatrixCanonicalJson(deviceKeys),
    ed25519Key: deviceKeys.keys[signingId]!,
    curve25519Key: deviceKeys.keys[curveId]!
  };
  Object.freeze(deviceKeys.algorithms);
  Object.freeze(deviceKeys.keys);
  Object.freeze(deviceKeys.signatures[context.userId]);
  Object.freeze(deviceKeys.signatures);
  Object.freeze(deviceKeys);
  return Object.freeze(result);
}

function dataRecord(
  value: unknown,
  expected: readonly string[],
  objectCode: string,
  fieldsCode = objectCode
): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) {
    fail(objectCode);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) fail(objectCode);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || !expected.includes(key))) {
    fail(fieldsCode);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(fieldsCode);
    result[key] = descriptor.value;
  }
  return result;
}

function algorithmArray(value: unknown): unknown[] {
  const code = "MATRIX_DEVICE_ALGORITHMS_INVALID";
  if (!value || typeof value !== "object" || types.isProxy(value) || !Array.isArray(value)) fail(code);
  if (Object.getPrototypeOf(value) !== Array.prototype) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || keys.some((key) => key !== "0" && key !== "1" && key !== "length")) fail(code);
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || length.enumerable || !Object.hasOwn(length, "value") || length.value !== 2) fail(code);
  const result: unknown[] = [];
  for (const index of ["0", "1"]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(code);
    result.push(descriptor.value);
  }
  return result;
}

function fail(code: string): never {
  throw new MatrixKeyUploadValidationError(code);
}
