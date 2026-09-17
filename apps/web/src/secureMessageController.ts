import type { MessagesApi } from "./api";
import type {
  ChatConversation,
  ChatMessage,
  DeliveryStatus,
} from "./dashboard";
import {
  decryptMatrixImageAttachment,
  encryptMatrixImageAttachment,
} from "./e2ee/matrixImageAttachment";
import type { MatrixMegolmMessageCrypto } from "./e2ee/matrixMegolmMessageCrypto";
import type {
  EncryptedMessageReceiptStatus,
  EncryptedTransportMessage,
} from "./messagePayload";

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

interface AuthenticatedMessageRecord {
  readonly messageId: string;
  readonly conversationId: string;
  readonly fingerprint: string;
  readonly expiresAtMs: number;
}

export class SecureMessageControllerError extends Error {
  readonly code: string;

  constructor(code: string, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "SecureMessageControllerError";
    this.code = code;
  }
}

/**
 * Orquesta HTTP, Rust Crypto y adjuntos sin exponer plaintext a api.ts.
 * Debe existir una sola instancia mientras la sesion Matrix este abierta.
 */
export class SecureMessageController {
  private readonly lifetime = new AbortController();
  private readonly objectUrls = new Map<string, string>();
  private readonly conversationMessageIds = new Map<string, Set<string>>();
  private readonly decryptedMessages = new Map<
    string,
    { conversationId: string; fingerprint: string; message: ChatMessage }
  >();
  private readonly authenticatedMessages = new Map<
    string,
    AuthenticatedMessageRecord
  >();
  private readonly authenticatedKeysByMessageId = new Map<string, string>();
  private readonly messageExpiryTimers = new Map<
    string,
    { authenticatedKey: string; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly api: MessagesApi,
    private readonly crypto: MatrixMegolmMessageCrypto,
    private readonly currentUserId: string,
    private readonly currentDeviceId: string,
  ) {}

  async load(
    conversation: ChatConversation,
    signal?: AbortSignal,
  ): Promise<ChatConversation> {
    signal = this.operationSignal(signal);
    this.assertConversation(conversation);
    const page = await this.api.list(
      conversation.id,
      this.currentDeviceId,
      { limit: 100 },
      signal,
    );
    throwIfAborted(signal);
    const messages: ChatMessage[] = [];
    const receiptsToRead: string[] = [];

    for (const encrypted of page.items) {
      throwIfAborted(signal);
      if (Date.parse(encrypted.expiresAt) <= Date.now()) {
        this.expireMessageIfDue(encrypted.id);
        continue;
      }
      const fingerprint = encryptedMessageFingerprint(encrypted);
      const authenticatedKey = authenticatedMessageKey(
        encrypted.senderDeviceId,
        encrypted.clientMessageId,
      );
      const cached = this.decryptedMessages.get(encrypted.id);
      if (
        cached?.conversationId === conversation.id &&
        cached.fingerprint === fingerprint &&
        this.matchesAuthenticatedMessage(
          authenticatedKey,
          encrypted.id,
          conversation.id,
          fingerprint,
          Date.parse(encrypted.expiresAt),
        )
      ) {
        const message = {
          ...cached.message,
          deliveryStatus: ownDeliveryStatus(encrypted, this.currentUserId),
        } as ChatMessage;
        cached.message = message;
        messages.push(message);
        if (
          encrypted.senderUserId !== this.currentUserId &&
          encrypted.receipts[0]?.status !== "READ"
        ) {
          receiptsToRead.push(encrypted.id);
        }
        continue;
      }
      const content = await this.crypto.decrypt(
        conversation.id,
        encrypted,
        signal,
      );
      throwIfAborted(signal);
      if (Date.parse(encrypted.expiresAt) <= Date.now()) {
        this.expireMessageIfDue(encrypted.id);
        continue;
      }
      if (
        authenticatedMessageKey(
          content.senderDeviceId,
          content.clientMessageId,
        ) !== authenticatedKey
      ) {
        throw new SecureMessageControllerError(
          "AUTHENTICATED_MESSAGE_BINDING_INVALID",
        );
      }
      this.rememberAuthenticatedMessage(
        authenticatedKey,
        encrypted.id,
        conversation.id,
        fingerprint,
        Date.parse(encrypted.expiresAt),
      );
      const chatMessage =
        content.kind === "TEXT"
          ? textChatMessage(encrypted, content.text, this.currentUserId)
          : await this.imageChatMessage(
              encrypted,
              content.image.mediaEncryptionInfo,
              signal,
            );
      messages.push(chatMessage);
      this.decryptedMessages.set(encrypted.id, {
        conversationId: conversation.id,
        fingerprint,
        message: chatMessage,
      });
      if (
        encrypted.senderUserId !== this.currentUserId &&
        encrypted.receipts[0]?.status !== "READ"
      ) {
        receiptsToRead.push(encrypted.id);
      }
    }

    // La lectura solo se confirma despues del descifrado y de construir el
    // contenido visible. Un fallo de receipt no oculta un mensaje autentico.
    await Promise.allSettled(
      receiptsToRead.map((messageId) =>
        this.api.updateReceipt(messageId, "READ", signal),
      ),
    );
    throwIfAborted(signal);

    const liveMessages = messages.filter((message) => {
      if (Date.parse(message.expiresAt) > Date.now()) return true;
      this.expireMessageIfDue(message.id);
      return false;
    });
    const liveMessageIds = new Set(liveMessages.map((message) => message.id));
    for (const previousId of this.conversationMessageIds.get(conversation.id) ?? []) {
      if (!liveMessageIds.has(previousId)) {
        this.revokeObjectUrl(previousId);
        this.decryptedMessages.delete(previousId);
      }
    }
    this.conversationMessageIds.set(conversation.id, liveMessageIds);

    return {
      ...conversation,
      messages: liveMessages,
      unreadCount: 0,
      ...(liveMessages.length > 0
        ? { lastActivityAt: liveMessages[liveMessages.length - 1]!.sentAt }
        : {}),
    };
  }

  async sendText(
    conversation: ChatConversation,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal = this.operationSignal(signal);
    this.assertConversation(conversation);
    const clientMessageId = crypto.randomUUID();
    const request = await this.crypto.encryptText(
      {
        conversationId: conversation.id,
        clientMessageId,
        senderUserId: this.currentUserId,
        senderDeviceId: this.currentDeviceId,
        participantUserId: conversation.participant.id,
        text,
      },
      signal,
    );
    await this.api.send(conversation.id, request, signal);
  }

  async sendImage(
    conversation: ChatConversation,
    file: File,
    signal?: AbortSignal,
  ): Promise<void> {
    signal = this.operationSignal(signal);
    this.assertConversation(conversation);
    if (!(file instanceof File) || file.size < 1 || file.size > MAX_ATTACHMENT_BYTES) {
      throw new SecureMessageControllerError("IMAGE_FILE_INVALID");
    }

    const plaintext = new Uint8Array(await file.arrayBuffer());
    let encrypted:
      | Awaited<ReturnType<typeof encryptMatrixImageAttachment>>
      | undefined;
    try {
      throwIfAborted(signal);
      encrypted = await encryptMatrixImageAttachment({
        bytes: plaintext,
        mimeType: file.type,
      });
      const grant = await this.api.requestAttachmentUpload(
        conversation.id,
        {
          declaredMimeType: encrypted.declaredMimeType,
          plaintextByteSize: encrypted.plaintextByteSize,
          ciphertextByteSize: encrypted.ciphertextByteSize,
          ciphertextSha256: encrypted.ciphertextSha256,
        },
        signal,
      );
      await this.api.uploadAttachment(grant, encrypted.encryptedBytes, signal);
      const clientMessageId = crypto.randomUUID();
      const request = await this.crypto.encryptImage(
        {
          conversationId: conversation.id,
          clientMessageId,
          senderUserId: this.currentUserId,
          senderDeviceId: this.currentDeviceId,
          participantUserId: conversation.participant.id,
          declaredMimeType: encrypted.declaredMimeType,
          plaintextByteSize: encrypted.plaintextByteSize,
          ciphertextByteSize: encrypted.ciphertextByteSize,
          ciphertextSha256: encrypted.ciphertextSha256,
          mediaEncryptionInfo: encrypted.mediaEncryptionInfo,
          attachmentGrantToken: grant.grantToken,
        },
        signal,
      );
      await this.api.send(conversation.id, request, signal);
    } catch (error) {
      if (error instanceof SecureMessageControllerError) throw error;
      throw new SecureMessageControllerError("IMAGE_SEND_FAILED", error);
    } finally {
      plaintext.fill(0);
      encrypted?.encryptedBytes.fill(0);
    }
  }

  close(): void {
    this.lifetime.abort();
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    for (const entry of this.messageExpiryTimers.values()) {
      clearTimeout(entry.timer);
    }
    this.objectUrls.clear();
    this.conversationMessageIds.clear();
    this.decryptedMessages.clear();
    this.authenticatedMessages.clear();
    this.authenticatedKeysByMessageId.clear();
    this.messageExpiryTimers.clear();
  }

  private async imageChatMessage(
    message: EncryptedTransportMessage,
    mediaEncryptionInfo: unknown,
    signal?: AbortSignal,
  ): Promise<ChatMessage> {
    const attachment = message.attachment;
    if (!attachment) {
      throw new SecureMessageControllerError("IMAGE_ATTACHMENT_MISSING");
    }
    const expiresAtMs = Date.parse(message.expiresAt);
    const deadline = expirySignal(expiresAtMs, signal);
    let encryptedBytes: Uint8Array | undefined;
    try {
      encryptedBytes = await downloadExactBytes(
        attachment.downloadUrl,
        attachment.ciphertextByteSize,
        deadline.signal,
      );
      throwIfExpired(expiresAtMs);
      const decrypted = await decryptMatrixImageAttachment({
        encryptedBytes,
        mediaEncryptionInfo: JSON.stringify(mediaEncryptionInfo),
        declaredMimeType: attachment.declaredMimeType,
        plaintextByteSize: attachment.plaintextByteSize,
        ciphertextByteSize: attachment.ciphertextByteSize,
        ciphertextSha256: attachment.ciphertextSha256,
      });
      try {
        throwIfAborted(deadline.signal);
        throwIfExpired(expiresAtMs);
        this.revokeObjectUrl(message.id);
        const url = URL.createObjectURL(
          new Blob([decrypted.bytes.slice()], { type: decrypted.mimeType }),
        );
        this.objectUrls.set(message.id, url);
        return {
          id: message.id,
          senderId: message.senderUserId,
          sentAt: message.createdAt,
          expiresAt: message.expiresAt,
          deliveryStatus: ownDeliveryStatus(
            message,
            this.currentUserId,
          ),
          kind: "image",
          image: { url, alt: "Foto cifrada" },
        };
      } finally {
        decrypted.bytes.fill(0);
      }
    } finally {
      deadline.dispose();
      encryptedBytes?.fill(0);
    }
  }

  private assertConversation(conversation: ChatConversation): void {
    if (
      !conversation ||
      conversation.participant.id === this.currentUserId ||
      !conversation.id ||
      !conversation.participant.id
    ) {
      throw new SecureMessageControllerError("CONVERSATION_INVALID");
    }
  }

  private revokeObjectUrl(messageId: string): void {
    const url = this.objectUrls.get(messageId);
    if (!url) return;
    URL.revokeObjectURL(url);
    this.objectUrls.delete(messageId);
  }

  private rememberAuthenticatedMessage(
    authenticatedKey: string,
    messageId: string,
    conversationId: string,
    fingerprint: string,
    expiresAtMs: number,
  ): void {
    throwIfExpired(expiresAtMs);
    const keyForMessage = this.authenticatedKeysByMessageId.get(messageId);
    const existing = this.authenticatedMessages.get(authenticatedKey);
    if (
      (keyForMessage !== undefined && keyForMessage !== authenticatedKey) ||
      (existing !== undefined &&
        (existing.messageId !== messageId ||
          existing.conversationId !== conversationId ||
          existing.fingerprint !== fingerprint ||
          existing.expiresAtMs !== expiresAtMs))
    ) {
      throw new SecureMessageControllerError(
        "MESSAGE_REPLAY_OR_REWRITE_DETECTED",
      );
    }
    if (existing) return;

    this.authenticatedMessages.set(authenticatedKey, {
      messageId,
      conversationId,
      fingerprint,
      expiresAtMs,
    });
    this.authenticatedKeysByMessageId.set(messageId, authenticatedKey);
    const timer = setTimeout(
      () => this.expireMessage(messageId, authenticatedKey),
      Math.max(0, expiresAtMs - Date.now()),
    );
    this.messageExpiryTimers.set(messageId, { authenticatedKey, timer });
  }

  private matchesAuthenticatedMessage(
    authenticatedKey: string,
    messageId: string,
    conversationId: string,
    fingerprint: string,
    expiresAtMs: number,
  ): boolean {
    const record = this.authenticatedMessages.get(authenticatedKey);
    return (
      record?.messageId === messageId &&
      record.conversationId === conversationId &&
      record.fingerprint === fingerprint &&
      record.expiresAtMs === expiresAtMs &&
      this.authenticatedKeysByMessageId.get(messageId) === authenticatedKey
    );
  }

  private expireMessage(
    messageId: string,
    expectedAuthenticatedKey?: string,
  ): void {
    const expiry = this.messageExpiryTimers.get(messageId);
    if (
      expectedAuthenticatedKey !== undefined &&
      expiry !== undefined &&
      expiry.authenticatedKey !== expectedAuthenticatedKey
    ) {
      return;
    }
    if (expiry) {
      clearTimeout(expiry.timer);
      this.messageExpiryTimers.delete(messageId);
    }

    this.revokeObjectUrl(messageId);
    this.decryptedMessages.delete(messageId);
    for (const ids of this.conversationMessageIds.values()) {
      ids.delete(messageId);
    }

    const authenticatedKey =
      expectedAuthenticatedKey ??
      expiry?.authenticatedKey ??
      this.authenticatedKeysByMessageId.get(messageId);
    if (authenticatedKey === undefined) return;
    if (
      this.authenticatedMessages.get(authenticatedKey)?.messageId === messageId
    ) {
      this.authenticatedMessages.delete(authenticatedKey);
    }
    if (this.authenticatedKeysByMessageId.get(messageId) === authenticatedKey) {
      this.authenticatedKeysByMessageId.delete(messageId);
    }
  }

  private expireMessageIfDue(messageId: string): void {
    const authenticatedKey =
      this.authenticatedKeysByMessageId.get(messageId);
    const authenticated =
      authenticatedKey === undefined
        ? undefined
        : this.authenticatedMessages.get(authenticatedKey);
    // expiresAt llega en metadata exterior. Una reescritura no autenticada a
    // una fecha pasada no debe borrar antes de tiempo el tombstone anti-replay
    // que ya fue aceptado y programado con el primer mensaje autenticado.
    if (authenticated && authenticated.expiresAtMs > Date.now()) return;
    this.expireMessage(messageId, authenticatedKey);
  }

  private operationSignal(external?: AbortSignal): AbortSignal {
    throwIfAborted(this.lifetime.signal);
    return external === undefined
      ? this.lifetime.signal
      : AbortSignal.any([this.lifetime.signal, external]);
  }
}

function textChatMessage(
  message: EncryptedTransportMessage,
  text: string,
  currentUserId: string,
): ChatMessage {
  return {
    id: message.id,
    senderId: message.senderUserId,
    sentAt: message.createdAt,
    expiresAt: message.expiresAt,
    deliveryStatus: ownDeliveryStatus(message, currentUserId),
    kind: "text",
    text,
  };
}

function authenticatedMessageKey(
  senderDeviceId: string,
  clientMessageId: string,
): string {
  return `${senderDeviceId}:${clientMessageId}`;
}

function encryptedMessageFingerprint(message: EncryptedTransportMessage): string {
  return JSON.stringify({
    id: message.id,
    senderUserId: message.senderUserId,
    senderDeviceId: message.senderDeviceId,
    clientMessageId: message.clientMessageId,
    serverSequence: message.serverSequence,
    kind: message.kind,
    createdAt: message.createdAt,
    expiresAt: message.expiresAt,
    protocolVersion: message.envelope.protocolVersion,
    cipherSuite: message.envelope.cipherSuite,
    ciphertext: message.envelope.ciphertext,
    attachment:
      message.attachment === null
        ? null
        : {
            declaredMimeType: message.attachment.declaredMimeType,
            plaintextByteSize: message.attachment.plaintextByteSize,
            ciphertextByteSize: message.attachment.ciphertextByteSize,
            ciphertextSha256: message.attachment.ciphertextSha256,
            cipherSuite: message.attachment.cipherSuite,
          },
  });
}

function ownDeliveryStatus(
  message: EncryptedTransportMessage,
  currentUserId: string,
): DeliveryStatus | undefined {
  if (message.senderUserId !== currentUserId) return undefined;
  return receiptDeliveryStatus(message.receipts[0]?.status);
}

function receiptDeliveryStatus(
  value: EncryptedMessageReceiptStatus | undefined,
): DeliveryStatus {
  if (value === "READ") return "read";
  if (value === "DELIVERED") return "delivered";
  return "sent";
}

async function downloadExactBytes(
  url: string,
  expectedBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      credentials: "omit",
      method: "GET",
      mode: "cors",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal,
    });
  } catch (error) {
    throwIfAborted(signal);
    if (isAbortError(error)) throw error;
    throw new SecureMessageControllerError("IMAGE_DOWNLOAD_FAILED", error);
  }
  if (!response.ok || !response.body) {
    throw new SecureMessageControllerError("IMAGE_DOWNLOAD_REJECTED");
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== expectedBytes)
  ) {
    await response.body.cancel();
    throw new SecureMessageControllerError("IMAGE_DOWNLOAD_SIZE_INVALID");
  }

  const reader = response.body.getReader();
  const output = new Uint8Array(expectedBytes);
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > expectedBytes) {
        throw new SecureMessageControllerError("IMAGE_DOWNLOAD_SIZE_INVALID");
      }
      output.set(value, offset);
      offset += value.byteLength;
    }
  } catch (error) {
    output.fill(0);
    await reader.cancel().catch(() => undefined);
    throwIfAborted(signal);
    if (error instanceof SecureMessageControllerError || isAbortError(error)) {
      throw error;
    }
    throw new SecureMessageControllerError("IMAGE_DOWNLOAD_FAILED", error);
  } finally {
    reader.releaseLock();
  }
  if (offset !== expectedBytes) {
    output.fill(0);
    throw new SecureMessageControllerError("IMAGE_DOWNLOAD_SIZE_INVALID");
  }
  return output;
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

function throwIfExpired(expiresAtMs: number): void {
  if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) return;
  throw new SecureMessageControllerError("MESSAGE_EXPIRED");
}

function expirySignal(
  expiresAtMs: number,
  parent?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  throwIfExpired(expiresAtMs);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new SecureMessageControllerError("MESSAGE_EXPIRED")),
    Math.max(0, expiresAtMs - Date.now()),
  );
  return {
    signal:
      parent === undefined
        ? controller.signal
        : AbortSignal.any([parent, controller.signal]),
    dispose: () => clearTimeout(timer),
  };
}
