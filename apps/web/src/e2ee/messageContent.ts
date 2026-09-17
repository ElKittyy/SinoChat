/**
 * Plaintext autenticado que vive dentro de cada evento Megolm de chat.
 *
 * Este modulo no cifra, no transporta mensajes y no modifica el gate E2EE. Su
 * unica responsabilidad es producir y validar el contrato que se entrega al
 * motor Matrix. El servidor solo recibe el resultado cifrado y los metadatos
 * de transporte que ya expone su DTO.
 */

export const SINOCHAT_MESSAGE_EVENT_TYPE =
  "com.sinochat.message.v1" as const;
export const SINOCHAT_MESSAGE_PROTOCOL_VERSION = "matrix-megolm-v1" as const;
export const SINOCHAT_MESSAGE_CIPHER_SUITE =
  "m.megolm.v1.aes-sha2" as const;
export const SINOCHAT_ATTACHMENT_CIPHER_SUITE = "A256CTR" as const;

export const SINOCHAT_MAX_TEXT_LENGTH = 4_000;
export const SINOCHAT_MAX_IMAGE_PLAINTEXT_BYTES = 5 * 1024 * 1024;
export const SINOCHAT_MAX_IMAGE_CIPHERTEXT_BYTES =
  SINOCHAT_MAX_IMAGE_PLAINTEXT_BYTES + 256 * 1024;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MATRIX_ROOM_ID_PATTERN = /^!c([0-9a-f]{32}):(.{1,255})$/;
const MATRIX_SERVER_NAME_PATTERN =
  /^(?:(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?$/;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_32_BYTES_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64_16_BYTES_PATTERN = /^[A-Za-z0-9+/]{22}$/;
const BASE64_32_BYTES_PATTERN = /^[A-Za-z0-9+/]{43}$/;

export type SinoChatMessageKind = "TEXT" | "IMAGE";
export type SinoChatImageMimeType =
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export interface MatrixV2MediaEncryptionInfo {
  readonly v: "v2";
  readonly key: {
    readonly kty: "oct";
    readonly key_ops: readonly ["decrypt", "encrypt"] | readonly ["encrypt", "decrypt"];
    readonly alg: "A256CTR";
    readonly k: string;
    readonly ext: true;
  };
  readonly iv: string;
  readonly hashes: {
    readonly sha256: string;
  };
}

interface SinoChatMessageBase {
  readonly protocolVersion: typeof SINOCHAT_MESSAGE_PROTOCOL_VERSION;
  readonly conversationId: string;
  readonly roomId: string;
  readonly clientMessageId: string;
  readonly senderUserId: string;
  readonly senderDeviceId: string;
}

export interface SinoChatTextMessageContent extends SinoChatMessageBase {
  readonly kind: "TEXT";
  readonly text: string;
}

export interface SinoChatImageMetadata {
  readonly declaredMimeType: SinoChatImageMimeType;
  readonly plaintextByteSize: number;
  readonly ciphertextByteSize: number;
  readonly ciphertextSha256: string;
  readonly mediaEncryptionInfo: MatrixV2MediaEncryptionInfo;
}

export interface SinoChatImageMessageContent extends SinoChatMessageBase {
  readonly kind: "IMAGE";
  readonly image: SinoChatImageMetadata;
}

export type SinoChatMessageContent =
  | SinoChatTextMessageContent
  | SinoChatImageMessageContent;

/** Forma que se pasa a `OlmMachine.encryptRoomEvent(roomId, eventType, content)`. */
export interface EncodedSinoChatMessage<
  TContent extends SinoChatMessageContent = SinoChatMessageContent,
> {
  readonly eventType: typeof SINOCHAT_MESSAGE_EVENT_TYPE;
  readonly content: TContent;
}

export interface EncodeSinoChatTextMessageInput {
  readonly conversationId: string;
  readonly roomId: string;
  readonly clientMessageId: string;
  readonly senderUserId: string;
  readonly senderDeviceId: string;
  readonly text: string;
}

export interface EncodeSinoChatImageMessageInput {
  readonly conversationId: string;
  readonly roomId: string;
  readonly clientMessageId: string;
  readonly senderUserId: string;
  readonly senderDeviceId: string;
  readonly declaredMimeType: SinoChatImageMimeType;
  readonly plaintextByteSize: number;
  readonly ciphertextByteSize: number;
  readonly ciphertextSha256: string;
  /** JSON emitido por `EncryptedAttachment.mediaEncryptionInfo` u objeto ya parseado. */
  readonly mediaEncryptionInfo: unknown;
}

export interface SinoChatAttachmentTransportMetadata {
  readonly declaredMimeType: string;
  readonly plaintextByteSize: number;
  readonly ciphertextByteSize: number;
  readonly ciphertextSha256: string;
  readonly cipherSuite: string;
}

/**
 * Metadatos exteriores devueltos por `GET .../messages` que deben coincidir con
 * el plaintext autenticado. Los campos adicionales de la respuesta (URL,
 * fechas, recibos) no forman parte de esta comparacion.
 */
export interface SinoChatMessageTransportBinding {
  readonly conversationId: string;
  readonly roomId: string;
  readonly clientMessageId: string;
  readonly senderUserId: string;
  readonly senderDeviceId: string;
  readonly kind: SinoChatMessageKind;
  readonly protocolVersion: string;
  readonly cipherSuite: string;
  readonly attachment?: SinoChatAttachmentTransportMetadata | null;
}

export type SinoChatMessageCodecErrorCode =
  | "SINOCHAT_MESSAGE_INPUT_INVALID"
  | "SINOCHAT_MESSAGE_EVENT_TYPE_INVALID"
  | "SINOCHAT_MESSAGE_CONTENT_INVALID"
  | "SINOCHAT_MESSAGE_BINDING_MISMATCH"
  | "SINOCHAT_ATTACHMENT_INFO_INVALID"
  | "SINOCHAT_ATTACHMENT_BINDING_MISMATCH";

export class SinoChatMessageCodecError extends Error {
  readonly code: SinoChatMessageCodecErrorCode;

  constructor(code: SinoChatMessageCodecErrorCode) {
    super(code);
    this.name = "SinoChatMessageCodecError";
    this.code = code;
  }
}

export function encodeSinoChatTextMessage(
  input: EncodeSinoChatTextMessageInput,
): EncodedSinoChatMessage<SinoChatTextMessageContent> {
  const record = plainRecord(input, "SINOCHAT_MESSAGE_INPUT_INVALID");
  assertOnlyDataKeys(
    record,
    [
      "conversationId",
      "roomId",
      "clientMessageId",
      "senderUserId",
      "senderDeviceId",
      "text",
    ],
    "SINOCHAT_MESSAGE_INPUT_INVALID",
  );

  const content = parseTextContent({
    protocolVersion: SINOCHAT_MESSAGE_PROTOCOL_VERSION,
    conversationId: record.conversationId,
    roomId: record.roomId,
    clientMessageId: record.clientMessageId,
    senderUserId: record.senderUserId,
    senderDeviceId: record.senderDeviceId,
    kind: "TEXT",
    text: record.text,
  });
  return Object.freeze({
    eventType: SINOCHAT_MESSAGE_EVENT_TYPE,
    content,
  });
}

export function encodeSinoChatImageMessage(
  input: EncodeSinoChatImageMessageInput,
): EncodedSinoChatMessage<SinoChatImageMessageContent> {
  const record = plainRecord(input, "SINOCHAT_MESSAGE_INPUT_INVALID");
  assertOnlyDataKeys(
    record,
    [
      "conversationId",
      "roomId",
      "clientMessageId",
      "senderUserId",
      "senderDeviceId",
      "declaredMimeType",
      "plaintextByteSize",
      "ciphertextByteSize",
      "ciphertextSha256",
      "mediaEncryptionInfo",
    ],
    "SINOCHAT_MESSAGE_INPUT_INVALID",
  );

  const content = parseImageContent({
    protocolVersion: SINOCHAT_MESSAGE_PROTOCOL_VERSION,
    conversationId: record.conversationId,
    roomId: record.roomId,
    clientMessageId: record.clientMessageId,
    senderUserId: record.senderUserId,
    senderDeviceId: record.senderDeviceId,
    kind: "IMAGE",
    image: {
      declaredMimeType: record.declaredMimeType,
      plaintextByteSize: record.plaintextByteSize,
      ciphertextByteSize: record.ciphertextByteSize,
      ciphertextSha256: normalizeHexSha256(record.ciphertextSha256),
      mediaEncryptionInfo: parseMediaEncryptionInfo(
        record.mediaEncryptionInfo,
      ),
    },
  });
  return Object.freeze({
    eventType: SINOCHAT_MESSAGE_EVENT_TYPE,
    content,
  });
}

/**
 * Valida un evento ya autenticado por Megolm. Nunca debe llamarse sobre datos antes
 * de que Rust Crypto confirme su autenticidad y el dispositivo remitente.
 */
export function decodeSinoChatMessageContent(
  eventType: unknown,
  value: unknown,
  binding: SinoChatMessageTransportBinding,
): SinoChatMessageContent {
  if (eventType !== SINOCHAT_MESSAGE_EVENT_TYPE) {
    throw new SinoChatMessageCodecError(
      "SINOCHAT_MESSAGE_EVENT_TYPE_INVALID",
    );
  }

  const content = plainRecord(value, "SINOCHAT_MESSAGE_CONTENT_INVALID");
  const parsed =
    content.kind === "TEXT"
      ? parseTextContent(content)
      : content.kind === "IMAGE"
        ? parseImageContent(content)
        : invalid("SINOCHAT_MESSAGE_CONTENT_INVALID");

  assertSinoChatMessageBinding(parsed, binding);
  return parsed;
}

export function assertSinoChatMessageBinding(
  content: SinoChatMessageContent,
  binding: SinoChatMessageTransportBinding,
): void {
  const expectedConversationId = uuid(
    binding.conversationId,
    "SINOCHAT_MESSAGE_BINDING_MISMATCH",
  );
  const expectedRoomId = matrixRoomId(
    binding.roomId,
    expectedConversationId,
    "SINOCHAT_MESSAGE_BINDING_MISMATCH",
  );
  const expectedClientMessageId = uuid(
    binding.clientMessageId,
    "SINOCHAT_MESSAGE_BINDING_MISMATCH",
  );
  const expectedSenderDeviceId = uuid(
    binding.senderDeviceId,
    "SINOCHAT_MESSAGE_BINDING_MISMATCH",
  );
  const expectedSenderUserId = uuid(
    binding.senderUserId,
    "SINOCHAT_MESSAGE_BINDING_MISMATCH",
  );
  if (
    binding.kind !== content.kind ||
    binding.protocolVersion !== content.protocolVersion ||
    binding.cipherSuite !== SINOCHAT_MESSAGE_CIPHER_SUITE ||
    expectedConversationId !== content.conversationId ||
    expectedRoomId !== content.roomId ||
    expectedClientMessageId !== content.clientMessageId ||
    expectedSenderUserId !== content.senderUserId ||
    expectedSenderDeviceId !== content.senderDeviceId
  ) {
    throw new SinoChatMessageCodecError(
      "SINOCHAT_MESSAGE_BINDING_MISMATCH",
    );
  }

  if (content.kind === "TEXT") {
    if (binding.attachment !== undefined && binding.attachment !== null) {
      throw new SinoChatMessageCodecError(
        "SINOCHAT_ATTACHMENT_BINDING_MISMATCH",
      );
    }
    return;
  }

  const attachment = binding.attachment;
  if (
    !attachment ||
    attachment.declaredMimeType !== content.image.declaredMimeType ||
    attachment.plaintextByteSize !== content.image.plaintextByteSize ||
    attachment.ciphertextByteSize !== content.image.ciphertextByteSize ||
    attachment.cipherSuite !== SINOCHAT_ATTACHMENT_CIPHER_SUITE ||
    normalizeHexSha256(
      attachment.ciphertextSha256,
      "SINOCHAT_ATTACHMENT_BINDING_MISMATCH",
    ) !== content.image.ciphertextSha256
  ) {
    throw new SinoChatMessageCodecError(
      "SINOCHAT_ATTACHMENT_BINDING_MISMATCH",
    );
  }
}

function parseTextContent(value: unknown): SinoChatTextMessageContent {
  const record = plainRecord(value, "SINOCHAT_MESSAGE_CONTENT_INVALID");
  assertOnlyDataKeys(
    record,
    [
      "protocolVersion",
      "conversationId",
      "roomId",
      "clientMessageId",
      "senderUserId",
      "senderDeviceId",
      "kind",
      "text",
    ],
    "SINOCHAT_MESSAGE_CONTENT_INVALID",
  );
  if (
    record.protocolVersion !== SINOCHAT_MESSAGE_PROTOCOL_VERSION ||
    record.kind !== "TEXT" ||
    typeof record.text !== "string" ||
    record.text.length < 1 ||
    record.text.length > SINOCHAT_MAX_TEXT_LENGTH ||
    record.text.trim().length === 0 ||
    !isWellFormedUnicode(record.text)
  ) {
    throw new SinoChatMessageCodecError(
      "SINOCHAT_MESSAGE_CONTENT_INVALID",
    );
  }

  const conversationId = uuid(
    record.conversationId,
    "SINOCHAT_MESSAGE_CONTENT_INVALID",
  );
  return Object.freeze({
    protocolVersion: SINOCHAT_MESSAGE_PROTOCOL_VERSION,
    conversationId,
    roomId: matrixRoomId(
      record.roomId,
      conversationId,
      "SINOCHAT_MESSAGE_CONTENT_INVALID",
    ),
    clientMessageId: uuid(
      record.clientMessageId,
      "SINOCHAT_MESSAGE_CONTENT_INVALID",
    ),
    senderUserId: uuid(
      record.senderUserId,
      "SINOCHAT_MESSAGE_CONTENT_INVALID",
    ),
    senderDeviceId: uuid(
      record.senderDeviceId,
      "SINOCHAT_MESSAGE_CONTENT_INVALID",
    ),
    kind: "TEXT",
    text: record.text,
  });
}

function parseImageContent(value: unknown): SinoChatImageMessageContent {
  const record = plainRecord(value, "SINOCHAT_MESSAGE_CONTENT_INVALID");
  assertOnlyDataKeys(
    record,
    [
      "protocolVersion",
      "conversationId",
      "roomId",
      "clientMessageId",
      "senderUserId",
      "senderDeviceId",
      "kind",
      "image",
    ],
    "SINOCHAT_MESSAGE_CONTENT_INVALID",
  );
  if (
    record.protocolVersion !== SINOCHAT_MESSAGE_PROTOCOL_VERSION ||
    record.kind !== "IMAGE"
  ) {
    throw new SinoChatMessageCodecError(
      "SINOCHAT_MESSAGE_CONTENT_INVALID",
    );
  }

  const conversationId = uuid(
    record.conversationId,
    "SINOCHAT_MESSAGE_CONTENT_INVALID",
  );
  const image = parseImageMetadata(record.image);
  return Object.freeze({
    protocolVersion: SINOCHAT_MESSAGE_PROTOCOL_VERSION,
    conversationId,
    roomId: matrixRoomId(
      record.roomId,
      conversationId,
      "SINOCHAT_MESSAGE_CONTENT_INVALID",
    ),
    clientMessageId: uuid(
      record.clientMessageId,
      "SINOCHAT_MESSAGE_CONTENT_INVALID",
    ),
    senderUserId: uuid(
      record.senderUserId,
      "SINOCHAT_MESSAGE_CONTENT_INVALID",
    ),
    senderDeviceId: uuid(
      record.senderDeviceId,
      "SINOCHAT_MESSAGE_CONTENT_INVALID",
    ),
    kind: "IMAGE",
    image,
  });
}

function parseImageMetadata(value: unknown): SinoChatImageMetadata {
  const record = plainRecord(value, "SINOCHAT_ATTACHMENT_INFO_INVALID");
  assertOnlyDataKeys(
    record,
    [
      "declaredMimeType",
      "plaintextByteSize",
      "ciphertextByteSize",
      "ciphertextSha256",
      "mediaEncryptionInfo",
    ],
    "SINOCHAT_ATTACHMENT_INFO_INVALID",
  );

  const mimeType = imageMimeType(record.declaredMimeType);
  const plaintextByteSize = boundedInteger(
    record.plaintextByteSize,
    1,
    SINOCHAT_MAX_IMAGE_PLAINTEXT_BYTES,
    "SINOCHAT_ATTACHMENT_INFO_INVALID",
  );
  const ciphertextByteSize = boundedInteger(
    record.ciphertextByteSize,
    plaintextByteSize,
    SINOCHAT_MAX_IMAGE_CIPHERTEXT_BYTES,
    "SINOCHAT_ATTACHMENT_INFO_INVALID",
  );
  const ciphertextSha256 = normalizeHexSha256(record.ciphertextSha256);
  const mediaEncryptionInfo = parseMediaEncryptionInfo(
    record.mediaEncryptionInfo,
  );
  if (
    decodeUnpaddedBase64ToHex(
      mediaEncryptionInfo.hashes.sha256,
      false,
    ) !== ciphertextSha256
  ) {
    throw new SinoChatMessageCodecError(
      "SINOCHAT_ATTACHMENT_INFO_INVALID",
    );
  }

  return Object.freeze({
    declaredMimeType: mimeType,
    plaintextByteSize,
    ciphertextByteSize,
    ciphertextSha256,
    mediaEncryptionInfo,
  });
}

function parseMediaEncryptionInfo(
  value: unknown,
): MatrixV2MediaEncryptionInfo {
  let parsed = value;
  if (typeof value === "string") {
    if (value.length < 2 || value.length > 2_048) {
      throw new SinoChatMessageCodecError(
        "SINOCHAT_ATTACHMENT_INFO_INVALID",
      );
    }
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new SinoChatMessageCodecError(
        "SINOCHAT_ATTACHMENT_INFO_INVALID",
      );
    }
  }

  const info = plainRecord(parsed, "SINOCHAT_ATTACHMENT_INFO_INVALID");
  assertOnlyDataKeys(
    info,
    ["v", "key", "iv", "hashes"],
    "SINOCHAT_ATTACHMENT_INFO_INVALID",
  );
  const key = plainRecord(info.key, "SINOCHAT_ATTACHMENT_INFO_INVALID");
  assertOnlyDataKeys(
    key,
    ["kty", "key_ops", "alg", "k", "ext"],
    "SINOCHAT_ATTACHMENT_INFO_INVALID",
  );
  const hashes = plainRecord(
    info.hashes,
    "SINOCHAT_ATTACHMENT_INFO_INVALID",
  );
  assertOnlyDataKeys(
    hashes,
    ["sha256"],
    "SINOCHAT_ATTACHMENT_INFO_INVALID",
  );

  if (
    info.v !== "v2" ||
    key.kty !== "oct" ||
    key.alg !== "A256CTR" ||
    key.ext !== true ||
    typeof key.k !== "string" ||
    !BASE64URL_32_BYTES_PATTERN.test(key.k) ||
    typeof info.iv !== "string" ||
    !BASE64_16_BYTES_PATTERN.test(info.iv) ||
    typeof hashes.sha256 !== "string" ||
    !BASE64_32_BYTES_PATTERN.test(hashes.sha256) ||
    !isExactKeyOperations(key.key_ops)
  ) {
    throw new SinoChatMessageCodecError(
      "SINOCHAT_ATTACHMENT_INFO_INVALID",
    );
  }

  // Comprueba bits de relleno canónicos además de la longitud textual.
  decodeUnpaddedBase64ToHex(key.k, true);
  decodeUnpaddedBase64ToHex(info.iv, false);
  decodeUnpaddedBase64ToHex(hashes.sha256, false);

  const keyOperations = Object.freeze(
    [...key.key_ops] as ["decrypt", "encrypt"] | ["encrypt", "decrypt"],
  );
  return Object.freeze({
    v: "v2",
    key: Object.freeze({
      kty: "oct",
      key_ops: keyOperations,
      alg: "A256CTR",
      k: key.k,
      ext: true,
    }),
    iv: info.iv,
    hashes: Object.freeze({ sha256: hashes.sha256 }),
  });
}

function imageMimeType(value: unknown): SinoChatImageMimeType {
  if (
    value !== "image/jpeg" &&
    value !== "image/png" &&
    value !== "image/webp"
  ) {
    throw new SinoChatMessageCodecError(
      "SINOCHAT_ATTACHMENT_INFO_INVALID",
    );
  }
  return value;
}

function normalizeHexSha256(
  value: unknown,
  code: SinoChatMessageCodecErrorCode = "SINOCHAT_ATTACHMENT_INFO_INVALID",
): string {
  if (typeof value !== "string") {
    throw new SinoChatMessageCodecError(code);
  }
  const normalized = value.toLowerCase();
  if (!HEX_SHA256_PATTERN.test(normalized)) {
    throw new SinoChatMessageCodecError(code);
  }
  return normalized;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  code: SinoChatMessageCodecErrorCode,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new SinoChatMessageCodecError(code);
  }
  return value;
}

function uuid(value: unknown, code: SinoChatMessageCodecErrorCode): string {
  if (typeof value !== "string" || !UUID_V4_PATTERN.test(value)) {
    throw new SinoChatMessageCodecError(code);
  }
  return value.toLowerCase();
}

function matrixRoomId(
  value: unknown,
  conversationId: string,
  code: SinoChatMessageCodecErrorCode,
): string {
  if (
    typeof value !== "string" ||
    value !== value.toLowerCase() ||
    value.length > 300
  ) {
    throw new SinoChatMessageCodecError(code);
  }

  const match = MATRIX_ROOM_ID_PATTERN.exec(value);
  const expectedConversationHex = conversationId.replaceAll("-", "");
  if (!match || match[1] !== expectedConversationHex) {
    throw new SinoChatMessageCodecError(code);
  }

  const serverName = match[2]!;
  if (
    !MATRIX_SERVER_NAME_PATTERN.test(serverName) ||
    serverName.includes("@") ||
    serverName.includes("/") ||
    serverName.startsWith(".") ||
    serverName.endsWith(".") ||
    serverName.includes("..")
  ) {
    throw new SinoChatMessageCodecError(code);
  }

  try {
    const parsed = new URL(`https://${serverName}`);
    if (!parsed.hostname || parsed.username || parsed.password) {
      throw new SinoChatMessageCodecError(code);
    }
  } catch {
    throw new SinoChatMessageCodecError(code);
  }
  return value;
}

function isExactKeyOperations(
  value: unknown,
): value is ["decrypt", "encrypt"] | ["encrypt", "decrypt"] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    ((value[0] === "decrypt" && value[1] === "encrypt") ||
      (value[0] === "encrypt" && value[1] === "decrypt"))
  );
}

function decodeUnpaddedBase64ToHex(
  value: string,
  urlSafe: boolean,
): string {
  const alphabet = urlSafe
    ? "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let accumulator = 0;
  let bits = 0;
  let output = "";

  for (const character of value) {
    const sextet = alphabet.indexOf(character);
    if (sextet < 0) {
      throw new SinoChatMessageCodecError(
        "SINOCHAT_ATTACHMENT_INFO_INVALID",
      );
    }
    accumulator = (accumulator << 6) | sextet;
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      output += ((accumulator >>> bits) & 0xff)
        .toString(16)
        .padStart(2, "0");
      accumulator &= bits === 0 ? 0 : (1 << bits) - 1;
    }
  }

  if (bits > 0 && accumulator !== 0) {
    throw new SinoChatMessageCodecError(
      "SINOCHAT_ATTACHMENT_INFO_INVALID",
    );
  }
  return output;
}

function plainRecord(
  value: unknown,
  code: SinoChatMessageCodecErrorCode,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SinoChatMessageCodecError(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SinoChatMessageCodecError(code);
  }
  return value as Record<string, unknown>;
}

function assertOnlyDataKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  code: SinoChatMessageCodecErrorCode,
): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some(
      (key) => typeof key !== "string" || !expectedKeys.includes(key),
    )
  ) {
    throw new SinoChatMessageCodecError(code);
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new SinoChatMessageCodecError(code);
    }
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function invalid(code: SinoChatMessageCodecErrorCode): never {
  throw new SinoChatMessageCodecError(code);
}
