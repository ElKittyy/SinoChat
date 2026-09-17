import type { OlmMachine } from "@matrix-org/matrix-sdk-crypto-wasm";
import {
  matrixDeviceIdFromUuid,
  matrixRoomIdFromUuid,
  matrixUserIdFromUuid,
  normalizeMatrixServerName
} from "@sinochat/contracts";
export {
  MATRIX_CRYPTO_PACKAGE_NAME,
  MATRIX_CRYPTO_PACKAGE_VERSION,
  MATRIX_MESSAGE_RETENTION_HOURS,
  MATRIX_PROTOCOL_NAME,
  MATRIX_SPECIFICATION_VERSION
} from "./matrixProfile";

const activeStores = new Set<string>();

let modulePromise:
  | Promise<typeof import("@matrix-org/matrix-sdk-crypto-wasm")>
  | undefined;
let initializationPromise: Promise<void> | undefined;

export interface MatrixCryptoIdentity {
  userId: string;
  deviceId: string;
  roomIdFor(conversationId: string): string;
}

export interface MatrixCryptoSession {
  identity: MatrixCryptoIdentity;
  machine: OlmMachine;
  close(): void;
}

export interface InitializeMatrixCryptoInput {
  sinochatUserId: string;
  sinochatDeviceId: string;
  serverName: string;
  /**
   * Secreto aleatorio local del dispositivo. Nunca debe derivarse de la
   * contrasena de la cuenta ni enviarse al servidor.
   */
  storePassphrase: string;
}

/**
 * Inicializa el motor oficial sin activar aun el transporte de chat. El
 * llamador debe conservar una sola instancia por dispositivo: abrir dos
 * maquinas sobre el mismo IndexedDB corromperia el estado criptografico.
 */
export async function initializeMatrixCrypto(
  input: InitializeMatrixCryptoInput
): Promise<MatrixCryptoSession> {
  assertBrowserCryptoPrerequisites();
  assertStorePassphrase(input.storePassphrase);

  const serverName = normalizeMatrixServerName(input.serverName);
  const matrixUserId = matrixUserIdFromUuid(
    input.sinochatUserId,
    serverName
  );
  const matrixDeviceId = matrixDeviceIdFromUuid(input.sinochatDeviceId);
  const deviceHex = matrixDeviceId.slice(1).toLowerCase();
  const storeName = `sinochat-e2ee-v1-${deviceHex}`;

  if (activeStores.has(storeName)) {
    throw new Error("E2EE_STORE_ALREADY_OPEN");
  }
  activeStores.add(storeName);

  let machine: OlmMachine | undefined;
  try {
    const matrix = await loadMatrixCryptoModule();
    const userId = new matrix.UserId(matrixUserId);
    const deviceId = new matrix.DeviceId(matrixDeviceId);

    try {
      machine = await matrix.OlmMachine.initialize(
        userId,
        deviceId,
        storeName,
        input.storePassphrase
      );
    } finally {
      userId.free();
      deviceId.free();
    }

    let closed = false;
    return {
      identity: {
        userId: matrixUserId,
        deviceId: matrixDeviceId,
        roomIdFor(conversationId: string) {
          return matrixRoomIdFromUuid(conversationId, serverName);
        }
      },
      machine,
      close() {
        if (closed) return;
        closed = true;
        machine?.close();
        activeStores.delete(storeName);
      }
    };
  } catch (error) {
    machine?.close();
    activeStores.delete(storeName);
    throw error;
  }
}

function assertBrowserCryptoPrerequisites(): void {
  if (globalThis.isSecureContext !== true) {
    throw new Error("E2EE_SECURE_CONTEXT_REQUIRED");
  }
  if (!("indexedDB" in globalThis)) {
    throw new Error("E2EE_INDEXED_DB_REQUIRED");
  }
}

function assertStorePassphrase(value: string): void {
  if (new TextEncoder().encode(value).byteLength < 32) {
    throw new Error("E2EE_STORE_PASSPHRASE_TOO_SHORT");
  }
}

async function loadMatrixCryptoModule() {
  modulePromise ??= import("@matrix-org/matrix-sdk-crypto-wasm");
  const matrix = await modulePromise;
  initializationPromise ??= matrix.initAsync();
  await initializationPromise;
  return matrix;
}
