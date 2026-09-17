import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initAsync } from "@matrix-org/matrix-sdk-crypto-wasm";
import ts from "typescript";

// Regresión del contrato del adaptador. El SDK se sustituye únicamente al
// descifrar; check:e2ee-browser prueba por separado la criptografía real.
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(resolve(webRoot, ".megolm-adapter-test-"));
try {
  for (const name of ["e2ee/matrixMegolmMessageCrypto", "e2ee/messageContent", "messagePayload"]) {
    const source = await readFile(resolve(webRoot, `src/${name}.ts`), "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: `${name}.ts`, reportDiagnostics: true,
    });
    assert.deepEqual(compiled.diagnostics ?? [], []);
    await writeFile(resolve(temporary, `${name.split("/").at(-1)}.mjs`),
      compiled.outputText.replaceAll('"../messagePayload"', '"./messagePayload.mjs"')
        .replaceAll('"./messageContent"', '"./messageContent.mjs"'), "utf8");
  }
  await initAsync();
  const { MatrixMegolmMessageCrypto } = await import(pathToFileURL(resolve(temporary, "matrixMegolmMessageCrypto.mjs")).href);
  const user = "11111111-1111-4111-8111-111111111111";
  const device = "22222222-2222-4222-8222-222222222222";
  const conversation = "33333333-3333-4333-8333-333333333333";
  const id = "44444444-4444-4444-8444-444444444444";
  const clientId = "55555555-5555-4555-8555-555555555555";
  const matrixUser = `@u${user.replaceAll("-", "")}:sinochat.invalid`;
  const matrixDevice = `D${device.replaceAll("-", "").toUpperCase()}`;
  const room = `!c${conversation.replaceAll("-", "")}:sinochat.invalid`;
  const eventId = `$m${id.replaceAll("-", "")}:sinochat.invalid`;
  const key = Buffer.alloc(32, 1).toString("base64").replace(/=+$/, "");
  const createdAt = "2026-09-10T12:00:00.000Z";
  const content = {
    protocolVersion: "matrix-megolm-v1", conversationId: conversation, roomId: room,
    clientMessageId: clientId, senderUserId: user, senderDeviceId: device, kind: "TEXT", text: "Prueba sintética",
  };
  const expectedEvent = {
    type: "com.sinochat.message.v1", sender: matrixUser, content,
    room_id: room, event_id: eventId, origin_server_ts: Date.parse(createdAt), unsigned: {},
  };
  const message = {
    id, senderUserId: user, senderDeviceId: device, clientMessageId: clientId, kind: "TEXT", createdAt,
    envelope: { protocolVersion: "matrix-megolm-v1", cipherSuite: "m.megolm.v1.aes-sha2", content: { sender_key: key } },
    attachment: null,
  };
  let released = 0;
  let response;
  const adapter = new MatrixMegolmMessageCrypto({
    userId: matrixUser, deviceId: matrixDevice, roomIdFor: () => room,
  }, {
    runExclusiveCryptoOperation: (operation) => operation({ machine: {
      async decryptRoomEvent(raw, sdkRoom) {
        assert.equal(sdkRoom.toString(), room);
        const transport = JSON.parse(raw);
        assert.deepEqual(Object.keys(transport).sort(), ["content", "event_id", "origin_server_ts", "sender", "type"]);
        assert.equal(transport.event_id, eventId);
        return response;
      },
    } }),
  });
  function prepare(changeEvent = () => {}, changeResponse = () => {}) {
    const event = structuredClone(expectedEvent);
    changeEvent(event);
    response = {
      event: JSON.stringify(event), sender: { toString: () => matrixUser },
      senderDevice: { toString: () => matrixDevice }, senderCurve25519Key: key,
      senderClaimedEd25519Key: key, forwarder: undefined, forwarderDevice: undefined,
      forwardingCurve25519KeyChain: [], free() { released++; },
    };
    changeResponse(response);
  }
  prepare();
  assert.deepEqual(await adapter.decrypt(conversation, message), content);
  assert.equal(released, 1);
  let cases = 1;
  async function reject(code, changeEvent, changeResponse) {
    prepare(changeEvent, changeResponse);
    const before = released;
    await assert.rejects(() => adapter.decrypt(conversation, message), (error) => {
      assert.ok(error.code === code || error.cause?.code === code, `Esperado ${code}; recibido ${error.code}/${error.cause?.code}`);
      return true;
    });
    assert.equal(released, before + 1, "También libera el evento WASM al rechazarlo");
    cases++;
  }
  await reject("MATRIX_DECRYPTED_EVENT_FIELDS_INVALID", (event) => { delete event.room_id; });
  await reject("MATRIX_DECRYPTED_EVENT_FIELDS_INVALID", (event) => { delete event.unsigned; });
  await reject("MATRIX_DECRYPTED_EVENT_FIELDS_INVALID", (event) => { event.unexpected = "ignored?"; });
  await reject("MATRIX_DECRYPTED_EVENT_BINDING_INVALID", (event) => { event.room_id = "!wrong:sinochat.invalid"; });
  for (const unsigned of [null, [], "", { age: 0 }, { content: { text: "injected" } }]) {
    await reject("MATRIX_DECRYPTED_EVENT_UNSIGNED_INVALID", (event) => { event.unsigned = unsigned; });
  }
  await reject("MATRIX_DECRYPTED_EVENT_BINDING_INVALID", (event) => { event.event_id = "$changed:sinochat.invalid"; });
  await reject("MATRIX_DECRYPTED_EVENT_BINDING_INVALID", (event) => { event.origin_server_ts++; });
  await reject("MATRIX_DECRYPTED_EVENT_BINDING_INVALID", (event) => { event.type = "m.room.message"; });
  await reject("MATRIX_DECRYPTED_EVENT_BINDING_INVALID", (event) => { event.sender = "@changed:sinochat.invalid"; });
  await reject("SINOCHAT_MESSAGE_BINDING_MISMATCH", (event) => { event.content.clientMessageId = id; });
  await reject("MATRIX_DECRYPTED_EVENT_JSON_INVALID", undefined, (value) => { value.event = "{"; });
  await reject("MATRIX_DECRYPTED_EVENT_INVALID", undefined, (value) => { value.event = "[]"; });
  await reject("MATRIX_DECRYPTED_SENDER_BINDING_INVALID", undefined, (value) => { value.forwarder = {}; });
  await reject("MATRIX_DECRYPTED_SENDER_BINDING_INVALID", undefined, (value) => { value.forwardingCurve25519KeyChain = [key]; });
  console.log(`[OK] ${cases} casos del adaptador Megolm: siete campos reales, room vinculado, unsigned vacío, integridad y liberación WASM.`);
} finally {
  const target = relative(webRoot, temporary);
  if (!target.startsWith(".megolm-adapter-test-") || target.includes("/") || target.includes("\\") || isAbsolute(target)) {
    throw new Error("UNSAFE_ADAPTER_TEST_PATH");
  }
  await rm(temporary, { recursive: true, force: true });
}
