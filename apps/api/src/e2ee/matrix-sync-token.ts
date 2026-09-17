import {
  createHash,
  createHmac,
  timingSafeEqual
} from "node:crypto";
import { readMatrixSyncTokenSecret } from "../config/runtime-config";

const TOKEN_PATTERN =
  /^sct1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_CONTEXT = "sinochat:matrix:sync-token:v1";

export interface MatrixSyncTokenData {
  id: string;
  deviceId: string;
  previousBatchId: string | null;
  fromSequence: bigint;
  upToSequence: bigint;
  fromDeviceListPosition: bigint;
  deviceListPosition: bigint;
  oneTimeKeyCount: number;
  unusedFallbackKey: boolean;
}

export interface IssuedMatrixSyncToken {
  token: string;
  tokenHash: string;
}

export class MatrixSyncTokenValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MatrixSyncTokenValidationError";
  }
}

export function issueMatrixSyncToken(
  data: MatrixSyncTokenData,
  environment: NodeJS.ProcessEnv = process.env
): IssuedMatrixSyncToken {
  assertTokenData(data);
  const mac = createHmac(
    "sha256",
    readMatrixSyncTokenSecret(environment)
  )
    .update(tokenPayload(data), "utf8")
    .digest("base64url");
  const token = `sct1.${data.id}.${mac}`;
  return {
    token,
    tokenHash: createHash("sha256").update(token, "utf8").digest("hex")
  };
}

export function parseMatrixSyncTokenBatchId(token: string): string {
  const match = TOKEN_PATTERN.exec(token);
  if (!match?.[1]) {
    throw new MatrixSyncTokenValidationError(
      "MATRIX_SYNC_TOKEN_FORMAT_INVALID"
    );
  }
  return match[1];
}

export function verifyMatrixSyncToken(
  token: string,
  storedTokenHash: string,
  data: MatrixSyncTokenData,
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  try {
    if (parseMatrixSyncTokenBatchId(token) !== data.id) return false;
    if (!HASH_PATTERN.test(storedTokenHash)) return false;
    const expected = issueMatrixSyncToken(data, environment);
    return (
      safeEqual(token, expected.token) &&
      safeEqual(storedTokenHash, expected.tokenHash)
    );
  } catch {
    return false;
  }
}

function tokenPayload(data: MatrixSyncTokenData): string {
  return [
    TOKEN_CONTEXT,
    data.id,
    data.deviceId,
    data.previousBatchId ?? "-",
    data.fromSequence.toString(),
    data.upToSequence.toString(),
    data.fromDeviceListPosition.toString(),
    data.deviceListPosition.toString(),
    data.oneTimeKeyCount.toString(),
    data.unusedFallbackKey ? "1" : "0"
  ].join("\n");
}

function assertTokenData(data: MatrixSyncTokenData): void {
  if (
    !uuid(data.id) ||
    !uuid(data.deviceId) ||
    (data.previousBatchId !== null && !uuid(data.previousBatchId)) ||
    data.fromSequence < 0n ||
    data.upToSequence < data.fromSequence ||
    data.fromDeviceListPosition < 0n ||
    data.deviceListPosition < data.fromDeviceListPosition ||
    !Number.isSafeInteger(data.oneTimeKeyCount) ||
    data.oneTimeKeyCount < 0 ||
    data.oneTimeKeyCount > 100 ||
    typeof data.unusedFallbackKey !== "boolean"
  ) {
    throw new MatrixSyncTokenValidationError(
      "MATRIX_SYNC_TOKEN_DATA_INVALID"
    );
  }
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value
  );
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
