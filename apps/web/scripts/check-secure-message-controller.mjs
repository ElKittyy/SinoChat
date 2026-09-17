import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const currentUserId = "11111111-1111-4111-8111-111111111111";
const currentDeviceId = "22222222-2222-4222-8222-222222222222";
const participantId = "33333333-3333-4333-8333-333333333333";
const participantDeviceId = "44444444-4444-4444-8444-444444444444";
const conversationId = "55555555-5555-4555-8555-555555555555";
const messageId = "66666666-6666-4666-8666-666666666666";
const clientMessageId = "77777777-7777-4777-8777-777777777777";
const roomId = "!c55555555555545558555555555555555:sinochat.invalid";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(webRoot, "src/secureMessageController.ts");
const source = await readFile(sourcePath, "utf8");
const appSource = await readFile(resolve(webRoot, "src/App.tsx"), "utf8");
const temporaryDirectory = await mkdtemp(
  resolve(webRoot, ".secure-message-controller-test-"),
);

try {
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  assert.deepEqual(compiled.diagnostics ?? [], []);
  const output = compiled.outputText.replaceAll(
    '"./e2ee/matrixImageAttachment"',
    '"./matrixImageAttachment.mjs"',
  );
  await writeFile(
    resolve(temporaryDirectory, "secureMessageController.mjs"),
    output,
    "utf8",
  );
  await writeFile(
    resolve(temporaryDirectory, "matrixImageAttachment.mjs"),
    [
      "export async function encryptMatrixImageAttachment() {",
      "  throw new Error('UNEXPECTED_IMAGE_ENCRYPT');",
      "}",
      "export async function decryptMatrixImageAttachment(input) {",
      "  globalThis.__sinochatDownloadedCiphertext = input.encryptedBytes;",
      "  const hook = globalThis.__sinochatDecryptAttachmentHook;",
      "  if (typeof hook === 'function') return hook(input);",
      "  return { bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' };",
      "}",
    ].join("\n"),
    "utf8",
  );

  const { SecureMessageController } = await import(
    pathToFileURL(
      resolve(temporaryDirectory, "secureMessageController.mjs"),
    ).href
  );
  await withControlledClock(async (clock) => {
    await checkTextLoadCacheAndReceipt(SecureMessageController);
    await checkSendBindings(SecureMessageController);
    await checkNoReceiptBeforeAuthenticatedDecrypt(SecureMessageController);
    await checkExpiryDuringDownload(SecureMessageController, clock);
    await checkExpiryDuringDecrypt(SecureMessageController, clock);
    await checkAutomaticObjectUrlRevocation(SecureMessageController, clock);
    await checkCloseWithExternalSignal(SecureMessageController);
    await checkAuthenticatedReplayAndRewrite(SecureMessageController);
  });

  assert.match(appSource, /new SecureMessageController\(/);
  assert.match(appSource, /matrixClient\.status === "ready"/);
  assert.match(appSource, /onSendText=\{sendText\}/);
  assert.match(appSource, /onSendImage=\{sendImage\}/);
  assert.doesNotMatch(appSource, /onSendText=\{sendText \?\?/);
  assert.doesNotMatch(appSource, /onSendImage=\{sendImage \?\?/);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log(
  "[OK] El controlador autentica plaintext, respeta vencimientos durante I/O, revoca Blob URLs, combina abortos de sesion y limpia buffers efimeros.",
);

async function checkTextLoadCacheAndReceipt(Controller) {
  let decryptCount = 0;
  const receipts = [];
  let status = "SENT";
  const encrypted = encryptedTextMessage(() => status);
  const api = {
    async list() {
      return { items: [encrypted()], nextAfterSequence: "1" };
    },
    async updateReceipt(messageId, nextStatus) {
      receipts.push([messageId, nextStatus]);
    },
  };
  const crypto = {
    async decrypt(_conversationId, message) {
      decryptCount += 1;
      return {
        protocolVersion: "matrix-megolm-v1",
        conversationId,
        roomId,
        clientMessageId: message.clientMessageId,
        senderUserId: participantId,
        senderDeviceId: participantDeviceId,
        kind: "TEXT",
        text: "mensaje autenticado",
      };
    },
  };
  const controller = new Controller(api, crypto, currentUserId, currentDeviceId);

  const first = await controller.load(conversation());
  assert.equal(first.messages[0].text, "mensaje autenticado");
  assert.equal(first.unreadCount, 0);
  assert.equal(decryptCount, 1);
  assert.deepEqual(receipts, [[messageId, "READ"]]);

  status = "READ";
  const second = await controller.load(conversation());
  assert.equal(second.messages[0].text, "mensaje autenticado");
  assert.equal(decryptCount, 1, "el mismo ciphertext no se descifra dos veces");
  assert.equal(receipts.length, 1);
  controller.close();
}

async function checkSendBindings(Controller) {
  let encryptedInput;
  let sent;
  const api = {
    async send(conversationIdValue, request) {
      sent = { conversationIdValue, request };
    },
  };
  const crypto = {
    async encryptText(input) {
      encryptedInput = input;
      return { encrypted: true };
    },
  };
  const controller = new Controller(api, crypto, currentUserId, currentDeviceId);
  await controller.sendText(conversation(), "hola privado");

  assert.equal(encryptedInput.conversationId, conversationId);
  assert.equal(encryptedInput.senderUserId, currentUserId);
  assert.equal(encryptedInput.senderDeviceId, currentDeviceId);
  assert.equal(encryptedInput.participantUserId, participantId);
  assert.equal(encryptedInput.text, "hola privado");
  assert.match(encryptedInput.clientMessageId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(sent, {
    conversationIdValue: conversationId,
    request: { encrypted: true },
  });
  controller.close();
}

async function checkNoReceiptBeforeAuthenticatedDecrypt(Controller) {
  let receiptCalled = false;
  const api = {
    async list() {
      return {
        items: [encryptedTextMessage(() => "SENT")()],
        nextAfterSequence: "1",
      };
    },
    async updateReceipt() {
      receiptCalled = true;
    },
  };
  const crypto = {
    async decrypt() {
      throw new Error("AUTHENTICATION_FAILED");
    },
  };
  const controller = new Controller(api, crypto, currentUserId, currentDeviceId);
  await assert.rejects(controller.load(conversation()), /AUTHENTICATION_FAILED/);
  assert.equal(receiptCalled, false);
  controller.close();
}

async function checkExpiryDuringDownload(Controller, clock) {
  await withImageGlobals(async ({ createdUrls }) => {
    const started = Promise.withResolvers();
    globalThis.fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        started.resolve();
      });
    const controller = imageController(Controller, Date.now() + 40);

    try {
      const rejected = assert.rejects(
        controller.load(conversation()),
        (error) => error?.code === "MESSAGE_EXPIRED",
      );
      await expectStageBeforeCompletion(started.promise, rejected, "download");
      clock.tick(40);
      await rejected;

      assert.equal(createdUrls.length, 0);
      assert.equal(controller.objectUrls.size, 0);
      assert.equal(controller.decryptedMessages.size, 0);
    } finally {
      controller.close();
    }
  });
}

async function checkExpiryDuringDecrypt(Controller, clock) {
  await withImageGlobals(async ({ createdUrls }) => {
    globalThis.fetch = async () => exactImageResponse();
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    let decryptedBytes;
    globalThis.__sinochatDecryptAttachmentHook = async () => {
      decryptedBytes = new Uint8Array([137, 80, 78, 71]);
      started.resolve();
      await release.promise;
      return { bytes: decryptedBytes, mimeType: "image/png" };
    };
    const controller = imageController(Controller, Date.now() + 35);

    try {
      const rejected = assert.rejects(
        controller.load(conversation()),
        (error) => error?.code === "MESSAGE_EXPIRED",
      );
      // Advance only once decryption is in progress. A busy machine must not
      // turn this into the different case of expiry before the decrypt hook.
      await expectStageBeforeCompletion(started.promise, rejected, "decrypt");
      clock.tick(34);
      assert.deepEqual(decryptedBytes, new Uint8Array([137, 80, 78, 71]));
      assert.equal(createdUrls.length, 0);
      clock.tick(1);
      release.resolve();
      await rejected;

      assert.equal(createdUrls.length, 0);
      assert.ok(decryptedBytes.every((byte) => byte === 0));
      assert.ok(
        globalThis.__sinochatDownloadedCiphertext.every((byte) => byte === 0),
        "el buffer cifrado descargado debe limpiarse aunque venza durante decrypt",
      );
      assert.equal(controller.objectUrls.size, 0);
      assert.equal(controller.decryptedMessages.size, 0);
    } finally {
      release.resolve();
      controller.close();
    }
  });
}

async function checkAutomaticObjectUrlRevocation(Controller, clock) {
  await withImageGlobals(async ({ createdUrls, revokedUrls }) => {
    globalThis.fetch = async () => exactImageResponse();
    const controller = imageController(Controller, Date.now() + 120);

    const loaded = await controller.load(conversation());

    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0].kind, "image");
    assert.equal(createdUrls.length, 1);
    assert.ok(
      globalThis.__sinochatDownloadedCiphertext.every((byte) => byte === 0),
      "el buffer cifrado descargado debe limpiarse despues del exito",
    );
    clock.tick(119);
    assert.equal(revokedUrls.length, 0, "la imagen no vence antes del plazo");
    assert.equal(controller.objectUrls.size, 1);
    clock.tick(1);
    assert.deepEqual(revokedUrls, createdUrls, "la imagen vence al cumplir el plazo");
    assert.equal(controller.objectUrls.size, 0);
    assert.equal(controller.decryptedMessages.size, 0);
    assert.equal(controller.authenticatedMessages.size, 0);
    assert.equal(controller.authenticatedKeysByMessageId.size, 0);
    assert.equal(controller.messageExpiryTimers.size, 0);
    controller.close();
  });
}

async function checkCloseWithExternalSignal(Controller) {
  await withImageGlobals(async ({ createdUrls }) => {
    globalThis.fetch = async () => exactImageResponse();
    let releaseDecrypt;
    let decryptStarted;
    const started = new Promise((resolve) => {
      decryptStarted = resolve;
    });
    globalThis.__sinochatDecryptAttachmentHook = async () => {
      decryptStarted();
      await new Promise((resolve) => {
        releaseDecrypt = resolve;
      });
      return {
        bytes: new Uint8Array([137, 80, 78, 71]),
        mimeType: "image/png",
      };
    };
    const controller = imageController(Controller, Date.now() + 5_000);
    const external = new AbortController();
    const loading = controller.load(conversation(), external.signal);
    await started;

    controller.close();
    releaseDecrypt();
    await assert.rejects(loading, (error) => error?.name === "AbortError");

    assert.equal(external.signal.aborted, false);
    assert.equal(createdUrls.length, 0);
    assert.equal(controller.objectUrls.size, 0);
    assert.equal(controller.decryptedMessages.size, 0);
    assert.equal(controller.authenticatedMessages.size, 0);
    assert.equal(controller.authenticatedKeysByMessageId.size, 0);
    assert.equal(controller.messageExpiryTimers.size, 0);
    assert.ok(
      globalThis.__sinochatDownloadedCiphertext.every((byte) => byte === 0),
    );
  });
}

async function checkAuthenticatedReplayAndRewrite(Controller) {
  const expiresAtMs = Date.now() + 5_000;
  const original = {
    ...encryptedTextMessage(() => "READ")(),
    createdAt: new Date(expiresAtMs - 48 * 60 * 60 * 1_000).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
  let current = original;
  const api = {
    async list() {
      return { items: [current], nextAfterSequence: current.serverSequence };
    },
    async updateReceipt() {},
  };
  const crypto = {
    async decrypt() {
      return {
        protocolVersion: "matrix-megolm-v1",
        conversationId,
        roomId,
        clientMessageId,
        senderUserId: participantId,
        senderDeviceId: participantDeviceId,
        kind: "TEXT",
        text: "mensaje autenticado",
      };
    },
  };
  const controller = new Controller(api, crypto, currentUserId, currentDeviceId);
  await controller.load(conversation());

  const forgedExpiry = Date.now() - 100;
  current = {
    ...original,
    createdAt: new Date(
      forgedExpiry - 48 * 60 * 60 * 1_000,
    ).toISOString(),
    expiresAt: new Date(forgedExpiry).toISOString(),
  };
  const hiddenByForgedExpiry = await controller.load(conversation());
  assert.equal(hiddenByForgedExpiry.messages.length, 0);
  assert.equal(
    controller.authenticatedMessages.size,
    1,
    "una fecha exterior reescrita no debe borrar el tombstone anti-replay",
  );

  current = {
    ...original,
    id: "88888888-8888-4888-8888-888888888888",
    serverSequence: "2",
  };
  await assert.rejects(
    controller.load(conversation()),
    (error) => error?.code === "MESSAGE_REPLAY_OR_REWRITE_DETECTED",
  );

  current = {
    ...original,
    envelope: { ...original.envelope, ciphertext: "ciphertext-reescrito" },
  };
  await assert.rejects(
    controller.load(conversation()),
    (error) => error?.code === "MESSAGE_REPLAY_OR_REWRITE_DETECTED",
  );

  current = original;
  await assert.rejects(
    controller.load({
      ...conversation(),
      id: "99999999-9999-4999-8999-999999999999",
    }),
    (error) => error?.code === "MESSAGE_REPLAY_OR_REWRITE_DETECTED",
  );

  assert.equal(controller.authenticatedMessages.size, 1);
  assert.equal(controller.authenticatedKeysByMessageId.size, 1);
  assert.equal(controller.messageExpiryTimers.size, 1);
  controller.close();
  assert.equal(controller.authenticatedMessages.size, 0);
  assert.equal(controller.authenticatedKeysByMessageId.size, 0);
  assert.equal(controller.messageExpiryTimers.size, 0);
}

function imageController(Controller, expiresAtMs) {
  const encrypted = encryptedImageMessage(expiresAtMs);
  const api = {
    async list() {
      return { items: [encrypted], nextAfterSequence: "1" };
    },
    async updateReceipt() {},
  };
  const crypto = {
    async decrypt() {
      return {
        protocolVersion: "matrix-megolm-v1",
        conversationId,
        roomId,
        clientMessageId,
        senderUserId: participantId,
        senderDeviceId: participantDeviceId,
        kind: "IMAGE",
        image: { mediaEncryptionInfo: { v: "v2" } },
      };
    },
  };
  return new Controller(api, crypto, currentUserId, currentDeviceId);
}

function encryptedImageMessage(expiresAtMs) {
  return {
    ...encryptedTextMessage(() => "READ")(),
    kind: "IMAGE",
    createdAt: new Date(expiresAtMs - 48 * 60 * 60 * 1_000).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    attachment: {
      declaredMimeType: "image/png",
      plaintextByteSize: 4,
      ciphertextByteSize: 4,
      ciphertextSha256: "a".repeat(64),
      cipherSuite: "A256CTR",
      downloadUrl: "https://storage.example.invalid/encrypted-image",
    },
  };
}

function exactImageResponse() {
  return new Response(new Uint8Array([1, 2, 3, 4]), {
    status: 200,
    headers: { "content-length": "4" },
  });
}

async function withImageGlobals(operation) {
  const originalFetch = globalThis.fetch;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const createdUrls = [];
  const revokedUrls = [];
  URL.createObjectURL = () => {
    const value = `blob:sinochat-test-${createdUrls.length + 1}`;
    createdUrls.push(value);
    return value;
  };
  URL.revokeObjectURL = (value) => {
    revokedUrls.push(value);
  };
  delete globalThis.__sinochatDownloadedCiphertext;
  delete globalThis.__sinochatDecryptAttachmentHook;
  try {
    await operation({ createdUrls, revokedUrls });
  } finally {
    globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    delete globalThis.__sinochatDownloadedCiphertext;
    delete globalThis.__sinochatDecryptAttachmentHook;
  }
}

async function withControlledClock(operation) {
  // Date and timeout callbacks share one clock; no assertion depends on CPU
  // scheduling, the calendar date, or a 35 ms wall-clock race.
  mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: new Date("2026-09-16T12:00:00Z"),
  });
  try {
    await operation(mock.timers);
  } finally {
    mock.timers.reset();
  }
}

async function expectStageBeforeCompletion(started, completed, stage) {
  await Promise.race([
    started,
    completed.then(() => {
      throw new Error(`EXPECTED_${stage.toUpperCase()}_BEFORE_COMPLETION`);
    }),
  ]);
}

function conversation() {
  return {
    id: conversationId,
    participant: {
      id: participantId,
      username: "cajero",
      presence: "offline",
    },
    messages: [],
    unreadCount: 1,
  };
}

function encryptedTextMessage(status) {
  const expiresAtMs = Date.now() + 5_000;
  return () => ({
    id: messageId,
    senderUserId: participantId,
    senderDeviceId: participantDeviceId,
    clientMessageId,
    serverSequence: "1",
    kind: "TEXT",
    createdAt: new Date(expiresAtMs - 48 * 60 * 60 * 1_000).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    envelope: {
      protocolVersion: "matrix-megolm-v1",
      cipherSuite: "m.megolm.v1.aes-sha2",
      ciphertext: "ciphertext-estable",
    },
    attachment: null,
    receipts: [
      {
        recipientUserId: currentUserId,
        status: status(),
        deliveredAt: null,
        readAt: null,
      },
    ],
  });
}
