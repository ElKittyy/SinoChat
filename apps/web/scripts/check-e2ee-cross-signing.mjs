import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { DeviceId, OlmMachine, RequestType, UserId, initAsync } from "@matrix-org/matrix-sdk-crypto-wasm";
import ts from "typescript";
import { assertTemporaryChild } from "./browser-test-environment.mjs";

// Real Rust Crypto + real pure server signature validator. Only HTTP and the
// public-key directory are in-memory fixtures; no browser, users, DB or secrets
// from the development environment are accessed by this suite.
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(resolve(webRoot, ".matrix-cross-signing-test-"));
const USER = "@u11111111111141118111111111111111:sinochat.invalid";
const DEVICE = "D22222222222242228222222222222222";
const identity = { userId: USER, deviceId: DEVICE, roomIdFor() { throw new Error("NO_CHAT_IN_BOOTSTRAP"); } };
let initialize, Coordinator, validateBootstrap;
try {
  const sources = new Map([
    ["matrixCrossSigning", resolve(webRoot, "src/e2ee/matrixCrossSigning.ts")],
    ["matrixTransport", resolve(webRoot, "src/e2ee/matrixTransport.ts")],
    ["matrix-cross-signing", resolve(webRoot, "../api/src/e2ee/matrix-cross-signing.ts")],
    ["matrix-key-upload", resolve(webRoot, "../api/src/e2ee/matrix-key-upload.ts")],
  ]);
  for (const [name, sourcePath] of sources) {
    const source = await readFile(sourcePath, "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: sourcePath, reportDiagnostics: true,
    });
    assert.deepEqual(compiled.diagnostics ?? [], []);
    let output = compiled.outputText;
    for (const dependency of sources.keys()) output = output.replaceAll(`"./${dependency}"`, `"./${dependency}.mjs"`);
    await writeFile(resolve(temporary, `${name}.mjs`), output, "utf8");
  }
  ({ initializeMatrixCrossSigning: initialize } = await import(pathToFileURL(resolve(temporary, "matrixCrossSigning.mjs")).href));
  ({ MatrixTransportCoordinator: Coordinator } = await import(pathToFileURL(resolve(temporary, "matrixTransport.mjs")).href));
  ({ parseMatrixCrossSigningBootstrap: validateBootstrap } = await import(pathToFileURL(resolve(temporary, "matrix-cross-signing.mjs")).href));
  await initAsync();

  await check("bootstrap real publica solo firmas/claves públicas, consulta y verifica el dispositivo propio", async (f) => {
    await f.start();
    assert.deepEqual(f.order, ["status", "bootstrap:false", "post", "query", "ack:1"]);
    assert.equal(f.posts.length, 1);
    assertPublicOnly(f.posts[0]);
    assert.deepEqual(Object.keys(f.posts[0]).sort(), ["device_signatures", "signing_keys"]);
    const sdkUser = new UserId(USER);
    const own = await f.machine.getIdentity(sdkUser);
    sdkUser.free();
    try {
      assert.equal(own.isVerified(), true);
      assert.equal(await own.trustsOurOwnDevice(), true);
    } finally { own.free(); }
    assert.equal(f.order.some((value) => value === `ack:${RequestType.SignatureUpload}`), false, "No inventa un ACK para SignatureUploadRequest sin id");
  });

  await check("bootstrap(false) repetido conserva claves, firmas e identidad publicada", async (f) => {
    await f.start();
    await f.start();
    assert.equal(f.bootstrapCalls, 2);
    assert.deepEqual(f.posts[0], f.posts[1]);
  });

  await check("dos arranques simultáneos se serializan en el mismo coordinador", async (f) => {
    await Promise.all([f.start(), f.start()]);
    assert.deepEqual(f.order, ["status", "bootstrap:false", "post", "query", "ack:1", "status", "bootstrap:false", "post", "query", "ack:1"]);
    assert.deepEqual(f.posts[0], f.posts[1]);
  });

  await check("fallo HTTP antes de persistir permite reintentar sin regenerar la identidad local", async (f) => {
    f.beforePost = () => { throw new Error("FIXTURE_NETWORK_FAILURE"); };
    await assert.rejects(f.start(), /FIXTURE_NETWORK_FAILURE/);
    assert.equal(f.remote, undefined);
    assert.equal(f.order.includes("query"), false);
    f.beforePost = undefined;
    await f.start();
    assert.deepEqual(f.posts[0], f.posts[1]);
  });

  await check("respuesta perdida tras commit permite reintentar contra el mismo pin", async (f) => {
    f.afterPost = () => { throw new Error("FIXTURE_RESPONSE_LOST"); };
    await assert.rejects(f.start(), /FIXTURE_RESPONSE_LOST/);
    const pin = structuredClone(f.remote.identity);
    assert.equal(f.order.includes("query"), false);
    f.afterPost = undefined;
    await f.start();
    assert.deepEqual(f.remote.identity, pin);
    assert.deepEqual(f.posts[0], f.posts[1]);
  });

  await check("falla consulta final y reintenta sin cambiar el pin ni la firma del dispositivo", async (f) => {
    f.beforeQuery = () => { throw new Error("FIXTURE_QUERY_FAILURE"); };
    await assert.rejects(f.start(), /FIXTURE_QUERY_FAILURE/);
    assert.equal(f.order.includes("ack:1"), false);
    f.beforeQuery = undefined;
    await f.start();
    assert.deepEqual(f.posts[0], f.posts[1]);
  });

  await check("cancelación previa no consulta, crea ni publica identidad", async (f) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(f.start(controller.signal), { name: "AbortError" });
    assert.deepEqual(f.order, []);
  });

  await check("cancelación tras publicar no confirma consultas y admite reintento seguro", async (f) => {
    const controller = new AbortController();
    f.afterPost = () => { controller.abort(); };
    await assert.rejects(f.start(controller.signal), { name: "AbortError" });
    assert.equal(f.order.includes("query"), false);
    f.afterPost = undefined;
    await f.start();
    assert.deepEqual(f.posts[0], f.posts[1]);
  });

  for (const field of ["matrixUserId", "matrixDeviceId"]) {
    await check(`rechaza status de otra identidad/sesión: ${field}`, async (f) => {
      f.statusTransform = (status) => ({ ...status, [field]: "FOREIGN" });
      await rejected(f, "MATRIX_CROSS_SIGNING_SESSION_MISMATCH");
      assert.equal(f.bootstrapCalls, 0);
      assert.equal(f.posts.length, 0);
    });
  }

  await check("identidad remota existente sin claves privadas locales no llama bootstrap(false)", async (f) => {
    const other = await fixture();
    try {
      await other.start();
      f.remote = structuredClone(other.remote);
      await rejected(f, "MATRIX_CROSS_SIGNING_LOCAL_KEYS_REQUIRED");
      assert.equal(f.bootstrapCalls, 0);
      assert.equal(f.posts.length, 0);
    } finally { other.close(); }
  });

  for (const field of ["masterKey", "selfSigningKey", "userSigningKey"]) {
    await check(`no sustituye silenciosamente el pin remoto: ${field}`, async (f) => {
      await f.start();
      const original = f.remote.identity[field];
      f.remote.identity[field] = Buffer.alloc(32, 70).toString("base64").replace(/=+$/, "");
      await rejected(f, "MATRIX_CROSS_SIGNING_IDENTITY_CHANGED");
      assert.equal(f.bootstrapCalls, 1, "El segundo intento falla ANTES de generar solicitudes");
      assert.equal(f.posts.length, 1);
      f.remote.identity[field] = original;
    });
  }

  await check("claves privadas locales parciales requieren recuperación, no una nueva raíz", async (f) => {
    let freed = false;
    f.machine.crossSigningStatus = async () => ({ hasMaster: true, hasSelfSigning: false, hasUserSigning: false, free() { freed = true; } });
    await rejected(f, "MATRIX_CROSS_SIGNING_LOCAL_KEYS_REQUIRED");
    assert.equal(freed, true);
    assert.equal(f.bootstrapCalls, 0);
  });

  await check("sin ACK del alta inicial no publica el bootstrap ni confirma uploads opcionales", async (f) => {
    await rejected(f, "MATRIX_CROSS_SIGNING_INITIAL_KEYS_NOT_ACKNOWLEDGED");
    assert.equal(f.posts.length, 0);
  }, { initialAck: false });

  await check("respuesta POST no fijada no se convierte en éxito ni se ingiere en Rust Crypto", async (f) => {
    f.postTransform = (status) => ({ ...status, state: "UNINITIALIZED", identity: null });
    await rejected(f, "MATRIX_CROSS_SIGNING_BOOTSTRAP_NOT_PINNED");
    assert.equal(f.order.includes("query"), false);
  });

  await check("respuesta POST con otra raíz falla antes de query/ACK", async (f) => {
    f.postTransform = (status) => ({ ...status, identity: { ...status.identity, masterKey: Buffer.alloc(32, 71).toString("base64").replace(/=+$/, "") } });
    await rejected(f, "MATRIX_CROSS_SIGNING_IDENTITY_CHANGED");
    assert.equal(f.order.includes("query"), false);
  });

  await check("query sin firma self-signing no autoriza el dispositivo aunque el POST haya respondido", async (f) => {
    f.queryTransform = (response) => {
      response.device_keys[USER][DEVICE] = structuredClone(f.originalDevice);
      return response;
    };
    await rejected(f, "MATRIX_CROSS_SIGNING_DEVICE_NOT_VERIFIED");
  });

  await check("query no acepta usuarios no solicitados", async (f) => {
    f.queryTransform = (response) => {
      response.master_keys["@foreign:sinochat.invalid"] = response.master_keys[USER];
      return response;
    };
    await rejected(f, "MATRIX_RESPONSE_TARGET_UNEXPECTED");
    assert.equal(f.order.includes("ack:1"), false);
  });

  await check("query con firma del dispositivo manipulada no autoriza el dispositivo", async (f) => {
    f.queryTransform = (response) => {
      response.device_keys[USER][DEVICE].signatures[USER][`ed25519:${f.remote.identity.selfSigningKey}`] = "A".repeat(86);
      return response;
    };
    await rejected(f, "MATRIX_CROSS_SIGNING_DEVICE_NOT_VERIFIED");
  });

  for (const mutation of [
    (body) => { body.private_key = "FIXTURE_PRIVATE_MATERIAL"; },
    (body) => { body.master_key.secret = "FIXTURE_PRIVATE_MATERIAL"; },
    (body) => { body.master_key.keys["private:seed"] = "FIXTURE_PRIVATE_MATERIAL"; },
    (body) => { body.master_key.signatures[USER].secret = "FIXTURE_PRIVATE_MATERIAL"; },
  ]) {
    await check("perfil público cerrado rechaza campos privados antes de cualquier POST", async (f) => {
      f.mutateSigningBody = mutation;
      await rejected(f, "MATRIX_CROSS_SIGNING_PUBLIC_BODY_INVALID");
      assert.equal(f.posts.length, 0);
      assert.equal(f.wrappersReleased, 3);
    });
  }

  await check("SignatureUploadRequest con id no se trata como bootstrap inicial", async (f) => {
    f.signatureId = "unexpected-verification-request";
    await rejected(f, "MATRIX_CROSS_SIGNING_SIGNATURE_REQUEST_UNEXPECTED");
    assert.equal(f.posts.length, 0);
    assert.equal(f.wrappersReleased, 3);
  });
} finally {
  assertTemporaryChild(webRoot, temporary, ".matrix-cross-signing-test-");
  await rm(temporary, { recursive: true, force: true });
}

async function check(name, operation, options) {
  await test(name, async () => {
    const current = await fixture(options);
    try { await operation(current); } finally { current.close(); }
  });
}

async function rejected(fixture, code) {
  await assert.rejects(fixture.start(), (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

async function fixture({ initialAck = true } = {}) {
  const sdkUser = new UserId(USER), sdkDevice = new DeviceId(DEVICE);
  const machine = await OlmMachine.initialize(sdkUser, sdkDevice);
  sdkUser.free(); sdkDevice.free();
  const initialRequests = await machine.outgoingRequests();
  let originalDevice;
  try {
    const initialUpload = initialRequests.find((request) => request.type === RequestType.KeysUpload);
    const body = JSON.parse(initialUpload.body);
    originalDevice = body.device_keys;
    if (initialAck) await machine.markRequestAsSent(initialUpload.id, initialUpload.type,
      JSON.stringify({ one_time_key_counts: { signed_curve25519: Object.keys(body.one_time_keys).length } }));
  } finally { initialRequests.forEach((request) => request.free()); }
  const fixture = {
    machine, originalDevice, order: [], posts: [], bootstrapCalls: 0, wrappersReleased: 0,
    remote: undefined, close() { machine.close(); },
  };
  const bootstrap = machine.bootstrapCrossSigning.bind(machine);
  machine.bootstrapCrossSigning = async (reset) => {
    assert.equal(reset, false, "Nunca resetea una identidad");
    fixture.bootstrapCalls++;
    fixture.order.push(`bootstrap:${reset}`);
    const request = await bootstrap(reset);
    if (!fixture.mutateSigningBody && !fixture.signatureId) return request;
    const keys = request.uploadKeysRequest, signing = request.uploadSigningKeysRequest, signatures = request.uploadSignaturesRequest;
    const body = JSON.parse(signing.body);
    fixture.mutateSigningBody?.(body);
    return {
      uploadKeysRequest: keys,
      uploadSigningKeysRequest: { body: JSON.stringify(body), free() { signing.free(); fixture.wrappersReleased++; } },
      uploadSignaturesRequest: { body: signatures.body, id: fixture.signatureId, free() { signatures.free(); fixture.wrappersReleased++; } },
      free() { request.free(); fixture.wrappersReleased++; },
    };
  };
  const mark = machine.markRequestAsSent.bind(machine);
  machine.markRequestAsSent = async (...args) => { fixture.order.push(`ack:${args[1]}`); return mark(...args); };
  const status = () => fixture.remote
    ? { state: "PINNED", matrixUserId: USER, matrixDeviceId: DEVICE, identity: {
      masterKey: fixture.remote.identity.masterKey, selfSigningKey: fixture.remote.identity.selfSigningKey, userSigningKey: fixture.remote.identity.userSigningKey,
    } }
    : { state: "UNINITIALIZED", matrixUserId: USER, matrixDeviceId: DEVICE, identity: null };
  const forbidden = () => { throw new Error("UNEXPECTED_BOOTSTRAP_HTTP_REQUEST"); };
  const api = {
    async getCrossSigningStatus() {
      fixture.order.push("status");
      return fixture.statusTransform?.(status()) ?? status();
    },
    async bootstrapCrossSigning(body) {
      fixture.order.push("post");
      assertPublicOnly(body);
      fixture.posts.push(structuredClone(body));
      fixture.beforePost?.();
      fixture.remote = validateBootstrap(body.signing_keys, body.device_signatures, {
        userId: USER, deviceId: DEVICE, registeredDeviceKeys: fixture.originalDevice,
        pinnedIdentity: fixture.remote?.identity ?? null,
      });
      fixture.afterPost?.();
      return fixture.postTransform?.(status()) ?? status();
    },
    async queryKeys(body) {
      fixture.order.push("query");
      assert.deepEqual(Object.keys(body.device_keys), [USER]);
      assert.deepEqual(body.device_keys[USER], []);
      fixture.beforeQuery?.();
      const remote = fixture.remote;
      const response = {
        device_keys: { [USER]: { [DEVICE]: structuredClone(remote.signedDeviceKeys) } },
        master_keys: { [USER]: structuredClone(remote.signingKeys.master_key) },
        self_signing_keys: { [USER]: structuredClone(remote.signingKeys.self_signing_key) },
        user_signing_keys: { [USER]: structuredClone(remote.signingKeys.user_signing_key) }, failures: {},
      };
      return fixture.queryTransform?.(response) ?? response;
    },
    uploadKeys: forbidden, claimKeys: forbidden, sendToDevice: forbidden, sync: forbidden,
  };
  const coordinator = new Coordinator(machine, DEVICE, api, { load: forbidden, save: forbidden, clear: forbidden });
  fixture.start = (signal) => initialize(identity, coordinator, api, signal);
  return fixture;
}

function assertPublicOnly(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, /private|secret|passphrase|pickle|seed|recovery/i);
    assertPublicOnly(child);
  }
}
