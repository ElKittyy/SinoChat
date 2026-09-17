const MATRIX_USER_ID_PATTERN = /^@u[0-9a-f]{32}:[^\s/@]{1,255}$/;
const MATRIX_DEVICE_ID_PATTERN = /^D[0-9A-F]{32}$/;
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9._~-]{1,255}$/;
const CURVE25519_KEY_PATTERN = /^[A-Za-z0-9+/]{43}$/;
const OLM_BODY_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const MATRIX_MESSAGE_ID_PATTERN = /^[0-9a-f]{32}$/;
const MAX_USERS = 10;
const MAX_TARGET_DEVICES = 20;
const MAX_CONTENT_BYTES = 60 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;

export const MATRIX_OLM_EVENT_TYPE = "m.room.encrypted";
export const MATRIX_OLM_ALGORITHM = "m.olm.v1.curve25519-aes-sha2";

export interface MatrixOlmCiphertext {
  body: string;
  type: 0 | 1;
}

export interface MatrixOlmToDeviceContent {
  algorithm: typeof MATRIX_OLM_ALGORITHM;
  ciphertext: Record<string, MatrixOlmCiphertext>;
  "org.matrix.msgid": string;
  sender_key: string;
}

export interface MatrixToDeviceRequest {
  eventType: typeof MATRIX_OLM_EVENT_TYPE;
  transactionId: string;
  messages: Record<
    string,
    Record<string, MatrixOlmToDeviceContent>
  >;
  targetCount: number;
}

export class MatrixToDeviceValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MatrixToDeviceValidationError";
  }
}

export function parseMatrixToDeviceRequest(
  rawEventType: string,
  rawTransactionId: string,
  value: unknown
): MatrixToDeviceRequest {
  if (rawEventType !== MATRIX_OLM_EVENT_TYPE) {
    fail("MATRIX_TO_DEVICE_EVENT_TYPE_INVALID");
  }
  if (!TRANSACTION_ID_PATTERN.test(rawTransactionId)) {
    fail("MATRIX_TO_DEVICE_TRANSACTION_ID_INVALID");
  }
  const body = record(value, "MATRIX_TO_DEVICE_BODY_INVALID");
  exactKeys(body, ["messages"], "MATRIX_TO_DEVICE_BODY_FIELDS_INVALID");
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_REQUEST_BYTES) {
    fail("MATRIX_TO_DEVICE_REQUEST_TOO_LARGE");
  }

  const rawMessages = record(
    body.messages,
    "MATRIX_TO_DEVICE_MESSAGES_INVALID"
  );
  const users = Object.entries(rawMessages);
  if (users.length < 1 || users.length > MAX_USERS) {
    fail("MATRIX_TO_DEVICE_USER_LIMIT_INVALID");
  }

  let targetCount = 0;
  const messages: MatrixToDeviceRequest["messages"] = {};
  for (const [userId, rawDevices] of users) {
    if (!MATRIX_USER_ID_PATTERN.test(userId)) {
      fail("MATRIX_TO_DEVICE_USER_ID_INVALID");
    }
    const devices = record(
      rawDevices,
      "MATRIX_TO_DEVICE_DEVICES_INVALID"
    );
    const deviceEntries = Object.entries(devices);
    if (deviceEntries.length < 1) {
      fail("MATRIX_TO_DEVICE_DEVICES_INVALID");
    }
    const parsedDevices: Record<string, MatrixOlmToDeviceContent> = {};
    for (const [deviceId, rawContent] of deviceEntries) {
      if (!MATRIX_DEVICE_ID_PATTERN.test(deviceId)) {
        fail("MATRIX_TO_DEVICE_DEVICE_ID_INVALID");
      }
      targetCount += 1;
      if (targetCount > MAX_TARGET_DEVICES) {
        fail("MATRIX_TO_DEVICE_TARGET_LIMIT_INVALID");
      }
      parsedDevices[deviceId] = parseMatrixOlmContent(rawContent);
    }
    messages[userId] = parsedDevices;
  }

  return {
    eventType: MATRIX_OLM_EVENT_TYPE,
    transactionId: rawTransactionId,
    messages,
    targetCount
  };
}

export function matrixToDeviceHashInput(
  request: MatrixToDeviceRequest
): Record<string, unknown> {
  return {
    event_type: request.eventType,
    messages: request.messages
  };
}

export function parseMatrixOlmContent(
  value: unknown
): MatrixOlmToDeviceContent {
  const content = record(value, "MATRIX_TO_DEVICE_CONTENT_INVALID");
  exactKeys(
    content,
    ["algorithm", "ciphertext", "org.matrix.msgid", "sender_key"],
    "MATRIX_TO_DEVICE_CONTENT_FIELDS_INVALID"
  );
  if (
    content.algorithm !== MATRIX_OLM_ALGORITHM ||
    typeof content["org.matrix.msgid"] !== "string" ||
    !MATRIX_MESSAGE_ID_PATTERN.test(content["org.matrix.msgid"]) ||
    typeof content.sender_key !== "string" ||
    !CURVE25519_KEY_PATTERN.test(content.sender_key)
  ) {
    fail("MATRIX_TO_DEVICE_OLM_ENVELOPE_INVALID");
  }
  const ciphertext = record(
    content.ciphertext,
    "MATRIX_TO_DEVICE_CIPHERTEXT_INVALID"
  );
  const entries = Object.entries(ciphertext);
  if (entries.length !== 1) {
    fail("MATRIX_TO_DEVICE_CIPHERTEXT_INVALID");
  }
  const parsedCiphertext: Record<string, MatrixOlmCiphertext> = {};
  for (const [curveKey, rawCiphertext] of entries) {
    if (!CURVE25519_KEY_PATTERN.test(curveKey)) {
      fail("MATRIX_TO_DEVICE_CIPHERTEXT_INVALID");
    }
    const encrypted = record(
      rawCiphertext,
      "MATRIX_TO_DEVICE_CIPHERTEXT_INVALID"
    );
    exactKeys(
      encrypted,
      ["body", "type"],
      "MATRIX_TO_DEVICE_CIPHERTEXT_INVALID"
    );
    if (
      typeof encrypted.body !== "string" ||
      encrypted.body.length < 1 ||
      !OLM_BODY_PATTERN.test(encrypted.body) ||
      (encrypted.type !== 0 && encrypted.type !== 1)
    ) {
      fail("MATRIX_TO_DEVICE_CIPHERTEXT_INVALID");
    }
    parsedCiphertext[curveKey] = {
      body: encrypted.body,
      type: encrypted.type
    };
  }
  if (Buffer.byteLength(JSON.stringify(content), "utf8") > MAX_CONTENT_BYTES) {
    fail("MATRIX_TO_DEVICE_CONTENT_TOO_LARGE");
  }
  return {
    algorithm: MATRIX_OLM_ALGORITHM,
    ciphertext: parsedCiphertext,
    "org.matrix.msgid": content["org.matrix.msgid"],
    sender_key: content.sender_key
  };
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  errorCode: string
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
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
  throw new MatrixToDeviceValidationError(code);
}
