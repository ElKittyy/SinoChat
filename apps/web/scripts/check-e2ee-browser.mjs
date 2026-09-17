import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { createMatrixBrowserRelay } from "./fixtures/matrix-browser-relay.mjs";
import { assertTemporaryChild, findBrowserExecutable, unusedLoopbackPort } from "./browser-test-environment.mjs";

// Criptografía y almacenamiento de navegador reales; transporte HTTP de prueba.
// No importa .env, no conecta con la API/DB y no cambia el gate del producto.
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "../..");
const relay = createMatrixBrowserRelay();
const cache = await mkdtemp(join(tmpdir(), "sinochat-e2ee-browser-"));
const browserErrors = [];
const wireBodies = [];
let server;
let browser;
let watchdog;
let failNextSendActor;
let injectedSendFailures = 0;
let attachmentBytes;

try {
  const matrixWasm = await readFile(resolve(repoRoot,
    "node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm_bg.wasm"));
  server = await createServer({
    root: webRoot, configFile: false, envDir: false, cacheDir: cache, logLevel: "error",
    resolve: { alias: { "@sinochat/contracts": resolve(repoRoot, "packages/contracts/src/index.ts") } },
    optimizeDeps: { noDiscovery: true, include: ["@matrix-org/matrix-sdk-crypto-wasm", "react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] },
    server: { host: "127.0.0.1", port: await unusedLoopbackPort(), strictPort: true },
    plugins: [{
      name: "sinochat-isolated-e2ee-browser-check",
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url === "/__sinochat_matrix_crypto.wasm") {
            response.setHeader("Content-Type", "application/wasm");
            response.end(matrixWasm);
          } else if (request.url === "/__sinochat_e2ee_browser__") {
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.setHeader("Cache-Control", "no-store");
            response.end('<!doctype html><html lang="es"><title>Prueba aislada SinoChat</title><script type="module" src="/scripts/fixtures/matrix-browser-client.mjs"></script></html>');
          } else if (request.url === "/synthetic-encrypted-image" && attachmentBytes) {
            response.setHeader("Content-Type", "application/octet-stream");
            response.setHeader("Content-Length", String(attachmentBytes.length));
            response.setHeader("Cache-Control", "private, no-store, max-age=0");
            response.end(attachmentBytes);
          } else if (request.url?.startsWith("/__sinochat_e2ee_api/")) {
            void handleRelay(request, response);
          } else next();
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: findBrowserExecutable(), headless: true, timeout: 30_000 });
  watchdog = setTimeout(() => { void browser.close(); }, 180_000);
  const clients = {};
  for (const actor of ["sender", "recipient", "outsider"]) {
    const context = await browser.newContext({ baseURL: origin, serviceWorkers: "block" });
    await context.clock.install({ time: new Date() });
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).origin !== origin) {
        browserErrors.push("UNEXPECTED_NON_FIXTURE_NETWORK_REQUEST");
        return route.abort();
      }
      return route.continue();
    });
    const page = await openPage(context, origin);
    const input = {
      actor, sinochatUserId: randomUUID(), sinochatDeviceId: randomUUID(),
      serverName: "sinochat.invalid", storePassphrase: randomBytes(32).toString("base64url"),
    };
    await call(page, "start", input);
    clients[actor] = { context, page, input };
  }
  const { sender, recipient, outsider } = clients;
  // Los contextos comparten origen HTTP, pero no Web Locks ni IndexedDB/storage.
  await sender.page.evaluate(() => localStorage.setItem("fixture-isolation", "sender"));
  assert.equal(await recipient.page.evaluate(() => localStorage.getItem("fixture-isolation")), null);
  const secondTab = await openPage(sender.context, origin);
  assert.deepEqual(await call(secondTab, "probeLock", { userId: sender.input.sinochatUserId }),
    { acquired: false, codes: ["MATRIX_SESSION_ALREADY_OPEN"] });
  assert.deepEqual(await call(secondTab, "probeLock", { userId: randomUUID(), abortBefore: true }),
    { acquired: false, codes: ["AbortError"] });
  console.log("[OK] Contextos aislados y bloqueo real entre pestañas con AbortSignal.");

  const conversationId = randomUUID();
  const texts = ["Prueba privada: ñ, á, 中文 y 🔒\n<script>no ejecutar</script>", "Segundo mensaje independiente 🔑"];
  const inputs = texts.map((text) => ({
    conversationId, clientMessageId: randomUUID(), participantUserId: recipient.input.sinochatUserId, text,
  }));
  // Dos llamadas simultáneas ejercitan la cola real de la aplicación, no solo el SDK.
  const outbound = await sender.page.evaluate(async (items) => {
    try {
      return await Promise.all(items.map((item) => window.sinochatE2eeFixture.sendText(item)));
    } catch (error) {
      throw new Error(`${error.message}; causa: ${error.cause?.message}`);
    }
  }, inputs);
  for (const result of outbound) assertEnvelopes(result, sender, recipient);
  assert.notEqual(outer(outbound[0]).session_id, outer(outbound[1]).session_id);
  const first = delivery(outbound[0], sender.input.sinochatUserId, 1);
  const second = delivery(outbound[1], sender.input.sinochatUserId, 2);
  await rejectsDecrypt(recipient.page, conversationId, first, "MATRIX_MESSAGE_DECRYPT_FAILED");
  await call(recipient.page, "sync");
  assert.deepEqual(await call(recipient.page, "inspectDecryptedFields", { conversationId, message: first }), {
    fields: ["content", "event_id", "origin_server_ts", "room_id", "sender", "type", "unsigned"],
    room: `!c${conversationId.replaceAll("-", "")}:sinochat.invalid`, unsigned: {},
  });
  for (const [index, message] of [first, second].entries()) {
    for (const client of [sender, recipient]) {
      assert.equal((await call(client.page, "decrypt", { conversationId, message })).text, texts[index]);
    }
  }
  assert.equal((await call(recipient.page, "decrypt", { conversationId, message: first })).text, texts[0]);
  await rejectsDecrypt(outsider.page, conversationId, first, "MATRIX_MESSAGE_DECRYPT_FAILED");
  const replyText = "Respuesta cifrada del cajero al cliente.";
  const reply = await call(recipient.page, "sendText", {
    conversationId, clientMessageId: randomUUID(), participantUserId: sender.input.sinochatUserId, text: replyText,
  });
  assertEnvelopes(reply, sender, recipient);
  await call(sender.page, "sync");
  const replyMessage = delivery(reply, recipient.input.sinochatUserId, 3);
  assert.equal((await call(sender.page, "decrypt", { conversationId, message: replyMessage })).text, replyText);
  console.log("[OK] Texto bidireccional, envíos simultáneos, rotación por mensaje e historial propio; tercero sin acceso.");

  // Alteraciones estructuralmente válidas: deben fallar por criptografía/binding,
  // no por campos desconocidos ni por un Base64 inválido.
  await rejectsDecrypt(recipient.page, randomUUID(), first, "MATRIX_MESSAGE_DECRYPT_FAILED");
  await rejectsDecrypt(recipient.page, conversationId, { ...first, clientMessageId: randomUUID() },
    "SINOCHAT_MESSAGE_BINDING_MISMATCH");
  await rejectsDecrypt(recipient.page, conversationId, { ...first, senderUserId: recipient.input.sinochatUserId },
    "MATRIX_DECRYPTED_SENDER_BINDING_INVALID");
  await rejectsDecrypt(recipient.page, conversationId,
    mutateOuter(first, (content) => { content.sender_key = Buffer.alloc(32, 42).toString("base64").replace(/=+$/, ""); }),
    "MATRIX_DECRYPTED_SENDER_BINDING_INVALID");
  const wrongDevice = mutateOuter({ ...first, senderDeviceId: outsider.input.sinochatDeviceId }, (content) => {
    content.device_id = `D${outsider.input.sinochatDeviceId.replaceAll("-", "").toUpperCase()}`;
  });
  await rejectsDecrypt(recipient.page, conversationId, wrongDevice, "MATRIX_DECRYPTED_SENDER_BINDING_INVALID");
  await rejectsDecrypt(recipient.page, conversationId, mutateOuter(first, (content) => {
    const bytes = Buffer.from(content.ciphertext, "base64");
    bytes[Math.floor(bytes.length / 2)] ^= 1;
    content.ciphertext = bytes.toString("base64").replace(/=+$/, "");
  }), "MATRIX_MESSAGE_DECRYPT_FAILED");
  console.log("[OK] Rechazados texto cifrado alterado y cambios de conversación, remitente, dispositivo, clave e ID cliente.");

  const photo = await call(sender.page, "sendImage", {
    conversationId, clientMessageId: randomUUID(), participantUserId: recipient.input.sinochatUserId,
  });
  assertEnvelopes(photo.outbound, sender, recipient);
  assert.equal(photo.secretAbsentFromWire, true);
  attachmentBytes = Buffer.from(photo.blob, "base64");
  const imageMessage = delivery(photo.outbound, sender.input.sinochatUserId, 4, {
    ...photo.metadata, cipherSuite: "A256CTR", downloadUrl: `${origin}/synthetic-encrypted-image`,
  });
  await call(recipient.page, "sync");
  const receivedImage = await call(recipient.page, "receiveImage", { conversationId, message: imageMessage, blob: photo.blob });
  assert.deepEqual(receivedImage, { hash: photo.plaintextHash, width: 12, height: 9 });
  const badImage = await call(recipient.page, "probeImage", {
    conversationId, message: imageMessage, blob: photo.blob, tamper: true,
  });
  assert.equal(badImage.rejected, true);
  assert.ok(badImage.codes.includes("E2EE_IMAGE_CIPHERTEXT_HASH_INVALID"));
  await rejectsDecrypt(recipient.page, conversationId, {
    ...imageMessage, attachment: { ...imageMessage.attachment, ciphertextSha256: "0".repeat(64) },
  }, "SINOCHAT_ATTACHMENT_BINDING_MISMATCH");
  assert.equal(await call(sender.page, "imageLimits"), true);
  console.log("[OK] PNG cifrado y decodificado sin exponer su clave; rechazo de manipulación, MIME falso y más de 5 MiB.");

  const savedToken = await call(recipient.page, "savedToken");
  await call(recipient.page, "close");
  await recipient.page.reload();
  await recipient.page.waitForFunction(() => Boolean(window.sinochatE2eeFixture));
  const wrongStoreSecret = await call(recipient.page, "probeStart", {
    ...recipient.input, storePassphrase: randomBytes(32).toString("base64url"),
  });
  assert.equal(wrongStoreSecret.rejected, true, "Una clave local incorrecta no puede abrir ni reemplazar el historial");
  assert.equal(wrongStoreSecret.codes.includes("MATRIX_SESSION_ALREADY_OPEN"), false);
  await call(recipient.page, "start", recipient.input);
  assert.equal(await call(recipient.page, "savedToken"), savedToken);
  assert.equal((await call(recipient.page, "decrypt", { conversationId, message: first })).text, texts[0]);
  assert.deepEqual(await call(recipient.page, "receiveImage", { conversationId, message: imageMessage, blob: photo.blob }), receivedImage);
  // Cierre abrupto: el navegador libera Web Locks sin llamar a nuestro close().
  await sender.page.close();
  await secondTab.waitForFunction(async (userId) => {
    const snapshot = await navigator.locks.query();
    return !snapshot.held.some((lock) => lock.name === `sinochat:e2ee-session:${userId}`);
  }, sender.input.sinochatUserId, { polling: 50, timeout: 5000 });
  assert.deepEqual(await call(secondTab, "probeLock", { userId: sender.input.sinochatUserId }), { acquired: true });
  sender.page = secondTab;
  await call(sender.page, "start", sender.input);
  assert.equal((await call(sender.page, "decrypt", { conversationId, message: first })).text, texts[0]);
  const afterReload = await call(sender.page, "sendText", {
    conversationId, clientMessageId: randomUUID(), participantUserId: recipient.input.sinochatUserId,
    text: "Mensaje después de reabrir el navegador de prueba.",
  });
  assertEnvelopes(afterReload, sender, recipient);
  assert.notEqual(outer(afterReload).session_id, outer(photo.outbound).session_id);
  await call(recipient.page, "sync");
  assert.equal((await call(recipient.page, "decrypt", {
    conversationId, message: delivery(afterReload, sender.input.sinochatUserId, 5),
  })).text, "Mensaje después de reabrir el navegador de prueba.");
  console.log("[OK] Claves e historial tras recarga/cierre de pestaña; cursor IndexedDB persistente y envío posterior.");

  const retryInput = {
    conversationId, clientMessageId: randomUUID(), participantUserId: recipient.input.sinochatUserId,
    text: "Reintento después de una caída al distribuir la clave.",
  };
  failNextSendActor = "sender";
  const failedSend = await call(sender.page, "probeSendText", retryInput);
  assert.equal(injectedSendFailures, 1);
  assert.equal(failedSend.rejected, true, "El envío no puede devolver un mensaje persistible si falla compartir su clave");
  assert.ok(failedSend.codes.includes("MATRIX_MESSAGE_ENCRYPT_FAILED"));
  const retried = await call(sender.page, "sendText", retryInput);
  assertEnvelopes(retried, sender, recipient);
  await call(recipient.page, "sync");
  assert.equal((await call(recipient.page, "decrypt", {
    conversationId, message: delivery(retried, sender.input.sinochatUserId, 6),
  })).text, retryInput.text);
  console.log("[OK] Una caída HTTP al compartir la clave impide completar el envío; el reintento se descifra.");

  const timeline = await call(recipient.page, "startTimeline", {
    conversationId, participantUserId: sender.input.sinochatUserId, items: [first, imageMessage],
  });
  assert.equal(timeline.messages[0].text, texts[0]);
  const blobUrl = timeline.messages[1].image.url;
  assert.ok(blobUrl.startsWith("blob:"));
  assert.equal(await call(recipient.page, "canFetchBlob", blobUrl), true);
  const replay = await call(recipient.page, "probeTimeline", [{ ...first, id: randomUUID() }]);
  assert.deepEqual(replay, { rejected: true, codes: ["MESSAGE_REPLAY_OR_REWRITE_DETECTED"], newReceipts: 0 });
  const hidden = {
    ...timeline, id: randomUUID(),
    messages: [{ ...timeline.messages[0], id: randomUUID(), text: "Mensaje en una conversación no seleccionada" }],
  };
  await call(recipient.page, "mountRetention", [timeline, hidden]);
  await recipient.page.waitForFunction(() => document.querySelector('[data-testid="retention-view"]')?.getAttribute("data-retained-count") === "3");
  assert.equal(await recipient.page.getByRole("log").getByText(texts[0], { exact: true }).count(), 1);
  await recipient.page.clock.pauseAt(await recipient.page.evaluate(() => Date.now()) + 100);
  const beforeExpiry = Date.parse(first.expiresAt) - await recipient.page.evaluate(() => Date.now()) - 1;
  await recipient.page.clock.fastForward(beforeExpiry);
  assert.equal(await recipient.page.getByRole("log").getByText(texts[0], { exact: true }).count(), 1);
  const requestsBeforeExpiry = wireBodies.length;
  await recipient.page.clock.fastForward(1);
  await recipient.page.waitForFunction(() => document.querySelector('[data-testid="retention-view"]')?.getAttribute("data-retained-count") === "1");
  assert.equal(await recipient.page.getByRole("log").getByText(texts[0], { exact: true }).count(), 0);
  await recipient.page.clock.fastForward(Date.parse(imageMessage.expiresAt) - await recipient.page.evaluate(() => Date.now()) + 1);
  await recipient.page.waitForFunction(() => document.querySelector('[data-testid="retention-view"]')?.getAttribute("data-retained-count") === "0");
  assert.equal(wireBodies.length, requestsBeforeExpiry, "La caducidad visual no depende de consultar la red");
  assert.equal(await call(recipient.page, "canFetchBlob", blobUrl), false);
  assert.equal((await call(recipient.page, "loadTimeline")).messages.length, 0);
  const resumeExpiry = await recipient.page.evaluate(() => Date.now()) + 1000;
  await call(recipient.page, "mountRetention", [{
    ...timeline, messages: [{ ...timeline.messages[0], expiresAt: new Date(resumeExpiry).toISOString() }],
  }]);
  await recipient.page.waitForFunction(() => document.querySelector('[data-testid="retention-view"]')?.getAttribute("data-retained-count") === "1");
  await recipient.page.clock.setSystemTime(new Date(resumeExpiry + 1));
  await recipient.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await recipient.page.waitForFunction(() => document.querySelector('[data-testid="retention-view"]')?.getAttribute("data-retained-count") === "0");
  console.log("[OK] Timeline real: replay rechazado sin recibo; React retira texto y foto a las 48 h simuladas sin red, también del chat no seleccionado; Blob URL revocada.");

  for (const text of [...texts, replyText]) {
    assert.equal(JSON.stringify(wireBodies).includes(text), false);
    assert.equal(JSON.stringify(outbound).includes(text), false);
  }
  assert.deepEqual(browserErrors, []);
  for (const client of Object.values(clients)) await call(client.page, "close");
  console.log("[OK] Validación del cliente real completada con relay HTTP sintético. Gate de producción sin modificar.");
} catch (error) {
  if (browserErrors.length) console.error("Errores de fixture/navegador:", browserErrors);
  throw error;
} finally {
  clearTimeout(watchdog);
  try { await browser?.close(); }
  finally {
    try { await server?.close(); }
    finally {
      assertTemporaryChild(tmpdir(), cache, "sinochat-e2ee-browser-");
      await rm(cache, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}

async function handleRelay(request, response) {
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  try {
    if (request.method !== "POST") throw new Error("FIXTURE_METHOD_INVALID");
    const match = /^\/__sinochat_e2ee_api\/(sender|recipient|outsider)\/([a-z]+)$/.exec(request.url);
    if (!match) throw new Error("FIXTURE_ROUTE_INVALID");
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error("FIXTURE_BODY_TOO_LARGE");
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    wireBodies.push(body);
    if (match[1] === failNextSendActor && match[2] === "send") {
      failNextSendActor = undefined;
      injectedSendFailures += 1;
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "FIXTURE_INJECTED_NETWORK_FAILURE" }));
      return;
    }
    response.end(JSON.stringify(await relay.handle(match[1], match[2], body)));
  } catch (error) {
    browserErrors.push(`${request.url}: ${error.message}`);
    response.statusCode = 400;
    response.end(JSON.stringify({ error: "FIXTURE_REQUEST_FAILED" }));
  }
}

async function openPage(context, origin) {
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto(`${origin}/__sinochat_e2ee_browser__`);
  await page.waitForFunction(() => Boolean(window.sinochatE2eeFixture));
  return page;
}

function call(page, method, input) {
  return page.evaluate(({ method, input }) => window.sinochatE2eeFixture[method](input), { method, input });
}

function outer(outbound) {
  return JSON.parse(Buffer.from(outbound.envelopes[0].ciphertext, "base64").toString("utf8"));
}

function assertEnvelopes(outbound, sender, recipient) {
  assert.deepEqual(outbound.envelopes.map((item) => item.recipientDeviceId).sort(),
    [sender.input.sinochatDeviceId, recipient.input.sinochatDeviceId].sort());
  assert.equal(outbound.envelopes[0].ciphertext, outbound.envelopes[1].ciphertext);
  assert.equal(outer(outbound).algorithm, "m.megolm.v1.aes-sha2");
}

function delivery(outbound, senderUserId, sequence, attachment = null) {
  const { recipientDeviceId, ...envelope } = outbound.envelopes[0];
  const now = Date.now();
  return {
    id: randomUUID(), senderUserId, senderDeviceId: outbound.senderDeviceId,
    clientMessageId: outbound.clientMessageId, serverSequence: String(sequence), kind: outbound.kind,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 48 * 60 * 60 * 1000).toISOString(),
    envelope, attachment, receipts: [],
  };
}

function mutateOuter(message, change) {
  const content = JSON.parse(Buffer.from(message.envelope.ciphertext, "base64").toString("utf8"));
  change(content);
  return { ...message, envelope: { ...message.envelope, ciphertext: Buffer.from(JSON.stringify(content)).toString("base64") } };
}

async function rejectsDecrypt(page, conversationId, message, expectedCode) {
  const result = await call(page, "probeDecrypt", { conversationId, message });
  assert.equal(result.rejected, true, `Se aceptó una alteración que requiere ${expectedCode}`);
  assert.ok(result.codes.includes(expectedCode), `Esperado ${expectedCode}; recibido ${result.codes.join(", ")}`);
}
