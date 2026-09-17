import {
  CollectStrategy,
  DecryptionSettings,
  EncryptionAlgorithm,
  EncryptionSettings,
  HistoryVisibility,
  RoomId,
  TrustRequirement,
  UserId,
  type OlmMachine,
} from "@matrix-org/matrix-sdk-crypto-wasm";
import {
  matrixDeviceIdFromUuid,
  matrixUserIdFromUuid,
  normalizeMatrixServerName,
  sinochatDeviceIdFromMatrixDeviceId,
} from "@sinochat/contracts";
import type { EncryptedTransportMessage, SendEncryptedMessageRequest } from "../messagePayload";
import {
  MATRIX_MEGOLM_ALGORITHM,
  MATRIX_MESSAGE_PROTOCOL_VERSION,
  parseMatrixMegolmEnvelopeBase64,
  validateSendEncryptedMessageRequest,
} from "../messagePayload";
import type { MatrixCryptoIdentity } from "./matrixRuntime";
import type { MatrixTransportCoordinator } from "./matrixTransport";
import {
  SINOCHAT_MESSAGE_EVENT_TYPE,
  decodeSinoChatMessageContent,
  encodeSinoChatImageMessage,
  encodeSinoChatTextMessage,
  type EncodeSinoChatImageMessageInput,
  type EncodeSinoChatTextMessageInput,
  type SinoChatMessageContent,
} from "./messageContent";

const EVENT_ID_LOCALPART_PREFIX = "m";
const MATRIX_KEY_PATTERN = /^[A-Za-z0-9+/]{43}$/;
const MAX_ACTIVE_DEVICES = 64;

export interface MatrixMessageEncryptBase {
  readonly conversationId: string;
  readonly clientMessageId: string;
  readonly senderUserId: string;
  readonly senderDeviceId: string;
  readonly participantUserId: string;
}

export type MatrixTextMessageEncryptInput = MatrixMessageEncryptBase &
  Pick<EncodeSinoChatTextMessageInput, "text">;

export type MatrixImageMessageEncryptInput = MatrixMessageEncryptBase &
  Pick<
    EncodeSinoChatImageMessageInput,
    | "declaredMimeType"
    | "plaintextByteSize"
    | "ciphertextByteSize"
    | "ciphertextSha256"
    | "mediaEncryptionInfo"
  > & {
    readonly attachmentGrantToken: string;
  };

export class MatrixMegolmMessageCryptoError extends Error {
  readonly code: string;

  constructor(code: string, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "MatrixMegolmMessageCryptoError";
    this.code = code;
  }
}

/**
 * Cifra y descifra mensajes de aplicacion sobre la misma cola que Matrix sync.
 * Una sesion Megolm dura un solo mensaje: privilegia aislamiento entre
 * cambios de dispositivos sobre ahorro de requests, una politica conservadora
 * mientras SinoChat no tenga una auditoria criptografica externa.
 */
export class MatrixMegolmMessageCrypto {
  private readonly serverName: string;

  constructor(
    private readonly identity: MatrixCryptoIdentity,
    private readonly coordinator: MatrixTransportCoordinator,
  ) {
    this.serverName = matrixServerName(identity.userId);
  }

  encryptText(
    input: MatrixTextMessageEncryptInput,
    signal?: AbortSignal,
  ): Promise<SendEncryptedMessageRequest> {
    const base = this.validateEncryptIdentity(input);
    const roomId = this.identity.roomIdFor(base.conversationId);
    const encoded = encodeSinoChatTextMessage({
      conversationId: base.conversationId,
      roomId,
      clientMessageId: base.clientMessageId,
      senderUserId: base.senderUserId,
      senderDeviceId: base.senderDeviceId,
      text: input.text,
    });
    return this.encryptEncoded(
      base,
      roomId,
      encoded.content,
      "TEXT",
      undefined,
      signal,
    );
  }

  encryptImage(
    input: MatrixImageMessageEncryptInput,
    signal?: AbortSignal,
  ): Promise<SendEncryptedMessageRequest> {
    const base = this.validateEncryptIdentity(input);
    const roomId = this.identity.roomIdFor(base.conversationId);
    const encoded = encodeSinoChatImageMessage({
      conversationId: base.conversationId,
      roomId,
      clientMessageId: base.clientMessageId,
      senderUserId: base.senderUserId,
      senderDeviceId: base.senderDeviceId,
      declaredMimeType: input.declaredMimeType,
      plaintextByteSize: input.plaintextByteSize,
      ciphertextByteSize: input.ciphertextByteSize,
      ciphertextSha256: input.ciphertextSha256,
      mediaEncryptionInfo: input.mediaEncryptionInfo,
    });
    return this.encryptEncoded(
      base,
      roomId,
      encoded.content,
      "IMAGE",
      input.attachmentGrantToken,
      signal,
    );
  }

  decrypt(
    conversationId: string,
    message: EncryptedTransportMessage,
    signal?: AbortSignal,
  ): Promise<SinoChatMessageContent> {
    const roomIdValue = this.identity.roomIdFor(conversationId);
    const expectedSenderUser = matrixUserIdFromUuid(
      message.senderUserId,
      this.serverName,
    );
    const expectedSenderDevice = matrixDeviceIdFromUuid(
      message.senderDeviceId,
    );
    const eventId = matrixEventId(message.id, this.serverName);
    const originServerTs = Date.parse(message.createdAt);

    return this.coordinator.runExclusiveCryptoOperation(async ({ machine }) => {
      throwIfAborted(signal);
      const roomId = new RoomId(roomIdValue);
      const settings = new DecryptionSettings(TrustRequirement.Untrusted);
      let decrypted:
        | Awaited<ReturnType<OlmMachine["decryptRoomEvent"]>>
        | undefined;
      try {
        decrypted = await machine.decryptRoomEvent(
          JSON.stringify({
            type: "m.room.encrypted",
            sender: expectedSenderUser,
            content: message.envelope.content,
            event_id: eventId,
            origin_server_ts: originServerTs,
          }),
          roomId,
          settings,
        );
        throwIfAborted(signal);

        const sender = decrypted.sender.toString();
        const senderDevice = decrypted.senderDevice?.toString();
        if (
          sender !== expectedSenderUser ||
          senderDevice !== expectedSenderDevice ||
          decrypted.senderCurve25519Key !== message.envelope.content.sender_key ||
          typeof decrypted.senderClaimedEd25519Key !== "string" ||
          !isCanonicalMatrixKey(decrypted.senderClaimedEd25519Key) ||
          decrypted.forwarder !== undefined ||
          decrypted.forwarderDevice !== undefined ||
          decrypted.forwardingCurve25519KeyChain.length !== 0
        ) {
          throw new MatrixMegolmMessageCryptoError(
            "MATRIX_DECRYPTED_SENDER_BINDING_INVALID",
          );
        }

        const event = strictDecryptedEvent(decrypted.event);
        if (
          event.type !== SINOCHAT_MESSAGE_EVENT_TYPE ||
          event.sender !== expectedSenderUser ||
          event.room_id !== roomIdValue ||
          event.event_id !== eventId ||
          event.origin_server_ts !== originServerTs
        ) {
          throw new MatrixMegolmMessageCryptoError(
            "MATRIX_DECRYPTED_EVENT_BINDING_INVALID",
          );
        }

        return decodeSinoChatMessageContent(event.type, event.content, {
          conversationId,
          roomId: roomIdValue,
          clientMessageId: message.clientMessageId,
          senderUserId: message.senderUserId,
          senderDeviceId: message.senderDeviceId,
          kind: message.kind,
          protocolVersion: message.envelope.protocolVersion,
          cipherSuite: message.envelope.cipherSuite,
          attachment: message.attachment,
        });
      } catch (error) {
        if (error instanceof MatrixMegolmMessageCryptoError) throw error;
        throw new MatrixMegolmMessageCryptoError(
          "MATRIX_MESSAGE_DECRYPT_FAILED",
          error,
        );
      } finally {
        decrypted?.free();
        settings.free();
        roomId.free();
      }
    }, signal);
  }

  private async encryptEncoded(
    base: MatrixMessageEncryptBase,
    roomIdValue: string,
    content: SinoChatMessageContent,
    kind: "TEXT" | "IMAGE",
    attachmentGrantToken: string | undefined,
    signal?: AbortSignal,
  ): Promise<SendEncryptedMessageRequest> {
    const memberUserIds = [
      this.identity.userId,
      matrixUserIdFromUuid(base.participantUserId, this.serverName),
    ];
    return this.coordinator.runExclusiveCryptoOperation(async (context) => {
      throwIfAborted(signal);
      try {
        await updateTrackedUsers(context.machine, memberUserIds);
        await context.flushOutgoingRequests();
        throwIfAborted(signal);

        const activeDevices = await activeDeviceIds(
          context.machine,
          memberUserIds,
        );
        const recipientDeviceIds = activeDevices.ids;
        if (
          recipientDeviceIds.length < 2 ||
          recipientDeviceIds.length > MAX_ACTIVE_DEVICES ||
          !recipientDeviceIds.includes(base.senderDeviceId) ||
          activeDevices.memberDeviceCounts.some((count) => count < 1)
        ) {
          throw new MatrixMegolmMessageCryptoError(
            "MATRIX_ACTIVE_DEVICE_SET_INVALID",
          );
        }

        const claim = await missingSessions(context.machine, memberUserIds);
        if (claim) {
          try {
            await context.sendExplicitRequest(claim);
          } finally {
            claim.free();
          }
        }

        const roomId = new RoomId(roomIdValue);
        const settings = encryptionSettings();
        try {
          const requests = await shareRoomKey(
            context.machine,
            roomId,
            memberUserIds,
            settings,
          );
          await commitRequests(requests, context.sendExplicitRequest);
          throwIfAborted(signal);

          const outerJson = await context.machine.encryptRoomEvent(
            roomId,
            SINOCHAT_MESSAGE_EVENT_TYPE,
            JSON.stringify(content),
          );
          const encodedOuter = bytesToPaddedBase64(
            new TextEncoder().encode(outerJson),
          );
          const parsedOuter = parseMatrixMegolmEnvelopeBase64(encodedOuter);
          if (
            parsedOuter.content.device_id !== this.identity.deviceId ||
            parsedOuter.content.algorithm !== MATRIX_MEGOLM_ALGORITHM
          ) {
            throw new MatrixMegolmMessageCryptoError(
              "MATRIX_ENCRYPTED_SENDER_BINDING_INVALID",
            );
          }

          return validateSendEncryptedMessageRequest({
            clientMessageId: base.clientMessageId,
            senderDeviceId: base.senderDeviceId,
            kind,
            envelopes: recipientDeviceIds.map((recipientDeviceId) => ({
              recipientDeviceId,
              protocolVersion: MATRIX_MESSAGE_PROTOCOL_VERSION,
              cipherSuite: MATRIX_MEGOLM_ALGORITHM,
              ciphertext: parsedOuter.base64,
            })),
            ...(attachmentGrantToken ? { attachmentGrantToken } : {}),
          });
        } finally {
          settings.free();
          roomId.free();
        }
      } catch (error) {
        if (error instanceof MatrixMegolmMessageCryptoError) throw error;
        throw new MatrixMegolmMessageCryptoError(
          "MATRIX_MESSAGE_ENCRYPT_FAILED",
          error,
        );
      }
    }, signal);
  }

  private validateEncryptIdentity<T extends MatrixMessageEncryptBase>(
    input: T,
  ): T {
    try {
      if (
        matrixUserIdFromUuid(input.senderUserId, this.serverName) !==
          this.identity.userId ||
        matrixDeviceIdFromUuid(input.senderDeviceId) !== this.identity.deviceId ||
        input.participantUserId === input.senderUserId ||
        matrixUserIdFromUuid(input.participantUserId, this.serverName) ===
          this.identity.userId
      ) {
        throw new MatrixMegolmMessageCryptoError(
          "MATRIX_ENCRYPT_SENDER_BINDING_INVALID",
        );
      }
      return input;
    } catch (error) {
      if (error instanceof MatrixMegolmMessageCryptoError) throw error;
      throw new MatrixMegolmMessageCryptoError(
        "MATRIX_ENCRYPT_IDENTITY_INVALID",
        error,
      );
    }
  }
}

function encryptionSettings(): EncryptionSettings {
  const settings = new EncryptionSettings();
  settings.algorithm = EncryptionAlgorithm.MegolmV1AesSha2;
  settings.historyVisibility = HistoryVisibility.Joined;
  settings.rotationPeriodMessages = 1n;
  settings.rotationPeriod = 60n * 60n * 1_000_000n;
  settings.sharingStrategy = CollectStrategy.allDevices();
  return settings;
}

async function updateTrackedUsers(
  machine: OlmMachine,
  memberUserIds: readonly string[],
): Promise<void> {
  const users = memberUserIds.map((value) => new UserId(value));
  try {
    await machine.updateTrackedUsers(users);
  } catch (error) {
    for (const user of users) safeFree(user);
    throw error;
  }
}

async function missingSessions(
  machine: OlmMachine,
  memberUserIds: readonly string[],
) {
  const users = memberUserIds.map((value) => new UserId(value));
  try {
    return await machine.getMissingSessions(users);
  } catch (error) {
    for (const user of users) safeFree(user);
    throw error;
  }
}

async function shareRoomKey(
  machine: OlmMachine,
  roomId: RoomId,
  memberUserIds: readonly string[],
  settings: EncryptionSettings,
) {
  const users = memberUserIds.map((value) => new UserId(value));
  try {
    return await machine.shareRoomKey(roomId, users, settings);
  } catch (error) {
    for (const user of users) safeFree(user);
    throw error;
  }
}

async function activeDeviceIds(
  machine: OlmMachine,
  memberUserIds: readonly string[],
): Promise<{ ids: string[]; memberDeviceCounts: number[] }> {
  const result = new Set<string>();
  const memberDeviceCounts: number[] = [];
  for (const memberUserId of memberUserIds) {
    let memberDeviceCount = 0;
    const userId = new UserId(memberUserId);
    let devices: Awaited<ReturnType<OlmMachine["getUserDevices"]>> | undefined;
    try {
      devices = await machine.getUserDevices(userId, 0);
    } finally {
      userId.free();
    }
    try {
      for (const device of devices.devices()) {
        try {
          if (
            device.isDeleted() ||
            device.isBlacklisted() ||
            !device.algorithms.includes(EncryptionAlgorithm.MegolmV1AesSha2)
          ) {
            continue;
          }
          const matrixDeviceId = device.deviceId;
          try {
            result.add(
              sinochatDeviceIdFromMatrixDeviceId(matrixDeviceId.toString()),
            );
            memberDeviceCount += 1;
          } finally {
            matrixDeviceId.free();
          }
        } finally {
          device.free();
        }
      }
    } finally {
      devices.free();
    }
    memberDeviceCounts.push(memberDeviceCount);
  }
  return { ids: [...result].sort(), memberDeviceCounts };
}

async function commitRequests(
  requests: Awaited<ReturnType<OlmMachine["shareRoomKey"]>>,
  send: (request: (typeof requests)[number]) => Promise<void>,
): Promise<void> {
  let index = 0;
  try {
    for (; index < requests.length; index += 1) {
      const request = requests[index]!;
      await send(request);
      request.free();
    }
  } catch (error) {
    for (let rest = index; rest < requests.length; rest += 1) {
      safeFree(requests[rest]!);
    }
    throw error;
  }
}

function strictDecryptedEvent(value: string): {
  type: unknown;
  sender: unknown;
  content: unknown;
  event_id: unknown;
  origin_server_ts: unknown;
  room_id: unknown;
  unsigned: unknown;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new MatrixMegolmMessageCryptoError(
      "MATRIX_DECRYPTED_EVENT_JSON_INVALID",
      error,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MatrixMegolmMessageCryptoError(
      "MATRIX_DECRYPTED_EVENT_INVALID",
    );
  }
  const event = parsed as Record<string, unknown>;
  const expectedKeys = [
    "type",
    "sender",
    "content",
    "event_id",
    "origin_server_ts",
    "room_id",
    "unsigned",
  ];
  if (
    Reflect.ownKeys(event).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(event, key))
  ) {
    throw new MatrixMegolmMessageCryptoError(
      "MATRIX_DECRYPTED_EVENT_FIELDS_INVALID",
    );
  }
  // Rust Crypto 18.6.0 devuelve room_id y unsigned incluso si el evento de
  // transporte no los incluía. No enviamos metadatos unsigned al SDK: su objeto
  // debe permanecer vacío y jamás sustituir contenido o bindings autenticados.
  if (
    !event.unsigned ||
    typeof event.unsigned !== "object" ||
    Array.isArray(event.unsigned) ||
    Reflect.ownKeys(event.unsigned).length !== 0
  ) {
    throw new MatrixMegolmMessageCryptoError(
      "MATRIX_DECRYPTED_EVENT_UNSIGNED_INVALID",
    );
  }
  return event as ReturnType<typeof strictDecryptedEvent>;
}

function matrixServerName(matrixUserId: string): string {
  const separator = matrixUserId.indexOf(":");
  if (separator < 3) {
    throw new MatrixMegolmMessageCryptoError("MATRIX_IDENTITY_INVALID");
  }
  const serverName = normalizeMatrixServerName(
    matrixUserId.slice(separator + 1),
  );
  if (!matrixUserId.endsWith(`:${serverName}`)) {
    throw new MatrixMegolmMessageCryptoError("MATRIX_IDENTITY_INVALID");
  }
  return serverName;
}

function matrixEventId(messageId: string, serverName: string): string {
  if (!/^[0-9a-f-]{36}$/.test(messageId)) {
    throw new MatrixMegolmMessageCryptoError("MESSAGE_ID_INVALID");
  }
  return `$${EVENT_ID_LOCALPART_PREFIX}${messageId.replaceAll("-", "")}:${serverName}`;
}

function isCanonicalMatrixKey(value: string): boolean {
  if (!MATRIX_KEY_PATTERN.test(value)) return false;
  try {
    return btoa(atob(`${value}=`)).replace(/=+$/u, "") === value;
  } catch {
    return false;
  }
}

function bytesToPaddedBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("La operacion fue cancelada.", "AbortError");
}

function safeFree(value: { free(): void }): void {
  try {
    value.free();
  } catch {
    // El SDK invalida algunos wrappers al transferirlos; liberar dos veces no
    // debe ocultar el error criptografico original.
  }
}
