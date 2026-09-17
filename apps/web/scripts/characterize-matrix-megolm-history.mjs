import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { assertTemporaryChild, findBrowserExecutable, unusedLoopbackPort } from "./browser-test-environment.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const virtualModuleId = "virtual:sinochat-megolm-history-characterization";
const resolvedVirtualModuleId = `\0${virtualModuleId}`;
const resultPrefix = "SINOCHAT_MEGOLM_RESULT_";
const errorPrefix = "SINOCHAT_MEGOLM_ERROR_";
const chromePath = findBrowserExecutable();
const browserProfile = mkdtempSync(join(tmpdir(), "sinochat-megolm-"));
const matrixWasm = readFileSync(
  resolve(
    webRoot,
    "..",
    "..",
    "node_modules",
    "@matrix-org",
    "matrix-sdk-crypto-wasm",
    "pkg",
    "matrix_sdk_crypto_wasm_bg.wasm",
  ),
);

const server = await createServer({
  root: webRoot,
  configFile: false,
  envDir: false,
  cacheDir: join(browserProfile, "vite-cache"),
  logLevel: "error",
  server: { host: "127.0.0.1", port: await unusedLoopbackPort(), strictPort: true },
  plugins: [
    {
      name: "sinochat-megolm-history-characterization",
      resolveId(id) {
        return id === virtualModuleId ? resolvedVirtualModuleId : null;
      },
      load(id) {
        return id === resolvedVirtualModuleId
          ? getBrowserCharacterization()
          : null;
      },
      configureServer(viteServer) {
        viteServer.middlewares.use((request, response, next) => {
          if (request.url === "/__sinochat_matrix_crypto.wasm") {
            response.statusCode = 200;
            response.setHeader("Content-Type", "application/wasm");
            response.end(matrixWasm);
            return;
          }
          if (request.url !== "/__sinochat_megolm_characterization__") {
            next();
            return;
          }
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(
            `<!doctype html><html><head><title>SINOCHAT_MEGOLM_PENDING</title></head><body><script type="module" src="/@id/${virtualModuleId}"></script></body></html>`,
          );
        });
      },
    },
  ],
});

try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("VITE_CHARACTERIZATION_ADDRESS_UNAVAILABLE");
  }
  const url = `http://127.0.0.1:${address.port}/__sinochat_megolm_characterization__`;
  const browser = await runChrome(chromePath, browserProfile, url);
  const encodedResult = extractTitle(browser.title, resultPrefix);
  const encodedError = extractTitle(browser.title, errorPrefix);
  if (encodedError) {
    throw new Error(decodeBase64Url(encodedError));
  }
  if (!encodedResult) {
    throw new Error(
      `CHROME_CHARACTERIZATION_DID_NOT_FINISH\n${browser.stderr.trim()}\ntitle=${browser.title}`,
    );
  }
  const result = JSON.parse(decodeBase64Url(encodedResult));
  console.log(JSON.stringify(result, null, 2));
  assertCharacterizationResult(result);
  console.log(
    "[OK] Megolm permite historial repetible y persistente. El room queda vinculado; sender/device/sender_key exteriores son mutables y deben compararse con bindings autenticados dentro del plaintext.",
  );
} finally {
  await server.close();
  const resolvedProfile = resolve(browserProfile);
  assertTemporaryChild(tmpdir(), resolvedProfile, "sinochat-megolm-");
  rmSync(resolvedProfile, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}

function runChrome(executable, profile, url) {
  return new Promise((resolveRun, rejectRun) => {
    let settled = false;
    let stderr = "";
    const child = spawn(
      executable,
      [
        "--headless=new",
        "--disable-gpu",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-extensions",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-allow-origins=*",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        url,
      ],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match || settled) return;
      settled = true;
      inspectPage(match[1], url).then(
        async (title) => {
          await stopChild(child);
          resolveRun({ title, stderr });
        },
        async (error) => {
          await stopChild(child);
          rejectRun(error);
        },
      );
    });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (!settled && code !== 0) {
        settled = true;
        rejectRun(new Error(`CHROME_EXIT_${code}\n${stderr.trim()}`));
      }
    });
  });
}

function stopChild(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveStop) => {
    child.once("close", resolveStop);
    child.kill();
  });
}

async function inspectPage(browserWebSocketUrl, expectedUrl) {
  const endpoint = new URL(browserWebSocketUrl);
  const origin = `http://${endpoint.host}`;
  const deadline = Date.now() + 90_000;
  let pageWebSocketUrl;
  while (Date.now() < deadline) {
    const targets = await fetch(`${origin}/json/list`).then((response) =>
      response.json(),
    );
    pageWebSocketUrl = targets.find(
      (target) => target.type === "page" && target.url === expectedUrl,
    )?.webSocketDebuggerUrl;
    if (pageWebSocketUrl) break;
    await delay(50);
  }
  if (!pageWebSocketUrl) throw new Error("CHROME_PAGE_TARGET_NOT_FOUND");

  const socket = new WebSocket(pageWebSocketUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });
  let commandId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const promise = pending.get(message.id);
    if (!promise) return;
    pending.delete(message.id);
    if (message.error) promise.reject(new Error(message.error.message));
    else promise.resolve(message.result);
  });
  const command = (method, params = {}) =>
    new Promise((resolveCommand, rejectCommand) => {
      const id = ++commandId;
      pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
      socket.send(JSON.stringify({ id, method, params }));
    });
  try {
    await command("Runtime.enable");
    while (Date.now() < deadline) {
      const evaluation = await command("Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      });
      const title = evaluation.result.value;
      if (
        title.startsWith(resultPrefix) ||
        title.startsWith(errorPrefix)
      ) {
        return title;
      }
      await delay(50);
    }
    throw new Error("CHROME_CHARACTERIZATION_TIMEOUT");
  } finally {
    socket.close();
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function extractTitle(title, prefix) {
  return title.startsWith(prefix) ? title.slice(prefix.length) : undefined;
}

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function assertCharacterizationResult(result) {
  const expected = {
    sdkVersion: "18.6.0",
    algorithm: "m.megolm.v1.aes-sha2",
    repeatedDecryption: true,
    persistedAfterStoreReopen: true,
    senderCanDecryptOwnEvent: true,
    senderMismatchRejected: false,
    deviceMismatchRejected: false,
    senderKeyMismatchRejected: false,
    wrongRoomRejected: true,
    eventMetadataMismatchRejected: false,
    ciphertextMutationRejected: true,
    sessionIdMismatchRejected: true,
    algorithmMismatchRejected: true,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (result[key] !== value) {
      throw new Error(`UNEXPECTED_${key}: ${JSON.stringify(result[key])}`);
    }
  }
  const expectedFields = [
    "algorithm",
    "ciphertext",
    "device_id",
    "sender_key",
    "session_id",
  ];
  if (JSON.stringify(result.outerFields) !== JSON.stringify(expectedFields)) {
    throw new Error(`UNEXPECTED_OUTER_FIELDS: ${JSON.stringify(result.outerFields)}`);
  }
  if (
    result.roomKeyTransport !== "m.olm.v1.curve25519-aes-sha2" ||
    result.mutationEvidence.sender.sender !==
      "@u22222222222242228222222222222222:sinochat.invalid" ||
    result.mutationEvidence.sender.senderDevice !== null ||
    result.mutationEvidence.deviceId.senderDevice !==
      "D11111111111141118111111111111111" ||
    result.mutationEvidence.senderKey.senderCurve25519Key !==
      result.decryptedSenderCurve25519Key ||
    result.mutationEvidence.eventMetadata.eventId !==
      "$m99999999999949998999999999999999:sinochat.invalid" ||
    result.mutationEvidence.eventMetadata.originServerTs !== 9_999_999_999_999
  ) {
    throw new Error("UNEXPECTED_MEGOLM_BINDING_EVIDENCE");
  }
}

function getBrowserCharacterization() {
  return String.raw`
import {
  CollectStrategy,
  DecryptionSettings,
  DeviceId,
  DeviceLists,
  EncryptionAlgorithm,
  EncryptionSettings,
  HistoryVisibility,
  OlmMachine,
  RequestType,
  RoomId,
  TrustRequirement,
  UserId,
  initAsync,
} from "@matrix-org/matrix-sdk-crypto-wasm";

const senderIdentity = {
  userId: "@u11111111111141118111111111111111:sinochat.invalid",
  deviceId: "D11111111111141118111111111111111",
};
const recipientIdentity = {
  userId: "@u22222222222242228222222222222222:sinochat.invalid",
  deviceId: "D22222222222242228222222222222222",
};
const roomIdValue = "!c33333333333343338333333333333333:sinochat.invalid";
const otherRoomIdValue = "!c44444444444444448444444444444444:sinochat.invalid";
const runId = crypto.randomUUID();
const senderStore = "sinochat-megolm-sender-" + runId;
const recipientStore = "sinochat-megolm-recipient-" + runId;
const passphrase = "SinoChat isolated characterization only";

try {
  finish("${resultPrefix}", await run());
} catch (error) {
  finish("${errorPrefix}", {
    name: error?.name,
    message: error?.message ?? String(error),
    stack: error?.stack,
    code: error?.code,
    description: error?.description,
  });
}

async function run() {
  await initAsync("/__sinochat_matrix_crypto.wasm");
  let sender = await createMachine(senderIdentity, senderStore);
  let recipient = await createMachine(recipientIdentity, recipientStore);
  try {
    const senderUpload = await completeInitialUpload(sender);
    const recipientUpload = await completeInitialUpload(recipient);
    await teachDevice(sender, recipientIdentity, recipientUpload.device_keys);
    await teachDevice(recipient, senderIdentity, senderUpload.device_keys);
    await establishOutboundSession(
      sender,
      recipientIdentity,
      recipientUpload.one_time_keys,
    );

    const roomKeyRequest = await shareRoomKey(
      sender,
      roomIdValue,
      [senderIdentity.userId, recipientIdentity.userId],
    );
    const roomKeyContent = extractToDeviceContent(
      roomKeyRequest,
      recipientIdentity,
    );
    equal(roomKeyRequest.event_type, "m.room.encrypted", "room key event type");
    equal(roomKeyContent.algorithm, "m.olm.v1.curve25519-aes-sha2", "room key Olm suite");
    await receiveToDevice(recipient, senderIdentity.userId, roomKeyRequest.event_type, roomKeyContent);
    await sender.markRequestAsSent(
      roomKeyRequest.id,
      roomKeyRequest.type,
      JSON.stringify({}),
    );
    roomKeyRequest.free();

    const roomId = new RoomId(roomIdValue);
    let encryptedContent;
    try {
      encryptedContent = JSON.parse(
        await sender.encryptRoomEvent(
          roomId,
          "com.sinochat.message.v1",
          JSON.stringify({
            version: 1,
            conversationId: "33333333-3333-4333-8333-333333333333",
            clientMessageId: "55555555-5555-4555-8555-555555555555",
            senderUserId: senderIdentity.userId,
            senderDeviceId: senderIdentity.deviceId,
            roomId: roomIdValue,
            kind: "TEXT",
            text: "historial Megolm de caracterizacion",
          }),
        ),
      );
    } finally {
      roomId.free();
    }
    deepEqual(Object.keys(encryptedContent).sort(), [
      "algorithm",
      "ciphertext",
      "device_id",
      "sender_key",
      "session_id",
    ], "outer Megolm fields");
    equal(encryptedContent.algorithm, "m.megolm.v1.aes-sha2", "Megolm suite");
    equal(encryptedContent.device_id, senderIdentity.deviceId, "outer sender device");
    equal(
      encryptedContent.sender_key,
      senderUpload.device_keys.keys["curve25519:" + senderIdentity.deviceId],
      "outer sender Curve25519 key",
    );

    const event = makeRoomEvent(senderIdentity.userId, encryptedContent, {
      eventId: "$m55555555555545558555555555555555:sinochat.invalid",
      timestamp: 1_786_000_000_000,
    });
    const first = await decrypt(recipient, event, roomIdValue);
    const second = await decrypt(recipient, event, roomIdValue);
    characterizePlaintext(first, senderUpload);
    characterizePlaintext(second, senderUpload);

    const own = await decrypt(sender, event, roomIdValue);
    characterizePlaintext(own, senderUpload);

    const senderMutation = await probeDecrypt(
      recipient,
      { ...event, sender: recipientIdentity.userId },
      roomIdValue,
    );
    const deviceMutation = await probeDecrypt(
      recipient,
      { ...event, content: { ...event.content, device_id: recipientIdentity.deviceId } },
      roomIdValue,
    );
    const senderKeyMutation = await probeDecrypt(
      recipient,
      { ...event, content: { ...event.content, sender_key: "A".repeat(43) } },
      roomIdValue,
    );
    const wrongRoom = await probeDecrypt(
      recipient,
      event,
      otherRoomIdValue,
    );
    const metadataMutation = await probeDecrypt(
      recipient,
      {
        ...event,
        event_id: "$m99999999999949998999999999999999:sinochat.invalid",
        origin_server_ts: 9_999_999_999_999,
      },
      roomIdValue,
    );
    const ciphertextMutation = await probeDecrypt(
      recipient,
      {
        ...event,
        content: {
          ...event.content,
          ciphertext: mutateFirstCharacter(event.content.ciphertext),
        },
      },
      roomIdValue,
    );
    const sessionIdMutation = await probeDecrypt(
      recipient,
      {
        ...event,
        content: {
          ...event.content,
          session_id: "A".repeat(event.content.session_id.length),
        },
      },
      roomIdValue,
    );
    const algorithmMutation = await probeDecrypt(
      recipient,
      {
        ...event,
        content: {
          ...event.content,
          algorithm: "m.olm.v1.curve25519-aes-sha2",
        },
      },
      roomIdValue,
    );

    recipient.close();
    recipient = null;
    recipient = await createMachine(recipientIdentity, recipientStore);
    const afterReopen = await decrypt(recipient, event, roomIdValue);
    characterizePlaintext(afterReopen, senderUpload);

    sender.close();
    sender = null;
    sender = await createMachine(senderIdentity, senderStore);
    const ownAfterReopen = await decrypt(sender, event, roomIdValue);
    characterizePlaintext(ownAfterReopen, senderUpload);

    return {
      sdkVersion: "18.6.0",
      algorithm: encryptedContent.algorithm,
      outerFields: Object.keys(encryptedContent).sort(),
      roomKeyTransport: roomKeyContent.algorithm,
      repeatedDecryption: second.content.clientMessageId === first.content.clientMessageId,
      persistedAfterStoreReopen:
        afterReopen.content.clientMessageId === first.content.clientMessageId,
      senderCanDecryptOwnEvent:
        own.content.clientMessageId === first.content.clientMessageId &&
        ownAfterReopen.content.clientMessageId === first.content.clientMessageId,
      senderMismatchRejected: senderMutation.rejected,
      deviceMismatchRejected: deviceMutation.rejected,
      senderKeyMismatchRejected: senderKeyMutation.rejected,
      wrongRoomRejected: wrongRoom.rejected,
      eventMetadataMismatchRejected: metadataMutation.rejected,
      ciphertextMutationRejected: ciphertextMutation.rejected,
      sessionIdMismatchRejected: sessionIdMutation.rejected,
      algorithmMismatchRejected: algorithmMutation.rejected,
      mutationEvidence: {
        sender: senderMutation,
        deviceId: deviceMutation,
        senderKey: senderKeyMutation,
        roomId: wrongRoom,
        eventMetadata: metadataMutation,
        ciphertext: ciphertextMutation,
        sessionId: sessionIdMutation,
        algorithm: algorithmMutation,
      },
      decryptedSender: first.sender,
      decryptedSenderDevice: first.senderDevice,
      decryptedSenderCurve25519Key: first.senderCurve25519Key,
      authenticatedApplicationBindings: {
        senderUserId: first.content.senderUserId,
        senderDeviceId: first.content.senderDeviceId,
        roomId: first.content.roomId,
        conversationId: first.content.conversationId,
        clientMessageId: first.content.clientMessageId,
      },
    };
  } finally {
    sender?.close();
    recipient?.close();
    await deleteDatabase(senderStore);
    await deleteDatabase(recipientStore);
  }
}

async function createMachine(identity, storeName) {
  const userId = new UserId(identity.userId);
  const deviceId = new DeviceId(identity.deviceId);
  try {
    return await OlmMachine.initialize(userId, deviceId, storeName, passphrase);
  } finally {
    userId.free();
    deviceId.free();
  }
}

async function completeInitialUpload(machine) {
  const requests = await machine.outgoingRequests();
  try {
    const upload = requests.find((request) => request.type === RequestType.KeysUpload);
    ok(upload, "initial keys upload");
    const body = JSON.parse(upload.body);
    await machine.markRequestAsSent(
      upload.id,
      upload.type,
      JSON.stringify({
        one_time_key_counts: {
          signed_curve25519: Object.keys(body.one_time_keys ?? {}).length,
        },
      }),
    );
    return body;
  } finally {
    for (const request of requests) request.free();
  }
}

async function teachDevice(machine, identity, deviceKeys) {
  const userId = new UserId(identity.userId);
  try {
    await machine.updateTrackedUsers([userId]);
  } catch (error) {
    userId.free();
    throw error;
  }
  const requests = await machine.outgoingRequests();
  try {
    const query = requests.find((request) => request.type === RequestType.KeysQuery);
    ok(query, "keys/query for tracked user");
    await machine.markRequestAsSent(
      query.id,
      query.type,
      JSON.stringify({
        device_keys: { [identity.userId]: { [identity.deviceId]: deviceKeys } },
        failures: {},
        master_keys: {},
        self_signing_keys: {},
        user_signing_keys: {},
      }),
    );
  } finally {
    for (const request of requests) request.free();
  }
}

async function establishOutboundSession(machine, identity, oneTimeKeys) {
  const userId = new UserId(identity.userId);
  let claim;
  try {
    claim = await machine.getMissingSessions([userId]);
  } catch (error) {
    userId.free();
    throw error;
  }
  ok(claim, "keys/claim before sharing room key");
  try {
    const requestedAlgorithm =
      JSON.parse(claim.body).one_time_keys[identity.userId][identity.deviceId];
    const oneTimeKeyEntry = Object.entries(oneTimeKeys).find(([keyId]) =>
      keyId.startsWith(requestedAlgorithm + ":"),
    );
    ok(oneTimeKeyEntry, "recipient signed one-time key");
    await machine.markRequestAsSent(
      claim.id,
      claim.type,
      JSON.stringify({
        failures: {},
        one_time_keys: {
          [identity.userId]: {
            [identity.deviceId]: { [oneTimeKeyEntry[0]]: oneTimeKeyEntry[1] },
          },
        },
      }),
    );
  } finally {
    claim.free();
  }
}

async function shareRoomKey(machine, roomIdValue, memberIds) {
  const roomId = new RoomId(roomIdValue);
  const users = memberIds.map((memberId) => new UserId(memberId));
  const settings = new EncryptionSettings();
  settings.algorithm = EncryptionAlgorithm.MegolmV1AesSha2;
  settings.historyVisibility = HistoryVisibility.Joined;
  settings.rotationPeriodMessages = 100n;
  settings.rotationPeriod = 48n * 60n * 60n * 1_000_000n;
  settings.sharingStrategy = CollectStrategy.allDevices();
  try {
    const requests = await machine.shareRoomKey(roomId, users, settings);
    equal(requests.length, 1, "one room-key to-device request");
    return requests[0];
  } finally {
    roomId.free();
    settings.free();
  }
}

function extractToDeviceContent(request, identity) {
  const body = JSON.parse(request.body);
  return body.messages[identity.userId][identity.deviceId];
}

async function receiveToDevice(machine, sender, type, content) {
  const deviceLists = new DeviceLists([], []);
  try {
    const events = await machine.receiveSyncChanges(
      JSON.stringify([{ type, sender, content }]),
      deviceLists,
      new Map(),
      new Set(),
    );
    for (const event of events) event.free();
  } finally {
    deviceLists.free();
  }
}

function makeRoomEvent(sender, content, metadata) {
  return {
    type: "m.room.encrypted",
    sender,
    content,
    event_id: metadata.eventId,
    origin_server_ts: metadata.timestamp,
  };
}

async function decrypt(machine, event, roomIdValue) {
  const roomId = new RoomId(roomIdValue);
  const settings = new DecryptionSettings(TrustRequirement.Untrusted);
  let decrypted;
  try {
    decrypted = await machine.decryptRoomEvent(JSON.stringify(event), roomId, settings);
    const eventJson = JSON.parse(decrypted.event);
    const sender = decrypted.sender.toString();
    const senderDevice = decrypted.senderDevice?.toString();
    return {
      event: eventJson,
      content: eventJson.content,
      sender,
      senderDevice,
      senderCurve25519Key: decrypted.senderCurve25519Key,
      senderClaimedEd25519Key: decrypted.senderClaimedEd25519Key,
    };
  } finally {
    decrypted?.free();
    settings.free();
    roomId.free();
  }
}

async function rejectsDecrypt(machine, event, roomIdValue) {
  return (await probeDecrypt(machine, event, roomIdValue)).rejected;
}

async function probeDecrypt(machine, event, roomIdValue) {
  try {
    const value = await decrypt(machine, event, roomIdValue);
    return {
      rejected: false,
      sender: value.sender,
      senderDevice: value.senderDevice ?? null,
      senderCurve25519Key: value.senderCurve25519Key,
      innerSenderUserId: value.content.senderUserId,
      innerSenderDeviceId: value.content.senderDeviceId,
      innerRoomId: value.content.roomId,
      eventId: value.event.event_id,
      originServerTs: value.event.origin_server_ts,
    };
  } catch (error) {
    return {
      rejected: true,
      errorName: error?.name,
      errorCode: error?.code,
      errorDescription: error?.description ?? error?.message ?? String(error),
    };
  }
}

function mutateFirstCharacter(value) {
  return (value.startsWith("A") ? "B" : "A") + value.slice(1);
}

function characterizePlaintext(decrypted, senderUpload) {
  equal(decrypted.event.type, "com.sinochat.message.v1", "decrypted event type");
  equal(decrypted.sender, senderIdentity.userId, "authenticated sender");
  equal(decrypted.senderDevice, senderIdentity.deviceId, "authenticated device");
  equal(
    decrypted.senderCurve25519Key,
    senderUpload.device_keys.keys["curve25519:" + senderIdentity.deviceId],
    "authenticated Curve25519 key",
  );
  equal(decrypted.content.senderUserId, senderIdentity.userId, "inner sender binding");
  equal(decrypted.content.senderDeviceId, senderIdentity.deviceId, "inner device binding");
  equal(decrypted.content.roomId, roomIdValue, "inner room binding");
}

function deleteDatabase(name) {
  return new Promise((resolveDelete, rejectDelete) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolveDelete();
    request.onerror = () => rejectDelete(request.error);
    request.onblocked = () => rejectDelete(new Error("INDEXEDDB_DELETE_BLOCKED"));
  });
}

function ok(value, label) {
  if (!value) throw new Error("ASSERTION_FAILED: " + label);
}

function equal(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      "ASSERTION_FAILED: " + label + "; actual=" +
      JSON.stringify(actual) + "; expected=" + JSON.stringify(expected),
    );
  }
}

function deepEqual(actual, expected, label) {
  equal(JSON.stringify(actual), JSON.stringify(expected), label);
}

function finish(prefix, value) {
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(value))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  document.title = prefix + encoded;
  document.body.textContent = JSON.stringify(value, null, 2);
}
`;
}
