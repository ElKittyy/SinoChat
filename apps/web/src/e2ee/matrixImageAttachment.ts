import {
  ALLOWED_IMAGE_MIME_TYPES,
  ATTACHMENT_MAX_BYTES,
} from "@sinochat/contracts";

export type AllowedImageMimeType =
  (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

export interface PlainImageAttachment {
  bytes: Uint8Array;
  mimeType: AllowedImageMimeType | string;
}

/**
 * Resultado listo para reservar y subir el blob cifrado.
 *
 * `mediaEncryptionInfo` contiene la clave del adjunto: debe viajar solamente
 * dentro del evento de aplicacion cifrado con Megolm. Nunca debe enviarse junto
 * al blob, al grant de subida ni a metadatos visibles para el servidor.
 */
export interface MatrixEncryptedImageAttachment {
  encryptedBytes: Uint8Array;
  mediaEncryptionInfo: string;
  declaredMimeType: AllowedImageMimeType;
  plaintextByteSize: number;
  ciphertextByteSize: number;
  ciphertextSha256: string;
}

export interface DecryptedImageAttachment {
  bytes: Uint8Array;
  mimeType: AllowedImageMimeType;
}

export type MatrixImageAttachmentErrorCode =
  | "E2EE_IMAGE_BYTES_INVALID"
  | "E2EE_IMAGE_EMPTY"
  | "E2EE_IMAGE_TOO_LARGE"
  | "E2EE_IMAGE_MIME_UNSUPPORTED"
  | "E2EE_IMAGE_MIME_MISMATCH"
  | "E2EE_IMAGE_PLAINTEXT_SIZE_INVALID"
  | "E2EE_IMAGE_CIPHERTEXT_SIZE_INVALID"
  | "E2EE_IMAGE_CIPHERTEXT_HASH_INVALID"
  | "E2EE_IMAGE_MEDIA_INFO_INVALID"
  | "E2EE_IMAGE_MEDIA_INFO_NOT_CONSUMED"
  | "E2EE_IMAGE_WEB_CRYPTO_REQUIRED"
  | "E2EE_IMAGE_ENCRYPT_FAILED"
  | "E2EE_IMAGE_DECRYPT_FAILED";

export class MatrixImageAttachmentError extends Error {
  constructor(
    readonly code: MatrixImageAttachmentErrorCode,
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "MatrixImageAttachmentError";
  }
}

let matrixModulePromise:
  | Promise<typeof import("@matrix-org/matrix-sdk-crypto-wasm")>
  | undefined;
let matrixInitializationPromise: Promise<void> | undefined;

/**
 * Cifra una imagen con el formato de adjuntos Matrix v2 (AES-256-CTR).
 * La firma binaria debe coincidir con el MIME declarado y el limite se aplica
 * a bytes reales, no al valor no confiable de `File.size`.
 */
export async function encryptMatrixImageAttachment(
  input: PlainImageAttachment,
): Promise<MatrixEncryptedImageAttachment> {
  const mimeType = parseAllowedMimeType(input?.mimeType);
  const plaintext = copyAndValidateBytes(input?.bytes, "plaintext");
  assertMimeMatchesBytes(plaintext, mimeType);
  requireSubtleCrypto();

  const matrix = await loadMatrixAttachmentModule().catch((error) => {
    throw wrapError("E2EE_IMAGE_ENCRYPT_FAILED", error);
  });
  let attachment:
    | InstanceType<typeof matrix.EncryptedAttachment>
    | undefined;

  try {
    attachment = matrix.Attachment.encrypt(plaintext);
    if (attachment.hasMediaEncryptionInfoBeenConsumed) {
      throw new MatrixImageAttachmentError(
        "E2EE_IMAGE_MEDIA_INFO_INVALID",
      );
    }

    // Se copia antes de liberar el wrapper WASM. El getter devuelve undefined
    // una vez que Attachment.decrypt ha consumido el secreto.
    const mediaEncryptionInfo = attachment.mediaEncryptionInfo;
    if (mediaEncryptionInfo === undefined) {
      throw new MatrixImageAttachmentError(
        "E2EE_IMAGE_MEDIA_INFO_INVALID",
      );
    }
    const encryptedBytes = attachment.encryptedData;
    if (
      encryptedBytes.byteLength === 0 ||
      encryptedBytes.byteLength !== plaintext.byteLength ||
      encryptedBytes.byteLength > ATTACHMENT_MAX_BYTES
    ) {
      throw new MatrixImageAttachmentError(
        "E2EE_IMAGE_CIPHERTEXT_SIZE_INVALID",
      );
    }

    const mediaInfo = parseMediaEncryptionInfo(mediaEncryptionInfo);
    const calculatedHash = await sha256(encryptedBytes);
    if (!equalBytes(mediaInfo.sha256, calculatedHash)) {
      throw new MatrixImageAttachmentError(
        "E2EE_IMAGE_CIPHERTEXT_HASH_INVALID",
      );
    }

    return {
      encryptedBytes,
      mediaEncryptionInfo,
      declaredMimeType: mimeType,
      plaintextByteSize: plaintext.byteLength,
      ciphertextByteSize: encryptedBytes.byteLength,
      ciphertextSha256: bytesToHex(calculatedHash),
    };
  } catch (error) {
    throw wrapError("E2EE_IMAGE_ENCRYPT_FAILED", error);
  } finally {
    attachment?.free();
    // Evita retener una segunda copia local del contenido sin cifrar.
    plaintext.fill(0);
  }
}

/**
 * Reconstruye un EncryptedAttachment efimero y consume exactamente una vez su
 * `mediaEncryptionInfo`. Antes de descifrar se comprueba el hash del blob tanto
 * contra el servidor como contra el descriptor secreto del evento E2EE.
 */
export async function decryptMatrixImageAttachment(
  input: MatrixEncryptedImageAttachment,
): Promise<DecryptedImageAttachment> {
  const mimeType = parseAllowedMimeType(input?.declaredMimeType);
  const plaintextByteSize = parseByteSize(
    input?.plaintextByteSize,
    "E2EE_IMAGE_PLAINTEXT_SIZE_INVALID",
  );
  const ciphertextByteSize = parseByteSize(
    input?.ciphertextByteSize,
    "E2EE_IMAGE_CIPHERTEXT_SIZE_INVALID",
  );
  const encryptedBytes = copyAndValidateBytes(
    input?.encryptedBytes,
    "ciphertext",
  );
  if (
    encryptedBytes.byteLength !== ciphertextByteSize ||
    ciphertextByteSize !== plaintextByteSize
  ) {
    throw new MatrixImageAttachmentError(
      "E2EE_IMAGE_CIPHERTEXT_SIZE_INVALID",
    );
  }

  const expectedServerHash = parseSha256Hex(input?.ciphertextSha256);
  // Captura tambien el JSON validado antes del primer await para que un objeto
  // mutable no pueda cambiar la clave entre la validacion y el constructor.
  const mediaInfo = parseMediaEncryptionInfo(input?.mediaEncryptionInfo);
  requireSubtleCrypto();
  const calculatedHash = await sha256(encryptedBytes);
  if (
    !equalBytes(calculatedHash, expectedServerHash) ||
    !equalBytes(calculatedHash, mediaInfo.sha256)
  ) {
    throw new MatrixImageAttachmentError(
      "E2EE_IMAGE_CIPHERTEXT_HASH_INVALID",
    );
  }

  const matrix = await loadMatrixAttachmentModule().catch((error) => {
    throw wrapError("E2EE_IMAGE_DECRYPT_FAILED", error);
  });
  let attachment:
    | InstanceType<typeof matrix.EncryptedAttachment>
    | undefined;
  let plaintext: Uint8Array | undefined;

  try {
    try {
      attachment = new matrix.EncryptedAttachment(
        encryptedBytes,
        mediaInfo.json,
      );
    } catch (error) {
      throw new MatrixImageAttachmentError(
        "E2EE_IMAGE_MEDIA_INFO_INVALID",
        error,
      );
    }
    if (attachment.hasMediaEncryptionInfoBeenConsumed) {
      throw new MatrixImageAttachmentError(
        "E2EE_IMAGE_MEDIA_INFO_INVALID",
      );
    }

    plaintext = matrix.Attachment.decrypt(attachment);
    if (!attachment.hasMediaEncryptionInfoBeenConsumed) {
      plaintext.fill(0);
      throw new MatrixImageAttachmentError(
        "E2EE_IMAGE_MEDIA_INFO_NOT_CONSUMED",
      );
    }
    if (plaintext.byteLength !== plaintextByteSize) {
      plaintext.fill(0);
      throw new MatrixImageAttachmentError(
        "E2EE_IMAGE_PLAINTEXT_SIZE_INVALID",
      );
    }
    try {
      assertMimeMatchesBytes(plaintext, mimeType);
    } catch (error) {
      plaintext.fill(0);
      throw error;
    }

    return { bytes: plaintext, mimeType };
  } catch (error) {
    throw wrapError("E2EE_IMAGE_DECRYPT_FAILED", error);
  } finally {
    attachment?.free();
    encryptedBytes.fill(0);
  }
}

/** Detecta solo contenedores admitidos; no confia en nombre ni extension. */
export function detectAllowedImageMimeType(
  value: Uint8Array,
): AllowedImageMimeType | undefined {
  if (!(value instanceof Uint8Array)) return undefined;
  if (looksLikeJpeg(value)) return "image/jpeg";
  if (looksLikePng(value)) return "image/png";
  if (looksLikeWebP(value)) return "image/webp";
  return undefined;
}

function copyAndValidateBytes(
  value: unknown,
  kind: "plaintext" | "ciphertext",
): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new MatrixImageAttachmentError("E2EE_IMAGE_BYTES_INVALID");
  }
  if (value.byteLength === 0) {
    throw new MatrixImageAttachmentError("E2EE_IMAGE_EMPTY");
  }
  if (value.byteLength > ATTACHMENT_MAX_BYTES) {
    throw new MatrixImageAttachmentError(
      kind === "plaintext"
        ? "E2EE_IMAGE_TOO_LARGE"
        : "E2EE_IMAGE_CIPHERTEXT_SIZE_INVALID",
    );
  }
  // Corta aliasing con File/ArrayBuffer y evita un cambio entre validacion y
  // cifrado/descifrado desde otro consumidor del mismo buffer.
  return new Uint8Array(value);
}

function parseAllowedMimeType(value: unknown): AllowedImageMimeType {
  if (
    typeof value !== "string" ||
    !ALLOWED_IMAGE_MIME_TYPES.includes(value as AllowedImageMimeType)
  ) {
    throw new MatrixImageAttachmentError(
      "E2EE_IMAGE_MIME_UNSUPPORTED",
    );
  }
  return value as AllowedImageMimeType;
}

function assertMimeMatchesBytes(
  bytes: Uint8Array,
  declaredMimeType: AllowedImageMimeType,
): void {
  if (detectAllowedImageMimeType(bytes) !== declaredMimeType) {
    throw new MatrixImageAttachmentError("E2EE_IMAGE_MIME_MISMATCH");
  }
}

function parseByteSize(
  value: unknown,
  code:
    | "E2EE_IMAGE_PLAINTEXT_SIZE_INVALID"
    | "E2EE_IMAGE_CIPHERTEXT_SIZE_INVALID",
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > ATTACHMENT_MAX_BYTES
  ) {
    throw new MatrixImageAttachmentError(code);
  }
  return value;
}

function parseSha256Hex(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new MatrixImageAttachmentError(
      "E2EE_IMAGE_CIPHERTEXT_HASH_INVALID",
    );
  }
  const result = new Uint8Array(32);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function parseMediaEncryptionInfo(value: unknown): {
  json: string;
  sha256: Uint8Array;
} {
  if (
    typeof value !== "string" ||
    value.length < 100 ||
    value.length > 2_048
  ) {
    throw new MatrixImageAttachmentError(
      "E2EE_IMAGE_MEDIA_INFO_INVALID",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new MatrixImageAttachmentError(
      "E2EE_IMAGE_MEDIA_INFO_INVALID",
      error,
    );
  }
  const root = exactRecord(
    parsed,
    ["hashes", "iv", "key", "v"],
    "E2EE_IMAGE_MEDIA_INFO_INVALID",
  );
  const key = exactRecord(
    root.key,
    ["alg", "ext", "k", "key_ops", "kty"],
    "E2EE_IMAGE_MEDIA_INFO_INVALID",
  );
  const hashes = exactRecord(
    root.hashes,
    ["sha256"],
    "E2EE_IMAGE_MEDIA_INFO_INVALID",
  );
  if (
    root.v !== "v2" ||
    key.kty !== "oct" ||
    key.alg !== "A256CTR" ||
    key.ext !== true ||
    !Array.isArray(key.key_ops) ||
    key.key_ops.length !== 2 ||
    new Set(key.key_ops).size !== 2 ||
    !key.key_ops.includes("encrypt") ||
    !key.key_ops.includes("decrypt") ||
    typeof key.k !== "string" ||
    typeof root.iv !== "string" ||
    typeof hashes.sha256 !== "string"
  ) {
    throw new MatrixImageAttachmentError(
      "E2EE_IMAGE_MEDIA_INFO_INVALID",
    );
  }

  decodeBase64(key.k, 32, true);
  const iv = decodeBase64(root.iv, 16, false);
  // Matrix v2 usa los ultimos 64 bits como contador inicial en cero.
  if (iv.subarray(8).some((byte) => byte !== 0)) {
    throw new MatrixImageAttachmentError(
      "E2EE_IMAGE_MEDIA_INFO_INVALID",
    );
  }
  return {
    json: value,
    sha256: decodeBase64(hashes.sha256, 32, false),
  };
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: MatrixImageAttachmentErrorCode,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new MatrixImageAttachmentError(code);
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new MatrixImageAttachmentError(code);
  }
  return value as Record<string, unknown>;
}

function decodeBase64(
  value: string,
  expectedBytes: number,
  urlSafe: boolean,
): Uint8Array {
  const pattern = urlSafe
    ? /^[A-Za-z0-9_-]+$/
    : /^[A-Za-z0-9+/]+$/;
  if (!pattern.test(value) || value.length % 4 === 1) {
    throw new MatrixImageAttachmentError(
      "E2EE_IMAGE_MEDIA_INFO_INVALID",
    );
  }
  const standard = urlSafe
    ? value.replaceAll("-", "+").replaceAll("_", "/")
    : value;
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch (error) {
    throw new MatrixImageAttachmentError(
      "E2EE_IMAGE_MEDIA_INFO_INVALID",
      error,
    );
  }
  if (decoded.length !== expectedBytes) {
    throw new MatrixImageAttachmentError(
      "E2EE_IMAGE_MEDIA_INFO_INVALID",
    );
  }
  const bytes = Uint8Array.from(decoded, (character) =>
    character.charCodeAt(0),
  );
  const canonical = bytesToBase64(bytes, urlSafe);
  if (canonical !== value) {
    throw new MatrixImageAttachmentError(
      "E2EE_IMAGE_MEDIA_INFO_INVALID",
    );
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array, urlSafe: boolean): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const standard = btoa(binary).replace(/=+$/u, "");
  return urlSafe
    ? standard.replaceAll("+", "-").replaceAll("/", "_")
    : standard;
}

function bytesToHex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

function requireSubtleCrypto(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) {
    throw new MatrixImageAttachmentError(
      "E2EE_IMAGE_WEB_CRYPTO_REQUIRED",
    );
  }
  return globalThis.crypto.subtle;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // `slice` garantiza un ArrayBuffer propio compatible con BufferSource y sin
  // riesgo de que cambie mientras WebCrypto procesa el digest.
  const digest = await requireSubtleCrypto().digest("SHA-256", bytes.slice());
  return new Uint8Array(digest);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function looksLikeJpeg(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 8 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[3] !== 0x00 &&
    bytes[3] !== 0xff &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  );
}

function looksLikePng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.byteLength < 45 ||
    signature.some((byte, index) => bytes[index] !== byte)
  ) {
    return false;
  }

  let offset = 8;
  let chunkIndex = 0;
  let sawImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = readUint32BigEndian(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const nextOffset = offset + 12 + length;
    if (nextOffset > bytes.length || !/^[A-Za-z]{4}$/.test(type)) {
      return false;
    }
    if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) {
      return false;
    }
    if (type === "IDAT") sawImageData = true;
    if (type === "IEND") {
      return length === 0 && sawImageData && nextOffset === bytes.length;
    }
    chunkIndex += 1;
    offset = nextOffset;
  }
  return false;
}

function looksLikeWebP(bytes: Uint8Array): boolean {
  if (
    bytes.byteLength < 20 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP" ||
    readUint32LittleEndian(bytes, 4) !== bytes.length - 8
  ) {
    return false;
  }

  let offset = 12;
  let sawImageChunk = false;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = readUint32LittleEndian(bytes, offset + 4);
    const paddedLength = length + (length % 2);
    const nextOffset = offset + 8 + paddedLength;
    if (nextOffset > bytes.length || !/^[\x20-\x7e]{4}$/.test(type)) {
      return false;
    }
    if (["VP8 ", "VP8L", "VP8X", "ANMF"].includes(type)) {
      sawImageChunk = true;
    }
    offset = nextOffset;
  }
  return sawImageChunk && offset === bytes.length;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return value;
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! * 0x1000000) +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! +
    (bytes[offset + 1]! << 8) +
    (bytes[offset + 2]! << 16) +
    (bytes[offset + 3]! * 0x1000000)
  );
}

async function loadMatrixAttachmentModule() {
  matrixModulePromise ??= import("@matrix-org/matrix-sdk-crypto-wasm");
  const matrix = await matrixModulePromise;
  matrixInitializationPromise ??= matrix.initAsync();
  await matrixInitializationPromise;
  return matrix;
}

function wrapError(
  fallbackCode:
    | "E2EE_IMAGE_ENCRYPT_FAILED"
    | "E2EE_IMAGE_DECRYPT_FAILED",
  error: unknown,
): MatrixImageAttachmentError {
  return error instanceof MatrixImageAttachmentError
    ? error
    : new MatrixImageAttachmentError(fallbackCode, error);
}
