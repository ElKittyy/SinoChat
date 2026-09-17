import { types } from "node:util";
import { hashMatrixCanonicalJson } from "./matrix-key-upload";

const EVENT_TYPES = ["request", "ready", "start", "accept", "key", "mac", "done", "cancel"].map((name) => `m.key.verification.${name}`);
const TRANSACTION_ID = /^[A-Za-z0-9._~-]{1,255}$/;
const DEVICE_ID = /^D[0-9A-F]{32}$/;
const MAC_V2 = "hkdf-hmac-sha256.v2";
const MAC_OFFERS = ["hkdf-hmac-sha256", MAC_V2, "org.matrix.msc3783.hkdf-hmac-sha256"];
const CANCEL_CODES = ["m.user", "m.timeout", "m.unknown_transaction", "m.unknown_method", "m.unexpected_message",
  "m.key_mismatch", "m.user_mismatch", "m.invalid_message", "m.accepted", "m.mismatched_commitment", "m.mismatched_sas"];
type ContentValue = string | number | readonly string[] | Readonly<Record<string, string>>;
export type MatrixSasContent = Readonly<Record<string, ContentValue>>;

export interface MatrixSasExpectation {
  /** Server-derived authenticated context, NOT values copied from the request. */
  userId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  /** Existing bound SDK flow; not the HTTP transaction/request identifier. */
  flowId: string;
  /** Public master key of the existing validated/pinned identity. */
  pinnedMasterKey: string;
}
export interface MatrixSasToDeviceRequest {
  eventType: string;
  transactionId: string;
  flowId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  messages: Readonly<Record<string, Readonly<Record<string, MatrixSasContent>>>>;
  canonicalSha256: string;
}
export class MatrixSasValidationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "MatrixSasValidationError"; }
}

/**
 * Pure, narrow wire validation for an ALREADY scoped own-device SAS flow.
 * No transport, flow admission, session/expiry checks, MAC/commitment verification,
 * consent, certificate publication or approval. SDK must still verify the crypto.
 * The conversation to-device endpoint must NOT call this to expand its allowlist.
 */
export function parseMatrixSasToDeviceRequest(eventType: string, transactionId: string, value: unknown,
  expected: MatrixSasExpectation): MatrixSasToDeviceRequest {
  if (typeof eventType !== "string" || !EVENT_TYPES.includes(eventType)) fail("MATRIX_SAS_EVENT_TYPE_INVALID");
  if (typeof transactionId !== "string" || !TRANSACTION_ID.test(transactionId)) fail("MATRIX_SAS_TRANSACTION_ID_INVALID");
  const scope = scopeRecord(expected);
  const body = record(value, ["messages"], "MATRIX_SAS_BODY_INVALID");
  const users = record(body.messages, [scope.userId], "MATRIX_SAS_RECIPIENT_INVALID");
  const devices = record(users[scope.userId], [scope.recipientDeviceId], "MATRIX_SAS_RECIPIENT_INVALID");
  const content = parseContent(eventType, devices[scope.recipientDeviceId], scope);
  const messages = { [scope.userId]: { [scope.recipientDeviceId]: content } };
  if (Buffer.byteLength(JSON.stringify({ messages }), "utf8") > 8192) fail("MATRIX_SAS_BODY_TOO_LARGE");
  const canonicalSha256 = hashMatrixCanonicalJson({ event_type: eventType, transaction_id: transactionId,
    sender_device_id: scope.senderDeviceId, pinned_master_key: scope.pinnedMasterKey, messages });
  return freeze({ eventType, transactionId, flowId: scope.flowId, senderDeviceId: scope.senderDeviceId,
    recipientDeviceId: scope.recipientDeviceId, messages, canonicalSha256 });
}

function parseContent(type: string, value: unknown, scope: MatrixSasExpectation): MatrixSasContent {
  const suffix = type.slice("m.key.verification.".length);
  const fields: Record<string, string[]> = {
    request: ["from_device", "methods", "timestamp", "transaction_id"],
    ready: ["from_device", "methods", "transaction_id"],
    start: ["from_device", "hashes", "key_agreement_protocols", "message_authentication_codes", "method", "short_authentication_string", "transaction_id"],
    // SDK 18.6.0 accept does not emit 'method'. Do not add/normalize wire fields.
    accept: ["commitment", "hash", "key_agreement_protocol", "message_authentication_code", "short_authentication_string", "transaction_id"],
    key: ["key", "transaction_id"], mac: ["keys", "mac", "transaction_id"],
    done: ["transaction_id"], cancel: ["code", "reason", "transaction_id"]
  };
  const raw = record(value, fields[suffix], "MATRIX_SAS_CONTENT_INVALID");
  if (raw.transaction_id !== scope.flowId) fail("MATRIX_SAS_FLOW_MISMATCH");
  const result: Record<string, ContentValue> = { transaction_id: scope.flowId };
  if (["request", "ready", "start"].includes(suffix)) {
    if (raw.from_device !== scope.senderDeviceId) fail("MATRIX_SAS_SENDER_MISMATCH");
    result.from_device = scope.senderDeviceId;
  }
  if (suffix === "request" || suffix === "ready") result.methods = choices(raw.methods, ["m.sas.v1"], "m.sas.v1");
  if (suffix === "request") {
    if (typeof raw.timestamp !== "number" || !Number.isSafeInteger(raw.timestamp) || raw.timestamp < 0 || Object.is(raw.timestamp, -0)) fail("MATRIX_SAS_TIMESTAMP_INVALID");
    result.timestamp = raw.timestamp; // Untrusted time. Future service + SDK check freshness.
  }
  if (suffix === "start") {
    if (raw.method !== "m.sas.v1") fail("MATRIX_SAS_ALGORITHM_INVALID");
    result.method = "m.sas.v1";
    result.hashes = choices(raw.hashes, ["sha256"], "sha256");
    result.key_agreement_protocols = choices(raw.key_agreement_protocols, ["curve25519-hkdf-sha256"], "curve25519-hkdf-sha256");
    // Preserve SDK offers, including legacy/MSC compatibility entries. Never
    // negotiate them: accept below requires v2. Sorting changes the commitment.
    result.message_authentication_codes = choices(raw.message_authentication_codes, MAC_OFFERS, MAC_V2);
    result.short_authentication_string = choices(raw.short_authentication_string, ["decimal", "emoji"], "decimal");
  }
  if (suffix === "accept") {
    if (raw.hash !== "sha256" || raw.key_agreement_protocol !== "curve25519-hkdf-sha256" || raw.message_authentication_code !== MAC_V2) fail("MATRIX_SAS_ALGORITHM_INVALID");
    result.commitment = base64(raw.commitment, "MATRIX_SAS_COMMITMENT_INVALID");
    result.hash = "sha256"; result.key_agreement_protocol = "curve25519-hkdf-sha256"; result.message_authentication_code = MAC_V2;
    result.short_authentication_string = choices(raw.short_authentication_string, ["decimal", "emoji"], "decimal");
  }
  if (suffix === "key") result.key = base64(raw.key, "MATRIX_SAS_KEY_INVALID");
  if (suffix === "mac") {
    const deviceKeyId = `ed25519:${scope.senderDeviceId}`, masterKeyId = `ed25519:${scope.pinnedMasterKey}`;
    const macFields = ownKeys(raw.mac, "MATRIX_SAS_MAC_INVALID");
    if (macFields.length < 1 || macFields.length > 2 || !macFields.includes(deviceKeyId) ||
      macFields.some((key) => key !== deviceKeyId && key !== masterKeyId)) fail("MATRIX_SAS_MAC_INVALID");
    const mac = record(raw.mac, macFields as string[], "MATRIX_SAS_MAC_INVALID");
    const parsedMac: Record<string, string> = {};
    for (const key of macFields as string[]) parsedMac[key] = base64(mac[key], "MATRIX_SAS_MAC_INVALID");
    result.mac = parsedMac; result.keys = base64(raw.keys, "MATRIX_SAS_MAC_INVALID");
  }
  if (suffix === "cancel") {
    if (typeof raw.code !== "string" || !CANCEL_CODES.includes(raw.code)) fail("MATRIX_SAS_CANCEL_INVALID");
    // A protocol diagnostic from the SDK, never a required user-entered reason.
    // Do not log/render it as trusted content, or treat it as evidence of consent.
    if (typeof raw.reason !== "string" || raw.reason.length < 1 || raw.reason.length > 512 ||
      Buffer.byteLength(raw.reason, "utf8") > 512 || !wellFormed(raw.reason) || /[\u0000-\u001f\u007f]/.test(raw.reason)) fail("MATRIX_SAS_CANCEL_INVALID");
    result.code = raw.code; result.reason = raw.reason;
  }
  return result;
}

function scopeRecord(value: unknown): MatrixSasExpectation {
  const code = "MATRIX_SAS_SCOPE_INVALID";
  const raw = record(value, ["userId", "senderDeviceId", "recipientDeviceId", "flowId", "pinnedMasterKey"], code);
  if (typeof raw.userId !== "string" || !/^@u[0-9a-f]{32}:[^\s/@]{1,255}$/.test(raw.userId) || !wellFormed(raw.userId) ||
    typeof raw.senderDeviceId !== "string" || !DEVICE_ID.test(raw.senderDeviceId) ||
    typeof raw.recipientDeviceId !== "string" || !DEVICE_ID.test(raw.recipientDeviceId) || raw.recipientDeviceId === raw.senderDeviceId ||
    typeof raw.flowId !== "string" || !TRANSACTION_ID.test(raw.flowId)) fail(code);
  return { userId: raw.userId, senderDeviceId: raw.senderDeviceId, recipientDeviceId: raw.recipientDeviceId,
    flowId: raw.flowId, pinnedMasterKey: base64(raw.pinnedMasterKey, code) };
}

function ownKeys(value: unknown, code: string): (string | symbol)[] {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) fail(code);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  return Reflect.ownKeys(value);
}
function record(value: unknown, fields: readonly string[], code: string): Record<string, unknown> {
  const keys = ownKeys(value, code);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) fail(code);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(code);
    result[key] = descriptor.value;
  }
  return result;
}
function choices(value: unknown, allowed: readonly string[], required: string): string[] {
  const code = "MATRIX_SAS_ALGORITHM_INVALID";
  if (!value || typeof value !== "object" || types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code);
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !Object.hasOwn(length, "value") || length.enumerable || !Number.isInteger(length.value) || length.value < 1 || length.value > allowed.length) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length.value + 1) fail(code);
  const result: string[] = [];
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string" ||
      !allowed.includes(descriptor.value) || result.includes(descriptor.value)) fail(code);
    result.push(descriptor.value);
  }
  if (!result.includes(required)) fail(code);
  return result;
}
function base64(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}$/.test(value)) fail(code);
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32 || bytes.toString("base64").replace(/=+$/, "") !== value) fail(code);
  return value;
}
function wellFormed(value: string): boolean {
  // Reject lone UTF-16 surrogates before canonical JSON hashing/UTF-8 encoding.
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function fail(code: string): never { throw new MatrixSasValidationError(code); }
