// Solo se sirve desde el verificador local. No es una ruta ni un bypass de la PWA.
import { DecryptionSettings, RoomId, TrustRequirement, initAsync } from "@matrix-org/matrix-sdk-crypto-wasm";
import { initializeMatrixCrypto } from "../../src/e2ee/matrixRuntime.ts";
import { MatrixMegolmMessageCrypto } from "../../src/e2ee/matrixMegolmMessageCrypto.ts";
import {
  IndexedDbMatrixSyncTokenStore,
  MatrixTransportCoordinator,
} from "../../src/e2ee/matrixTransport.ts";
import { BrowserMatrixSessionLockProvider } from "../../src/e2ee/matrixSessionLifecycle.ts";
import {
  decryptMatrixImageAttachment,
  encryptMatrixImageAttachment,
} from "../../src/e2ee/matrixImageAttachment.ts";
import { parseEncryptedMessagePage } from "../../src/messagePayload.ts";
import { SecureMessageController } from "../../src/secureMessageController.ts";
import { mountRetentionView, unmountRetentionView } from "./local-retention-view.mjs";

let session;
let coordinator;
let messages;
let lease;
let identity;
let imagePlaintext;
let imageCiphertext;
let timeline;
let timelineItems;
let timelineConversation;
let receiptCount = 0;
const tokenStore = new IndexedDbMatrixSyncTokenStore();
const locks = new BrowserMatrixSessionLockProvider();

async function start(input) {
  if (session) throw new Error("FIXTURE_ALREADY_STARTED");
  identity = input;
  // El AbortSignal es el que utiliza el lifecycle real, no una opción simulada.
  lease = await locks.acquire(input.sinochatUserId, new AbortController().signal);
  try {
    await initAsync("/__sinochat_matrix_crypto.wasm");
    session = await initializeMatrixCrypto(input);
    const request = async (action, body, signal) => {
      const response = await fetch(`/__sinochat_e2ee_api/${input.actor}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) throw new Error(`FIXTURE_HTTP_${response.status}`);
      return response.json();
    };
    coordinator = new MatrixTransportCoordinator(
      session.machine,
      session.identity.deviceId,
      {
        uploadKeys: (body, signal) => request("upload", body, signal),
        queryKeys: (body, signal) => request("query", body, signal),
        claimKeys: (requestId, body, signal) => request("claim", { requestId, body }, signal),
        sendToDevice: (eventType, transactionId, body, signal) =>
          request("send", { eventType, transactionId, body }, signal),
        sync: ({ signal, ...body }) => request("sync", body, signal),
      },
      tokenStore,
    );
    messages = new MatrixMegolmMessageCrypto(session.identity, coordinator);
    await coordinator.flushOutgoingRequests();
    return { userId: session.identity.userId, deviceId: session.identity.deviceId };
  } catch (error) {
    session?.close();
    session = undefined;
    lease.release();
    lease = undefined;
    throw error;
  }
}

function base(input) {
  return {
    conversationId: input.conversationId,
    clientMessageId: input.clientMessageId,
    senderUserId: identity.sinochatUserId,
    senderDeviceId: identity.sinochatDeviceId,
    participantUserId: input.participantUserId,
  };
}

async function sync() {
  const result = await coordinator.sync();
  try {
    if (result.rejectedApplicationEventCount !== 0) {
      throw new Error("FIXTURE_APPLICATION_EVENT_IN_CONTROL_CHANNEL");
    }
    return { nextBatch: result.nextBatch, controlEvents: result.processedControlEvents.length };
  } finally {
    for (const event of result.processedControlEvents) event.free();
  }
}

function parse(message) {
  return parseEncryptedMessagePage({
    items: [message], nextAfterSequence: message.serverSequence,
  }).items[0];
}

async function decrypt({ conversationId, message }) {
  return messages.decrypt(conversationId, parse(message));
}

function errorCodes(error) {
  const codes = [];
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
    codes.push(typeof current.code === "string" ? current.code : current.name);
  }
  return codes;
}

async function probeDecrypt(input) {
  try {
    await decrypt(input);
    return { rejected: false };
  } catch (error) {
    return { rejected: true, codes: errorCodes(error) };
  }
}

async function sendImage(input) {
  // Una imagen sintética decodificable; no modifica ni reutiliza los logotipos.
  const canvas = document.createElement("canvas");
  canvas.width = 12;
  canvas.height = 9;
  const drawing = canvas.getContext("2d");
  drawing.fillStyle = "#C8102E";
  drawing.fillRect(0, 0, 12, 9);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  imagePlaintext = new Uint8Array(await blob.arrayBuffer());
  const attachment = await encryptMatrixImageAttachment({ bytes: imagePlaintext, mimeType: "image/png" });
  imageCiphertext = attachment.encryptedBytes;
  const { encryptedBytes, mediaEncryptionInfo, ...metadata } = attachment;
  const outbound = await messages.encryptImage({
    ...base(input), ...metadata, mediaEncryptionInfo,
    attachmentGrantToken: `${"A".repeat(48)}.${"B".repeat(43)}`,
  });
  const secret = JSON.parse(mediaEncryptionInfo).key.k;
  const wire = JSON.stringify({ outbound, metadata, blob: toBase64(encryptedBytes) });
  if (wire.includes(secret) || wire.includes("mediaEncryptionInfo")) {
    throw new Error("FIXTURE_ATTACHMENT_SECRET_EXPOSED");
  }
  return {
    outbound, metadata, blob: toBase64(encryptedBytes),
    plaintextHash: await hash(imagePlaintext),
    secretAbsentFromWire: true,
  };
}

async function receiveImage({ conversationId, message, blob, tamper = false }) {
  const content = await decrypt({ conversationId, message });
  if (content.kind !== "IMAGE") throw new Error("FIXTURE_IMAGE_EXPECTED");
  const bytes = Uint8Array.from(atob(blob), (char) => char.charCodeAt(0));
  if (tamper) bytes[0] ^= 1;
  const result = await decryptMatrixImageAttachment({
    ...content.image,
    mediaEncryptionInfo: JSON.stringify(content.image.mediaEncryptionInfo),
    encryptedBytes: bytes,
  });
  const bitmap = await createImageBitmap(new Blob([result.bytes], { type: result.mimeType }));
  try {
    return { hash: await hash(result.bytes), width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
    result.bytes.fill(0);
  }
}

async function imageLimits() {
  const cases = [
    [{ bytes: new Uint8Array(5 * 1024 * 1024 + 1), mimeType: "image/png" }, "E2EE_IMAGE_TOO_LARGE"],
    [{ bytes: imagePlaintext, mimeType: "image/webp" }, "E2EE_IMAGE_MIME_MISMATCH"],
  ];
  for (const [input, expected] of cases) {
    try {
      await encryptMatrixImageAttachment(input);
      throw new Error("FIXTURE_INVALID_IMAGE_ACCEPTED");
    } catch (error) {
      if (error.code !== expected) throw error;
    }
  }
  return true;
}

async function close() {
  unmountRetentionView();
  timeline?.close();
  timeline = undefined;
  await coordinator?.drain();
  session?.close();
  session = undefined;
  lease?.release();
  lease = undefined;
  imagePlaintext?.fill(0);
  imageCiphertext?.fill(0);
}

function toBase64(bytes) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

async function hash(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
}

window.sinochatE2eeFixture = {
  start, sync, decrypt, probeDecrypt, sendImage, receiveImage, imageLimits, close,
  async probeStart(input) {
    try {
      await start(input);
      return { rejected: false };
    } catch (error) {
      return { rejected: true, codes: errorCodes(error) };
    }
  },
  async startTimeline({ conversationId, participantUserId, items }) {
    timelineItems = items;
    timelineConversation = {
      id: conversationId, participant: { id: participantUserId, username: "Usuario de prueba", presence: "offline" },
      messages: [], unreadCount: 0,
    };
    timeline = new SecureMessageController({
      async list() {
        return parseEncryptedMessagePage({ items: timelineItems, nextAfterSequence: timelineItems.at(-1)?.serverSequence ?? "0" });
      },
      async updateReceipt() { receiptCount++; },
    }, messages, identity.sinochatUserId, identity.sinochatDeviceId);
    return timeline.load(timelineConversation);
  },
  async probeTimeline(items) {
    const original = timelineItems;
    const previousReceipts = receiptCount;
    timelineItems = items;
    try {
      await timeline.load(timelineConversation);
      return { rejected: false };
    } catch (error) {
      return { rejected: true, codes: errorCodes(error), newReceipts: receiptCount - previousReceipts };
    } finally {
      timelineItems = original;
    }
  },
  loadTimeline: () => timeline.load(timelineConversation),
  mountRetention: (conversations) => mountRetentionView(conversations, identity.sinochatUserId),
  async canFetchBlob(url) {
    try {
      const response = await fetch(url);
      return response.ok;
    } catch { return false; }
  },
  async inspectDecryptedFields({ conversationId, message }) {
    const room = new RoomId(session.identity.roomIdFor(conversationId));
    const settings = new DecryptionSettings(TrustRequirement.Untrusted);
    let decrypted;
    try {
      decrypted = await session.machine.decryptRoomEvent(JSON.stringify({
        type: "m.room.encrypted", sender: `@u${message.senderUserId.replaceAll("-", "")}:sinochat.invalid`,
        content: parse(message).envelope.content,
        event_id: `$m${message.id.replaceAll("-", "")}:sinochat.invalid`,
        origin_server_ts: Date.parse(message.createdAt),
      }), room, settings);
      const event = JSON.parse(decrypted.event);
      return { fields: Object.keys(event), room: event.room_id, unsigned: event.unsigned };
    } finally {
      decrypted?.free(); settings.free(); room.free();
    }
  },
  sendText: (input) => messages.encryptText({ ...base(input), text: input.text }),
  async probeSendText(input) {
    try {
      await messages.encryptText({ ...base(input), text: input.text });
      return { rejected: false };
    } catch (error) {
      return { rejected: true, codes: errorCodes(error) };
    }
  },
  savedToken: () => tokenStore.load(session.identity.deviceId),
  async probeLock({ userId, abortBefore = false }) {
    const controller = new AbortController();
    if (abortBefore) controller.abort();
    try {
      const acquired = await locks.acquire(userId, controller.signal);
      acquired.release();
      return { acquired: true };
    } catch (error) {
      return { acquired: false, codes: errorCodes(error) };
    }
  },
  async probeImage(input) {
    try {
      await receiveImage(input);
      return { rejected: false };
    } catch (error) {
      return { rejected: true, codes: errorCodes(error) };
    }
  },
};
