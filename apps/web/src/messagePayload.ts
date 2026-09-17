const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SERVER_SEQUENCE_PATTERN = /^(?:0|[1-9]\d{0,19})$/;
const PADDED_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UNPADDED_BASE64_PATTERN = /^[A-Za-z0-9+/]+$/;
const MATRIX_DEVICE_ID_PATTERN = /^D[0-9A-F]{32}$/;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_ENVELOPE_BYTES = 128 * 1024;
const MAX_IMAGE_PLAINTEXT_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_CIPHERTEXT_BYTES =
  MAX_IMAGE_PLAINTEXT_BYTES + 256 * 1024;
const RETENTION_MILLISECONDS = 48 * 60 * 60 * 1_000;

export const MATRIX_MESSAGE_PROTOCOL_VERSION = "matrix-megolm-v1" as const;
export const MATRIX_MEGOLM_ALGORITHM = "m.megolm.v1.aes-sha2" as const;
export const MATRIX_ATTACHMENT_CIPHER_SUITE = "A256CTR" as const;

export type EncryptedMessageKind = "TEXT" | "IMAGE";
export type EncryptedImageMimeType =
  | "image/jpeg"
  | "image/png"
  | "image/webp";
export type EncryptedMessageReceiptStatus = "SENT" | "DELIVERED" | "READ";

export interface MatrixMegolmContent {
  readonly algorithm: typeof MATRIX_MEGOLM_ALGORITHM;
  readonly ciphertext: string;
  readonly device_id: string;
  readonly sender_key: string;
  readonly session_id: string;
}

export interface EncryptedMessageAttachment {
  readonly declaredMimeType: EncryptedImageMimeType;
  readonly plaintextByteSize: number;
  readonly ciphertextByteSize: number;
  readonly ciphertextSha256: string;
  readonly cipherSuite: typeof MATRIX_ATTACHMENT_CIPHER_SUITE;
  readonly downloadUrl: string;
}

export interface EncryptedMessageReceipt {
  readonly recipientUserId: string;
  readonly status: EncryptedMessageReceiptStatus;
  readonly deliveredAt: string | null;
  readonly readAt: string | null;
}

export interface EncryptedTransportMessage {
  readonly id: string;
  readonly senderUserId: string;
  readonly senderDeviceId: string;
  readonly clientMessageId: string;
  readonly serverSequence: string;
  readonly kind: EncryptedMessageKind;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly envelope: {
    readonly protocolVersion: typeof MATRIX_MESSAGE_PROTOCOL_VERSION;
    readonly cipherSuite: typeof MATRIX_MEGOLM_ALGORITHM;
    readonly ciphertext: string;
    readonly content: MatrixMegolmContent;
  };
  readonly attachment: EncryptedMessageAttachment | null;
  readonly receipts: readonly EncryptedMessageReceipt[];
}

export interface EncryptedMessagePage {
  readonly items: readonly EncryptedTransportMessage[];
  readonly nextAfterSequence: string;
}

export interface AttachmentUploadGrant {
  readonly uploadUrl: string;
  readonly uploadHeaders: Readonly<{
    "cache-control": "private, no-store, max-age=0";
    "content-length": number;
    "content-type": "application/octet-stream";
    "if-none-match": "*";
    "x-amz-checksum-sha256": string;
  }>;
  readonly uploadExpiresInSeconds: number;
  readonly grantToken: string;
  readonly grantExpiresAt: string;
}

export interface MessageAcknowledgement {
  readonly id: string;
  readonly clientMessageId: string;
  readonly serverSequence: string;
  readonly kind: EncryptedMessageKind;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly created: boolean;
}

export interface AttachmentUploadRequest {
  readonly declaredMimeType: EncryptedImageMimeType;
  readonly plaintextByteSize: number;
  readonly ciphertextByteSize: number;
  readonly ciphertextSha256: string;
}

export interface OutboundMessageEnvelope {
  readonly recipientDeviceId: string;
  readonly protocolVersion: typeof MATRIX_MESSAGE_PROTOCOL_VERSION;
  readonly cipherSuite: typeof MATRIX_MEGOLM_ALGORITHM;
  readonly ciphertext: string;
}

export interface SendEncryptedMessageRequest {
  readonly clientMessageId: string;
  readonly senderDeviceId: string;
  readonly kind: EncryptedMessageKind;
  readonly envelopes: readonly OutboundMessageEnvelope[];
  readonly attachmentGrantToken?: string;
}

export interface MessageReceiptAcknowledgement {
  readonly messageId: string;
  readonly status: Extract<EncryptedMessageReceiptStatus, "DELIVERED" | "READ">;
  readonly deliveredAt: string;
  readonly readAt: string | null;
}

export class MessagePayloadError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "MessagePayloadError";
    this.code = code;
  }
}

export function parseEncryptedMessagePage(
  value: unknown,
): EncryptedMessagePage {
  const page = record(value, "MESSAGE_PAGE_INVALID");
  exactKeys(page, ["items", "nextAfterSequence"], "MESSAGE_PAGE_FIELDS_INVALID");
  if (!Array.isArray(page.items) || page.items.length > 100) {
    fail("MESSAGE_PAGE_INVALID");
  }
  const items = page.items.map(parseEncryptedMessage);
  const nextAfterSequence = serverSequence(
    page.nextAfterSequence,
    true,
    "MESSAGE_PAGE_CURSOR_INVALID",
  );
  if (
    items.length > 0 &&
    items[items.length - 1]!.serverSequence !== nextAfterSequence
  ) {
    fail("MESSAGE_PAGE_CURSOR_INVALID");
  }
  for (let index = 1; index < items.length; index += 1) {
    if (
      BigInt(items[index - 1]!.serverSequence) >=
      BigInt(items[index]!.serverSequence)
    ) {
      fail("MESSAGE_PAGE_ORDER_INVALID");
    }
  }
  return Object.freeze({ items: Object.freeze(items), nextAfterSequence });
}

export function parseAttachmentUploadGrant(
  value: unknown,
  expected: { readonly ciphertextByteSize: number; readonly ciphertextSha256: string },
): AttachmentUploadGrant {
  const grant = record(value, "ATTACHMENT_UPLOAD_GRANT_INVALID");
  exactKeys(
    grant,
    [
      "uploadUrl",
      "uploadHeaders",
      "uploadExpiresInSeconds",
      "grantToken",
      "grantExpiresAt",
    ],
    "ATTACHMENT_UPLOAD_GRANT_FIELDS_INVALID",
  );
  const expectedBytes = integer(
    expected.ciphertextByteSize,
    1,
    MAX_IMAGE_CIPHERTEXT_BYTES,
    "ATTACHMENT_UPLOAD_EXPECTATION_INVALID",
  );
  const expectedSha256 = sha256Hex(
    expected.ciphertextSha256,
    "ATTACHMENT_UPLOAD_EXPECTATION_INVALID",
  );
  const headers = record(grant.uploadHeaders, "ATTACHMENT_UPLOAD_HEADERS_INVALID");
  exactKeys(
    headers,
    [
      "cache-control",
      "content-length",
      "content-type",
      "if-none-match",
      "x-amz-checksum-sha256",
    ],
    "ATTACHMENT_UPLOAD_HEADERS_INVALID",
  );
  const expectedChecksum = hexToBase64(expectedSha256);
  if (
    headers["cache-control"] !== "private, no-store, max-age=0" ||
    headers["content-length"] !== expectedBytes ||
    headers["content-type"] !== "application/octet-stream" ||
    headers["if-none-match"] !== "*" ||
    headers["x-amz-checksum-sha256"] !== expectedChecksum
  ) {
    fail("ATTACHMENT_UPLOAD_HEADERS_INVALID");
  }
  const uploadExpiresInSeconds = integer(
    grant.uploadExpiresInSeconds,
    1,
    300,
    "ATTACHMENT_UPLOAD_EXPIRY_INVALID",
  );
  const grantExpiresAt = isoDate(
    grant.grantExpiresAt,
    "ATTACHMENT_UPLOAD_EXPIRY_INVALID",
  );
  if (
    typeof grant.grantToken !== "string" ||
    grant.grantToken.length < 80 ||
    grant.grantToken.length > 4_096 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(grant.grantToken)
  ) {
    fail("ATTACHMENT_UPLOAD_TOKEN_INVALID");
  }
  return Object.freeze({
    uploadUrl: httpUrl(grant.uploadUrl, "ATTACHMENT_UPLOAD_URL_INVALID"),
    uploadHeaders: Object.freeze({
      "cache-control": "private, no-store, max-age=0",
      "content-length": expectedBytes,
      "content-type": "application/octet-stream",
      "if-none-match": "*",
      "x-amz-checksum-sha256": expectedChecksum,
    }),
    uploadExpiresInSeconds,
    grantToken: grant.grantToken,
    grantExpiresAt,
  });
}

export function parseMessageAcknowledgement(
  value: unknown,
  expected: {
    readonly clientMessageId: string;
    readonly kind: EncryptedMessageKind;
  },
): MessageAcknowledgement {
  const acknowledgement = record(value, "MESSAGE_ACK_INVALID");
  exactKeys(
    acknowledgement,
    [
      "id",
      "clientMessageId",
      "serverSequence",
      "kind",
      "createdAt",
      "expiresAt",
      "created",
    ],
    "MESSAGE_ACK_FIELDS_INVALID",
  );
  const clientMessageId = uuid(
    acknowledgement.clientMessageId,
    "MESSAGE_ACK_INVALID",
  );
  const kind = messageKind(acknowledgement.kind, "MESSAGE_ACK_INVALID");
  if (
    clientMessageId !== uuid(expected.clientMessageId, "MESSAGE_ACK_EXPECTATION_INVALID") ||
    kind !== expected.kind ||
    typeof acknowledgement.created !== "boolean"
  ) {
    fail("MESSAGE_ACK_MISMATCH");
  }
  const createdAt = isoDate(acknowledgement.createdAt, "MESSAGE_ACK_INVALID");
  const expiresAt = isoDate(acknowledgement.expiresAt, "MESSAGE_ACK_INVALID");
  assertRetention(createdAt, expiresAt, "MESSAGE_ACK_RETENTION_INVALID");
  return Object.freeze({
    id: uuid(acknowledgement.id, "MESSAGE_ACK_INVALID"),
    clientMessageId,
    serverSequence: serverSequence(
      acknowledgement.serverSequence,
      false,
      "MESSAGE_ACK_INVALID",
    ),
    kind,
    createdAt,
    expiresAt,
    created: acknowledgement.created,
  });
}

export function validateAttachmentUploadRequest(
  value: unknown,
): AttachmentUploadRequest {
  const input = record(value, "ATTACHMENT_UPLOAD_REQUEST_INVALID");
  exactKeys(
    input,
    [
      "declaredMimeType",
      "plaintextByteSize",
      "ciphertextByteSize",
      "ciphertextSha256",
    ],
    "ATTACHMENT_UPLOAD_REQUEST_FIELDS_INVALID",
  );
  const plaintextByteSize = integer(
    input.plaintextByteSize,
    1,
    MAX_IMAGE_PLAINTEXT_BYTES,
    "ATTACHMENT_UPLOAD_REQUEST_INVALID",
  );
  return Object.freeze({
    declaredMimeType: imageMimeType(input.declaredMimeType),
    plaintextByteSize,
    ciphertextByteSize: integer(
      input.ciphertextByteSize,
      plaintextByteSize,
      MAX_IMAGE_CIPHERTEXT_BYTES,
      "ATTACHMENT_UPLOAD_REQUEST_INVALID",
    ),
    ciphertextSha256: sha256Hex(
      input.ciphertextSha256,
      "ATTACHMENT_UPLOAD_REQUEST_INVALID",
    ),
  });
}

export function validateSendEncryptedMessageRequest(
  value: unknown,
): SendEncryptedMessageRequest {
  const input = record(value, "SEND_MESSAGE_REQUEST_INVALID");
  const allowedKeys = [
    "clientMessageId",
    "senderDeviceId",
    "kind",
    "envelopes",
    ...(Object.hasOwn(input, "attachmentGrantToken")
      ? ["attachmentGrantToken"]
      : []),
  ];
  exactKeys(input, allowedKeys, "SEND_MESSAGE_REQUEST_FIELDS_INVALID");
  const clientMessageId = uuid(
    input.clientMessageId,
    "SEND_MESSAGE_REQUEST_INVALID",
  );
  const senderDeviceId = uuid(
    input.senderDeviceId,
    "SEND_MESSAGE_REQUEST_INVALID",
  );
  const kind = messageKind(input.kind, "SEND_MESSAGE_REQUEST_INVALID");
  if (
    !Array.isArray(input.envelopes) ||
    input.envelopes.length < 1 ||
    input.envelopes.length > 64
  ) {
    fail("SEND_MESSAGE_ENVELOPES_INVALID");
  }

  const recipients = new Set<string>();
  let canonicalCiphertext: string | undefined;
  const envelopes = input.envelopes.map((value) => {
    const envelope = record(value, "SEND_MESSAGE_ENVELOPE_INVALID");
    exactKeys(
      envelope,
      ["recipientDeviceId", "protocolVersion", "cipherSuite", "ciphertext"],
      "SEND_MESSAGE_ENVELOPE_FIELDS_INVALID",
    );
    const recipientDeviceId = uuid(
      envelope.recipientDeviceId,
      "SEND_MESSAGE_ENVELOPE_INVALID",
    );
    if (
      recipients.has(recipientDeviceId) ||
      envelope.protocolVersion !== MATRIX_MESSAGE_PROTOCOL_VERSION ||
      envelope.cipherSuite !== MATRIX_MEGOLM_ALGORITHM
    ) {
      fail("SEND_MESSAGE_ENVELOPE_INVALID");
    }
    recipients.add(recipientDeviceId);
    const parsed = parseMatrixMegolmEnvelopeBase64(envelope.ciphertext);
    if (
      parsed.content.device_id !== matrixDeviceIdFromUuid(senderDeviceId) ||
      (canonicalCiphertext !== undefined && canonicalCiphertext !== parsed.base64)
    ) {
      fail("SEND_MESSAGE_ENVELOPE_BINDING_INVALID");
    }
    canonicalCiphertext = parsed.base64;
    return Object.freeze({
      recipientDeviceId,
      protocolVersion: MATRIX_MESSAGE_PROTOCOL_VERSION,
      cipherSuite: MATRIX_MEGOLM_ALGORITHM,
      ciphertext: parsed.base64,
    });
  });

  const attachmentGrantToken = input.attachmentGrantToken;
  if (
    (kind === "TEXT" && attachmentGrantToken !== undefined) ||
    (kind === "IMAGE" &&
      (typeof attachmentGrantToken !== "string" ||
        attachmentGrantToken.length < 80 ||
        attachmentGrantToken.length > 4_096 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(attachmentGrantToken)))
  ) {
    fail("SEND_MESSAGE_ATTACHMENT_GRANT_INVALID");
  }

  return Object.freeze({
    clientMessageId,
    senderDeviceId,
    kind,
    envelopes: Object.freeze(envelopes),
    ...(typeof attachmentGrantToken === "string"
      ? { attachmentGrantToken }
      : {}),
  });
}

export function parseMessageReceiptAcknowledgement(
  value: unknown,
  expectedMessageId: string,
): MessageReceiptAcknowledgement {
  const receipt = record(value, "MESSAGE_RECEIPT_ACK_INVALID");
  exactKeys(
    receipt,
    ["messageId", "status", "deliveredAt", "readAt"],
    "MESSAGE_RECEIPT_ACK_FIELDS_INVALID",
  );
  const messageId = uuid(receipt.messageId, "MESSAGE_RECEIPT_ACK_INVALID");
  const expectedId = uuid(
    expectedMessageId,
    "MESSAGE_RECEIPT_ACK_EXPECTATION_INVALID",
  );
  const status = receiptStatus(receipt.status);
  const deliveredAt = nullableIsoDate(
    receipt.deliveredAt,
    "MESSAGE_RECEIPT_ACK_INVALID",
  );
  const readAt = nullableIsoDate(receipt.readAt, "MESSAGE_RECEIPT_ACK_INVALID");
  if (
    messageId !== expectedId ||
    status === "SENT" ||
    deliveredAt === null ||
    (status === "DELIVERED" && readAt !== null) ||
    (status === "READ" && readAt === null) ||
    (readAt !== null && Date.parse(readAt) < Date.parse(deliveredAt))
  ) {
    fail("MESSAGE_RECEIPT_ACK_MISMATCH");
  }
  return Object.freeze({ messageId, status, deliveredAt, readAt });
}

export function parseMatrixMegolmEnvelopeBase64(value: unknown): {
  readonly base64: string;
  readonly json: string;
  readonly content: MatrixMegolmContent;
} {
  const decoded = decodeCanonicalPaddedBase64(
    value,
    16,
    MAX_ENVELOPE_BYTES,
    "MATRIX_MEGOLM_BASE64_INVALID",
  );
  let json: string;
  let rawContent: unknown;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    rawContent = JSON.parse(json) as unknown;
  } catch {
    fail("MATRIX_MEGOLM_JSON_INVALID");
  }
  const content = record(rawContent, "MATRIX_MEGOLM_CONTENT_INVALID");
  exactKeys(
    content,
    ["algorithm", "ciphertext", "device_id", "sender_key", "session_id"],
    "MATRIX_MEGOLM_CONTENT_FIELDS_INVALID",
  );
  if (
    content.algorithm !== MATRIX_MEGOLM_ALGORITHM ||
    typeof content.device_id !== "string" ||
    !MATRIX_DEVICE_ID_PATTERN.test(content.device_id) ||
    typeof content.sender_key !== "string" ||
    decodeCanonicalUnpaddedBase64(content.sender_key, 32) === undefined ||
    typeof content.session_id !== "string" ||
    decodeCanonicalUnpaddedBase64(content.session_id, 32) === undefined ||
    typeof content.ciphertext !== "string" ||
    decodeCanonicalUnpaddedBase64(content.ciphertext, undefined, 16) === undefined
  ) {
    fail("MATRIX_MEGOLM_CONTENT_INVALID");
  }
  return Object.freeze({
    base64: value as string,
    json,
    content: Object.freeze({
      algorithm: MATRIX_MEGOLM_ALGORITHM,
      ciphertext: content.ciphertext,
      device_id: content.device_id,
      sender_key: content.sender_key,
      session_id: content.session_id,
    }),
  });
}

function parseEncryptedMessage(value: unknown): EncryptedTransportMessage {
  const message = record(value, "MESSAGE_ITEM_INVALID");
  exactKeys(
    message,
    [
      "id",
      "senderUserId",
      "senderDeviceId",
      "clientMessageId",
      "serverSequence",
      "kind",
      "createdAt",
      "expiresAt",
      "envelope",
      "attachment",
      "receipts",
    ],
    "MESSAGE_ITEM_FIELDS_INVALID",
  );
  const kind = messageKind(message.kind, "MESSAGE_ITEM_INVALID");
  const createdAt = isoDate(message.createdAt, "MESSAGE_ITEM_INVALID");
  const expiresAt = isoDate(message.expiresAt, "MESSAGE_ITEM_INVALID");
  assertRetention(createdAt, expiresAt, "MESSAGE_RETENTION_INVALID");
  const envelope = parseEnvelope(message.envelope);
  const senderDeviceId = uuid(message.senderDeviceId, "MESSAGE_ITEM_INVALID");
  if (envelope.content.device_id !== matrixDeviceIdFromUuid(senderDeviceId)) {
    fail("MESSAGE_ENVELOPE_SENDER_DEVICE_MISMATCH");
  }
  const attachment =
    message.attachment === null
      ? null
      : parseAttachment(message.attachment);
  if (kind === "TEXT" && attachment !== null) {
    fail("MESSAGE_ATTACHMENT_KIND_INVALID");
  }
  if (!Array.isArray(message.receipts) || message.receipts.length > 1) {
    fail("MESSAGE_RECEIPTS_INVALID");
  }
  const receipts = message.receipts.map(parseReceipt);
  return Object.freeze({
    id: uuid(message.id, "MESSAGE_ITEM_INVALID"),
    senderUserId: uuid(message.senderUserId, "MESSAGE_ITEM_INVALID"),
    senderDeviceId,
    clientMessageId: uuid(message.clientMessageId, "MESSAGE_ITEM_INVALID"),
    serverSequence: serverSequence(
      message.serverSequence,
      false,
      "MESSAGE_ITEM_INVALID",
    ),
    kind,
    createdAt,
    expiresAt,
    envelope,
    attachment,
    receipts: Object.freeze(receipts),
  });
}

function parseEnvelope(value: unknown): EncryptedTransportMessage["envelope"] {
  const envelope = record(value, "MESSAGE_ENVELOPE_INVALID");
  exactKeys(
    envelope,
    ["protocolVersion", "cipherSuite", "ciphertext"],
    "MESSAGE_ENVELOPE_FIELDS_INVALID",
  );
  if (
    envelope.protocolVersion !== MATRIX_MESSAGE_PROTOCOL_VERSION ||
    envelope.cipherSuite !== MATRIX_MEGOLM_ALGORITHM
  ) {
    fail("MESSAGE_ENVELOPE_PROFILE_INVALID");
  }
  const parsed = parseMatrixMegolmEnvelopeBase64(envelope.ciphertext);
  return Object.freeze({
    protocolVersion: MATRIX_MESSAGE_PROTOCOL_VERSION,
    cipherSuite: MATRIX_MEGOLM_ALGORITHM,
    ciphertext: parsed.base64,
    content: parsed.content,
  });
}

function parseAttachment(value: unknown): EncryptedMessageAttachment {
  const attachment = record(value, "MESSAGE_ATTACHMENT_INVALID");
  exactKeys(
    attachment,
    [
      "declaredMimeType",
      "plaintextByteSize",
      "ciphertextByteSize",
      "ciphertextSha256",
      "cipherSuite",
      "downloadUrl",
    ],
    "MESSAGE_ATTACHMENT_FIELDS_INVALID",
  );
  if (attachment.cipherSuite !== MATRIX_ATTACHMENT_CIPHER_SUITE) {
    fail("MESSAGE_ATTACHMENT_PROFILE_INVALID");
  }
  const plaintextByteSize = integer(
    attachment.plaintextByteSize,
    1,
    MAX_IMAGE_PLAINTEXT_BYTES,
    "MESSAGE_ATTACHMENT_INVALID",
  );
  const ciphertextByteSize = integer(
    attachment.ciphertextByteSize,
    plaintextByteSize,
    MAX_IMAGE_CIPHERTEXT_BYTES,
    "MESSAGE_ATTACHMENT_INVALID",
  );
  return Object.freeze({
    declaredMimeType: imageMimeType(attachment.declaredMimeType),
    plaintextByteSize,
    ciphertextByteSize,
    ciphertextSha256: sha256Hex(
      attachment.ciphertextSha256,
      "MESSAGE_ATTACHMENT_INVALID",
    ),
    cipherSuite: MATRIX_ATTACHMENT_CIPHER_SUITE,
    downloadUrl: httpUrl(
      attachment.downloadUrl,
      "MESSAGE_ATTACHMENT_URL_INVALID",
    ),
  });
}

function parseReceipt(value: unknown): EncryptedMessageReceipt {
  const receipt = record(value, "MESSAGE_RECEIPT_INVALID");
  exactKeys(
    receipt,
    ["recipientUserId", "status", "deliveredAt", "readAt"],
    "MESSAGE_RECEIPT_FIELDS_INVALID",
  );
  const status = receiptStatus(receipt.status);
  const deliveredAt = nullableIsoDate(receipt.deliveredAt, "MESSAGE_RECEIPT_INVALID");
  const readAt = nullableIsoDate(receipt.readAt, "MESSAGE_RECEIPT_INVALID");
  if (
    (status === "SENT" && (deliveredAt !== null || readAt !== null)) ||
    (status === "DELIVERED" && (deliveredAt === null || readAt !== null)) ||
    (status === "READ" && (deliveredAt === null || readAt === null)) ||
    (deliveredAt !== null && readAt !== null && Date.parse(readAt) < Date.parse(deliveredAt))
  ) {
    fail("MESSAGE_RECEIPT_STATE_INVALID");
  }
  return Object.freeze({
    recipientUserId: uuid(receipt.recipientUserId, "MESSAGE_RECEIPT_INVALID"),
    status,
    deliveredAt,
    readAt,
  });
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

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: string,
): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string" || !expected.includes(key))
  ) {
    fail(code);
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail(code);
    }
  }
}

function uuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID_V4_PATTERN.test(value)) fail(code);
  return value;
}

function matrixDeviceIdFromUuid(value: string): string {
  return `D${value.replaceAll("-", "").toUpperCase()}`;
}

function messageKind(value: unknown, code: string): EncryptedMessageKind {
  if (value !== "TEXT" && value !== "IMAGE") fail(code);
  return value;
}

function receiptStatus(value: unknown): EncryptedMessageReceiptStatus {
  if (value !== "SENT" && value !== "DELIVERED" && value !== "READ") {
    fail("MESSAGE_RECEIPT_INVALID");
  }
  return value;
}

function imageMimeType(value: unknown): EncryptedImageMimeType {
  if (value !== "image/jpeg" && value !== "image/png" && value !== "image/webp") {
    fail("MESSAGE_ATTACHMENT_INVALID");
  }
  return value;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(code);
  }
  return value;
}

function serverSequence(value: unknown, allowZero: boolean, code: string): string {
  if (
    typeof value !== "string" ||
    !SERVER_SEQUENCE_PATTERN.test(value) ||
    (!allowZero && value === "0")
  ) {
    fail(code);
  }
  return value;
}

function sha256Hex(value: unknown, code: string): string {
  if (typeof value !== "string" || !HEX_SHA256_PATTERN.test(value)) fail(code);
  return value;
}

function isoDate(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail(code);
  }
  return value;
}

function nullableIsoDate(value: unknown, code: string): string | null {
  return value === null ? null : isoDate(value, code);
}

function assertRetention(createdAt: string, expiresAt: string, code: string): void {
  if (Date.parse(expiresAt) - Date.parse(createdAt) !== RETENTION_MILLISECONDS) {
    fail(code);
  }
}

function httpUrl(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length > 8_192) fail(code);
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      fail(code);
    }
    return parsed.toString();
  } catch {
    fail(code);
  }
}

function decodeCanonicalPaddedBase64(
  value: unknown,
  minimumBytes: number,
  maximumBytes: number,
  code: string,
): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !PADDED_BASE64_PATTERN.test(value)
  ) {
    fail(code);
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    fail(code);
  }
  if (binary.length < minimumBytes || binary.length > maximumBytes) fail(code);
  if (btoa(binary) !== value) fail(code);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeCanonicalUnpaddedBase64(
  value: string,
  expectedBytes?: number,
  minimumBytes = 1,
): Uint8Array | undefined {
  if (!UNPADDED_BASE64_PATTERN.test(value) || value.length % 4 === 1) {
    return undefined;
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(value + padding);
  } catch {
    return undefined;
  }
  if (
    binary.length < minimumBytes ||
    (expectedBytes !== undefined && binary.length !== expectedBytes) ||
    btoa(binary).replace(/=+$/u, "") !== value
  ) {
    return undefined;
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hexToBase64(value: string): string {
  let binary = "";
  for (let index = 0; index < value.length; index += 2) {
    binary += String.fromCharCode(Number.parseInt(value.slice(index, index + 2), 16));
  }
  return btoa(binary);
}

function fail(code: string): never {
  throw new MessagePayloadError(code);
}
