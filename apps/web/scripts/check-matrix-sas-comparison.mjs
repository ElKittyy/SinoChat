import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { RequestType } from "@matrix-org/matrix-sdk-crypto-wasm";
import ts from "typescript";
import { assertTemporaryChild } from "./browser-test-environment.mjs";

// Controller regression using a controllable SDK port. SDK cryptography and
// the React clicks are checked separately, not simulated by these state tests.
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prefix = ".sas-comparison-test-";
const temporary = await mkdtemp(resolve(webRoot, prefix));
try {
  const source = await readFile(resolve(webRoot, "src/e2ee/matrixSasComparison.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true,
  });
  assert.deepEqual(compiled.diagnostics ?? [], []);
  await writeFile(resolve(temporary, "comparison.mjs"), compiled.outputText, "utf8");
  const { MatrixSasComparison, MatrixSasComparisonError } = await import(pathToFileURL(resolve(temporary, "comparison.mjs")));
  const USER = "@u11111111111141118111111111111111:sinochat.invalid";
  const SELF = "D22222222222242228222222222222222";
  const OTHER = "D33333333333343338333333333333333";
  const FLOW = "synthetic-flow-01";
  const timestamp = 1_800_000_000_000;
  const scope = { userId: USER, deviceId: SELF, otherDeviceId: OTHER, flowId: FLOW, expiresAtMs: timestamp + 10_000 };

  function fixture(overrides = {}) {
    const state = { wall: timestamp, monotonic: 500, present: true, confirmed: false, done: false, cancelled: false,
      timeout: false, decimals: [1234, 5678, 9012], confirmCalls: 0, cancelCodes: [], sent: 0, freed: 0, requestsFreed: 0, cancellationsFreed: 0,
      userId: USER, deviceId: SELF, otherUserId: USER, otherDeviceId: OTHER, flowId: FLOW, roomId: undefined,
      selfVerification: true, fromRequest: true, ...overrides };
    const handle = (text) => ({ toString: () => text, free() {} });
    const packet = (type = "m.key.verification.mac", target = OTHER, flow = FLOW) => {
      let released = false;
      return ({
      type: RequestType.ToDevice, id: "real-sdk-request-id-synthetic-test", event_type: type,
      body: JSON.stringify({ messages: { [USER]: { [target]: { transaction_id: flow } } } }),
      free() {
        assert.equal(released, false, "Each SDK request wrapper must be freed exactly once");
        released = true;
        state.requestsFreed++;
        if (type === "m.key.verification.cancel") state.cancellationsFreed++;
      },
    }); };
    const sas = {
      get userId() { return handle(state.userId); }, get deviceId() { return handle(state.deviceId); },
      get otherUserId() { return handle(state.otherUserId); }, get otherDeviceId() { return handle(state.otherDeviceId); },
      get flowId() { return state.flowId; }, get roomId() { return state.roomId ? handle(state.roomId) : undefined; },
      isSelfVerification: () => state.selfVerification, startedFromRequest: () => state.fromRequest,
      isDone: () => state.done, haveWeConfirmed: () => state.confirmed, canBePresented: () => state.present,
      timedOut: () => state.timeout, isCancelled: () => state.cancelled, decimals: () => state.decimals,
      async confirm() { state.confirmCalls++; state.confirmed = true; return state.requests ?? [packet()]; },
      cancelWithCode(code) { state.cancelCodes.push(code); state.cancelled = true; return packet("m.key.verification.cancel"); },
      free() { state.freed++; },
    };
    let tail = Promise.resolve();
    const channel = {
      runExclusive(operation) { const next = tail.then(operation, operation); tail = next.catch(() => {}); return next; },
      async send(request, signal) { assert.equal(signal.aborted, false); state.sent++; await state.onSend?.(request, signal); },
    };
    const controller = new MatrixSasComparison(sas, { ...scope, expiresAtMs: state.expiresAtMs ?? scope.expiresAtMs }, channel,
      { wall: () => state.wall, monotonic: () => state.monotonic });
    return { state, sas, controller, packet, channel };
  }
  function errorCode(code) {
    return (error) => {
      assert.ok(error instanceof MatrixSasComparisonError);
      assert.equal(error.message, error.code);
      assert.equal(error.code, code);
      assert.equal(Object.hasOwn(error, "cause"), false);
      return true;
    };
  }
  async function withFixture(operation, overrides) {
    const f = fixture(overrides);
    try { await operation(f); }
    finally { await f.controller.close(); assert.equal(f.state.freed, 1); }
  }

  await test("read never confirms or sends; receipt is stable and snapshots are immutable", async () => {
    await withFixture(async ({ controller, state }) => {
      const view = await controller.read();
      assert.equal(view.state, "compare");
      assert.equal((await controller.read()).comparisonId, view.comparisonId);
      assert.ok(Object.isFrozen(view) && Object.isFrozen(view.decimals));
      assert.equal(state.confirmCalls, 0); assert.equal(state.sent, 0);
      assert.throws(() => { view.decimals[0] = 9999; });
    });
  });
  await test("confirmation needs an actually issued receipt, then waits for the peer", async () => {
    await withFixture(async ({ controller, state }) => {
      await assert.rejects(controller.confirm("guessed"), errorCode("MATRIX_SAS_COMPARISON_STALE"));
      assert.equal(state.confirmCalls, 0);
      const view = await controller.read();
      assert.equal((await controller.confirm(view.comparisonId)).state, "waiting-peer");
      assert.equal(state.confirmCalls, 1); assert.equal(state.sent, 1); assert.equal(state.requestsFreed, 1);
      state.done = true;
      assert.deepEqual(await controller.read(), { state: "comparison-complete" });
    });
  });
  await test("old visible values cannot confirm a changed comparison", async () => {
    await withFixture(async ({ controller, state }) => {
      const old = await controller.read(); state.decimals = [1111, 2222, 3333];
      await assert.rejects(controller.confirm(old.comparisonId), errorCode("MATRIX_SAS_COMPARISON_STALE"));
      assert.equal(state.confirmCalls, 0);
      assert.notEqual((await controller.read()).comparisonId, old.comparisonId);
    });
  });
  await test("no confirm while waiting and no receipt reuse after values disappear", async () => {
    await withFixture(async ({ controller, state }) => {
      const old = await controller.read(); state.present = false;
      assert.deepEqual(await controller.read(), { state: "waiting" });
      await assert.rejects(controller.confirm(old.comparisonId), errorCode("MATRIX_SAS_COMPARISON_STALE"));
      state.present = true;
      assert.notEqual((await controller.read()).comparisonId, old.comparisonId);
    });
  });
  await test("queued double click confirms only once", async () => {
    await withFixture(async ({ controller, state }) => {
      const view = await controller.read();
      const results = await Promise.allSettled([controller.confirm(view.comparisonId), controller.confirm(view.comparisonId)]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(state.confirmCalls, 1); assert.equal(state.sent, 1);
    });
  });
  for (const reason of ["wall", "monotonic", "sdk", "invalid-clock"]) {
    await test(`expires inclusively and never recovers after clock rollback: ${reason}`, async () => {
      await withFixture(async ({ controller, state }) => {
        const old = await controller.read();
        if (reason === "wall") state.wall = scope.expiresAtMs;
        if (reason === "monotonic") { state.monotonic += 10_000; state.wall -= 300_000; }
        if (reason === "sdk") state.timeout = true;
        if (reason === "invalid-clock") state.wall = Number.NaN;
        assert.deepEqual(await controller.read(), { state: "expired" });
        state.wall = timestamp; state.monotonic = 500; state.timeout = false;
        await assert.rejects(controller.confirm(old.comparisonId), errorCode("MATRIX_SAS_COMPARISON_STALE"));
        assert.deepEqual(await controller.read(), { state: "expired" }); assert.equal(state.confirmCalls, 0);
      });
    });
  }
  await test("one millisecond before the deadline still displays the comparison", async () => {
    await withFixture(async ({ controller, state }) => {
      state.wall = scope.expiresAtMs - 1; state.monotonic += 9999;
      assert.equal((await controller.read()).state, "compare");
    });
  });
  for (const field of ["userId", "deviceId", "otherUserId", "otherDeviceId", "flowId", "roomId", "selfVerification", "fromRequest"]) {
    await test(`binds the SDK flow on every operation: ${field}`, async () => {
      await withFixture(async ({ controller, state }) => {
        const old = await controller.read();
        state[field] = ["selfVerification", "fromRequest"].includes(field) ? false : "different";
        await assert.rejects(controller.confirm(old.comparisonId), errorCode("MATRIX_SAS_FLOW_MISMATCH"));
        assert.deepEqual(await controller.read(), { state: "failed" }); assert.equal(state.confirmCalls, 0);
      });
    });
  }
  for (const decimals of [undefined, [1234, 5678], [999, 1234, 1234], [9192, 1234, 1234], [1000.1, 1234, 1234], [NaN, 1234, 1234]]) {
    await test("malformed SAS presentation fails closed without exposing values", async () => {
      await withFixture(async ({ controller }) => {
        await assert.rejects(controller.read(), errorCode("MATRIX_SAS_DECIMALS_INVALID"));
        assert.deepEqual(await controller.read(), { state: "failed" });
      }, { decimals });
    });
  }
  for (const action of ["reject", "cancel"]) {
    await test(`${action} is irreversible and sends the appropriate SDK cancellation`, async () => {
      await withFixture(async ({ controller, state }) => {
        const old = await controller.read();
        assert.deepEqual(await controller[action](), { state: "cancelled" });
        await controller[action]();
        assert.deepEqual(state.cancelCodes, [action === "reject" ? "m.mismatched_sas" : "m.user"]);
        await assert.rejects(controller.confirm(old.comparisonId), errorCode("MATRIX_SAS_COMPARISON_STALE"));
        assert.equal(state.confirmCalls, 0); assert.equal(state.sent, 1);
      });
    });
  }
  await test("remote cancellation and SDK confirmation outside this controller cannot approve", async () => {
    await withFixture(async ({ controller, state }) => {
      state.cancelled = true; assert.deepEqual(await controller.read(), { state: "cancelled" });
    });
    await withFixture(async ({ controller, state }) => {
      state.confirmed = true; state.done = true;
      await assert.rejects(controller.read(), errorCode("MATRIX_SAS_UNCONFIRMED_COMPLETION"));
    });
  });
  for (const change of ["secret", "peer", "flow", "room", "no-id", "bad-json"]) {
    await test(`rejects the complete outgoing batch before I/O: ${change}`, async () => {
      await withFixture(async ({ controller, state, packet }) => {
        const bad = packet();
        if (change === "secret") bad.event_type = "m.secret.send";
        if (change === "peer") bad.body = packet(undefined, SELF).body;
        if (change === "flow") bad.body = packet(undefined, OTHER, "wrong").body;
        if (change === "room") bad.type = RequestType.RoomMessage;
        if (change === "no-id") bad.id = undefined;
        if (change === "bad-json") bad.body = "private-error-detail";
        state.requests = [packet(), bad];
        const view = await controller.read();
        await assert.rejects(controller.confirm(view.comparisonId), errorCode("MATRIX_SAS_OUTGOING_INVALID"));
        assert.equal(state.sent, 0);
        assert.equal(state.requestsFreed - state.cancellationsFreed, 2);
        assert.equal(state.cancellationsFreed, 1);
        assert.deepEqual(state.cancelCodes, ["m.user"]);
        assert.equal(state.cancelled, true, "A failed batch must also cancel the live SDK flow");
      });
    });
  }
  await test("transport failure does not report completion or retry; only safe code escapes", async () => {
    await withFixture(async ({ controller, state }) => {
      state.onSend = () => { state.done = true; throw new Error("private-error-detail"); };
      const view = await controller.read();
      await assert.rejects(controller.confirm(view.comparisonId), errorCode("MATRIX_SAS_OPERATION_FAILED"));
      assert.deepEqual(await controller.read(), { state: "failed" });
      await assert.rejects(controller.confirm(view.comparisonId), errorCode("MATRIX_SAS_COMPARISON_STALE"));
      assert.equal(state.sent, 1); assert.equal(state.requestsFreed, 1);
    });
  });
  await test("expiry during I/O prevents the next packet and completion", async () => {
    await withFixture(async ({ controller, state, packet }) => {
      state.requests = [packet(), packet("m.key.verification.done")];
      state.onSend = () => { state.wall = scope.expiresAtMs; state.done = true; };
      const view = await controller.read();
      assert.deepEqual(await controller.confirm(view.comparisonId), { state: "expired" });
      assert.equal(state.sent, 1); assert.equal(state.requestsFreed, 2);
    });
  });
  await test("close aborts in-flight transport and waits to free the SDK handle exactly once", async () => {
    const f = fixture();
    let releaseSend, entered;
    const started = new Promise((resolve) => { entered = resolve; });
    f.state.onSend = async (_request, signal) => {
      entered(signal); await new Promise((resolve) => { releaseSend = resolve; });
    };
    const view = await f.controller.read();
    const pending = f.controller.confirm(view.comparisonId);
    const signal = await started;
    const closed = f.controller.close();
    assert.equal(signal.aborted, true); assert.equal(f.state.freed, 0);
    releaseSend();
    assert.deepEqual(await pending, { state: "closed" });
    await closed; await f.controller.close();
    assert.equal(f.state.freed, 1); assert.deepEqual(await f.controller.read(), { state: "closed" });
    assert.equal(f.state.cancelled, true, "Closing also cancels the SDK flow, not just the UI wrapper");
  });
  await test("remote cancellation during I/O prevents all following packets", async () => {
    await withFixture(async ({ controller, state, packet }) => {
      state.requests = [packet(), packet("m.key.verification.done")];
      state.onSend = () => { state.cancelled = true; };
      const view = await controller.read();
      assert.deepEqual(await controller.confirm(view.comparisonId), { state: "cancelled" });
      assert.equal(state.sent, 1); assert.equal(state.requestsFreed, 2);
    });
  });
  await test("cancel intent aborts a pending confirm before its queued cancellation runs", async () => {
    await withFixture(async ({ controller, state, packet }) => {
      state.requests = [packet(), packet("m.key.verification.done")];
      let entered, release;
      const started = new Promise((resolve) => { entered = resolve; });
      state.onSend = async (request, signal) => {
        if (request.event_type === "m.key.verification.cancel") return;
        entered(signal); await new Promise((resolve) => { release = resolve; });
      };
      const view = await controller.read();
      const pending = controller.confirm(view.comparisonId);
      const signal = await started;
      const cancelled = controller.reject();
      assert.equal(signal.aborted, true);
      release();
      assert.deepEqual(await pending, { state: "cancelled" });
      assert.deepEqual(await cancelled, { state: "cancelled" });
      assert.deepEqual(state.cancelCodes, ["m.mismatched_sas"]);
      assert.equal(state.sent, 2, "Only the initial packet and the cancellation are sent");
      assert.equal(state.requestsFreed, 3);
    });
  });
  await test("a transport rejecting an aborted confirm still allows queued SDK cancellation", async () => {
    await withFixture(async ({ controller, state }) => {
      let entered;
      const started = new Promise((resolve) => { entered = resolve; });
      state.onSend = async (request, signal) => {
        if (request.event_type === "m.key.verification.cancel") return;
        entered(); await new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("ABORTED_PRIVATE_DETAIL")), { once: true });
        });
      };
      const view = await controller.read();
      const pending = assert.rejects(controller.confirm(view.comparisonId), errorCode("MATRIX_SAS_OPERATION_FAILED"));
      await started;
      assert.deepEqual(await controller.cancel(), { state: "cancelled" });
      await pending;
      assert.equal(state.cancelled, true); assert.equal(state.sent, 2);
    });
  });
  await test("deadline timer aborts a hanging send without waiting for another read", async () => {
    await withFixture(async ({ controller, state }) => {
      state.onSend = async (_request, signal) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("TIMED_OUT_PRIVATE_DETAIL")), { once: true });
      });
      const view = await controller.read();
      await assert.rejects(controller.confirm(view.comparisonId), errorCode("MATRIX_SAS_OPERATION_FAILED"));
      assert.deepEqual(await controller.read(), { state: "expired" });
      assert.equal(state.cancelled, true); assert.equal(state.confirmCalls, 1);
    }, { expiresAtMs: timestamp + 30 });
  });
} finally {
  assertTemporaryChild(webRoot, temporary, prefix);
  await rm(temporary, { recursive: true, force: true });
}
