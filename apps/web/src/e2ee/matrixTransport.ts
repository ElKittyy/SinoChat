import {
  DeviceLists,
  ProcessedToDeviceEventType,
  RequestType,
  UserId,
  type OlmMachine,
} from "@matrix-org/matrix-sdk-crypto-wasm";

const APPLICATION_MESSAGE_EVENT_TYPE = "com.sinochat.message.v1";
const MATRIX_SIGNED_CURVE25519 = "signed_curve25519";
const MAX_QUERY_USERS_PER_HTTP_REQUEST = 20;
const MAX_OUTGOING_REQUESTS_PER_FLUSH = 100;
const SYNC_TOKEN_PATTERN = /^sct1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

type JsonObject = Record<string, unknown>;
type OutgoingRequest = Awaited<
  ReturnType<OlmMachine["outgoingRequests"]>
>[number];
type ProcessedToDeviceEvent = Awaited<
  ReturnType<OlmMachine["receiveSyncChanges"]>
>[number];

export interface MatrixExclusiveCryptoContext {
  readonly machine: OlmMachine;
  sendExplicitRequest(request: OutgoingRequest): Promise<void>;
  flushOutgoingRequests(): Promise<number>;
}

export interface MatrixSyncRequest {
  signal?: AbortSignal;
  since?: string;
  timeout?: number;
}

export interface MatrixHttpTransport {
  uploadKeys(body: JsonObject, signal?: AbortSignal): Promise<unknown>;
  queryKeys(body: JsonObject, signal?: AbortSignal): Promise<unknown>;
  claimKeys(
    requestId: string,
    body: JsonObject,
    signal?: AbortSignal,
  ): Promise<unknown>;
  sendToDevice(
    eventType: string,
    transactionId: string,
    body: JsonObject,
    signal?: AbortSignal,
  ): Promise<unknown>;
  sync(request: MatrixSyncRequest): Promise<unknown>;
}

export interface MatrixSyncTokenStore {
  load(deviceId: string): Promise<string | undefined>;
  save(deviceId: string, token: string): Promise<void>;
  clear(deviceId: string): Promise<void>;
}

export interface MatrixSyncResult {
  nextBatch: string;
  /** El consumidor debe llamar free() cuando termine de procesar cada evento. */
  processedControlEvents: readonly ProcessedToDeviceEvent[];
  rejectedApplicationEventCount: number;
  outgoingRequestsSent: number;
}

export class MatrixTransportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MatrixTransportError";
  }
}

/**
 * Une Rust Crypto con los endpoints privados de SinoChat. Todas las operaciones
 * se serializan para no aplicar dos respuestas sobre el mismo CryptoStore en
 * paralelo. Un request solo se marca como enviado despues de una respuesta HTTP
 * valida, y next_batch solo se persiste despues de receiveSyncChanges.
 */
export class MatrixTransportCoordinator {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly machine: OlmMachine,
    private readonly matrixDeviceId: string,
    private readonly transport: MatrixHttpTransport,
    private readonly tokenStore: MatrixSyncTokenStore,
  ) {}

  sync(timeout = 0, signal?: AbortSignal): Promise<MatrixSyncResult> {
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 30_000) {
      return Promise.reject(
        new MatrixTransportError("MATRIX_SYNC_TIMEOUT_INVALID"),
      );
    }
    return this.enqueue(() => this.performSync(timeout, signal));
  }

  flushOutgoingRequests(signal?: AbortSignal): Promise<number> {
    return this.enqueue(() => this.flushOutgoingRequestsUnlocked(signal));
  }

  /**
   * Envia y confirma una solicitud devuelta directamente por Rust Crypto,
   * por ejemplo `getMissingSessions` o `shareRoomKey`. Esas solicitudes no
   * siempre aparecen en `outgoingRequests()`. El llamador conserva la
   * propiedad del wrapper WASM y debe invocar `free()` en un `finally`.
   */
  sendExplicitRequest(
    request: OutgoingRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.enqueue(() => this.commitRequestUnlocked(request, signal));
  }

  /**
   * Ejecuta una operacion criptografica completa en la misma cola que sync.
   * El contexto permite confirmar requests sin volver a encolar y evita el
   * intercalado entre key query, key claim, room-key share y cifrado Megolm.
   * Los wrappers WASM siguen siendo propiedad del callback y deben liberarse.
   */
  runExclusiveCryptoOperation<T>(
    operation: (context: MatrixExclusiveCryptoContext) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.enqueue(() =>
      operation({
        machine: this.machine,
        sendExplicitRequest: (request) =>
          this.commitRequestUnlocked(request, signal),
        flushOutgoingRequests: () =>
          this.flushOutgoingRequestsUnlocked(signal),
      }),
    );
  }

  clearSyncPosition(): Promise<void> {
    return this.enqueue(() => this.tokenStore.clear(this.matrixDeviceId));
  }

  /** Espera a que la operacion serializada actual termine o falle. */
  drain(): Promise<void> {
    return this.tail;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async performSync(
    timeout: number,
    signal?: AbortSignal,
  ): Promise<MatrixSyncResult> {
    const since = await this.tokenStore.load(this.matrixDeviceId);
    if (since !== undefined && !SYNC_TOKEN_PATTERN.test(since)) {
      await this.tokenStore.clear(this.matrixDeviceId);
      throw new MatrixTransportError("MATRIX_SYNC_TOKEN_LOCAL_INVALID");
    }

    const sync = parseSyncResponse(
      await this.transport.sync({ since, timeout, signal }),
    );
    const changed = sync.deviceLists.changed.map(
      (matrixUserId) => new UserId(matrixUserId),
    );
    const left = sync.deviceLists.left.map(
      (matrixUserId) => new UserId(matrixUserId),
    );
    const deviceLists = new DeviceLists(changed, left);

    let processed: ProcessedToDeviceEvent[];
    try {
      processed = await this.machine.receiveSyncChanges(
        JSON.stringify(sync.toDeviceEvents),
        deviceLists,
        new Map(Object.entries(sync.oneTimeKeyCounts)),
        new Set(sync.unusedFallbackKeyTypes),
      );
    } finally {
      deviceLists.free();
    }

    const controlEvents: ProcessedToDeviceEvent[] = [];
    let rejectedApplicationEventCount = 0;
    for (const event of processed) {
      if (isApplicationMessageDeliveredToDevice(event)) {
        rejectedApplicationEventCount += 1;
        event.free();
      } else {
        controlEvents.push(event);
      }
    }

    // Si el proceso cae antes de este punto, el SDK vuelve a recibir el mismo
    // lote. Rust Crypto conserva la proteccion de replay; nunca adelantamos el
    // cursor antes de aplicar los cambios criptograficos.
    try {
      await this.tokenStore.save(this.matrixDeviceId, sync.nextBatch);
      const outgoingRequestsSent =
        await this.flushOutgoingRequestsUnlocked(signal);

      return {
        nextBatch: sync.nextBatch,
        processedControlEvents: controlEvents,
        rejectedApplicationEventCount,
        outgoingRequestsSent,
      };
    } catch (error) {
      // El llamador no recibe estos wrappers si falla el commit local o el
      // pump posterior, por lo que debemos liberar su memoria WASM aqui.
      for (const event of controlEvents) event.free();
      throw error;
    }
  }

  private async flushOutgoingRequestsUnlocked(
    signal?: AbortSignal,
  ): Promise<number> {
    let sent = 0;
    while (sent < MAX_OUTGOING_REQUESTS_PER_FLUSH) {
      const requests = await this.machine.outgoingRequests();
      if (requests.length === 0) return sent;

      let index = 0;
      try {
        for (; index < requests.length; index += 1) {
          const request = requests[index]!;
          if (sent >= MAX_OUTGOING_REQUESTS_PER_FLUSH) {
            throw new MatrixTransportError(
              "MATRIX_OUTGOING_REQUEST_LIMIT_REACHED",
            );
          }
          await this.commitRequestUnlocked(request, signal);
          sent += 1;
          request.free();
        }
      } catch (error) {
        for (let rest = index; rest < requests.length; rest += 1) {
          requests[rest]!.free();
        }
        throw error;
      }
    }

    throw new MatrixTransportError("MATRIX_OUTGOING_REQUEST_LIMIT_REACHED");
  }

  private async commitRequestUnlocked(
    request: OutgoingRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    if (typeof request.id !== "string" || request.id.length === 0) {
      throw new MatrixTransportError("MATRIX_OUTGOING_REQUEST_ID_INVALID");
    }
    const response = await this.sendOutgoingRequest(request, signal);
    const marked = await this.machine.markRequestAsSent(
      request.id,
      request.type,
      JSON.stringify(response),
    );
    if (marked !== true) {
      throw new MatrixTransportError(
        "MATRIX_OUTGOING_REQUEST_NOT_COMMITTED",
      );
    }
  }

  private async sendOutgoingRequest(
    request: OutgoingRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const body = parseJsonObject(
      request.body,
      "MATRIX_OUTGOING_REQUEST_BODY_INVALID",
    );
    switch (request.type) {
      case RequestType.KeysUpload:
        return parseKeysUploadResponse(
          await this.transport.uploadKeys(body, signal),
        );
      case RequestType.KeysQuery:
        return this.sendKeysQuery(body, signal);
      case RequestType.KeysClaim:
        if (typeof request.id !== "string" || request.id.length === 0) {
          throw new MatrixTransportError("MATRIX_OUTGOING_REQUEST_ID_INVALID");
        }
        return this.sendKeysClaim(request.id, body, signal);
      case RequestType.ToDevice:
        if (!("event_type" in request) || !("txn_id" in request)) {
          throw new MatrixTransportError(
            "MATRIX_TO_DEVICE_REQUEST_INVALID",
          );
        }
        return parseEmptyResponse(
          await this.transport.sendToDevice(
            request.event_type,
            request.txn_id,
            body,
            signal,
          ),
          "MATRIX_TO_DEVICE_RESPONSE_INVALID",
        );
      default:
        // SignatureUpload, RoomMessage y KeysBackup solo se habilitaran junto
        // con cross-signing/backup. Marcarlos ahora perderia trabajo del SDK.
        throw new MatrixTransportError(
          "MATRIX_OUTGOING_REQUEST_UNSUPPORTED",
        );
    }
  }

  private async sendKeysQuery(
    body: JsonObject,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    assertOnlyKeys(body, ["device_keys"], ["timeout"]);
    const deviceKeys = plainRecord(
      body.device_keys,
      "MATRIX_KEYS_QUERY_BODY_INVALID",
    );
    const entries = Object.entries(deviceKeys);
    if (entries.length === 0) {
      throw new MatrixTransportError("MATRIX_KEYS_QUERY_BODY_INVALID");
    }

    const merged = emptyQueryResponse();
    for (
      let offset = 0;
      offset < entries.length;
      offset += MAX_QUERY_USERS_PER_HTTP_REQUEST
    ) {
      const chunk = Object.fromEntries(
        entries.slice(offset, offset + MAX_QUERY_USERS_PER_HTTP_REQUEST),
      );
      const response = parseQueryResponse(
        await this.transport.queryKeys(
          {
            device_keys: chunk,
            ...(body.timeout === undefined ? {} : { timeout: body.timeout }),
          },
          signal,
        ),
      );
      const requestedUsers = new Set(Object.keys(chunk));
      assertResponseUsers(response.device_keys, requestedUsers);
      assertResponseUsers(response.master_keys, requestedUsers);
      assertResponseUsers(response.self_signing_keys, requestedUsers);
      assertResponseUsers(response.user_signing_keys, requestedUsers);
      if (Object.keys(response.failures).length !== 0) {
        throw new MatrixTransportError(
          "MATRIX_KEYS_QUERY_RESPONSE_INVALID",
        );
      }
      mergeRecord(merged.device_keys, response.device_keys);
      mergeRecord(merged.failures, response.failures);
      mergeRecord(merged.master_keys, response.master_keys);
      mergeRecord(merged.self_signing_keys, response.self_signing_keys);
      mergeRecord(merged.user_signing_keys, response.user_signing_keys);
    }
    return merged;
  }

  private async sendKeysClaim(
    originalRequestId: string,
    body: JsonObject,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    assertOnlyKeys(body, ["one_time_keys"], ["timeout"]);
    const oneTimeKeys = plainRecord(
      body.one_time_keys,
      "MATRIX_KEYS_CLAIM_BODY_INVALID",
    );
    const entries = Object.entries(oneTimeKeys);
    if (entries.length === 0) {
      throw new MatrixTransportError("MATRIX_KEYS_CLAIM_BODY_INVALID");
    }

    const merged: JsonObject = {
      failures: {},
      one_time_keys: {},
    };
    for (const [matrixUserId, devices] of entries) {
      const subRequestId = await deriveClaimSubRequestId(
        originalRequestId,
        matrixUserId,
      );
      const response = parseClaimResponse(
        await this.transport.claimKeys(
          subRequestId,
          {
            one_time_keys: { [matrixUserId]: devices },
            ...(body.timeout === undefined ? {} : { timeout: body.timeout }),
          },
          signal,
        ),
      );
      assertResponseUsers(
        response.one_time_keys,
        new Set([matrixUserId]),
      );
      if (Object.keys(response.failures).length !== 0) {
        throw new MatrixTransportError(
          "MATRIX_KEYS_CLAIM_RESPONSE_INVALID",
        );
      }
      mergeRecord(
        merged.failures as JsonObject,
        response.failures,
      );
      mergeRecord(
        merged.one_time_keys as JsonObject,
        response.one_time_keys,
      );
    }
    return merged;
  }
}

export class IndexedDbMatrixSyncTokenStore
  implements MatrixSyncTokenStore
{
  constructor(
    private readonly databaseName = "sinochat-e2ee-sync-v1",
  ) {}

  async load(deviceId: string): Promise<string | undefined> {
    return this.withStore("readonly", async (store) => {
      const record = await idbRequest<unknown>(store.get(deviceId));
      if (record === undefined) return undefined;
      const value = plainRecord(record, "MATRIX_SYNC_TOKEN_STORE_INVALID");
      if (value.deviceId !== deviceId || typeof value.token !== "string") {
        throw new MatrixTransportError("MATRIX_SYNC_TOKEN_STORE_INVALID");
      }
      return value.token;
    });
  }

  async save(deviceId: string, token: string): Promise<void> {
    if (!SYNC_TOKEN_PATTERN.test(token)) {
      throw new MatrixTransportError("MATRIX_SYNC_TOKEN_INVALID");
    }
    await this.withStore("readwrite", async (store) => {
      await idbRequest(store.put({ deviceId, token }));
    });
  }

  async clear(deviceId: string): Promise<void> {
    await this.withStore("readwrite", async (store) => {
      await idbRequest(store.delete(deviceId));
    });
  }

  private async withStore<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const database = await openTokenDatabase(this.databaseName);
    try {
      const transaction = database.transaction("positions", mode);
      const result = await operation(transaction.objectStore("positions"));
      await idbTransaction(transaction);
      return result;
    } finally {
      database.close();
    }
  }
}

interface ParsedSyncResponse {
  nextBatch: string;
  toDeviceEvents: JsonObject[];
  deviceLists: { changed: string[]; left: string[] };
  oneTimeKeyCounts: Record<string, number>;
  unusedFallbackKeyTypes: string[];
}

function parseSyncResponse(value: unknown): ParsedSyncResponse {
  const response = plainRecord(value, "MATRIX_SYNC_RESPONSE_INVALID");
  if (
    typeof response.next_batch !== "string" ||
    !SYNC_TOKEN_PATTERN.test(response.next_batch)
  ) {
    throw new MatrixTransportError("MATRIX_SYNC_RESPONSE_INVALID");
  }
  const toDevice = plainRecord(
    response.to_device,
    "MATRIX_SYNC_RESPONSE_INVALID",
  );
  if (!Array.isArray(toDevice.events) || toDevice.events.length > 100) {
    throw new MatrixTransportError("MATRIX_SYNC_RESPONSE_INVALID");
  }
  const events = toDevice.events.map((event) => {
    const parsed = plainRecord(event, "MATRIX_SYNC_RESPONSE_INVALID");
    if (
      parsed.type !== "m.room.encrypted" ||
      typeof parsed.sender !== "string" ||
      !isPlainRecord(parsed.content)
    ) {
      throw new MatrixTransportError("MATRIX_SYNC_RESPONSE_INVALID");
    }
    return parsed;
  });

  const rawLists =
    response.device_lists === undefined
      ? { changed: [], left: [] }
      : plainRecord(response.device_lists, "MATRIX_SYNC_RESPONSE_INVALID");
  const changed = matrixUserIdArray(rawLists.changed ?? []);
  const left = matrixUserIdArray(rawLists.left ?? []);
  if (changed.some((userId) => left.includes(userId))) {
    throw new MatrixTransportError("MATRIX_SYNC_RESPONSE_INVALID");
  }

  const rawCounts = plainRecord(
    response.device_one_time_keys_count,
    "MATRIX_SYNC_RESPONSE_INVALID",
  );
  const counts: Record<string, number> = {};
  for (const [algorithm, count] of Object.entries(rawCounts)) {
    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > 100
    ) {
      throw new MatrixTransportError("MATRIX_SYNC_RESPONSE_INVALID");
    }
    counts[algorithm] = count;
  }
  if (!(MATRIX_SIGNED_CURVE25519 in counts)) {
    throw new MatrixTransportError("MATRIX_SYNC_RESPONSE_INVALID");
  }

  if (!Array.isArray(response.device_unused_fallback_key_types)) {
    throw new MatrixTransportError("MATRIX_SYNC_RESPONSE_INVALID");
  }
  const fallbackTypes = response.device_unused_fallback_key_types.map(
    (algorithm) => {
      if (algorithm !== MATRIX_SIGNED_CURVE25519) {
        throw new MatrixTransportError("MATRIX_SYNC_RESPONSE_INVALID");
      }
      return algorithm;
    },
  );
  if (new Set(fallbackTypes).size !== fallbackTypes.length) {
    throw new MatrixTransportError("MATRIX_SYNC_RESPONSE_INVALID");
  }

  return {
    nextBatch: response.next_batch,
    toDeviceEvents: events,
    deviceLists: { changed, left },
    oneTimeKeyCounts: counts,
    unusedFallbackKeyTypes: fallbackTypes,
  };
}

function isApplicationMessageDeliveredToDevice(
  event: ProcessedToDeviceEvent,
): boolean {
  if (
    event.type !== ProcessedToDeviceEventType.Decrypted &&
    event.type !== ProcessedToDeviceEventType.PlainText
  ) {
    return false;
  }
  try {
    const raw = plainRecord(
      JSON.parse(event.rawEvent) as unknown,
      "MATRIX_TO_DEVICE_EVENT_INVALID",
    );
    return raw.type === APPLICATION_MESSAGE_EVENT_TYPE;
  } catch {
    // Un evento procesado pero imposible de interpretar tampoco se entrega a
    // la capa de chat. Rust Crypto ya conserva su estado interno.
    return true;
  }
}

async function deriveClaimSubRequestId(
  originalRequestId: string,
  matrixUserId: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${originalRequestId}\0${matrixUserId}`),
    ),
  );
  const base64 = btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `claim_${base64}`;
}

function parseJsonObject(value: string, code: string): JsonObject {
  try {
    return plainRecord(JSON.parse(value) as unknown, code);
  } catch (error) {
    if (error instanceof MatrixTransportError) throw error;
    throw new MatrixTransportError(code);
  }
}

function parseQueryResponse(value: unknown) {
  const response = plainRecord(value, "MATRIX_KEYS_QUERY_RESPONSE_INVALID");
  return {
    device_keys: plainRecord(
      response.device_keys,
      "MATRIX_KEYS_QUERY_RESPONSE_INVALID",
    ),
    failures: plainRecord(
      response.failures,
      "MATRIX_KEYS_QUERY_RESPONSE_INVALID",
    ),
    master_keys: plainRecord(
      response.master_keys,
      "MATRIX_KEYS_QUERY_RESPONSE_INVALID",
    ),
    self_signing_keys: plainRecord(
      response.self_signing_keys,
      "MATRIX_KEYS_QUERY_RESPONSE_INVALID",
    ),
    user_signing_keys: plainRecord(
      response.user_signing_keys,
      "MATRIX_KEYS_QUERY_RESPONSE_INVALID",
    ),
  };
}

function parseClaimResponse(value: unknown) {
  const response = plainRecord(value, "MATRIX_KEYS_CLAIM_RESPONSE_INVALID");
  return {
    failures: plainRecord(
      response.failures,
      "MATRIX_KEYS_CLAIM_RESPONSE_INVALID",
    ),
    one_time_keys: plainRecord(
      response.one_time_keys,
      "MATRIX_KEYS_CLAIM_RESPONSE_INVALID",
    ),
  };
}

function parseKeysUploadResponse(value: unknown): JsonObject {
  const response = plainRecord(value, "MATRIX_KEYS_UPLOAD_RESPONSE_INVALID");
  assertOnlyKeys(response, ["one_time_key_counts"], []);
  const counts = plainRecord(
    response.one_time_key_counts,
    "MATRIX_KEYS_UPLOAD_RESPONSE_INVALID",
  );
  const count = counts[MATRIX_SIGNED_CURVE25519];
  if (
    Object.keys(counts).length !== 1 ||
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > 100
  ) {
    throw new MatrixTransportError("MATRIX_KEYS_UPLOAD_RESPONSE_INVALID");
  }
  return response;
}

function parseEmptyResponse(value: unknown, code: string): JsonObject {
  const response = plainRecord(value, code);
  if (Object.keys(response).length !== 0) {
    throw new MatrixTransportError(code);
  }
  return response;
}

function emptyQueryResponse() {
  return {
    device_keys: {} as JsonObject,
    failures: {} as JsonObject,
    master_keys: {} as JsonObject,
    self_signing_keys: {} as JsonObject,
    user_signing_keys: {} as JsonObject,
  };
}

function mergeRecord(target: JsonObject, source: JsonObject): void {
  for (const [key, value] of Object.entries(source)) {
    if (Object.hasOwn(target, key)) {
      throw new MatrixTransportError("MATRIX_RESPONSE_TARGET_DUPLICATED");
    }
    target[key] = value;
  }
}

function assertResponseUsers(
  response: JsonObject,
  requestedUsers: ReadonlySet<string>,
): void {
  if (Object.keys(response).some((userId) => !requestedUsers.has(userId))) {
    throw new MatrixTransportError("MATRIX_RESPONSE_TARGET_UNEXPECTED");
  }
}

function assertOnlyKeys(
  value: JsonObject,
  required: string[],
  optional: string[],
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new MatrixTransportError("MATRIX_OUTGOING_REQUEST_FIELDS_INVALID");
  }
}

function matrixUserIdArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new MatrixTransportError("MATRIX_SYNC_RESPONSE_INVALID");
  }
  const result = value.map((userId) => {
    if (
      typeof userId !== "string" ||
      !/^@u[0-9a-f]{32}:[^\s/@]{1,255}$/.test(userId)
    ) {
      throw new MatrixTransportError("MATRIX_SYNC_RESPONSE_INVALID");
    }
    return userId;
  });
  if (new Set(result).size !== result.length) {
    throw new MatrixTransportError("MATRIX_SYNC_RESPONSE_INVALID");
  }
  return result;
}

function plainRecord(value: unknown, code: string): JsonObject {
  if (!isPlainRecord(value)) throw new MatrixTransportError(code);
  return value;
}

function isPlainRecord(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function openTokenDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("positions")) {
        database.createObjectStore("positions", { keyPath: "deviceId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      new MatrixTransportError("MATRIX_SYNC_TOKEN_STORE_UNAVAILABLE"),
    );
    request.onblocked = () => reject(
      new MatrixTransportError("MATRIX_SYNC_TOKEN_STORE_BLOCKED"),
    );
  });
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      new MatrixTransportError("MATRIX_SYNC_TOKEN_STORE_UNAVAILABLE"),
    );
  });
}

function idbTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(
      new MatrixTransportError("MATRIX_SYNC_TOKEN_STORE_UNAVAILABLE"),
    );
    transaction.onabort = () => reject(
      new MatrixTransportError("MATRIX_SYNC_TOKEN_STORE_UNAVAILABLE"),
    );
  });
}
