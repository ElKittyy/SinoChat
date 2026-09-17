const DATABASE_NAME = "sinochat-e2ee-local-device-v1";
const DATABASE_VERSION = 1;
const KEY_STORE = "keyring";
const DEVICE_STORE = "devices";
const WRAPPING_KEY_ID = "device-secrets-v1";
const RECORD_VERSION = 1;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MatrixLocalDeviceRecord {
  userId: string;
  deviceId: string;
  matrixServerName: string;
  storePassphrase: string;
  bindingSecret?: string;
  initialKeyUpload?: MatrixInitialKeyUpload;
  initialCompletionResponse?: string;
}

export interface MatrixInitialKeyUpload {
  requestId: string;
  requestType: number;
  body: string;
}

export interface MatrixLocalDeviceStore {
  load(userId: string): Promise<MatrixLocalDeviceRecord | undefined>;
  createProvisional(input: {
    userId: string;
    deviceId: string;
    matrixServerName: string;
  }): Promise<MatrixLocalDeviceRecord>;
  saveInitialKeyUpload(
    userId: string,
    deviceId: string,
    request: MatrixInitialKeyUpload,
  ): Promise<MatrixLocalDeviceRecord>;
  saveInitialCompletion(
    userId: string,
    deviceId: string,
    bindingSecret: string,
    response: string,
  ): Promise<MatrixLocalDeviceRecord>;
  finishInitialKeyUpload(
    userId: string,
    deviceId: string,
  ): Promise<MatrixLocalDeviceRecord>;
  clear(userId: string): Promise<void>;
}

export class MatrixLocalDeviceStoreError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MatrixLocalDeviceStoreError";
  }
}

interface StoredWrappingKey {
  id: typeof WRAPPING_KEY_ID;
  key: CryptoKey;
}

interface StoredDeviceCiphertext {
  userId: string;
  version: typeof RECORD_VERSION;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
}

/**
 * Conserva los secretos locales cifrados con una CryptoKey AES-GCM no
 * extraible que el navegador serializa por structured clone. Esto evita
 * guardar passphrase/bindingSecret como texto en IndexedDB; no pretende
 * proteger contra JavaScript malicioso ejecutado en el mismo origen.
 */
export class IndexedDbMatrixLocalDeviceStore
  implements MatrixLocalDeviceStore
{
  constructor(private readonly databaseName = DATABASE_NAME) {}

  async load(
    userId: string,
  ): Promise<MatrixLocalDeviceRecord | undefined> {
    assertUserId(userId);
    const [database, wrappingKey] = await Promise.all([
      openDatabase(this.databaseName),
      this.wrappingKey(),
    ]);
    try {
      const transaction = database.transaction(DEVICE_STORE, "readonly");
      const row = await request<unknown>(
        transaction.objectStore(DEVICE_STORE).get(userId),
      );
      await transactionCompletion(transaction);
      if (row === undefined) return undefined;
      const parsed = parseStoredCiphertext(row, userId);
      return decryptRecord(wrappingKey, parsed);
    } finally {
      database.close();
    }
  }

  async createProvisional(input: {
    userId: string;
    deviceId: string;
    matrixServerName: string;
  }): Promise<MatrixLocalDeviceRecord> {
    assertUserId(input.userId);
    assertDeviceId(input.deviceId);
    assertServerName(input.matrixServerName);

    const existing = await this.load(input.userId);
    if (existing) return assertSameRegistration(existing, input);

    const record: MatrixLocalDeviceRecord = {
      ...input,
      storePassphrase: randomSecret(),
    };
    const wrappingKey = await this.wrappingKey();
    const stored = await encryptRecord(wrappingKey, record);
    const database = await openDatabase(this.databaseName);
    try {
      const transaction = database.transaction(DEVICE_STORE, "readwrite");
      try {
        await request(transaction.objectStore(DEVICE_STORE).add(stored));
        await transactionCompletion(transaction);
        return record;
      } catch (error) {
        safelyAbort(transaction);
        if (!isConstraintError(error)) throw error;
      }
    } finally {
      database.close();
    }

    const winner = await this.load(input.userId);
    if (!winner) {
      throw new MatrixLocalDeviceStoreError(
        "MATRIX_LOCAL_DEVICE_CREATE_RACE_LOST",
      );
    }
    return assertSameRegistration(winner, input);
  }

  async saveInitialKeyUpload(
    userId: string,
    deviceId: string,
    request: MatrixInitialKeyUpload,
  ): Promise<MatrixLocalDeviceRecord> {
    assertUserId(userId);
    assertDeviceId(deviceId);
    validateInitialKeyUpload(request);
    const current = await this.requireCurrent(userId, deviceId);
    if (current.initialKeyUpload) {
      if (!sameInitialKeyUpload(current.initialKeyUpload, request)) {
        throw new MatrixLocalDeviceStoreError(
          "MATRIX_LOCAL_INITIAL_UPLOAD_CHANGED",
        );
      }
      return current;
    }
    if (
      current.bindingSecret !== undefined ||
      current.initialCompletionResponse !== undefined
    ) {
      throw new MatrixLocalDeviceStoreError(
        "MATRIX_LOCAL_INITIAL_UPLOAD_STATE_INVALID",
      );
    }
    return this.write({ ...current, initialKeyUpload: request });
  }

  async saveInitialCompletion(
    userId: string,
    deviceId: string,
    bindingSecret: string,
    response: string,
  ): Promise<MatrixLocalDeviceRecord> {
    assertUserId(userId);
    assertDeviceId(deviceId);
    if (!SECRET_PATTERN.test(bindingSecret)) {
      throw new MatrixLocalDeviceStoreError(
        "MATRIX_LOCAL_BINDING_SECRET_INVALID",
      );
    }
    if (response.length < 2 || response.length > 1_048_576) {
      throw new MatrixLocalDeviceStoreError(
        "MATRIX_LOCAL_INITIAL_RESPONSE_INVALID",
      );
    }
    const current = await this.requireCurrent(userId, deviceId);
    if (!current.initialKeyUpload) {
      throw new MatrixLocalDeviceStoreError(
        "MATRIX_LOCAL_INITIAL_UPLOAD_MISSING",
      );
    }
    if (
      current.bindingSecret !== undefined &&
      current.bindingSecret !== bindingSecret
    ) {
      throw new MatrixLocalDeviceStoreError(
        "MATRIX_LOCAL_BINDING_SECRET_CHANGED",
      );
    }
    if (
      current.initialCompletionResponse !== undefined &&
      current.initialCompletionResponse !== response
    ) {
      throw new MatrixLocalDeviceStoreError(
        "MATRIX_LOCAL_INITIAL_RESPONSE_CHANGED",
      );
    }
    const ready = {
      ...current,
      bindingSecret,
      initialCompletionResponse: response,
    };
    return this.write(ready);
  }

  async finishInitialKeyUpload(
    userId: string,
    deviceId: string,
  ): Promise<MatrixLocalDeviceRecord> {
    const current = await this.requireCurrent(userId, deviceId);
    if (
      !current.bindingSecret ||
      !current.initialCompletionResponse ||
      !current.initialKeyUpload
    ) {
      throw new MatrixLocalDeviceStoreError(
        "MATRIX_LOCAL_INITIAL_UPLOAD_NOT_COMPLETED",
      );
    }
    const ready = { ...current };
    delete ready.initialKeyUpload;
    delete ready.initialCompletionResponse;
    return this.write(ready);
  }

  private async requireCurrent(
    userId: string,
    deviceId: string,
  ): Promise<MatrixLocalDeviceRecord> {
    const current = await this.load(userId);
    if (!current || current.deviceId !== deviceId) {
      throw new MatrixLocalDeviceStoreError(
        "MATRIX_LOCAL_DEVICE_NOT_PROVISIONED",
      );
    }
    return current;
  }

  private async write(
    record: MatrixLocalDeviceRecord,
  ): Promise<MatrixLocalDeviceRecord> {
    validateRecord(record);
    const wrappingKey = await this.wrappingKey();
    const stored = await encryptRecord(wrappingKey, record);
    const database = await openDatabase(this.databaseName);
    try {
      const transaction = database.transaction(DEVICE_STORE, "readwrite");
      await request(transaction.objectStore(DEVICE_STORE).put(stored));
      await transactionCompletion(transaction);
      return record;
    } finally {
      database.close();
    }
  }

  async clear(userId: string): Promise<void> {
    assertUserId(userId);
    const database = await openDatabase(this.databaseName);
    try {
      const transaction = database.transaction(DEVICE_STORE, "readwrite");
      await request(transaction.objectStore(DEVICE_STORE).delete(userId));
      await transactionCompletion(transaction);
    } finally {
      database.close();
    }
  }

  private async wrappingKey(): Promise<CryptoKey> {
    assertBrowserStoragePrerequisites();
    const firstDatabase = await openDatabase(this.databaseName);
    try {
      const transaction = firstDatabase.transaction(KEY_STORE, "readonly");
      const row = await request<unknown>(
        transaction.objectStore(KEY_STORE).get(WRAPPING_KEY_ID),
      );
      await transactionCompletion(transaction);
      const existing = parseWrappingKey(row);
      if (existing) return existing;
    } finally {
      firstDatabase.close();
    }

    const generated = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    if (!isCryptoKey(generated)) {
      throw new MatrixLocalDeviceStoreError(
        "MATRIX_LOCAL_WRAPPING_KEY_INVALID",
      );
    }

    const database = await openDatabase(this.databaseName);
    try {
      const transaction = database.transaction(KEY_STORE, "readwrite");
      const store = transaction.objectStore(KEY_STORE);
      const row = await request<unknown>(store.get(WRAPPING_KEY_ID));
      const winner = parseWrappingKey(row);
      if (winner) {
        await transactionCompletion(transaction);
        return winner;
      }
      await request(
        store.add({ id: WRAPPING_KEY_ID, key: generated } satisfies StoredWrappingKey),
      );
      await transactionCompletion(transaction);
      return generated;
    } finally {
      database.close();
    }
  }
}

async function encryptRecord(
  key: CryptoKey,
  record: MatrixLocalDeviceRecord,
): Promise<StoredDeviceCiphertext> {
  validateRecord(record);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: additionalData(record.userId),
      tagLength: 128,
    },
    key,
    new TextEncoder().encode(JSON.stringify(record)),
  );
  return {
    userId: record.userId,
    version: RECORD_VERSION,
    iv: copyBuffer(iv),
    ciphertext,
  };
}

async function decryptRecord(
  key: CryptoKey,
  stored: StoredDeviceCiphertext,
): Promise<MatrixLocalDeviceRecord> {
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: stored.iv,
        additionalData: additionalData(stored.userId),
        tagLength: 128,
      },
      key,
      stored.ciphertext,
    );
  } catch {
    throw new MatrixLocalDeviceStoreError(
      "MATRIX_LOCAL_DEVICE_DECRYPT_FAILED",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch {
    throw new MatrixLocalDeviceStoreError(
      "MATRIX_LOCAL_DEVICE_PAYLOAD_INVALID",
    );
  }
  const record = parseRecord(value);
  if (record.userId !== stored.userId) {
    throw new MatrixLocalDeviceStoreError(
      "MATRIX_LOCAL_DEVICE_OWNER_MISMATCH",
    );
  }
  return record;
}

function parseStoredCiphertext(
  value: unknown,
  expectedUserId: string,
): StoredDeviceCiphertext {
  if (!isRecord(value)) {
    throw new MatrixLocalDeviceStoreError("MATRIX_LOCAL_DEVICE_ROW_INVALID");
  }
  const { ciphertext, iv, userId, version } = value;
  if (
    userId !== expectedUserId ||
    version !== RECORD_VERSION ||
    !(iv instanceof ArrayBuffer) ||
    iv.byteLength !== 12 ||
    !(ciphertext instanceof ArrayBuffer) ||
    ciphertext.byteLength < 17
  ) {
    throw new MatrixLocalDeviceStoreError("MATRIX_LOCAL_DEVICE_ROW_INVALID");
  }
  return { ciphertext, iv, userId, version };
}

function parseWrappingKey(value: unknown): CryptoKey | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.id !== WRAPPING_KEY_ID) {
    throw new MatrixLocalDeviceStoreError(
      "MATRIX_LOCAL_WRAPPING_KEY_ROW_INVALID",
    );
  }
  const key = value.key;
  if (
    !isCryptoKey(key) ||
    key.extractable ||
    key.algorithm.name !== "AES-GCM" ||
    !key.usages.includes("encrypt") ||
    !key.usages.includes("decrypt")
  ) {
    throw new MatrixLocalDeviceStoreError(
      "MATRIX_LOCAL_WRAPPING_KEY_INVALID",
    );
  }
  return key;
}

function parseRecord(value: unknown): MatrixLocalDeviceRecord {
  if (!isRecord(value)) {
    throw new MatrixLocalDeviceStoreError(
      "MATRIX_LOCAL_DEVICE_PAYLOAD_INVALID",
    );
  }
  const {
    bindingSecret,
    deviceId,
    initialCompletionResponse,
    initialKeyUpload,
    matrixServerName,
    storePassphrase,
    userId,
  } = value;
  const record: MatrixLocalDeviceRecord = {
    userId: String(userId),
    deviceId: String(deviceId),
    matrixServerName: String(matrixServerName),
    storePassphrase: String(storePassphrase),
    ...(bindingSecret === undefined
      ? {}
      : { bindingSecret: String(bindingSecret) }),
    ...(initialKeyUpload === undefined
      ? {}
      : { initialKeyUpload: parseInitialKeyUpload(initialKeyUpload) }),
    ...(initialCompletionResponse === undefined
      ? {}
      : { initialCompletionResponse: String(initialCompletionResponse) }),
  };
  validateRecord(record);
  return record;
}

function validateRecord(record: MatrixLocalDeviceRecord): void {
  assertUserId(record.userId);
  assertDeviceId(record.deviceId);
  assertServerName(record.matrixServerName);
  if (!SECRET_PATTERN.test(record.storePassphrase)) {
    throw new MatrixLocalDeviceStoreError(
      "MATRIX_LOCAL_STORE_PASSPHRASE_INVALID",
    );
  }
  if (
    record.bindingSecret !== undefined &&
    !SECRET_PATTERN.test(record.bindingSecret)
  ) {
    throw new MatrixLocalDeviceStoreError(
      "MATRIX_LOCAL_BINDING_SECRET_INVALID",
    );
  }
  if (record.initialKeyUpload) {
    validateInitialKeyUpload(record.initialKeyUpload);
  }
  if (
    record.initialCompletionResponse !== undefined &&
    (record.initialCompletionResponse.length < 2 ||
      record.initialCompletionResponse.length > 1_048_576)
  ) {
    throw new MatrixLocalDeviceStoreError(
      "MATRIX_LOCAL_INITIAL_RESPONSE_INVALID",
    );
  }
  if (
    record.initialCompletionResponse !== undefined &&
    (record.initialKeyUpload === undefined ||
      record.bindingSecret === undefined)
  ) {
    throw new MatrixLocalDeviceStoreError(
      "MATRIX_LOCAL_INITIAL_UPLOAD_STATE_INVALID",
    );
  }
  if (
    record.initialKeyUpload !== undefined &&
    record.bindingSecret !== undefined &&
    record.initialCompletionResponse === undefined
  ) {
    throw new MatrixLocalDeviceStoreError(
      "MATRIX_LOCAL_INITIAL_UPLOAD_STATE_INVALID",
    );
  }
}

function parseInitialKeyUpload(value: unknown): MatrixInitialKeyUpload {
  if (!isRecord(value)) {
    throw new MatrixLocalDeviceStoreError(
      "MATRIX_LOCAL_INITIAL_UPLOAD_INVALID",
    );
  }
  const request = {
    requestId: String(value.requestId),
    requestType: Number(value.requestType),
    body: String(value.body),
  };
  validateInitialKeyUpload(request);
  return request;
}

function validateInitialKeyUpload(request: MatrixInitialKeyUpload): void {
  if (
    !/^[A-Za-z0-9._=-]{1,255}$/.test(request.requestId) ||
    !Number.isSafeInteger(request.requestType) ||
    request.requestType < 0 ||
    request.requestType > 32 ||
    request.body.length < 2 ||
    request.body.length > 1_048_576
  ) {
    throw new MatrixLocalDeviceStoreError(
      "MATRIX_LOCAL_INITIAL_UPLOAD_INVALID",
    );
  }
}

function sameInitialKeyUpload(
  first: MatrixInitialKeyUpload,
  second: MatrixInitialKeyUpload,
): boolean {
  return (
    first.requestId === second.requestId &&
    first.requestType === second.requestType &&
    first.body === second.body
  );
}

function assertSameRegistration(
  record: MatrixLocalDeviceRecord,
  expected: { userId: string; deviceId: string; matrixServerName: string },
): MatrixLocalDeviceRecord {
  if (
    record.userId !== expected.userId ||
    record.deviceId !== expected.deviceId ||
    record.matrixServerName !== expected.matrixServerName
  ) {
    throw new MatrixLocalDeviceStoreError(
      "MATRIX_LOCAL_DEVICE_REGISTRATION_CONFLICT",
    );
  }
  return record;
}

function assertUserId(value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new MatrixLocalDeviceStoreError("MATRIX_LOCAL_USER_ID_INVALID");
  }
}

function assertDeviceId(value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new MatrixLocalDeviceStoreError("MATRIX_LOCAL_DEVICE_ID_INVALID");
  }
}

function assertServerName(value: string): void {
  if (
    value.length < 1 ||
    value.length > 255 ||
    /[\s/@]/.test(value) ||
    value !== value.toLowerCase()
  ) {
    throw new MatrixLocalDeviceStoreError(
      "MATRIX_LOCAL_SERVER_NAME_INVALID",
    );
  }
}

function assertBrowserStoragePrerequisites(): void {
  if (
    globalThis.isSecureContext !== true ||
    !("indexedDB" in globalThis) ||
    !("crypto" in globalThis) ||
    !("subtle" in crypto) ||
    typeof CryptoKey === "undefined"
  ) {
    throw new MatrixLocalDeviceStoreError(
      "MATRIX_LOCAL_SECURE_STORAGE_UNAVAILABLE",
    );
  }
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof CryptoKey !== "undefined" && value instanceof CryptoKey;
}

function randomSecret(): string {
  assertBrowserStoragePrerequisites();
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function additionalData(userId: string): Uint8Array {
  return new TextEncoder().encode(
    `sinochat:matrix-local-device:v${RECORD_VERSION}:${userId}`,
  );
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConstraintError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "ConstraintError";
}

function safelyAbort(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // La transaccion puede haberse abortado automaticamente por ConstraintError.
  }
}

function openDatabase(name: string): Promise<IDBDatabase> {
  assertBrowserStoragePrerequisites();
  return new Promise((resolve, reject) => {
    const operation = indexedDB.open(name, DATABASE_VERSION);
    operation.onupgradeneeded = () => {
      const database = operation.result;
      if (!database.objectStoreNames.contains(KEY_STORE)) {
        database.createObjectStore(KEY_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(DEVICE_STORE)) {
        database.createObjectStore(DEVICE_STORE, { keyPath: "userId" });
      }
    };
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () =>
      reject(
        operation.error ??
          new MatrixLocalDeviceStoreError(
            "MATRIX_LOCAL_DATABASE_OPEN_FAILED",
          ),
      );
    operation.onblocked = () =>
      reject(
        new MatrixLocalDeviceStoreError("MATRIX_LOCAL_DATABASE_BLOCKED"),
      );
  });
}

function request<T = undefined>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () =>
      reject(
        operation.error ??
          new MatrixLocalDeviceStoreError("MATRIX_LOCAL_DATABASE_FAILED"),
      );
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        transaction.error ??
          new MatrixLocalDeviceStoreError(
            "MATRIX_LOCAL_DATABASE_TRANSACTION_ABORTED",
          ),
      );
    transaction.onerror = () => {
      // onabort entrega el error final y evita resolver antes del rollback.
    };
  });
}
