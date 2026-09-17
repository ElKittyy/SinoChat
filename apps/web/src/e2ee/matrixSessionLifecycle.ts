import {
  RequestType,
  type OlmMachine,
} from "@matrix-org/matrix-sdk-crypto-wasm";
import type {
  E2eeApi,
  MatrixDeviceCompletion,
  MatrixDeviceRegistration,
  SessionUser,
} from "../api";
import {
  IndexedDbMatrixLocalDeviceStore,
  type MatrixInitialKeyUpload,
  type MatrixLocalDeviceRecord,
  type MatrixLocalDeviceStore,
} from "./matrixLocalDeviceStore";
import {
  initializeMatrixCrypto,
  MATRIX_CRYPTO_PACKAGE_NAME,
  MATRIX_CRYPTO_PACKAGE_VERSION,
  MATRIX_MESSAGE_RETENTION_HOURS,
  MATRIX_PROTOCOL_NAME,
  MATRIX_SPECIFICATION_VERSION,
  type MatrixCryptoSession,
} from "./matrixRuntime";
import {
  IndexedDbMatrixSyncTokenStore,
  MatrixTransportCoordinator,
  type MatrixSyncResult,
  type MatrixSyncTokenStore,
} from "./matrixTransport";
import { MatrixMegolmMessageCrypto } from "./matrixMegolmMessageCrypto";
import { initializeMatrixCrossSigning } from "./matrixCrossSigning";

type CryptoFactory = typeof initializeMatrixCrypto;

export interface MatrixSessionLease {
  release(): void;
}

export interface MatrixSessionLockProvider {
  acquire(userId: string, signal?: AbortSignal): Promise<MatrixSessionLease>;
}

export type MatrixSessionLifecycleResult =
  | {
      state: "not-applicable";
      close(): Promise<void>;
    }
  | {
      state: "blocked";
      message: string;
      reasonCode: string;
      close(): Promise<void>;
    }
  | {
      state: "ready";
      identity: MatrixCryptoSession["identity"];
      coordinator: MatrixTransportCoordinator;
      messages: MatrixMegolmMessageCrypto;
      close(): Promise<void>;
    };

export interface MatrixControlEventConsumer {
  (result: MatrixSyncResult): void | Promise<void>;
}

export class MatrixSessionLifecycleError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MatrixSessionLifecycleError";
  }
}

/**
 * Impide que dos pestanas del mismo origen abran a la vez el CryptoStore de un
 * usuario. La Web Lock se mantiene durante toda la vida de OlmMachine y el
 * navegador la libera tambien si el documento desaparece inesperadamente.
 */
export class BrowserMatrixSessionLockProvider
  implements MatrixSessionLockProvider
{
  async acquire(
    userId: string,
    signal?: AbortSignal,
  ): Promise<MatrixSessionLease> {
    throwIfAborted(signal);
    if (
      typeof navigator === "undefined" ||
      !("locks" in navigator) ||
      !navigator.locks
    ) {
      throw new MatrixSessionLifecycleError(
        "MATRIX_BROWSER_LOCKS_UNAVAILABLE",
      );
    }

    let releaseLock: (() => void) | undefined;
    let resolveAcquired: (lease: MatrixSessionLease) => void = () => {};
    let rejectAcquired: (reason: unknown) => void = () => {};
    let acquiredSettled = false;
    const acquired = new Promise<MatrixSessionLease>((resolve, reject) => {
      resolveAcquired = resolve;
      rejectAcquired = reject;
    });
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const rejectPending = (reason: unknown) => {
      if (acquiredSettled) return;
      acquiredSettled = true;
      signal?.removeEventListener("abort", onAbort);
      rejectAcquired(reason);
    };
    const onAbort = () => {
      rejectPending(
        signal?.reason ??
          new DOMException("La operacion fue cancelada.", "AbortError"),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let request: Promise<unknown>;
    try {
      request = navigator.locks.request(
        `sinochat:e2ee-session:${userId}`,
        {
          ifAvailable: true,
          mode: "exclusive",
        },
        async (lock) => {
          // Web Locks prohibe combinar ifAvailable con signal. El aborto se
          // resuelve aqui mientras la peticion esta pendiente; un callback
          // tardio retorna sin retener el lock ni entregar una lease.
          if (acquiredSettled) return;
          if (signal?.aborted) {
            onAbort();
            return;
          }
          if (!lock) {
            rejectPending(
              new MatrixSessionLifecycleError(
                "MATRIX_SESSION_ALREADY_OPEN",
              ),
            );
            return;
          }

          let released = false;
          acquiredSettled = true;
          signal?.removeEventListener("abort", onAbort);
          resolveAcquired({
            release() {
              if (released) return;
              released = true;
              releaseLock?.();
            },
          });
          await held;
        },
      );
    } catch (error) {
      rejectPending(
        isAbortError(error)
          ? error
          : new MatrixSessionLifecycleError("MATRIX_SESSION_LOCK_FAILED"),
      );
      return acquired;
    }

    void request.catch((error: unknown) => {
      rejectPending(
        isAbortError(error)
          ? error
          : new MatrixSessionLifecycleError(
              "MATRIX_SESSION_LOCK_FAILED",
            ),
      );
    });
    return acquired;
  }
}

/**
 * Arranca exactamente una maquina para la sesion autenticada. Consulta el gate
 * antes de tocar IndexedDB o cualquier endpoint Matrix; por eso el codigo puede
 * quedar montado en React mientras el release compilado siga BLOCKED.
 */
export class MatrixSessionLifecycle {
  constructor(
    private readonly api: E2eeApi,
    private readonly localDevices: MatrixLocalDeviceStore =
      new IndexedDbMatrixLocalDeviceStore(),
    private readonly syncTokens: MatrixSyncTokenStore =
      new IndexedDbMatrixSyncTokenStore(),
    private readonly cryptoFactory: CryptoFactory = initializeMatrixCrypto,
    private readonly sessionLocks: MatrixSessionLockProvider =
      new BrowserMatrixSessionLockProvider(),
    private readonly initializeCrossSigning: typeof initializeMatrixCrossSigning =
      initializeMatrixCrossSigning,
  ) {}

  async start(
    user: SessionUser,
    signal?: AbortSignal,
  ): Promise<MatrixSessionLifecycleResult> {
    if (user.role === "ADMIN") return inertResult("not-applicable");
    throwIfAborted(signal);
    const release = await this.api.getStatus(signal);
    this.assertReleaseProfile(release);
    if (release.state === "BLOCKED") {
      return {
        state: "blocked",
        message: release.message,
        reasonCode: release.reasonCode,
        async close() {},
      };
    }
    if (user.status !== "ACTIVE") {
      throw new MatrixSessionLifecycleError(
        "MATRIX_SESSION_USER_NOT_ACTIVE",
      );
    }

    let cryptoSession: MatrixCryptoSession | undefined;
    let sessionLease: MatrixSessionLease | undefined;
    try {
      sessionLease = await this.sessionLocks.acquire(user.id, signal);
      throwIfAborted(signal);
      let local = await this.resolveLocalDevice(user, signal);
      throwIfAborted(signal);
      cryptoSession = await this.cryptoFactory({
        sinochatUserId: user.id,
        sinochatDeviceId: local.deviceId,
        serverName: local.matrixServerName,
        storePassphrase: local.storePassphrase,
      });
      local = await this.finishInitialRegistration(
        user,
        local,
        cryptoSession,
        signal,
      );
      if (!local.bindingSecret) {
        throw new MatrixSessionLifecycleError(
          "MATRIX_LOCAL_BINDING_SECRET_MISSING",
        );
      }

      const coordinator = new MatrixTransportCoordinator(
        cryptoSession.machine,
        cryptoSession.identity.deviceId,
        this.api,
        this.syncTokens,
      );
      await this.initializeCrossSigning(cryptoSession.identity, coordinator, this.api, signal);
      await coordinator.flushOutgoingRequests(signal);
      const messages = new MatrixMegolmMessageCrypto(
        cryptoSession.identity,
        coordinator,
      );
      throwIfAborted(signal);
      const ownedSession = cryptoSession;
      const ownedLease = sessionLease;
      cryptoSession = undefined;
      sessionLease = undefined;
      let closePromise: Promise<void> | undefined;
      return {
        state: "ready",
        identity: ownedSession.identity,
        coordinator,
        messages,
        close() {
          closePromise ??= (async () => {
            await coordinator.drain();
            try {
              ownedSession.close();
            } finally {
              ownedLease.release();
            }
          })();
          return closePromise;
        },
      };
    } catch (error) {
      try {
        cryptoSession?.close();
      } catch {
        // Conserva el error original, pero no retiene el bloqueo del navegador.
      }
      sessionLease?.release();
      throw error;
    }
  }

  private async resolveLocalDevice(
    user: SessionUser,
    signal?: AbortSignal,
  ): Promise<MatrixLocalDeviceRecord> {
    let local = await this.localDevices.load(user.id);
    if (local) {
      if (user.deviceId !== null && user.deviceId !== local.deviceId) {
        throw new MatrixSessionLifecycleError(
          "MATRIX_SESSION_DEVICE_MISMATCH",
        );
      }
      if (user.deviceId === null && local.bindingSecret) {
        await this.api.bindSession(
          local.deviceId,
          local.bindingSecret,
          signal,
        );
        return local;
      }
      if (user.deviceId === null) {
        const registration = await this.api.reserveDevice(signal);
        this.assertRegistrationMatchesLocal(registration, local);
      }
      return local;
    }

    if (user.deviceId !== null) {
      throw new MatrixSessionLifecycleError(
        "MATRIX_LOCAL_DEVICE_CREDENTIALS_MISSING",
      );
    }
    const registration = await this.api.reserveDevice(signal);
    local = await this.localDevices.createProvisional({
      userId: user.id,
      deviceId: registration.deviceId,
      matrixServerName: registration.matrixServerName,
    });
    this.assertRegistrationMatchesLocal(registration, local);
    return local;
  }

  private async finishInitialRegistration(
    user: SessionUser,
    local: MatrixLocalDeviceRecord,
    cryptoSession: MatrixCryptoSession,
    signal?: AbortSignal,
  ): Promise<MatrixLocalDeviceRecord> {
    if (
      cryptoSession.identity.userId.length === 0 ||
      cryptoSession.identity.deviceId.length === 0
    ) {
      throw new MatrixSessionLifecycleError("MATRIX_IDENTITY_INVALID");
    }
    if (
      local.bindingSecret &&
      !local.initialKeyUpload &&
      !local.initialCompletionResponse
    ) {
      return local;
    }

    let request = local.initialKeyUpload;
    if (!request) {
      request = await this.captureInitialKeyUpload(
        cryptoSession.machine,
      );
      local = await this.localDevices.saveInitialKeyUpload(
        user.id,
        local.deviceId,
        request,
      );
      request = local.initialKeyUpload;
      if (!request) {
        throw new MatrixSessionLifecycleError(
          "MATRIX_INITIAL_UPLOAD_JOURNAL_FAILED",
        );
      }
    }

    let response = local.initialCompletionResponse;
    if (!response) {
      const body = parseJsonObject(request.body);
      const completion = await this.api.completeDevice(
        local.deviceId,
        body,
        signal,
      );
      this.assertCompletion(completion, local, cryptoSession);
      response = JSON.stringify(completion);
      local = await this.localDevices.saveInitialCompletion(
        user.id,
        local.deviceId,
        completion.bindingSecret,
        response,
      );
    }

    await this.commitInitialKeyUpload(
      cryptoSession.machine,
      request,
      response,
    );
    return this.localDevices.finishInitialKeyUpload(
      user.id,
      local.deviceId,
    );
  }

  private async captureInitialKeyUpload(
    machine: OlmMachine,
  ): Promise<MatrixInitialKeyUpload> {
    const outgoing = await machine.outgoingRequests();
    try {
      const uploads = outgoing.filter(
        (request) => request.type === RequestType.KeysUpload,
      );
      if (uploads.length !== 1) {
        throw new MatrixSessionLifecycleError(
          "MATRIX_INITIAL_KEYS_UPLOAD_MISSING",
        );
      }
      const upload = uploads[0]!;
      if (typeof upload.id !== "string" || upload.id.length === 0) {
        throw new MatrixSessionLifecycleError(
          "MATRIX_INITIAL_KEYS_UPLOAD_ID_INVALID",
        );
      }
      parseJsonObject(upload.body);
      return {
        requestId: upload.id,
        requestType: upload.type,
        body: upload.body,
      };
    } finally {
      for (const request of outgoing) request.free();
    }
  }

  private async commitInitialKeyUpload(
    machine: OlmMachine,
    journal: MatrixInitialKeyUpload,
    response: string,
  ): Promise<void> {
    const outgoing = await machine.outgoingRequests();
    let stillPending = false;
    try {
      for (const request of outgoing) {
        if (
          request.id === journal.requestId &&
          request.type === journal.requestType
        ) {
          if (request.body !== journal.body) {
            throw new MatrixSessionLifecycleError(
              "MATRIX_INITIAL_KEYS_UPLOAD_CHANGED",
            );
          }
          stillPending = true;
        }
      }
    } finally {
      for (const request of outgoing) request.free();
    }
    if (!stillPending) return;
    const committed = await machine.markRequestAsSent(
      journal.requestId,
      journal.requestType,
      response,
    );
    if (committed !== true) {
      throw new MatrixSessionLifecycleError(
        "MATRIX_INITIAL_KEYS_UPLOAD_NOT_COMMITTED",
      );
    }
  }

  private assertRegistrationMatchesLocal(
    registration: MatrixDeviceRegistration,
    local: MatrixLocalDeviceRecord,
  ): void {
    if (
      registration.deviceId !== local.deviceId ||
      registration.matrixServerName !== local.matrixServerName
    ) {
      throw new MatrixSessionLifecycleError(
        "MATRIX_REGISTRATION_RESERVATION_CHANGED",
      );
    }
  }

  private assertCompletion(
    completion: MatrixDeviceCompletion,
    local: MatrixLocalDeviceRecord,
    cryptoSession: MatrixCryptoSession,
  ): void {
    if (
      completion.deviceId !== local.deviceId ||
      completion.matrixUserId !== cryptoSession.identity.userId ||
      completion.matrixDeviceId !== cryptoSession.identity.deviceId
    ) {
      throw new MatrixSessionLifecycleError(
        "MATRIX_REGISTRATION_COMPLETION_MISMATCH",
      );
    }
  }

  private assertReleaseProfile(release: {
    clientLibrary: string;
    clientLibraryVersion: string;
    matrixSpecificationVersion: string;
    messageRetentionHours: number;
    protocol: string;
  }): void {
    if (
      release.protocol !== MATRIX_PROTOCOL_NAME ||
      release.clientLibrary !== MATRIX_CRYPTO_PACKAGE_NAME ||
      release.clientLibraryVersion !== MATRIX_CRYPTO_PACKAGE_VERSION ||
      release.matrixSpecificationVersion !== MATRIX_SPECIFICATION_VERSION ||
      release.messageRetentionHours !== MATRIX_MESSAGE_RETENTION_HOURS
    ) {
      throw new MatrixSessionLifecycleError(
        "MATRIX_RELEASE_PROFILE_MISMATCH",
      );
    }
  }
}

export async function runMatrixSyncLoop(
  coordinator: MatrixTransportCoordinator,
  signal: AbortSignal,
  consume?: MatrixControlEventConsumer,
): Promise<void> {
  let retryDelayMs = 500;
  let unknownPositionRecovered = false;
  while (!signal.aborted) {
    try {
      const result = await coordinator.sync(30_000, signal);
      retryDelayMs = 500;
      unknownPositionRecovered = false;
      try {
        await consume?.(result);
      } finally {
        for (const event of result.processedControlEvents) event.free();
      }
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return;
      if (
        isApiErrorLike(error) &&
        error.code === "M_UNKNOWN_POS" &&
        !unknownPositionRecovered
      ) {
        unknownPositionRecovered = true;
        await coordinator.clearSyncPosition();
        continue;
      }
      if (!isTransientNetworkError(error)) throw error;
      await abortableDelay(retryDelayMs, signal);
      retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
    }
  }
}

function inertResult(
  state: "not-applicable",
): MatrixSessionLifecycleResult {
  return { state, async close() {} };
}

function parseJsonObject(body: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new MatrixSessionLifecycleError(
      "MATRIX_INITIAL_KEYS_UPLOAD_BODY_INVALID",
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MatrixSessionLifecycleError(
      "MATRIX_INITIAL_KEYS_UPLOAD_BODY_INVALID",
    );
  }
  return value as Record<string, unknown>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("La operacion fue cancelada.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isTransientNetworkError(error: unknown): boolean {
  return (
    isApiErrorLike(error) && (error.status === 0 || error.status >= 500)
  );
}

function isApiErrorLike(
  error: unknown,
): error is Error & { status: number; code?: string } {
  return (
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number" &&
    Number.isFinite(error.status) &&
    (!("code" in error) ||
      error.code === undefined ||
      typeof error.code === "string")
  );
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("La operacion fue cancelada.", "AbortError"),
      );
      return;
    }
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("La operacion fue cancelada.", "AbortError"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
