import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import {
  Attachment,
  DeviceId,
  OlmMachine,
  ProcessedToDeviceEventType,
  RequestType,
  UserId,
  initAsync,
} from "@matrix-org/matrix-sdk-crypto-wasm";

const lifecycleUserId = "11111111-1111-4111-8111-111111111111";
const lifecycleDeviceId = "22222222-2222-4222-8222-222222222222";
const lifecycleMatrixUserId =
  "@u11111111111141118111111111111111:sinochat.invalid";
const lifecycleMatrixDeviceId = "D22222222222242228222222222222222";

const webPackage = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
assert.equal(
  webPackage.dependencies["@matrix-org/matrix-sdk-crypto-wasm"],
  "18.6.0",
  "La dependencia criptografica debe permanecer fijada exactamente",
);

await initAsync();

const userId = new UserId("@runtime_probe:sinochat.invalid");
const deviceId = new DeviceId("RUNTIME_PROBE");
let machine;

try {
  machine = await OlmMachine.initialize(userId, deviceId);
  const requests = await machine.outgoingRequests();
  const upload = requests.find(
    (request) => request.type === RequestType.KeysUpload,
  );

  assert.ok(upload, "El motor debe solicitar la publicacion inicial de claves");
  const body = JSON.parse(upload.body);
  assert.equal(body.device_keys.user_id, "@runtime_probe:sinochat.invalid");
  assert.equal(body.device_keys.device_id, "RUNTIME_PROBE");
  assert.deepEqual(body.device_keys.algorithms.sort(), [
    "m.megolm.v1.aes-sha2",
    "m.olm.v1.curve25519-aes-sha2",
  ]);
  assert.equal(
    typeof body.device_keys.keys["ed25519:RUNTIME_PROBE"],
    "string",
  );
  assert.equal(
    typeof body.device_keys.keys["curve25519:RUNTIME_PROBE"],
    "string",
  );
  assert.ok(Object.keys(body.one_time_keys).length > 0);
  assertNoPrivateMaterial(body);

  const plaintext = new TextEncoder().encode("imagen de prueba SinoChat");
  const encryptedAttachment = Attachment.encrypt(plaintext);
  try {
    const encryptionInfo = JSON.parse(
      encryptedAttachment.mediaEncryptionInfo,
    );
    assert.equal(encryptionInfo.v, "v2");
    assert.equal(encryptionInfo.key.alg, "A256CTR");
    assert.equal(typeof encryptionInfo.hashes.sha256, "string");
    assert.notDeepEqual(encryptedAttachment.encryptedData, plaintext);

    const decrypted = Attachment.decrypt(encryptedAttachment);
    assert.deepEqual(decrypted, plaintext);
    assert.equal(encryptedAttachment.hasMediaEncryptionInfoBeenConsumed, true);
  } finally {
    encryptedAttachment.free();
  }
} finally {
  machine?.close();
  userId.free();
  deviceId.free();
}

console.log(
  "[OK] Matrix Rust Crypto WASM inicia, publica solo claves publicas y cifra adjuntos v2.",
);

await checkPrivateTransportCoordinator();
await checkMatrixSessionLifecycle();

function assertNoPrivateMaterial(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(
      key,
      /(?:private|secret|passphrase|pickle)/i,
      `Campo privado inesperado: ${key}`,
    );
    assertNoPrivateMaterial(child);
  }
}

async function checkPrivateTransportCoordinator() {
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const sourcePath = resolve(webRoot, "src/e2ee/matrixTransport.ts");
  const temporaryDirectory = await mkdtemp(
    resolve(webRoot, ".matrix-transport-test-"),
  );
  const outputPath = resolve(temporaryDirectory, "matrixTransport.mjs");

  try {
    const source = await readFile(sourcePath, "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: sourcePath,
      reportDiagnostics: true,
    });
    assert.deepEqual(
      compiled.diagnostics ?? [],
      [],
      "El coordinador Matrix debe transpilar sin diagnosticos",
    );
    await writeFile(outputPath, compiled.outputText, "utf8");
    const {
      MatrixTransportCoordinator,
      MatrixTransportError,
    } = await import(pathToFileURL(outputPath).href);

    await checkMarkOnlyAfterHttpSuccess(MatrixTransportCoordinator);
    await checkExplicitRequest(MatrixTransportCoordinator);
    await checkExclusiveCryptoOperation(MatrixTransportCoordinator);
    await checkQueryChunking(MatrixTransportCoordinator);
    await checkClaimSplitting(MatrixTransportCoordinator);
    await checkSyncCommitOrder(
      MatrixTransportCoordinator,
      MatrixTransportError,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  console.log(
    "[OK] El transporte web serializa sync y operaciones Megolm, divide keys/query/claim y marca requests solo tras HTTP 200.",
  );
}

async function checkExclusiveCryptoOperation(Coordinator) {
  const order = [];
  const request = fakeRequest({
    body: JSON.stringify({ one_time_keys: {} }),
    id: "exclusive-upload-01",
    type: RequestType.KeysUpload,
  });
  const machine = fakeMachine([request], {
    onMark() {
      order.push("mark");
    },
  });
  const nextBatch = `sct1.${"A".repeat(22)}.${"B".repeat(43)}`;
  const coordinator = new Coordinator(
    machine,
    "D11111111111141118111111111111111",
    emptyTransport({
      async uploadKeys() {
        order.push("upload-http");
        return { one_time_key_counts: { signed_curve25519: 50 } };
      },
      async sync() {
        order.push("sync-http");
        return {
          next_batch: nextBatch,
          to_device: { events: [] },
          device_one_time_keys_count: { signed_curve25519: 0 },
          device_unused_fallback_key_types: [],
        };
      },
    }),
    memoryTokenStore(),
  );

  const exclusive = coordinator.runExclusiveCryptoOperation(
    async (context) => {
      order.push("exclusive-start");
      assert.equal(context.machine, machine);
      assert.equal(await context.flushOutgoingRequests(), 1);
      await Promise.resolve();
      order.push("exclusive-end");
    },
  );
  const sync = coordinator.sync();
  await Promise.all([exclusive, sync]);

  assert.deepEqual(order, [
    "exclusive-start",
    "upload-http",
    "mark",
    "exclusive-end",
    "sync-http",
  ]);
}

async function checkExplicitRequest(Coordinator) {
  const order = [];
  const request = fakeRequest({
    body: JSON.stringify({ one_time_keys: {} }),
    id: "explicit-upload-01",
    type: RequestType.KeysUpload,
  });
  const coordinator = new Coordinator(
    fakeMachine([], {
      onMark() {
        order.push("mark");
      },
    }),
    "D11111111111141118111111111111111",
    emptyTransport({
      async uploadKeys() {
        order.push("http");
        return { one_time_key_counts: { signed_curve25519: 50 } };
      },
    }),
    memoryTokenStore(),
  );

  await coordinator.sendExplicitRequest(request);
  assert.deepEqual(order, ["http", "mark"]);
  assert.equal(
    request.freed,
    false,
    "El coordinador no debe liberar un wrapper WASM propiedad del llamador",
  );
  request.free();

  let httpCalled = false;
  const invalidRequest = fakeRequest({
    body: JSON.stringify({ one_time_keys: {} }),
    id: "",
    type: RequestType.KeysUpload,
  });
  const invalidCoordinator = new Coordinator(
    fakeMachine([]),
    "D11111111111141118111111111111111",
    emptyTransport({
      async uploadKeys() {
        httpCalled = true;
        return {};
      },
    }),
    memoryTokenStore(),
  );
  await assert.rejects(
    invalidCoordinator.sendExplicitRequest(invalidRequest),
    /MATRIX_OUTGOING_REQUEST_ID_INVALID/,
  );
  assert.equal(httpCalled, false);
  invalidRequest.free();
}

async function checkMatrixSessionLifecycle() {
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await checkCrossSigningErrorMessages(webRoot);
  const temporaryDirectory = await mkdtemp(
    resolve(webRoot, ".matrix-lifecycle-test-"),
  );
  const sources = [
    "messagePayload",
    "matrixLocalDeviceStore",
    "messageContent",
    "matrixMegolmMessageCrypto",
    "matrixProfile",
    "matrixRuntime",
    "matrixTransport",
    "matrixCrossSigning",
    "matrixSessionLifecycle",
  ];

  try {
    for (const name of sources) {
      const sourcePath = resolve(
        webRoot,
        name === "messagePayload"
          ? `src/${name}.ts`
          : `src/e2ee/${name}.ts`,
      );
      const source = await readFile(sourcePath, "utf8");
      if (name === "matrixLocalDeviceStore") {
        assert.match(source, /name: "AES-GCM"/);
        assert.match(source, /false,\s*\["encrypt", "decrypt"\]/);
        assert.match(source, /typeof CryptoKey !== "undefined"/);
        assert.doesNotMatch(source, /localStorage|sessionStorage/);
      }
      if (name === "matrixSessionLifecycle") {
        assert.match(source, /navigator\.locks\.request/);
        assert.match(source, /ifAvailable: true/);
        assert.doesNotMatch(source, /steal\s*:/);
      }
      const compiled = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        fileName: sourcePath,
        reportDiagnostics: true,
      });
      assert.deepEqual(
        compiled.diagnostics ?? [],
        [],
        `${name} debe transpilar sin diagnosticos`,
      );
      let output = compiled.outputText;
      for (const dependency of sources) {
        output = output.replaceAll(
          `"./${dependency}"`,
          `"./${dependency}.mjs"`,
        );
      }
      output = output.replaceAll(
        '"../messagePayload"',
        '"./messagePayload.mjs"',
      );
      await writeFile(
        resolve(temporaryDirectory, `${name}.mjs`),
        output,
        "utf8",
      );
    }

    const {
      BrowserMatrixSessionLockProvider,
      MatrixSessionLifecycle,
      MatrixSessionLifecycleError,
    } = await import(
      pathToFileURL(
        resolve(temporaryDirectory, "matrixSessionLifecycle.mjs"),
      ).href
    );
    await checkBrowserSessionLocks(BrowserMatrixSessionLockProvider);
    // These tests isolate lifecycle journaling. The real SDK bootstrap and its
    // HTTP/query round trip are covered by check:e2ee-cross-signing.
    class LifecycleWithBootstrapFixture extends MatrixSessionLifecycle {
      constructor(...args) {
        super(...args, async (_identity, _coordinator, api) => api.fixtureCrossSigningInitialized());
      }
    }
    await checkBlockedGateDoesNotTouchCrypto(LifecycleWithBootstrapFixture);
    await checkReleaseProfileBeforeSessionLock(
      LifecycleWithBootstrapFixture,
      MatrixSessionLifecycleError,
    );
    await checkInitialRegistrationJournal(LifecycleWithBootstrapFixture);
    await checkExclusiveSessionLease(
      LifecycleWithBootstrapFixture,
      MatrixSessionLifecycleError,
    );
    await checkFailedLifecycleReleasesLease(LifecycleWithBootstrapFixture);
    await checkCloseDrainsCoordinator(LifecycleWithBootstrapFixture);
    await checkExistingDeviceBinding(LifecycleWithBootstrapFixture);
    await checkCrashAfterInitialMark(LifecycleWithBootstrapFixture);
    await checkCrossSigningFailureReleasesLease(MatrixSessionLifecycle);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  console.log(
    "[OK] El ciclo web respeta BLOCKED, valida el perfil, excluye pestañas, reanuda el alta inicial y vincula sesiones antes de abrir Rust Crypto.",
  );
}

async function checkCrossSigningErrorMessages(webRoot) {
  const source = await readFile(resolve(webRoot, "src/App.tsx"), "utf8");
  const ast = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const declaration = ast.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "matrixErrorMessage");
  assert.ok(declaration, "App conserva el formateador de errores criptográficos");
  const compiled = ts.transpileModule(declaration.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const format = new Function("isApiError", "MatrixLocalDeviceStoreError", "isMatrixSessionLifecycleError",
    `${compiled.outputText}\nreturn matrixErrorMessage;`)(() => false, class FixtureLocalError extends Error {}, () => false);
  for (const [code, expected] of [
    ["MATRIX_CROSS_SIGNING_LOCAL_KEYS_REQUIRED", /no conserva todas las claves.*No se creó una identidad nueva/],
    ["MATRIX_CROSS_SIGNING_IDENTITY_CHANGED", /no coincide con la registrada.*no se reemplazaron tus claves/],
    ["MATRIX_CROSS_SIGNING_IDENTITY_NOT_VERIFIED", /verificar las firmas.*bloqueado por seguridad/],
    ["MATRIX_CROSS_SIGNING_DEVICE_NOT_VERIFIED", /verificar las firmas.*bloqueado por seguridad/],
    ["MATRIX_CROSS_SIGNING_SESSION_MISMATCH", /corresponda a tu sesión.*bloqueado/],
    ["MATRIX_CROSS_SIGNING_PUBLIC_BODY_INVALID", /bloqueado; no se restablecieron tus claves/],
  ]) {
    const error = Object.assign(new Error("FIXTURE_DO_NOT_DISPLAY_INTERNAL_DETAILS"), { name: "MatrixCrossSigningError", code });
    assert.match(format(error), expected);
    assert.doesNotMatch(format(error), /FIXTURE_|MATRIX_CROSS_SIGNING_/);
  }
  for (const statement of ast.statements.filter(ts.isImportDeclaration)) {
    assert.doesNotMatch(statement.moduleSpecifier.getText(ast), /matrixCrossSigning|matrix-sdk-crypto-wasm/,
      "El mensaje de error no debe cargar Rust Crypto anticipadamente");
  }
  console.log("[OK] Los errores de identidad detienen el chat, explican el motivo y no ofrecen restablecer claves ni cargan WASM.");
}

async function checkBrowserSessionLocks(LockProvider) {
  const originalNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const requests = [];
  const locks = {
    request(name, options, callback) {
      assert.equal(options.ifAvailable, true);
      assert.equal(options.mode, "exclusive");
      assert.equal(
        Object.hasOwn(options, "signal"),
        false,
        "Web Locks rechaza ifAvailable:true junto con signal",
      );
      return new Promise((resolveRequest, rejectRequest) => {
        requests.push({
          name,
          reject: rejectRequest,
          async deliver(lock) {
            try {
              await callback(lock);
              resolveRequest();
            } catch (error) {
              rejectRequest(error);
              throw error;
            }
          },
        });
      });
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks },
  });
  try {
    const provider = new LockProvider();
    const controller = new AbortController();
    const acquired = provider.acquire(lifecycleUserId, controller.signal);
    const first = requests.shift();
    assert.equal(first.name, `sinochat:e2ee-session:${lifecycleUserId}`);
    let firstReleased = false;
    const held = first.deliver({ name: first.name }).then(() => {
      firstReleased = true;
    });
    const lease = await acquired;
    controller.abort();
    await Promise.resolve();
    assert.equal(
      firstReleased,
      false,
      "Un aborto posterior a la adquisicion no debe soltar la maquina activa",
    );

    const occupied = provider.acquire(lifecycleUserId);
    const rejectedOccupied = assert.rejects(occupied, {
      code: "MATRIX_SESSION_ALREADY_OPEN",
    });
    await requests.shift().deliver(null);
    await rejectedOccupied;
    lease.release();
    lease.release();
    await held;
    assert.equal(firstReleased, true);

    const pendingController = new AbortController();
    const pending = provider.acquire(lifecycleUserId, pendingController.signal);
    const pendingRequest = requests.shift();
    const pendingReason = new Error("aborto durante adquisicion");
    const rejectedPending = assert.rejects(
      pending,
      (error) => error === pendingReason,
    );
    pendingController.abort(pendingReason);
    await rejectedPending;
    await pendingRequest.deliver({ name: pendingRequest.name });

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(
      provider.acquire(lifecycleUserId, alreadyAborted.signal),
      { name: "AbortError" },
    );
    assert.equal(requests.length, 0);

    const rejectedRequest = provider.acquire(lifecycleUserId);
    const rejection = assert.rejects(rejectedRequest, {
      code: "MATRIX_SESSION_LOCK_FAILED",
    });
    requests.shift().reject(new DOMException("denegado", "SecurityError"));
    await rejection;

    locks.request = () => {
      throw new TypeError("solicitud rechazada sin promesa");
    };
    await assert.rejects(provider.acquire(lifecycleUserId), {
      code: "MATRIX_SESSION_LOCK_FAILED",
    });
  } finally {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    } else {
      delete globalThis.navigator;
    }
  }
  console.log(
    "[OK] Web Locks conserva ifAvailable, gestiona aborto pendiente y mantiene la lease adquirida hasta release.",
  );
}

async function checkBlockedGateDoesNotTouchCrypto(Lifecycle) {
  const order = [];
  const lifecycle = new Lifecycle(
    lifecycleApi(order, { state: "BLOCKED" }),
    forbiddenLocalStore(),
    memoryTokenStore(),
    async () => {
      throw new Error("CRYPTO_MUST_NOT_START_WHILE_BLOCKED");
    },
    forbiddenSessionLocks(),
  );
  const result = await lifecycle.start(sessionUser());
  assert.equal(result.state, "blocked");
  assert.deepEqual(order, ["status"]);
  await result.close();
}

async function checkReleaseProfileBeforeSessionLock(Lifecycle, LifecycleError) {
  const order = [];
  const api = lifecycleApi(order, { state: "READY" });
  api.getStatus = async () => {
    order.push("status");
    return {
      ...lifecycleRelease("READY"),
      clientLibrary: "otro-paquete",
    };
  };
  const lifecycle = new Lifecycle(
    api,
    forbiddenLocalStore(),
    memoryTokenStore(),
    async () => {
      throw new Error("CRYPTO_MUST_NOT_START_WITH_INVALID_PROFILE");
    },
    forbiddenSessionLocks(),
  );

  await assert.rejects(
    lifecycle.start(sessionUser()),
    (error) =>
      error instanceof LifecycleError &&
      error.code === "MATRIX_RELEASE_PROFILE_MISMATCH",
  );
  assert.deepEqual(order, ["status"]);
}

async function checkInitialRegistrationJournal(Lifecycle) {
  const order = [];
  const local = memoryLocalDeviceStore(order);
  const machine = lifecycleMachine(order, true);
  const locks = memorySessionLocks(order);
  const lifecycle = new Lifecycle(
    lifecycleApi(order, { state: "READY" }),
    local,
    memoryTokenStore(),
    async (input) => {
      order.push("crypto");
      assert.equal(input.sinochatUserId, lifecycleUserId);
      assert.equal(input.sinochatDeviceId, lifecycleDeviceId);
      assert.equal(input.storePassphrase, "P".repeat(43));
      return lifecycleCryptoSession(machine);
    },
    locks,
  );

  const result = await lifecycle.start(sessionUser());

  assert.equal(result.state, "ready");
  assert.equal(local.record.bindingSecret, "B".repeat(43));
  assert.equal(local.record.initialKeyUpload, undefined);
  assert.equal(local.record.initialCompletionResponse, undefined);
  assert.ok(order.indexOf("journal-request") < order.indexOf("complete"));
  assert.ok(order.indexOf("complete") < order.indexOf("journal-response"));
  assert.ok(order.indexOf("journal-response") < order.indexOf("mark"));
  assert.ok(order.indexOf("mark") < order.indexOf("journal-finish"));
  assert.ok(order.indexOf("journal-finish") < order.indexOf("cross-signing"));
  assert.ok(order.indexOf("cross-signing") < order.lastIndexOf("outgoing"));
  assert.ok(order.indexOf("lock-acquire") < order.indexOf("local-load"));
  assert.equal(locks.releaseCount, 0);
  await Promise.all([result.close(), result.close()]);
  assert.equal(machine.closed, true);
  assert.equal(locks.releaseCount, 1);
}

async function checkExclusiveSessionLease(Lifecycle, LifecycleError) {
  const order = [];
  const local = memoryLocalDeviceStore(order);
  const machine = lifecycleMachine(order, true);
  const locks = memorySessionLocks(order, LifecycleError);
  const first = new Lifecycle(
    lifecycleApi(order, { state: "READY" }),
    local,
    memoryTokenStore(),
    async () => lifecycleCryptoSession(machine),
    locks,
  );
  const firstResult = await first.start(sessionUser());

  const second = new Lifecycle(
    lifecycleApi(order, { state: "READY" }),
    forbiddenLocalStore(),
    memoryTokenStore(),
    async () => {
      throw new Error("SECOND_CRYPTO_MUST_NOT_START");
    },
    locks,
  );
  await assert.rejects(
    second.start(sessionUser()),
    (error) =>
      error instanceof LifecycleError &&
      error.code === "MATRIX_SESSION_ALREADY_OPEN",
  );
  assert.equal(locks.releaseCount, 0);
  await firstResult.close();
  assert.equal(locks.releaseCount, 1);

  const reacquired = await locks.acquire(lifecycleUserId);
  reacquired.release();
  assert.equal(locks.releaseCount, 2);
}

async function checkCrossSigningFailureReleasesLease(Lifecycle) {
  const order = [];
  const machine = lifecycleMachine(order, true);
  const locks = memorySessionLocks(order);
  const lifecycle = new Lifecycle(
    lifecycleApi(order, { state: "READY" }),
    memoryLocalDeviceStore(order), memoryTokenStore(),
    async () => lifecycleCryptoSession(machine), locks,
    async () => { throw new Error("FIXTURE_CROSS_SIGNING_FAILURE"); },
  );
  await assert.rejects(lifecycle.start(sessionUser()), /FIXTURE_CROSS_SIGNING_FAILURE/);
  assert.equal(machine.closed, true);
  assert.equal(locks.releaseCount, 1);
  assert.equal(order.at(-1), "lock-release");
}

async function checkFailedLifecycleReleasesLease(Lifecycle) {
  const order = [];
  const locks = memorySessionLocks(order);
  const lifecycle = new Lifecycle(
    lifecycleApi(order, { state: "READY" }),
    forbiddenLocalStore(),
    memoryTokenStore(),
    async () => {
      throw new Error("CRYPTO_MUST_NOT_START_AFTER_LOCAL_FAILURE");
    },
    locks,
  );

  await assert.rejects(
    lifecycle.start(sessionUser()),
    /LOCAL_STORE_MUST_NOT_BE_TOUCHED_WHILE_BLOCKED/,
  );
  assert.equal(locks.releaseCount, 1);
}

async function checkCloseDrainsCoordinator(Lifecycle) {
  const order = [];
  const local = memoryLocalDeviceStore(order);
  const machine = lifecycleMachine(order, true);
  const locks = memorySessionLocks(order);
  const api = lifecycleApi(order, { state: "READY" });
  let resolveSync;
  api.sync = async () =>
    new Promise((resolve) => {
      resolveSync = resolve;
    });
  const lifecycle = new Lifecycle(
    api,
    local,
    memoryTokenStore(),
    async () => lifecycleCryptoSession(machine),
    locks,
  );
  const result = await lifecycle.start(sessionUser());
  assert.equal(result.state, "ready");

  const syncing = result.coordinator.sync();
  for (let attempt = 0; attempt < 10 && !resolveSync; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(typeof resolveSync, "function");
  const closing = result.close();
  await Promise.resolve();
  assert.equal(machine.closed, false);
  assert.equal(locks.releaseCount, 0);

  resolveSync({
    next_batch: `sct1.${"A".repeat(22)}.${"B".repeat(43)}`,
    to_device: { events: [] },
    device_one_time_keys_count: { signed_curve25519: 7 },
    device_unused_fallback_key_types: ["signed_curve25519"],
  });
  await syncing;
  await closing;
  assert.equal(machine.closed, true);
  assert.equal(locks.releaseCount, 1);
}

async function checkExistingDeviceBinding(Lifecycle) {
  const order = [];
  const local = memoryLocalDeviceStore(order, {
    bindingSecret: "B".repeat(43),
  });
  const machine = lifecycleMachine(order, false);
  const locks = memorySessionLocks(order);
  const lifecycle = new Lifecycle(
    lifecycleApi(order, { state: "READY" }),
    local,
    memoryTokenStore(),
    async () => {
      order.push("crypto");
      return lifecycleCryptoSession(machine);
    },
    locks,
  );

  const result = await lifecycle.start(sessionUser());

  assert.equal(result.state, "ready");
  assert.ok(order.indexOf("bind") < order.indexOf("crypto"));
  assert.equal(order.includes("complete"), false);
  await result.close();
  assert.equal(locks.releaseCount, 1);
}

async function checkCrashAfterInitialMark(Lifecycle) {
  const order = [];
  const initialRequest = lifecycleInitialRequest();
  const completion = lifecycleCompletion();
  const local = memoryLocalDeviceStore(order, {
    bindingSecret: completion.bindingSecret,
    initialKeyUpload: initialRequest,
    initialCompletionResponse: JSON.stringify(completion),
  });
  const machine = lifecycleMachine(order, false);
  const locks = memorySessionLocks(order);
  const lifecycle = new Lifecycle(
    lifecycleApi(order, { state: "READY" }),
    local,
    memoryTokenStore(),
    async () => lifecycleCryptoSession(machine),
    locks,
  );

  const result = await lifecycle.start(
    sessionUser({ deviceId: lifecycleDeviceId }),
  );

  assert.equal(result.state, "ready");
  assert.equal(order.includes("complete"), false);
  assert.equal(order.includes("journal-finish"), true);
  assert.equal(local.record.initialKeyUpload, undefined);
  await result.close();
  assert.equal(locks.releaseCount, 1);
}

async function checkMarkOnlyAfterHttpSuccess(Coordinator) {
  const order = [];
  const request = fakeRequest({
    body: JSON.stringify({ one_time_keys: {} }),
    id: "upload-01",
    type: RequestType.KeysUpload,
  });
  const machine = fakeMachine([request], {
    onMark() {
      order.push("mark");
    },
  });
  const transport = emptyTransport({
    async uploadKeys() {
      order.push("http");
      return { one_time_key_counts: { signed_curve25519: 50 } };
    },
  });
  const coordinator = new Coordinator(
    machine,
    "D11111111111141118111111111111111",
    transport,
    memoryTokenStore(),
  );

  assert.equal(await coordinator.flushOutgoingRequests(), 1);
  assert.deepEqual(order, ["http", "mark"]);
  assert.equal(request.freed, true);

  const failed = fakeRequest({
    body: JSON.stringify({ one_time_keys: {} }),
    id: "upload-02",
    type: RequestType.KeysUpload,
  });
  let marked = false;
  const failingCoordinator = new Coordinator(
    fakeMachine([failed], { onMark: () => { marked = true; } }),
    "D11111111111141118111111111111111",
    emptyTransport({
      async uploadKeys() {
        throw new Error("HTTP_FAILED");
      },
    }),
    memoryTokenStore(),
  );
  await assert.rejects(
    failingCoordinator.flushOutgoingRequests(),
    /HTTP_FAILED/,
  );
  assert.equal(marked, false);
  assert.equal(failed.freed, true);
}

async function checkQueryChunking(Coordinator) {
  const users = Object.fromEntries(
    Array.from({ length: 21 }, (_, index) => [
      matrixUser(index + 1),
      [],
    ]),
  );
  const request = fakeRequest({
    body: JSON.stringify({ device_keys: users }),
    id: "query-01",
    type: RequestType.KeysQuery,
  });
  const chunkSizes = [];
  let markedResponse;
  const machine = fakeMachine([request], {
    onMark(_id, _type, response) {
      markedResponse = JSON.parse(response);
    },
  });
  const coordinator = new Coordinator(
    machine,
    "D11111111111141118111111111111111",
    emptyTransport({
      async queryKeys(body) {
        const requested = Object.keys(body.device_keys);
        chunkSizes.push(requested.length);
        return {
          device_keys: Object.fromEntries(
            requested.map((userId) => [userId, {}]),
          ),
          failures: {},
          master_keys: {},
          self_signing_keys: {},
          user_signing_keys: {},
        };
      },
    }),
    memoryTokenStore(),
  );

  await coordinator.flushOutgoingRequests();
  assert.deepEqual(chunkSizes, [20, 1]);
  assert.equal(Object.keys(markedResponse.device_keys).length, 21);
}

async function checkClaimSplitting(Coordinator) {
  const firstUser = matrixUser(41);
  const secondUser = matrixUser(42);
  const body = {
    one_time_keys: {
      [firstUser]: {
        D11111111111141118111111111111111: "signed_curve25519",
      },
      [secondUser]: {
        D22222222222242228222222222222222: "signed_curve25519",
      },
    },
    timeout: 10_000,
  };

  const first = await runClaim(Coordinator, body);
  const second = await runClaim(Coordinator, body);
  assert.equal(first.ids.length, 2);
  assert.equal(new Set(first.ids).size, 2);
  assert.deepEqual(first.ids, second.ids);
  for (const id of first.ids) {
    assert.match(id, /^claim_[A-Za-z0-9_-]{43}$/);
  }
  assert.deepEqual(Object.keys(first.response.one_time_keys).sort(), [
    firstUser,
    secondUser,
  ]);
}

async function runClaim(Coordinator, body) {
  const request = fakeRequest({
    body: JSON.stringify(body),
    id: "claim-original-01",
    type: RequestType.KeysClaim,
  });
  const ids = [];
  let response;
  const coordinator = new Coordinator(
    fakeMachine([request], {
      onMark(_id, _type, rawResponse) {
        response = JSON.parse(rawResponse);
      },
    }),
    "D11111111111141118111111111111111",
    emptyTransport({
      async claimKeys(requestId, requestBody) {
        ids.push(requestId);
        const userId = Object.keys(requestBody.one_time_keys)[0];
        return {
          failures: {},
          one_time_keys: { [userId]: {} },
        };
      },
    }),
    memoryTokenStore(),
  );
  await coordinator.flushOutgoingRequests();
  return { ids, response };
}

async function checkSyncCommitOrder(Coordinator, TransportError) {
  const order = [];
  const applicationEvent = fakeProcessedEvent(
    ProcessedToDeviceEventType.Decrypted,
    "com.sinochat.message.v1",
  );
  const controlEvent = fakeProcessedEvent(
    ProcessedToDeviceEventType.PlainText,
    "m.room_key_request",
  );
  const machine = fakeMachine([], {
    async onReceive() {
      order.push("receive");
      return [applicationEvent, controlEvent];
    },
  });
  const store = memoryTokenStore({
    onSave() {
      order.push("save");
    },
  });
  const nextBatch = `sct1.${"A".repeat(22)}.${"B".repeat(43)}`;
  const coordinator = new Coordinator(
    machine,
    "D11111111111141118111111111111111",
    emptyTransport({
      async sync() {
        order.push("http");
        return {
          next_batch: nextBatch,
          to_device: { events: [] },
          device_one_time_keys_count: { signed_curve25519: 7 },
          device_unused_fallback_key_types: ["signed_curve25519"],
        };
      },
    }),
    store,
  );

  const result = await coordinator.sync();
  assert.deepEqual(order, ["http", "receive", "save"]);
  assert.equal(result.nextBatch, nextBatch);
  assert.equal(result.rejectedApplicationEventCount, 1);
  assert.equal(applicationEvent.freed, true);
  assert.equal(result.processedControlEvents.length, 1);
  assert.equal(result.processedControlEvents[0], controlEvent);
  controlEvent.free();

  let syncCalled = false;
  const invalidStore = memoryTokenStore();
  invalidStore.value = "token-local-corrupto";
  const invalidCoordinator = new Coordinator(
    fakeMachine([]),
    "D11111111111141118111111111111111",
    emptyTransport({
      async sync() {
        syncCalled = true;
      },
    }),
    invalidStore,
  );
  await assert.rejects(
    invalidCoordinator.sync(),
    (error) =>
      error instanceof TransportError &&
      error.code === "MATRIX_SYNC_TOKEN_LOCAL_INVALID",
  );
  assert.equal(syncCalled, false);
  assert.equal(invalidStore.value, undefined);
}

function fakeMachine(initialRequests, hooks = {}) {
  let emitted = false;
  return {
    async outgoingRequests() {
      if (emitted) return [];
      emitted = true;
      return initialRequests;
    },
    async markRequestAsSent(id, type, response) {
      hooks.onMark?.(id, type, response);
      return true;
    },
    async receiveSyncChanges(...argumentsList) {
      return hooks.onReceive?.(...argumentsList) ?? [];
    },
  };
}

function fakeRequest({ body, id, type }) {
  return {
    body,
    id,
    type,
    freed: false,
    free() {
      this.freed = true;
    },
  };
}

function fakeProcessedEvent(type, eventType) {
  return {
    type,
    rawEvent: JSON.stringify({
      type: eventType,
      sender: matrixUser(99),
      content: {},
    }),
    freed: false,
    free() {
      this.freed = true;
    },
  };
}

function emptyTransport(overrides = {}) {
  const unsupported = async () => {
    throw new Error("UNEXPECTED_MATRIX_HTTP_REQUEST");
  };
  return {
    uploadKeys: unsupported,
    queryKeys: unsupported,
    claimKeys: unsupported,
    sendToDevice: unsupported,
    sync: unsupported,
    ...overrides,
  };
}

function memoryTokenStore(hooks = {}) {
  return {
    value: undefined,
    async load() {
      return this.value;
    },
    async save(_deviceId, token) {
      hooks.onSave?.(token);
      this.value = token;
    },
    async clear() {
      this.value = undefined;
    },
  };
}

function matrixUser(value) {
  return `@u${value.toString(16).padStart(32, "0")}:sinochat.invalid`;
}

function sessionUser(overrides = {}) {
  return {
    id: lifecycleUserId,
    username: "cliente",
    role: "CLIENT",
    status: "ACTIVE",
    deviceId: null,
    ...overrides,
  };
}

function lifecycleRelease(state) {
  return {
    state,
    reasonCode:
      state === "READY" ? "E2EE_READY" : "E2EE_INTEGRATION_INCOMPLETE",
    protocol: "Matrix Olm/Megolm",
    clientLibrary: "@matrix-org/matrix-sdk-crypto-wasm",
    clientLibraryVersion: "18.6.0",
    matrixSpecificationVersion: "v1.18",
    messageRetentionHours: 48,
    message: state === "READY" ? "Disponible" : "Bloqueado",
  };
}

function lifecycleApi(order, { state }) {
  const unexpected = async () => {
    throw new Error("UNEXPECTED_LIFECYCLE_HTTP_REQUEST");
  };
  return {
    async fixtureCrossSigningInitialized() {
      order.push("cross-signing");
    },
    async getStatus() {
      order.push("status");
      return lifecycleRelease(state);
    },
    async reserveDevice() {
      order.push("reserve");
      return {
        deviceId: lifecycleDeviceId,
        matrixUserId: lifecycleMatrixUserId,
        matrixDeviceId: lifecycleMatrixDeviceId,
        matrixServerName: "sinochat.invalid",
        expiresAt: "2026-08-28T13:10:00.000Z",
      };
    },
    async completeDevice(registrationId, body) {
      order.push("complete");
      assert.equal(registrationId, lifecycleDeviceId);
      assert.deepEqual(body, { device_keys: { public: true } });
      return lifecycleCompletion();
    },
    async bindSession(deviceId, bindingSecret) {
      order.push("bind");
      assert.equal(deviceId, lifecycleDeviceId);
      assert.equal(bindingSecret, "B".repeat(43));
    },
    uploadKeys: unexpected,
    queryKeys: unexpected,
    claimKeys: unexpected,
    sendToDevice: unexpected,
    sync: unexpected,
  };
}

function lifecycleCompletion() {
  return {
    deviceId: lifecycleDeviceId,
    matrixUserId: lifecycleMatrixUserId,
    matrixDeviceId: lifecycleMatrixDeviceId,
    bindingSecret: "B".repeat(43),
    publishedAt: "2026-08-28T13:00:00.000Z",
    one_time_key_counts: { signed_curve25519: 50 },
  };
}

function lifecycleInitialRequest() {
  return {
    requestId: "initial-upload-01",
    requestType: RequestType.KeysUpload,
    body: JSON.stringify({ device_keys: { public: true } }),
  };
}

function lifecycleMachine(order, initialPending) {
  let pending = initialPending;
  return {
    closed: false,
    async outgoingRequests() {
      order.push("outgoing");
      return pending ? [fakeRequest(lifecycleInitialRequestAsFake())] : [];
    },
    async markRequestAsSent(id, type, response) {
      order.push("mark");
      const request = lifecycleInitialRequest();
      assert.equal(id, request.requestId);
      assert.equal(type, request.requestType);
      assert.deepEqual(JSON.parse(response), lifecycleCompletion());
      pending = false;
      return true;
    },
    async receiveSyncChanges() {
      return [];
    },
    close() {
      this.closed = true;
    },
  };
}

function lifecycleInitialRequestAsFake() {
  const request = lifecycleInitialRequest();
  return {
    id: request.requestId,
    type: request.requestType,
    body: request.body,
  };
}

function lifecycleCryptoSession(machine) {
  return {
    identity: {
      userId: lifecycleMatrixUserId,
      deviceId: lifecycleMatrixDeviceId,
      roomIdFor(conversationId) {
        return `!c${conversationId.replaceAll("-", "")}:sinochat.invalid`;
      },
    },
    machine,
    close() {
      machine.close();
    },
  };
}

function memoryLocalDeviceStore(order, seed) {
  let record = seed
    ? {
        userId: lifecycleUserId,
        deviceId: lifecycleDeviceId,
        matrixServerName: "sinochat.invalid",
        storePassphrase: "P".repeat(43),
        ...seed,
      }
    : undefined;
  return {
    get record() {
      return record;
    },
    async load() {
      order.push("local-load");
      return record ? structuredClone(record) : undefined;
    },
    async createProvisional(input) {
      order.push("local-create");
      record = {
        ...input,
        storePassphrase: "P".repeat(43),
      };
      return structuredClone(record);
    },
    async saveInitialKeyUpload(_userId, _deviceId, request) {
      order.push("journal-request");
      record = { ...record, initialKeyUpload: structuredClone(request) };
      return structuredClone(record);
    },
    async saveInitialCompletion(
      _userId,
      _deviceId,
      bindingSecret,
      response,
    ) {
      order.push("journal-response");
      record = {
        ...record,
        bindingSecret,
        initialCompletionResponse: response,
      };
      return structuredClone(record);
    },
    async finishInitialKeyUpload() {
      order.push("journal-finish");
      record = { ...record };
      delete record.initialKeyUpload;
      delete record.initialCompletionResponse;
      return structuredClone(record);
    },
    async clear() {
      record = undefined;
    },
  };
}

function forbiddenLocalStore() {
  const forbidden = async () => {
    throw new Error("LOCAL_STORE_MUST_NOT_BE_TOUCHED_WHILE_BLOCKED");
  };
  return {
    load: forbidden,
    createProvisional: forbidden,
    saveInitialKeyUpload: forbidden,
    saveInitialCompletion: forbidden,
    finishInitialKeyUpload: forbidden,
    clear: forbidden,
  };
}

function forbiddenSessionLocks() {
  return {
    async acquire() {
      throw new Error("SESSION_LOCK_MUST_NOT_BE_TOUCHED");
    },
  };
}

function memorySessionLocks(order, LifecycleError) {
  let active = false;
  let releaseCount = 0;
  return {
    get releaseCount() {
      return releaseCount;
    },
    async acquire(userId) {
      assert.equal(userId, lifecycleUserId);
      order.push("lock-acquire");
      if (active) {
        if (LifecycleError) {
          throw new LifecycleError("MATRIX_SESSION_ALREADY_OPEN");
        }
        throw new Error("MATRIX_SESSION_ALREADY_OPEN");
      }
      active = true;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          active = false;
          releaseCount += 1;
          order.push("lock-release");
        },
      };
    },
  };
}
