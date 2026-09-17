import { OwnUserIdentity, UserId, type OlmMachine } from "@matrix-org/matrix-sdk-crypto-wasm";
import type { E2eeApi, MatrixCrossSigningPublicIdentity, MatrixCrossSigningStatus } from "../api";
import type { MatrixCryptoIdentity } from "./matrixRuntime";
import type { MatrixTransportCoordinator } from "./matrixTransport";

type JsonObject = Record<string, unknown>;
type BootstrapApi = Pick<E2eeApi, "getCrossSigningStatus" | "bootstrapCrossSigning">;

export class MatrixCrossSigningError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MatrixCrossSigningError";
  }
}

/**
 * Initial-device bootstrap ONLY. The server's atomic endpoint pins the public
 * triplet and this device's signature together. Rust Crypto keeps every private
 * key in its local store; no exports, reset, recovery or device approvals occur.
 * The release gate must already have been checked by the session lifecycle.
 */
export async function initializeMatrixCrossSigning(
  identity: MatrixCryptoIdentity,
  coordinator: MatrixTransportCoordinator,
  api: BootstrapApi,
  signal?: AbortSignal,
): Promise<void> {
  await coordinator.runExclusiveCryptoOperation(async (context) => {
    signal?.throwIfAborted();
    const remote = assertStatus(await api.getCrossSigningStatus(signal), identity);
    signal?.throwIfAborted();
    const privateStatus = await context.machine.crossSigningStatus();
    let complete: boolean;
    let partial: boolean;
    try {
      const availability = [privateStatus.hasMaster, privateStatus.hasSelfSigning, privateStatus.hasUserSigning];
      complete = availability.every((value) => value === true);
      partial = availability.some((value) => value === true) && !complete;
    } finally {
      privateStatus.free();
    }
    const local = await readOwnIdentity(context.machine, identity.userId);
    // An existing root with missing secrets needs the future recovery ceremony,
    // never bootstrap(false), which could otherwise generate a replacement.
    if (partial || (remote.state === "PINNED" && (!complete || !local)) || (Boolean(local) !== complete)) {
      fail("MATRIX_CROSS_SIGNING_LOCAL_KEYS_REQUIRED");
    }
    if (remote.state === "PINNED") assertSameIdentity(local!, remote.identity);

    signal?.throwIfAborted();
    const bootstrap = await context.machine.bootstrapCrossSigning(false);
    const uploadKeys = bootstrap.uploadKeysRequest;
    const signing = bootstrap.uploadSigningKeysRequest;
    const signatures = bootstrap.uploadSignaturesRequest;
    try {
      // Initial device registration and its ACK must finish first. This closed
      // profile must not silently turn into an additional device-key upload.
      if (uploadKeys !== undefined) fail("MATRIX_CROSS_SIGNING_INITIAL_KEYS_NOT_ACKNOWLEDGED");
      const signingKeys = jsonObject(signing.body);
      const deviceSignatures = jsonObject(signatures.body);
      const generated = publicTriplet(signingKeys, identity.userId);
      assertPublicDeviceSignature(deviceSignatures, identity, generated.selfSigningKey);
      if (signatures.id !== undefined) fail("MATRIX_CROSS_SIGNING_SIGNATURE_REQUEST_UNEXPECTED");
      if (local) assertSameIdentity(generated, local);
      if (remote.state === "PINNED") assertSameIdentity(generated, remote.identity);
      signal?.throwIfAborted();
      const published = assertStatus(await api.bootstrapCrossSigning({
        signing_keys: signingKeys, device_signatures: deviceSignatures,
      }, signal), identity);
      if (published.state !== "PINNED") fail("MATRIX_CROSS_SIGNING_BOOTSTRAP_NOT_PINNED");
      assertSameIdentity(generated, published.identity);
      // Bootstrap signature requests in SDK 18.6 have no id and need no ACK.
      // Requests from other ceremonies are intentionally not handled here.
      signal?.throwIfAborted();
      // queryKeysForUsers takes ownership of every UserId in its array.
      const query = context.machine.queryKeysForUsers([new UserId(identity.userId)]);
      try {
        await context.sendExplicitRequest(query);
      } finally {
        query.free();
      }
      const verified = await readOwnIdentity(context.machine, identity.userId, true);
      if (!verified) fail("MATRIX_CROSS_SIGNING_IDENTITY_NOT_VERIFIED");
      assertSameIdentity(verified, generated);
      signal?.throwIfAborted();
    } finally {
      uploadKeys?.free();
      signing.free();
      signatures.free();
      bootstrap.free();
    }
  }, signal);
}

async function readOwnIdentity(
  machine: OlmMachine,
  userId: string,
  requireDeviceTrust = false,
): Promise<MatrixCrossSigningPublicIdentity | undefined> {
  const sdkUser = new UserId(userId);
  let own;
  try {
    own = await machine.getIdentity(sdkUser);
  } finally {
    sdkUser.free();
  }
  if (!own) return undefined;
  try {
    if (!(own instanceof OwnUserIdentity) || own.hasVerificationViolation() || !own.isVerified()) {
      fail("MATRIX_CROSS_SIGNING_IDENTITY_NOT_VERIFIED");
    }
    if (requireDeviceTrust && !(await own.trustsOurOwnDevice())) {
      fail("MATRIX_CROSS_SIGNING_DEVICE_NOT_VERIFIED");
    }
    return publicTriplet({
      master_key: jsonObject(own.masterKey),
      self_signing_key: jsonObject(own.selfSigningKey),
      user_signing_key: jsonObject(own.userSigningKey),
    }, userId);
  } finally {
    own.free();
  }
}

function publicTriplet(value: unknown, userId: string): MatrixCrossSigningPublicIdentity {
  const keys = exactObject(value, ["master_key", "self_signing_key", "user_signing_key"]);
  const result = {
    masterKey: publicKey(keys.master_key, "master", userId),
    selfSigningKey: publicKey(keys.self_signing_key, "self_signing", userId),
    userSigningKey: publicKey(keys.user_signing_key, "user_signing", userId),
  };
  if (new Set(Object.values(result)).size !== 3) fail("MATRIX_CROSS_SIGNING_PUBLIC_BODY_INVALID");
  return result;
}

function publicKey(value: unknown, usage: string, userId: string): string {
  const key = exactObject(value, ["keys", "signatures", "usage", "user_id"]);
  if (key.user_id !== userId || !Array.isArray(key.usage) || key.usage.length !== 1 || key.usage[0] !== usage) {
    fail("MATRIX_CROSS_SIGNING_PUBLIC_BODY_INVALID");
  }
  const entries = Object.entries(object(key.keys));
  if (entries.length !== 1) fail("MATRIX_CROSS_SIGNING_PUBLIC_BODY_INVALID");
  const [keyId, publicValue] = entries[0]!;
  if (!isPublicKey(publicValue) || keyId !== `ed25519:${publicValue}`) fail("MATRIX_CROSS_SIGNING_PUBLIC_BODY_INVALID");
  assertPublicSignatures(key.signatures, userId);
  return publicValue;
}

function assertPublicDeviceSignature(value: unknown, identity: MatrixCryptoIdentity, selfSigningKey: string): void {
  const users = exactObject(value, [identity.userId]);
  const devices = exactObject(users[identity.userId], [identity.deviceId]);
  const device = exactObject(devices[identity.deviceId], ["algorithms", "device_id", "keys", "signatures", "user_id"]);
  if (device.user_id !== identity.userId || device.device_id !== identity.deviceId ||
    !Array.isArray(device.algorithms) || device.algorithms.length !== 2 ||
    device.algorithms[0] !== "m.olm.v1.curve25519-aes-sha2" || device.algorithms[1] !== "m.megolm.v1.aes-sha2") {
    fail("MATRIX_CROSS_SIGNING_PUBLIC_BODY_INVALID");
  }
  const publicKeys = exactObject(device.keys, [`curve25519:${identity.deviceId}`, `ed25519:${identity.deviceId}`]);
  if (!Object.values(publicKeys).every(isPublicKey)) fail("MATRIX_CROSS_SIGNING_PUBLIC_BODY_INVALID");
  const signatures = exactObject(device.signatures, [identity.userId]);
  exactObject(signatures[identity.userId], [`ed25519:${selfSigningKey}`]);
  assertPublicSignatures(device.signatures, identity.userId);
}

function assertPublicSignatures(value: unknown, userId: string): void {
  const signatures = exactObject(value, [userId]);
  const entries = Object.entries(object(signatures[userId]));
  if (entries.length < 1 || entries.length > 2 || entries.some(([key, signature]) =>
    !/^ed25519:(?:D[0-9A-F]{32}|[A-Za-z0-9+/]{43})$/.test(key) ||
    typeof signature !== "string" || !/^[A-Za-z0-9+/]{85}[AQgw]$/.test(signature))) {
    fail("MATRIX_CROSS_SIGNING_PUBLIC_BODY_INVALID");
  }
}

function assertStatus(value: MatrixCrossSigningStatus, identity: MatrixCryptoIdentity): MatrixCrossSigningStatus {
  const status = exactObject(value, ["state", "identity", "matrixUserId", "matrixDeviceId"]);
  if (status.matrixUserId !== identity.userId || status.matrixDeviceId !== identity.deviceId) {
    fail("MATRIX_CROSS_SIGNING_SESSION_MISMATCH");
  }
  if (status.state === "UNINITIALIZED" && status.identity === null) return value;
  if (status.state !== "PINNED") fail("MATRIX_CROSS_SIGNING_STATUS_INVALID");
  const triplet = exactObject(status.identity, ["masterKey", "selfSigningKey", "userSigningKey"]);
  if (!Object.values(triplet).every(isPublicKey) || new Set(Object.values(triplet)).size !== 3) {
    fail("MATRIX_CROSS_SIGNING_STATUS_INVALID");
  }
  return value;
}

function assertSameIdentity(a: MatrixCrossSigningPublicIdentity, b: MatrixCrossSigningPublicIdentity): void {
  if (a.masterKey !== b.masterKey || a.selfSigningKey !== b.selfSigningKey || a.userSigningKey !== b.userSigningKey) {
    fail("MATRIX_CROSS_SIGNING_IDENTITY_CHANGED");
  }
}

function isPublicKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$/.test(value);
}

function jsonObject(value: string): JsonObject {
  if (typeof value !== "string" || value.length > 16_384) fail("MATRIX_CROSS_SIGNING_PUBLIC_BODY_INVALID");
  try {
    return object(JSON.parse(value));
  } catch {
    fail("MATRIX_CROSS_SIGNING_PUBLIC_BODY_INVALID");
  }
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("MATRIX_CROSS_SIGNING_PUBLIC_BODY_INVALID");
  }
  return value as JsonObject;
}

function exactObject(value: unknown, keys: string[]): JsonObject {
  const result = object(value);
  if (Object.keys(result).sort().join(",") !== [...keys].sort().join(",")) fail("MATRIX_CROSS_SIGNING_PUBLIC_BODY_INVALID");
  return result;
}

function fail(code: string): never {
  throw new MatrixCrossSigningError(code);
}
