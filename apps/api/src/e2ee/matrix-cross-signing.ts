import {
  MATRIX_MEGOLM_ALGORITHM,
  MATRIX_OLM_ALGORITHM,
  MatrixDeviceKeys,
  MatrixKeyUploadValidationError,
  assertMatrixEd25519PublicKey,
  encodeMatrixCanonicalJson,
  parseInitialMatrixKeyUpload,
  verifyMatrixSignedObject
} from "./matrix-key-upload";

type CrossSigningUsage = "master" | "self_signing" | "user_signing";

export interface MatrixCrossSigningKey {
  keys: Record<string, string>;
  signatures: Record<string, Record<string, string>>;
  usage: [CrossSigningUsage];
  user_id: string;
}

export interface MatrixCrossSigningPublicIdentity {
  userId: string;
  masterKey: string;
  selfSigningKey: string;
  userSigningKey: string;
}

export interface MatrixCrossSigningBootstrapExpectation {
  /** Derived from the authenticated, eligible user's current device, not the body. */
  userId: string;
  deviceId: string;
  /** Immutable original, self-signed device keys loaded from the directory. */
  registeredDeviceKeys: unknown;
  /** Required: null ONLY when no identity exists, otherwise the persisted triplet. */
  pinnedIdentity: MatrixCrossSigningPublicIdentity | null;
}

export interface MatrixCrossSigningBootstrap {
  signingKeys: {
    master_key: MatrixCrossSigningKey;
    self_signing_key: MatrixCrossSigningKey;
    user_signing_key: MatrixCrossSigningKey;
  };
  /** Original device signature PLUS the verified self-signing signature. */
  signedDeviceKeys: MatrixDeviceKeys;
  identity: MatrixCrossSigningPublicIdentity;
}

export interface MatrixDeviceCertificateExpectation {
  /** Server-derived candidate identifiers, not fields taken from the upload. */
  userId: string;
  deviceId: string;
  /** Immutable self-signed candidate snapshot, eventually from quarantine. */
  originalDeviceKeys: unknown;
  /** An existing, server-pinned identity is mandatory; this never bootstraps. */
  pinnedIdentity: MatrixCrossSigningPublicIdentity;
}

export interface MatrixDeviceCertificate {
  signedDeviceKeys: MatrixDeviceKeys;
  identity: MatrixCrossSigningPublicIdentity;
}

export class MatrixCrossSigningValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MatrixCrossSigningValidationError";
  }
}

/**
 * Closed initial-bootstrap profile for Matrix Rust Crypto 18.6. Public data only.
 * This pure validator grants NO device trust or permission. Its service consumer
 * MUST atomically recheck session, device eligibility and the pinned triplet;
 * null must never be inferred from a client request. Resets, key rotations,
 * additional-device verification and other users' signatures are not supported.
 */
export function parseMatrixCrossSigningBootstrap(
  signingKeysValue: unknown,
  signaturesValue: unknown,
  expected: MatrixCrossSigningBootstrapExpectation
): MatrixCrossSigningBootstrap {
  try {
    return parseBootstrap(signingKeysValue, signaturesValue, expected);
  } catch (error) {
    if (error instanceof MatrixKeyUploadValidationError) {
      throw new MatrixCrossSigningValidationError(error.code);
    }
    throw error;
  }
}

/**
 * Checks a standard Matrix signature-upload certificate against an EXISTING
 * identity and immutable candidate keys. The certificate signs only the device
 * object: NOT a ceremony ID, expiry, approving session or human consent. This
 * result is therefore NOT an approval token and must never by itself create an
 * active Device. A separate, one-use authorization ceremony is still required.
 * The server must have authenticated the pinned triplet already: this device
 * certificate alone cannot authenticate the master-to-self-signing chain.
 * No roots, private keys, local-trust flags or other users' signatures accepted.
 */
export function parseMatrixDeviceCertificate(
  signaturesValue: unknown,
  expected: MatrixDeviceCertificateExpectation
): MatrixDeviceCertificate {
  try {
    const { userId, deviceId } = expected;
    if (
      typeof userId !== "string" || !/^@u[0-9a-f]{32}:[^\s/@]{1,255}$/.test(userId) ||
      typeof deviceId !== "string" || !/^D[0-9A-F]{32}$/.test(deviceId)
    ) fail("MATRIX_EXPECTED_ID_INVALID");
    const identity = parsePinnedIdentity(expected.pinnedIdentity, userId);
    const publicKeys = [identity.masterKey, identity.selfSigningKey, identity.userSigningKey];
    if (new Set(publicKeys).size !== 3) fail("MATRIX_CROSS_SIGNING_KEY_REUSED");
    for (const key of publicKeys) assertMatrixEd25519PublicKey(key, "MATRIX_CROSS_SIGNING_PUBLIC_KEY_INVALID");
    const deviceKeyId = `ed25519:${deviceId}`;
    const original = parseDevice(expected.originalDeviceKeys, userId, deviceId, deviceKeyId);
    parseInitialMatrixKeyUpload({ device_keys: original }, { userId, deviceId });
    if (publicKeys.some((key) => Object.values(original.keys).includes(key))) {
      fail("MATRIX_CROSS_SIGNING_KEY_REUSED");
    }
    const users = exactRecord(signaturesValue, [userId]);
    const devices = exactRecord(users[userId], [deviceId]);
    const selfKeyId = `ed25519:${identity.selfSigningKey}`;
    const signed = parseDevice(devices[deviceId], userId, deviceId, selfKeyId);
    if (!encodeMatrixCanonicalJson(deviceCore(signed)).equals(encodeMatrixCanonicalJson(deviceCore(original)))) {
      fail("MATRIX_CROSS_SIGNING_DEVICE_IDENTITY_MISMATCH");
    }
    verifyMatrixSignedObject(signed, userId, selfKeyId, identity.selfSigningKey, "MATRIX_CROSS_SIGNING_DEVICE_CERTIFICATE_INVALID");
    // Never trust a replacement self-signature supplied by the approver.
    signed.signatures[userId][deviceKeyId] = original.signatures[userId][deviceKeyId];
    return { signedDeviceKeys: signed, identity };
  } catch (error) {
    if (error instanceof MatrixKeyUploadValidationError) {
      throw new MatrixCrossSigningValidationError(error.code);
    }
    throw error;
  }
}

function parseBootstrap(
  signingKeysValue: unknown,
  signaturesValue: unknown,
  expected: MatrixCrossSigningBootstrapExpectation
): MatrixCrossSigningBootstrap {
  const { userId, deviceId } = expected;
  if (
    typeof userId !== "string" || !/^@u[0-9a-f]{32}:[^\s/@]{1,255}$/.test(userId) ||
    typeof deviceId !== "string" || !/^D[0-9A-F]{32}$/.test(deviceId)
  ) fail("MATRIX_EXPECTED_ID_INVALID");

  const deviceKeyId = `ed25519:${deviceId}`;
  // Reconstruct the trusted snapshot before the shared initial-upload validator
  // sees it: no accessors, unexpected properties or input references survive.
  const originalDevice = parseDevice(expected.registeredDeviceKeys, userId, deviceId, deviceKeyId);
  parseInitialMatrixKeyUpload({ device_keys: originalDevice }, { userId, deviceId });
  const originalEd25519 = originalDevice.keys[deviceKeyId];
  const pinned = expected.pinnedIdentity === null ? null : parsePinnedIdentity(expected.pinnedIdentity, userId);

  const body = exactRecord(signingKeysValue, ["master_key", "self_signing_key", "user_signing_key"]);
  const master = parseKey(body.master_key, "master", userId, deviceKeyId);
  const masterKey = publicKey(master);
  const masterKeyId = `ed25519:${masterKey}`;
  const selfSigning = parseKey(body.self_signing_key, "self_signing", userId, masterKeyId);
  const userSigning = parseKey(body.user_signing_key, "user_signing", userId, masterKeyId);
  const identity: MatrixCrossSigningPublicIdentity = {
    userId, masterKey,
    selfSigningKey: publicKey(selfSigning),
    userSigningKey: publicKey(userSigning)
  };
  const publicKeys = [identity.masterKey, identity.selfSigningKey, identity.userSigningKey];
  if (
    new Set(publicKeys).size !== 3 ||
    publicKeys.some((key) => Object.values(originalDevice.keys).includes(key))
  ) fail("MATRIX_CROSS_SIGNING_KEY_REUSED");
  if (pinned && (
    pinned.masterKey !== identity.masterKey ||
    pinned.selfSigningKey !== identity.selfSigningKey ||
    pinned.userSigningKey !== identity.userSigningKey
  )) fail("MATRIX_CROSS_SIGNING_IDENTITY_CHANGE_FORBIDDEN");

  verifyMatrixSignedObject(master, userId, deviceKeyId, originalEd25519, "MATRIX_CROSS_SIGNING_DEVICE_SIGNATURE_INVALID");
  verifyMatrixSignedObject(master, userId, masterKeyId, masterKey, "MATRIX_CROSS_SIGNING_MASTER_SIGNATURE_INVALID");
  verifyMatrixSignedObject(selfSigning, userId, masterKeyId, masterKey, "MATRIX_CROSS_SIGNING_SELF_KEY_SIGNATURE_INVALID");
  verifyMatrixSignedObject(userSigning, userId, masterKeyId, masterKey, "MATRIX_CROSS_SIGNING_USER_KEY_SIGNATURE_INVALID");

  const signatures = exactRecord(signaturesValue, [userId]);
  const devices = exactRecord(signatures[userId], [deviceId]);
  const selfKeyId = `ed25519:${identity.selfSigningKey}`;
  // The SDK uploads ONLY its new signature, not the original device self-signature.
  const signedDevice = parseDevice(devices[deviceId], userId, deviceId, selfKeyId);
  if (!encodeMatrixCanonicalJson(deviceCore(signedDevice)).equals(
    encodeMatrixCanonicalJson(deviceCore(originalDevice))
  )) fail("MATRIX_CROSS_SIGNING_DEVICE_IDENTITY_MISMATCH");
  verifyMatrixSignedObject(signedDevice, userId, selfKeyId, identity.selfSigningKey, "MATRIX_CROSS_SIGNING_DEVICE_CERTIFICATE_INVALID");
  signedDevice.signatures[userId][deviceKeyId] = originalDevice.signatures[userId][deviceKeyId];

  return {
    signingKeys: { master_key: master, self_signing_key: selfSigning, user_signing_key: userSigning },
    signedDeviceKeys: signedDevice,
    identity
  };
}

function parseKey(
  value: unknown,
  usage: CrossSigningUsage,
  userId: string,
  signingKeyId: string
): MatrixCrossSigningKey {
  const input = exactRecord(value, ["keys", "signatures", "usage", "user_id"]);
  if (input.user_id !== userId) fail("MATRIX_CROSS_SIGNING_USER_MISMATCH");
  exactArray(input.usage, [usage]);
  const keys = record(input.keys);
  if (Object.keys(keys).length !== 1) fail("MATRIX_CROSS_SIGNING_PUBLIC_KEY_INVALID");
  const [keyId] = Object.keys(keys);
  const key = base64(keys[keyId], 32);
  if (keyId !== `ed25519:${key}`) fail("MATRIX_CROSS_SIGNING_KEY_ID_INVALID");
  // user_signing is only signed by master here; it must still be a strong
  // public point before any future use to authenticate another user's identity.
  assertMatrixEd25519PublicKey(key, "MATRIX_CROSS_SIGNING_PUBLIC_KEY_INVALID");
  return {
    keys: { [keyId]: key },
    signatures: parseSignatures(input.signatures, userId, usage === "master" ? [signingKeyId, keyId] : [signingKeyId]),
    usage: [usage],
    user_id: userId
  };
}

function parseDevice(value: unknown, userId: string, deviceId: string, signingKeyId: string): MatrixDeviceKeys {
  const input = exactRecord(value, ["algorithms", "device_id", "keys", "signatures", "user_id"]);
  if (input.user_id !== userId || input.device_id !== deviceId) fail("MATRIX_CROSS_SIGNING_DEVICE_IDENTITY_MISMATCH");
  exactArray(input.algorithms, [MATRIX_OLM_ALGORITHM, MATRIX_MEGOLM_ALGORITHM]);
  const edKeyId = `ed25519:${deviceId}`;
  const curveKeyId = `curve25519:${deviceId}`;
  const keys = exactRecord(input.keys, [edKeyId, curveKeyId]);
  return {
    user_id: userId,
    device_id: deviceId,
    algorithms: [MATRIX_OLM_ALGORITHM, MATRIX_MEGOLM_ALGORITHM],
    keys: { [edKeyId]: base64(keys[edKeyId], 32), [curveKeyId]: base64(keys[curveKeyId], 32) },
    signatures: parseSignatures(input.signatures, userId, [signingKeyId])
  };
}

function parseSignatures(value: unknown, userId: string, keyIds: string[]): Record<string, Record<string, string>> {
  const input = exactRecord(value, [userId]);
  const signer = exactRecord(input[userId], keyIds);
  return { [userId]: Object.fromEntries(keyIds.map((keyId) => [keyId, base64(signer[keyId], 64)])) };
}

function parsePinnedIdentity(value: unknown, userId: string): MatrixCrossSigningPublicIdentity {
  const input = exactRecord(value, ["userId", "masterKey", "selfSigningKey", "userSigningKey"]);
  if (input.userId !== userId) fail("MATRIX_CROSS_SIGNING_USER_MISMATCH");
  return {
    userId,
    masterKey: base64(input.masterKey, 32),
    selfSigningKey: base64(input.selfSigningKey, 32),
    userSigningKey: base64(input.userSigningKey, 32)
  };
}

function publicKey(key: MatrixCrossSigningKey): string {
  return Object.values(key.keys)[0];
}

function deviceCore(device: MatrixDeviceKeys): Omit<MatrixDeviceKeys, "signatures"> {
  const { signatures: _signatures, ...core } = device;
  return core;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MATRIX_CROSS_SIGNING_OBJECT_INVALID");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== null && prototype !== Object.prototype) fail("MATRIX_CROSS_SIGNING_OBJECT_INVALID");
  const keys = Reflect.ownKeys(value);
  if (keys.length > 8) fail("MATRIX_CROSS_SIGNING_FIELDS_INVALID");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail("MATRIX_CROSS_SIGNING_FIELDS_INVALID");
    }
  }
  return value as Record<string, unknown>;
}

function exactRecord(value: unknown, expected: readonly string[]): Record<string, unknown> {
  const input = record(value);
  const keys = Object.keys(input);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(input, key))) {
    fail("MATRIX_CROSS_SIGNING_FIELDS_INVALID");
  }
  return input;
}

function exactArray(value: unknown, expected: readonly string[]): void {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== expected.length) {
    fail("MATRIX_CROSS_SIGNING_ARRAY_INVALID");
  }
  if (Reflect.ownKeys(value).length !== expected.length + 1) fail("MATRIX_CROSS_SIGNING_ARRAY_INVALID");
  for (let index = 0; index < expected.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || descriptor.value !== expected[index]) {
      fail("MATRIX_CROSS_SIGNING_ARRAY_INVALID");
    }
  }
}

function base64(value: unknown, bytes: number): string {
  const length = Math.ceil(bytes * 8 / 6);
  if (typeof value !== "string" || value.length !== length || !/^[A-Za-z0-9+/]+$/.test(value)) {
    fail("MATRIX_CROSS_SIGNING_BASE64_INVALID");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== bytes || decoded.toString("base64").replace(/=+$/u, "") !== value) {
    fail("MATRIX_CROSS_SIGNING_BASE64_INVALID");
  }
  return value;
}

function fail(code: string): never {
  throw new MatrixCrossSigningValidationError(code);
}
