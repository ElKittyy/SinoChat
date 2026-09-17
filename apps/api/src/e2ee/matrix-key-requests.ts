import { MATRIX_SIGNED_CURVE25519_ALGORITHM } from "./matrix-key-upload";

const MATRIX_USER_ID_PATTERN = /^@u[0-9a-f]{32}:[^\s/@]{1,255}$/;
const MATRIX_DEVICE_ID_PATTERN = /^D[0-9A-F]{32}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._~-]{1,64}$/;
// Rust Crypto puede agrupar al dispositivo propio y varias contrapartes
// marcadas como dirty en una sola consulta. El servicio vuelve a autorizar
// cada identidad; este limite solo acota trabajo y tamano de respuesta.
const MAX_USERS_PER_REQUEST = 20;
const MAX_DEVICES_PER_USER = 10;
const MAX_TIMEOUT_MS = 30_000;

export interface MatrixKeysQuery {
  deviceKeys: Record<string, string[]>;
  timeout?: number;
}

export interface MatrixKeysClaim {
  oneTimeKeys: Record<
    string,
    Record<string, typeof MATRIX_SIGNED_CURVE25519_ALGORITHM>
  >;
  timeout?: number;
}

export class MatrixKeyRequestValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MatrixKeyRequestValidationError";
  }
}

export function parseMatrixKeysQuery(value: unknown): MatrixKeysQuery {
  const body = record(value, "MATRIX_KEYS_QUERY_NOT_OBJECT");
  exactOptionalKeys(
    body,
    ["device_keys"],
    ["timeout"],
    "MATRIX_KEYS_QUERY_FIELDS_INVALID"
  );
  const deviceKeys = record(
    body.device_keys,
    "MATRIX_KEYS_QUERY_DEVICE_KEYS_INVALID"
  );
  const users = Object.entries(deviceKeys);
  if (users.length < 1 || users.length > MAX_USERS_PER_REQUEST) {
    fail("MATRIX_KEYS_QUERY_USER_LIMIT_INVALID");
  }

  const parsed: Record<string, string[]> = {};
  for (const [userId, rawDeviceIds] of users) {
    matrixUserId(userId);
    if (
      !Array.isArray(rawDeviceIds) ||
      rawDeviceIds.length > MAX_DEVICES_PER_USER
    ) {
      fail("MATRIX_KEYS_QUERY_DEVICES_INVALID");
    }
    const deviceIds = rawDeviceIds.map((deviceId) => {
      if (typeof deviceId !== "string") {
        fail("MATRIX_KEYS_QUERY_DEVICES_INVALID");
      }
      matrixDeviceId(deviceId);
      return deviceId;
    });
    if (new Set(deviceIds).size !== deviceIds.length) {
      fail("MATRIX_KEYS_QUERY_DEVICES_INVALID");
    }
    parsed[userId] = deviceIds;
  }

  const timeout = optionalTimeout(body.timeout);
  return timeout === undefined
    ? { deviceKeys: parsed }
    : { deviceKeys: parsed, timeout };
}

export function parseMatrixKeysClaim(value: unknown): MatrixKeysClaim {
  const body = record(value, "MATRIX_KEYS_CLAIM_NOT_OBJECT");
  exactOptionalKeys(
    body,
    ["one_time_keys"],
    ["timeout"],
    "MATRIX_KEYS_CLAIM_FIELDS_INVALID"
  );
  const oneTimeKeys = record(
    body.one_time_keys,
    "MATRIX_KEYS_CLAIM_KEYS_INVALID"
  );
  const users = Object.entries(oneTimeKeys);
  if (users.length < 1 || users.length > MAX_USERS_PER_REQUEST) {
    fail("MATRIX_KEYS_CLAIM_USER_LIMIT_INVALID");
  }

  let targets = 0;
  const parsed: MatrixKeysClaim["oneTimeKeys"] = {};
  for (const [userId, rawDevices] of users) {
    matrixUserId(userId);
    const devices = record(rawDevices, "MATRIX_KEYS_CLAIM_DEVICES_INVALID");
    const entries = Object.entries(devices);
    if (entries.length < 1 || entries.length > MAX_DEVICES_PER_USER) {
      fail("MATRIX_KEYS_CLAIM_DEVICE_LIMIT_INVALID");
    }
    const parsedDevices: Record<
      string,
      typeof MATRIX_SIGNED_CURVE25519_ALGORITHM
    > = {};
    for (const [deviceId, algorithm] of entries) {
      matrixDeviceId(deviceId);
      if (algorithm !== MATRIX_SIGNED_CURVE25519_ALGORITHM) {
        fail("MATRIX_KEYS_CLAIM_ALGORITHM_INVALID");
      }
      parsedDevices[deviceId] = MATRIX_SIGNED_CURVE25519_ALGORITHM;
      targets += 1;
    }
    parsed[userId] = parsedDevices;
  }
  if (targets > MAX_DEVICES_PER_USER) {
    fail("MATRIX_KEYS_CLAIM_DEVICE_LIMIT_INVALID");
  }

  const timeout = optionalTimeout(body.timeout);
  return timeout === undefined
    ? { oneTimeKeys: parsed }
    : { oneTimeKeys: parsed, timeout };
}

export function parseMatrixClaimRequestId(value: string): string {
  if (!REQUEST_ID_PATTERN.test(value)) {
    fail("MATRIX_KEYS_CLAIM_REQUEST_ID_INVALID");
  }
  return value;
}

export function matrixQueryHashInput(query: MatrixKeysQuery) {
  return query.timeout === undefined
    ? { device_keys: query.deviceKeys }
    : { device_keys: query.deviceKeys, timeout: query.timeout };
}

export function matrixClaimHashInput(claim: MatrixKeysClaim) {
  return claim.timeout === undefined
    ? { one_time_keys: claim.oneTimeKeys }
    : { one_time_keys: claim.oneTimeKeys, timeout: claim.timeout };
}

function matrixUserId(value: string): void {
  if (!MATRIX_USER_ID_PATTERN.test(value)) {
    fail("MATRIX_USER_ID_INVALID");
  }
}

function matrixDeviceId(value: string): void {
  if (!MATRIX_DEVICE_ID_PATTERN.test(value)) {
    fail("MATRIX_DEVICE_ID_INVALID");
  }
}

function optionalTimeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMEOUT_MS
  ) {
    fail("MATRIX_REQUEST_TIMEOUT_INVALID");
  }
  return value;
}

function exactOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  errorCode: string
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    fail(errorCode);
  }
}

function record(value: unknown, errorCode: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    fail(errorCode);
  }
  return value as Record<string, unknown>;
}

function fail(code: string): never {
  throw new MatrixKeyRequestValidationError(code);
}
