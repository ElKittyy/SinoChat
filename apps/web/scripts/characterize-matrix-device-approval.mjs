import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import {
  DeviceId, DeviceLists, OlmMachine, RequestType, UserId, VerificationMethod, initAsync,
} from "@matrix-org/matrix-sdk-crypto-wasm";

// Characterization only: in-memory SDK machines, synthetic public-key directory,
// no HTTP, database, real users, private-key export, recovery, or release gate.
// Device.verify() creates a signature; it is NOT a verification ceremony. An
// application must authenticate the displayed key through an independent channel
// before calling it. The synthetic confirmations below do not implement that UI.
const USER = "@u11111111111141118111111111111111:sinochat.invalid";
const FIRST = "D22222222222242228222222222222222";
const SECOND = "D33333333333343338333333333333333";
const FOREIGN_USER = "@u44444444444444448444444444444444:sinochat.invalid";
const FOREIGN_DEVICE = "D55555555555545558555555555555555";
await initAsync();
const { MatrixSasComparison } = await loadComparisonController();

await test("Device.verify signs only the second device's original public keys, without a request id", async () => {
  await withFixture(async (f) => {
    const before = await deviceState(f.first.machine, SECOND);
    assert.equal(before.crossSigned, false);
    assert.equal(before.verified, false);
    const result = await signDevice(f.first.machine, USER, SECOND);
    assert.equal(result.id, undefined);
    assert.equal(result.type, RequestType.SignatureUpload);
    assert.deepEqual(Object.keys(result.body), [USER]);
    assert.deepEqual(Object.keys(result.body[USER]), [SECOND]);
    const certificate = result.body[USER][SECOND];
    assert.deepEqual(Object.keys(certificate).sort(), ["algorithms", "device_id", "keys", "signatures", "user_id"]);
    assert.deepEqual(withoutSignatures(certificate), withoutSignatures(f.second.original));
    assert.deepEqual(Object.keys(certificate.signatures), [USER]);
    assert.deepEqual(Object.keys(certificate.signatures[USER]), [`ed25519:${f.selfKey}`]);
    verifyPublicSignature(certificate, f.selfKey, certificate.signatures[USER][`ed25519:${f.selfKey}`]);
    assertPublicOnly(result.body);

    const retry = await signDevice(f.first.machine, USER, SECOND);
    assert.deepEqual(retry, result, "Repeated direct verification is deterministic for the same keys");
    const pending = await f.first.machine.outgoingRequests();
    try {
      assert.equal(pending.some((request) => request.type === RequestType.SignatureUpload), false,
        "Direct Device.verify does not queue an id-bearing signature request");
    } finally { pending.forEach((request) => request.free()); }
    // No fabricated markRequestAsSent for a request without an id.
    console.log("[OK] SignatureUpload: { USER: { SECOND_DEVICE: original_device_keys + self_signing_signature } }; id=undefined; no ACK invented.");
  });
});

await test("Publishing and querying the certificate trusts the second device on the initial trusted machine", async () => {
  await withFixture(async (f) => {
    const signed = await signDevice(f.first.machine, USER, SECOND);
    const beforeQuery = await deviceState(f.first.machine, SECOND);
    f.directory.device_keys[USER][SECOND] = mergeCertificate(f.second.original, signed.body[USER][SECOND]);
    await query(f.first.machine, f.directory);
    const afterQuery = await deviceState(f.first.machine, SECOND);
    assert.equal(afterQuery.crossSigned, true);
    assert.equal(afterQuery.crossSigningTrusted, true);
    assert.equal(afterQuery.verified, true);
    console.log(`[OK] Initial machine: after Device.verify/before query=${JSON.stringify(beforeQuery)}; after certificate query=${JSON.stringify(afterQuery)}.`);
  });
});

await test("The new device gets a valid certificate without acquiring cross-signing private keys or automatically trusting the root", async () => {
  await withFixture(async (f) => {
    const signed = await signDevice(f.first.machine, USER, SECOND);
    f.directory.device_keys[USER][SECOND] = mergeCertificate(f.second.original, signed.body[USER][SECOND]);
    await query(f.second.machine, f.directory);
    const identity = await identityState(f.second.machine);
    assert.equal(identity.trustsOwnDevice, true);
    assert.equal(identity.verified, false, "A server-supplied signed device does not authenticate the root to a new client");
    assert.equal(identity.violation, false);
    assert.deepEqual(await privateKeyAvailability(f.second.machine), { master: false, selfSigning: false, userSigning: false });
    console.log(`[OK] New device after certificate query: ${JSON.stringify(identity)}; no cross-signing private keys.`);
  });
});

await test("Explicit own-root verification on the new device signs the root with its device key, not the self-signing key", async () => {
  await withFixture(async (f) => {
    const signed = await signDevice(f.first.machine, USER, SECOND);
    f.directory.device_keys[USER][SECOND] = mergeCertificate(f.second.original, signed.body[USER][SECOND]);
    await query(f.second.machine, f.directory);
    const user = new UserId(USER);
    const own = await f.second.machine.getIdentity(user);
    user.free();
    assert.ok(own);
    let request;
    try {
      // Synthetic external confirmation: this fixture already holds the first
      // machine's public root. Never replace this with trusting HTTP alone.
      assert.deepEqual(JSON.parse(own.masterKey).keys, f.signing.master_key.keys);
      request = await own.verify();
      assert.equal(request.id, undefined);
      assert.equal(request.type, RequestType.SignatureUpload);
      const body = JSON.parse(request.body);
      assert.deepEqual(Object.keys(body), [USER]);
      assert.deepEqual(Object.keys(body[USER]), [f.masterKey]);
      const root = body[USER][f.masterKey];
      assert.deepEqual(withoutSignatures(root), withoutSignatures(f.signing.master_key));
      assert.ok(root.signatures[USER][`ed25519:${SECOND}`]);
      verifyPublicSignature(root, f.second.original.keys[`ed25519:${SECOND}`], root.signatures[USER][`ed25519:${SECOND}`]);
      assertPublicOnly(body);
    } finally { request?.free(); own.free(); }
    const after = await identityState(f.second.machine);
    assert.equal(after.verified, true);
    assert.equal(after.trustsOwnDevice, true);
    assert.deepEqual(await privateKeyAvailability(f.second.machine), { master: false, selfSigning: false, userSigning: false });
    console.log("[OK] Explicit own-root verification emits { USER: { MASTER_PUBLIC_KEY: master_key_with_new_device_signature } }; id=undefined. It does not recover cross-signing secrets.");
  });
});

await test("The new device cannot approve another device without the self-signing private key", async () => {
  await withFixture(async (f) => {
    await assert.rejects(signDevice(f.second.machine, USER, FIRST));
    assert.deepEqual(await privateKeyAvailability(f.second.machine), { master: false, selfSigning: false, userSigning: false });
  });
});

await test("Device.verify rejects a different user's device even on the trusted signing machine", async () => {
  await withFixture(async (f) => {
    const foreign = await makeMachine(FOREIGN_USER, FOREIGN_DEVICE);
    try {
      f.directory.device_keys[FOREIGN_USER] = { [FOREIGN_DEVICE]: foreign.original };
      await query(f.first.machine, f.directory, [USER, FOREIGN_USER]);
      await assert.rejects(signDevice(f.first.machine, FOREIGN_USER, FOREIGN_DEVICE));
    } finally { foreign.machine.close(); }
  });
});

await test("A substituted device key under the same device id is not adopted by a machine that already pinned it", async () => {
  await withFixture(async (f) => {
    const substitute = await makeMachine(USER, SECOND);
    try {
      const signed = await signDevice(f.first.machine, USER, SECOND);
      f.directory.device_keys[USER][SECOND] = mergeCertificate(f.second.original, signed.body[USER][SECOND]);
      await query(f.first.machine, f.directory);
      const known = await devicePublicKey(f.first.machine, SECOND);
      assert.notEqual(substitute.original.keys[`ed25519:${SECOND}`], known);
      // This is a complete, validly device-signed replacement with the same id,
      // not malformed JSON. The original self-signature must not authorize it.
      f.directory.device_keys[USER][SECOND] = structuredClone(substitute.original);
      f.directory.device_keys[USER][SECOND].signatures[USER][`ed25519:${f.selfKey}`] = signed.body[USER][SECOND].signatures[USER][`ed25519:${f.selfKey}`];
      await query(f.first.machine, f.directory);
      assert.equal(await devicePublicKey(f.first.machine, SECOND), known);
      console.log("[OK] SDK keeps the previously pinned device key when the directory substitutes a different signed device under the same id.");
    } finally { substitute.machine.close(); }
  });
});

await test("A tampered self-signing signature does not authorize the new device", async () => {
  await withFixture(async (f) => {
    const signed = await signDevice(f.first.machine, USER, SECOND);
    const certificate = mergeCertificate(f.second.original, signed.body[USER][SECOND]);
    certificate.signatures[USER][`ed25519:${f.selfKey}`] = "A".repeat(86);
    f.directory.device_keys[USER][SECOND] = certificate;
    await query(f.second.machine, f.directory);
    assert.equal((await identityState(f.second.machine)).trustsOwnDevice, false);
    assert.equal((await deviceState(f.second.machine, SECOND)).crossSigned, false);
  });
});

await test("The real comparison controller and SDK SAS verify both devices and the root without transporting private secrets", async () => {
  await withFixture(async (f) => {
    const relay = verificationRelay(f);
    const initialDevice = await getDevice(f.second.machine, USER, FIRST);
    let firstRequest, secondRequest, firstSas, secondSas, firstComparison, secondComparison;
    try {
      let outgoing;
      [secondRequest, outgoing] = initialDevice.requestVerification([VerificationMethod.SasV1]);
      assert.equal(secondRequest.isSelfVerification(), true);
      await relay.send(f.second, outgoing);
      firstRequest = verificationRequest(f.first.machine, secondRequest.flowId);
      assert.ok(firstRequest);
      const ready = firstRequest.acceptWithMethods([VerificationMethod.SasV1]);
      assert.ok(ready);
      await relay.send(f.first, ready);
      assert.equal(secondRequest.isReady(), true);
      assertVerificationParticipants(firstRequest, FIRST, SECOND, secondRequest.flowId);
      assertVerificationParticipants(secondRequest, SECOND, FIRST, secondRequest.flowId);
      const started = await secondRequest.startSas();
      assert.ok(started);
      [secondSas, outgoing] = started;
      await relay.send(f.second, outgoing);
      firstSas = sas(f.first.machine, secondRequest.flowId);
      assert.ok(firstSas);
      assertVerificationParticipants(firstSas, FIRST, SECOND, secondRequest.flowId);
      assertVerificationParticipants(secondSas, SECOND, FIRST, secondRequest.flowId);
      const accept = firstSas.accept();
      assert.ok(accept);
      await relay.send(f.first, accept);
      await relay.flush();
      assert.equal(firstSas.canBePresented(), true);
      assert.equal(secondSas.canBePresented(), true);
      assert.equal(canonicalJson(Array.from(firstSas.emojiIndex())) === canonicalJson(Array.from(secondSas.emojiIndex())), true);
      assert.equal(canonicalJson(Array.from(firstSas.decimals())) === canonicalJson(Array.from(secondSas.decimals())), true);
      assert.equal(firstSas.isSelfVerification(), true);
      assert.equal(secondSas.isSelfVerification(), true);
      // The controller owns each transferred Sas and each confirmation request.
      // This remains a synthetic human comparison, not a browser UI or approval API.
      const scope = { userId: USER, flowId: secondRequest.flowId, expiresAtMs: Date.now() + 60_000 };
      const channel = (sender) => ({
        runExclusive: async (operation) => operation(),
        async send(request, signal) {
          assert.equal(signal.aborted, false);
          await relay.send(sender, request, { freeRequest: false });
        },
      });
      firstComparison = new MatrixSasComparison(firstSas,
        { ...scope, deviceId: FIRST, otherDeviceId: SECOND }, channel(f.first));
      firstSas = undefined;
      secondComparison = new MatrixSasComparison(secondSas,
        { ...scope, deviceId: SECOND, otherDeviceId: FIRST }, channel(f.second));
      secondSas = undefined;
      const firstView = await firstComparison.read(), secondView = await secondComparison.read();
      assert.equal(firstView.state, "compare");
      assert.equal(secondView.state, "compare");
      assert.equal(canonicalJson(firstView.decimals) === canonicalJson(secondView.decimals), true);
      assert.equal((await firstComparison.confirm(firstView.comparisonId)).state, "waiting-peer");
      assert.equal((await secondComparison.read()).state, "compare");
      await secondComparison.confirm(secondView.comparisonId);
      await relay.flush();
      assert.equal((await firstComparison.read()).state, "comparison-complete");
      assert.equal((await secondComparison.read()).state, "comparison-complete");
      assert.equal(firstRequest.isDone(), true);
      assert.equal(secondRequest.isDone(), true);
      const beforeQuery = {
        firstSeesSecond: await deviceState(f.first.machine, SECOND),
        secondSeesFirst: await deviceState(f.second.machine, FIRST),
        secondIdentity: await identityState(f.second.machine),
      };
      await query(f.first.machine, f.directory);
      await query(f.second.machine, f.directory);
      assert.equal((await identityState(f.second.machine)).verified, true);
      assert.equal((await identityState(f.second.machine)).trustsOwnDevice, true);
      assert.equal((await deviceState(f.first.machine, SECOND)).verified, true);
      assert.equal((await deviceState(f.first.machine, SECOND)).crossSigningTrusted, true);
      assert.equal((await deviceState(f.second.machine, FIRST)).verified, true);
      assert.deepEqual(await privateKeyAvailability(f.second.machine), { master: false, selfSigning: false, userSigning: false });
      assert.ok(relay.signatures.some((value) => value.sender === FIRST && value.target === SECOND && value.hasId));
      // SAS authenticates the root locally on the new device. This SDK version
      // does not necessarily emit a second-device signature over that root.
      // Do not invent a missing upload or mistake local trust for secret sharing.
      assert.equal(relay.events.some((event) => !event.type.startsWith("m.key.verification.")), false);
      console.log(`[OK] SAS pre-directory-refresh trust: ${JSON.stringify(beforeQuery)}.`);
      console.log(`[OK] SAS signature requests: ${JSON.stringify(relay.signatures)}. All queued signature ids acknowledged only after synthetic publication; no secret events relayed.`);
      console.log(`[OK] SAS event sequence: ${relay.events.map((event) => `${event.sender === FIRST ? "A" : "B"}:${event.type}`).join(" -> ")}.`);
    } finally {
      await firstComparison?.close(); await secondComparison?.close();
      firstSas?.free(); secondSas?.free(); firstRequest?.free(); secondRequest?.free(); initialDevice.free();
    }
  });
});

await test("One-sided SAS confirmation cannot finish either side or publish an approval", async () => {
  await withFixture(async (f) => withSas(f, {}, async ({ relay, firstSas, secondSas, firstRequest, secondRequest }) => {
    for (const request of await firstSas.confirm()) await relay.send(f.first, request);
    await relay.flush();
    assert.equal(firstSas.haveWeConfirmed(), true);
    assert.equal(secondSas.haveWeConfirmed(), false);
    for (const value of [firstSas, secondSas, firstRequest, secondRequest]) assert.equal(value.isDone(), false);
    await assertNotApproved(f, relay);
  }));
});

await test("Explicit mismatch cancels both SAS flows and later confirmation cannot approve a device", async () => {
  await withFixture(async (f) => withSas(f, {}, async ({ relay, firstSas, secondSas }) => {
    const cancellation = secondSas.cancelWithCode("m.mismatched_sas");
    assert.ok(cancellation);
    await relay.send(f.second, cancellation);
    await relay.flush();
    assert.equal(firstSas.isCancelled(), true);
    assert.equal(secondSas.isCancelled(), true);
    for (const current of [firstSas, secondSas]) {
      const outgoing = await current.confirm();
      try { assert.equal(outgoing.length, 0); }
      finally { outgoing.forEach((request) => request.free()); }
      assert.equal(current.isDone(), false);
    }
    await assertNotApproved(f, relay);
  }));
});

await test("An altered SAS commitment is rejected by the real SDK without publishing a certificate", async () => {
  let altered = false;
  await withFixture(async (f) => withSas(f, {
    expectPresentable: false,
    mutateWireEvent(event) {
      if (event.type === "m.key.verification.accept") {
        event.content.commitment = "A".repeat(43);
        altered = true;
      }
    },
  }, async ({ relay, firstSas, secondSas }) => {
    assert.equal(altered, true);
    assert.equal(secondSas.isCancelled(), true);
    assert.equal(firstSas.isDone(), false);
    assert.equal(secondSas.isDone(), false);
    await assertNotApproved(f, relay);
  }));
});

await test("An altered SAS MAC is rejected by the real SDK without publishing a certificate", async () => {
  let altered = false;
  await withFixture(async (f) => withSas(f, {
    mutateWireEvent(event) {
      if (event.type === "m.key.verification.mac") {
        event.content.keys = "A".repeat(43);
        altered = true;
      }
    },
  }, async ({ relay, firstSas, secondSas }) => {
    for (const request of await firstSas.confirm()) await relay.send(f.first, request);
    for (const request of await secondSas.confirm()) await relay.send(f.second, request);
    await relay.flush();
    assert.equal(altered, true);
    assert.equal(firstSas.isDone(), false);
    assert.equal(secondSas.isDone(), false);
    assert.equal(secondSas.isCancelled(), true);
    await assertNotApproved(f, relay);
  }));
});

await test("An event for an unrelated transaction cannot advance the original SAS flow", async () => {
  let altered = false;
  await withFixture(async (f) => withSas(f, {
    expectPresentable: false,
    mutateWireEvent(event) {
      if (event.type === "m.key.verification.key") {
        event.content.transaction_id = "unrelated-synthetic-transaction";
        altered = true;
      }
    },
  }, async ({ relay, firstSas, secondSas }) => {
    assert.equal(altered, true);
    assert.equal(firstSas.isDone(), false);
    assert.equal(secondSas.isDone(), false);
    assert.equal(firstSas.canBePresented() && secondSas.canBePresented(), false);
    await assertNotApproved(f, relay);
  }));
});

await test("The synthetic relay rejects conflicting retries, unexpected senders, participants, flows, and event types", async () => {
  await withFixture(async (f) => {
    const relay = verificationRelay(f);
    const device = await getDevice(f.second.machine, USER, FIRST);
    let verification;
    try {
      let outgoing;
      [verification, outgoing] = device.requestVerification([VerificationMethod.SasV1]);
      const snapshot = { id: outgoing.id, type: outgoing.type, event_type: outgoing.event_type, body: outgoing.body };
      await relay.send(f.second, outgoing);
      const synthetic = (overrides = {}) => ({ ...snapshot, ...overrides, free() {} });
      await relay.send(f.second, synthetic());
      assert.equal(relay.events.length, 1, "An identical retry must not be delivered twice");
      const changed = JSON.parse(snapshot.body);
      changed.messages[USER][FIRST].timestamp += 1;
      await assert.rejects(relay.send(f.second, synthetic({ body: JSON.stringify(changed) })),
        /repeated request id must have identical public content/);
      await assert.rejects(relay.send({ machine: f.second.machine }, synthetic({ id: "unknown-sender" })),
        /Only the two bound machines/);
      await assert.rejects(relay.send(f.second, synthetic({ id: "secret", event_type: "m.secret.request" })),
        /never relays secrets/);
      await assert.rejects(relay.send(f.second, synthetic({ id: "lookalike", event_type: "m.key.verification.fake" })),
        /never relays secrets/);
      const wrongUser = { messages: { [FOREIGN_USER]: JSON.parse(snapshot.body).messages[USER] } };
      await assert.rejects(relay.send(f.second, synthetic({ id: "wrong-user", body: JSON.stringify(wrongUser) })));
      const wrongDevice = { messages: { [USER]: { [SECOND]: JSON.parse(snapshot.body).messages[USER][FIRST] } } };
      await assert.rejects(relay.send(f.second, synthetic({ id: "wrong-device", body: JSON.stringify(wrongDevice) })));
      const wrongFlow = JSON.parse(snapshot.body);
      wrongFlow.messages[USER][FIRST].transaction_id = "other-flow";
      await assert.rejects(relay.send(f.second, synthetic({ id: "wrong-flow", body: JSON.stringify(wrongFlow) })), /bound flow/);
      const wrongOrigin = JSON.parse(snapshot.body);
      wrongOrigin.messages[USER][FIRST].from_device = FOREIGN_DEVICE;
      await assert.rejects(relay.send(f.second, synthetic({ id: "wrong-origin", body: JSON.stringify(wrongOrigin) })));
      assert.equal(relay.events.length, 1);
      assert.equal(relay.signatures.length, 0);
      assert.equal(verification.isDone(), false);
    } finally { verification?.free(); device.free(); }
  });
});

async function assertNotApproved(f, relay) {
  assert.equal(relay.signatures.length, 0);
  assert.deepEqual(f.directory.device_keys[USER][SECOND], f.second.original);
  await query(f.first.machine, f.directory);
  await query(f.second.machine, f.directory);
  assert.equal((await deviceState(f.first.machine, SECOND)).verified, false);
  assert.equal((await identityState(f.second.machine)).verified, false);
  assert.equal((await identityState(f.second.machine)).trustsOwnDevice, false);
  assert.deepEqual(await privateKeyAvailability(f.second.machine), { master: false, selfSigning: false, userSigning: false });
}

async function withSas(f, options, operation) {
  const relay = verificationRelay(f, options);
  const initialDevice = await getDevice(f.second.machine, USER, FIRST);
  let firstRequest, secondRequest, firstSas, secondSas;
  try {
    let outgoing;
    [secondRequest, outgoing] = initialDevice.requestVerification([VerificationMethod.SasV1]);
    await relay.send(f.second, outgoing);
    firstRequest = verificationRequest(f.first.machine, secondRequest.flowId);
    assert.ok(firstRequest);
    const ready = firstRequest.acceptWithMethods([VerificationMethod.SasV1]);
    assert.ok(ready);
    await relay.send(f.first, ready);
    assert.equal(secondRequest.isReady(), true);
    assertVerificationParticipants(firstRequest, FIRST, SECOND, secondRequest.flowId);
    assertVerificationParticipants(secondRequest, SECOND, FIRST, secondRequest.flowId);
    const started = await secondRequest.startSas();
    assert.ok(started);
    [secondSas, outgoing] = started;
    await relay.send(f.second, outgoing);
    firstSas = sas(f.first.machine, secondRequest.flowId);
    assert.ok(firstSas);
    assertVerificationParticipants(firstSas, FIRST, SECOND, secondRequest.flowId);
    assertVerificationParticipants(secondSas, SECOND, FIRST, secondRequest.flowId);
    const accept = firstSas.accept();
    assert.ok(accept);
    await relay.send(f.first, accept);
    await relay.flush();
    if (options.expectPresentable !== false) {
      assert.equal(firstSas.canBePresented(), true);
      assert.equal(secondSas.canBePresented(), true);
      // Compare without exposing SAS values through assertion diffs or logs.
      assert.equal(canonicalJson(Array.from(firstSas.decimals())) === canonicalJson(Array.from(secondSas.decimals())), true);
      assert.equal(canonicalJson(Array.from(firstSas.emojiIndex())) === canonicalJson(Array.from(secondSas.emojiIndex())), true);
    }
    await operation({ relay, firstRequest, secondRequest, firstSas, secondSas });
  } finally {
    firstSas?.free(); secondSas?.free(); firstRequest?.free(); secondRequest?.free(); initialDevice.free();
  }
}

function assertVerificationParticipants(current, ownDeviceId, peerDeviceId, flowId) {
  assert.equal(current.flowId, flowId);
  assert.equal(current.isSelfVerification(), true);
  assert.equal(current.roomId, undefined);
  const peer = current.otherUserId, peerDevice = current.otherDeviceId;
  try { assert.equal(peer.toString(), USER); assert.equal(peerDevice?.toString(), peerDeviceId); }
  finally { peer.free(); peerDevice?.free(); }
  if ("deviceId" in current) {
    const own = current.deviceId;
    try { assert.equal(own.toString(), ownDeviceId); }
    finally { own.free(); }
  }
}

function verificationRequest(machine, flowId) {
  const user = new UserId(USER);
  try { return machine.getVerificationRequest(user, flowId); }
  finally { user.free(); }
}

function sas(machine, flowId) {
  const user = new UserId(USER);
  try { return machine.getVerification(user, flowId); }
  finally { user.free(); }
}

function verificationRelay(f, { mutateWireEvent } = {}) {
  const seen = new Map(), signatures = [], events = [];
  const machines = [f.first, f.second];
  const allowedEventTypes = new Set([
    "m.key.verification.request", "m.key.verification.ready", "m.key.verification.start",
    "m.key.verification.accept", "m.key.verification.key", "m.key.verification.mac",
    "m.key.verification.done", "m.key.verification.cancel",
  ]);
  let flowId;
  async function send(sender, request, { freeRequest = true } = {}) {
    try {
      assert.ok(machines.includes(sender), "Only the two bound machines may send events");
      const senderId = sender === f.first ? FIRST : SECOND;
      const dedup = `${senderId}:${request.type}:${request.id}`;
      assert.ok(request.id, "Interactive verification requests have real ids");
      const fingerprint = canonicalJson({ type: request.type, eventType: request.event_type ?? null, body: JSON.parse(request.body) });
      if (seen.has(dedup)) {
        assert.equal(seen.get(dedup) === fingerprint, true, "A repeated request id must have identical public content");
        return;
      }
      if (request.type === RequestType.ToDevice) {
        assert.equal(allowedEventTypes.has(request.event_type), true,
          "This fixture never relays secrets, messages, key gossip, or recovery");
        const body = JSON.parse(request.body);
        assert.deepEqual(Object.keys(body), ["messages"]);
        assert.deepEqual(Object.keys(body.messages), [USER]);
        const recipient = sender === f.first ? f.second : f.first;
        const recipientId = sender === f.first ? SECOND : FIRST;
        assert.deepEqual(Object.keys(body.messages[USER]), [recipientId]);
        const content = body.messages[USER][recipientId];
        assert.equal(typeof content.transaction_id, "string");
        assert.ok(content.transaction_id.length > 0);
        if (!flowId) {
          assert.equal(request.event_type, "m.key.verification.request");
          assert.equal(senderId, SECOND);
        }
        if (flowId) assert.equal(content.transaction_id, flowId, "All events must belong to the bound flow");
        if (["m.key.verification.request", "m.key.verification.ready", "m.key.verification.start"].includes(request.event_type)) {
          assert.equal(content.from_device, senderId);
        } else if (content.from_device !== undefined) assert.equal(content.from_device, senderId);
        if (request.event_type === "m.key.verification.request" || request.event_type === "m.key.verification.ready") {
          assert.deepEqual(content.methods, ["m.sas.v1"]);
        }
        if (request.event_type === "m.key.verification.start") {
          assert.equal(content.method, "m.sas.v1");
        }
        assertPublicOnly(content);
        flowId ??= content.transaction_id;
        events.push({ sender: senderId, type: request.event_type });
        const event = { sender: USER, type: request.event_type, content };
        // Fault injection is exclusively for the negative SDK characterization.
        // Sender, recipient, flow and original SDK payload are checked first;
        // only a cloned wire event is corrupted, never SDK state or a certificate.
        const wireEvent = structuredClone(event);
        mutateWireEvent?.(wireEvent);
        const changed = new DeviceLists();
        try {
          const processed = await recipient.machine.receiveSyncChanges(JSON.stringify([wireEvent]), changed, new Map(), new Set());
          for (const value of processed) value.free?.();
        } finally { changed.free(); }
        seen.set(dedup, fingerprint);
        await sender.machine.markRequestAsSent(request.id, request.type, "{}");
      } else if (request.type === RequestType.SignatureUpload) {
        const body = JSON.parse(request.body);
        assertPublicOnly(body);
        assert.deepEqual(Object.keys(body), [USER]);
        assert.ok(flowId, "A signature upload must follow a bound SAS flow");
        assert.equal(Object.keys(body[USER]).length, 1);
        for (const [keyId, signed] of Object.entries(body[USER])) {
          if (keyId === SECOND) {
            assert.equal(senderId, FIRST);
            assert.deepEqual(Object.keys(signed.signatures[USER]), [`ed25519:${f.selfKey}`]);
            verifyPublicSignature(signed, f.selfKey, signed.signatures[USER][`ed25519:${f.selfKey}`]);
            f.directory.device_keys[USER][SECOND] = mergeCertificate(f.second.original, signed);
            signatures.push({ sender: senderId, target: SECOND, signature: "SELF_SIGNING", hasId: true });
          } else {
            assert.equal(keyId, f.masterKey);
            assert.equal(senderId, SECOND);
            assert.deepEqual(withoutSignatures(signed), withoutSignatures(f.signing.master_key));
            verifyPublicSignature(signed, f.second.original.keys[`ed25519:${SECOND}`], signed.signatures[USER][`ed25519:${SECOND}`]);
            f.directory.master_keys[USER].signatures[USER] = {
              ...f.directory.master_keys[USER].signatures[USER], ...signed.signatures[USER],
            };
            signatures.push({ sender: senderId, target: "MASTER_KEY", signature: "DEVICE_B", hasId: true });
          }
        }
        seen.set(dedup, fingerprint);
        await sender.machine.markRequestAsSent(request.id, request.type, JSON.stringify({ failures: {} }));
      } else {
        throw new Error("UNEXPECTED_VERIFICATION_REQUEST_TYPE");
      }
    } finally { if (freeRequest) request.free(); }
  }
  async function flush() {
    for (let iteration = 0; iteration < 20; iteration++) {
      let delivered = false;
      for (const sender of machines) {
        const requests = await sender.machine.outgoingRequests();
        for (const request of requests) {
          if (request.type === RequestType.SignatureUpload ||
              (request.type === RequestType.ToDevice && allowedEventTypes.has(request.event_type))) {
            const senderId = sender === f.first ? FIRST : SECOND;
            const isNew = !seen.has(`${senderId}:${request.type}:${request.id}`);
            await send(sender, request);
            delivered ||= isNew;
          } else {
            // Automatic m.secret.request may be produced by the SDK after SAS;
            // leave it unacknowledged and do not deliver it in this experiment.
            request.free();
          }
        }
      }
      if (!delivered) return;
    }
    throw new Error("VERIFICATION_RELAY_DID_NOT_SETTLE");
  }
  return { send, flush, signatures, events };
}

async function withFixture(operation) {
  const first = await makeMachine(USER, FIRST);
  let second;
  try {
    second = await makeMachine(USER, SECOND);
    const requests = await first.machine.bootstrapCrossSigning(false);
    let signing, signature;
    const optionalKeys = requests.uploadKeysRequest;
    const signingRequest = requests.uploadSigningKeysRequest;
    const signatureRequest = requests.uploadSignaturesRequest;
    try {
      assert.equal(optionalKeys, undefined, "Initial upload is already acknowledged");
      assert.equal(signatureRequest.id, undefined);
      signing = JSON.parse(signingRequest.body);
      signature = JSON.parse(signatureRequest.body);
    } finally {
      optionalKeys?.free(); signingRequest.free(); signatureRequest.free(); requests.free();
    }
    const directory = {
      device_keys: { [USER]: { [FIRST]: mergeCertificate(first.original, signature[USER][FIRST]), [SECOND]: second.original } },
      master_keys: { [USER]: signing.master_key },
      self_signing_keys: { [USER]: signing.self_signing_key },
      user_signing_keys: { [USER]: signing.user_signing_key }, failures: {},
    };
    await query(first.machine, directory);
    await query(second.machine, directory);
    assert.equal((await identityState(first.machine)).verified, true);
    assert.equal((await identityState(first.machine)).trustsOwnDevice, true);
    await operation({ first, second, signing, directory,
      masterKey: Object.values(signing.master_key.keys)[0],
      selfKey: Object.values(signing.self_signing_key.keys)[0] });
  } finally { second?.machine.close(); first.machine.close(); }
}

async function makeMachine(userId, deviceId) {
  const user = new UserId(userId), device = new DeviceId(deviceId);
  let machine;
  try { machine = await OlmMachine.initialize(user, device); }
  finally { user.free(); device.free(); }
  try {
    const requests = await machine.outgoingRequests();
    try {
      const upload = requests.find((request) => request.type === RequestType.KeysUpload);
      assert.ok(upload?.id);
      const body = JSON.parse(upload.body);
      await machine.markRequestAsSent(upload.id, upload.type, JSON.stringify({
        one_time_key_counts: { signed_curve25519: Object.keys(body.one_time_keys).length },
      }));
      assertPublicOnly(body.device_keys);
      return { machine, original: body.device_keys };
    } finally { requests.forEach((request) => request.free()); }
  } catch (error) { machine.close(); throw error; }
}

async function query(machine, directory, users = [USER]) {
  // queryKeysForUsers consumes the UserId handles; do not free them a second time.
  const request = machine.queryKeysForUsers(users.map((user) => new UserId(user)));
  try { await machine.markRequestAsSent(request.id, request.type, JSON.stringify(directory)); }
  finally { request.free(); }
}

async function getDevice(machine, userId, deviceId) {
  const user = new UserId(userId), device = new DeviceId(deviceId);
  try {
    const result = await machine.getDevice(user, device, 0);
    assert.ok(result);
    return result;
  } finally { user.free(); device.free(); }
}

async function signDevice(machine, userId, deviceId) {
  const device = await getDevice(machine, userId, deviceId);
  let request;
  try {
    request = await device.verify();
    return { body: JSON.parse(request.body), id: request.id, type: request.type };
  } finally { request?.free(); device.free(); }
}

async function deviceState(machine, deviceId) {
  const device = await getDevice(machine, USER, deviceId);
  try {
    return { verified: device.isVerified(), crossSigned: device.isCrossSignedByOwner(),
      crossSigningTrusted: device.isCrossSigningTrusted(), locallyTrusted: device.isLocallyTrusted() };
  } finally { device.free(); }
}

async function devicePublicKey(machine, deviceId) {
  const device = await getDevice(machine, USER, deviceId);
  const key = device.ed25519Key;
  try { assert.ok(key); return key.toBase64(); }
  finally { key?.free(); device.free(); }
}

async function identityState(machine) {
  const user = new UserId(USER);
  let identity;
  try { identity = await machine.getIdentity(user); }
  finally { user.free(); }
  try {
    assert.ok(identity);
    return { verified: identity.isVerified(), trustsOwnDevice: await identity.trustsOurOwnDevice(),
      violation: identity.hasVerificationViolation() };
  } finally { identity?.free(); }
}

async function privateKeyAvailability(machine) {
  const status = await machine.crossSigningStatus();
  try { return { master: status.hasMaster, selfSigning: status.hasSelfSigning, userSigning: status.hasUserSigning }; }
  finally { status.free(); }
}

function withoutSignatures(value) {
  const copy = structuredClone(value);
  delete copy.signatures;
  delete copy.unsigned;
  return copy;
}

function mergeCertificate(original, signed) {
  assert.deepEqual(withoutSignatures(signed), withoutSignatures(original));
  const certificate = structuredClone(signed);
  certificate.signatures[USER] = { ...original.signatures[USER], ...signed.signatures[USER] };
  return certificate;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function verifyPublicSignature(body, key, signature) {
  const publicKey = createPublicKey({ key: Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(key, "base64"),
  ]), format: "der", type: "spki" });
  assert.equal(verify(null, Buffer.from(canonicalJson(withoutSignatures(body))), publicKey, Buffer.from(signature, "base64")), true);
}

function assertPublicOnly(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, /private|secret|passphrase|pickle|seed|recovery/i);
    assertPublicOnly(child);
  }
}

async function loadComparisonController() {
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const temporary = await mkdtemp(resolve(webRoot, ".matrix-sas-characterization-"));
  try {
    const source = await readFile(resolve(webRoot, "src/e2ee/matrixSasComparison.ts"), "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: "matrixSasComparison.ts", reportDiagnostics: true,
    });
    assert.deepEqual(compiled.diagnostics ?? [], []);
    const filename = resolve(temporary, "matrixSasComparison.mjs");
    await writeFile(filename, compiled.outputText, "utf8");
    return await import(pathToFileURL(filename).href);
  } finally {
    assertTemporaryChild(webRoot, temporary);
    await rm(temporary, { recursive: true, force: true });
  }
}

function assertTemporaryChild(webRoot, temporary) {
  const target = relative(webRoot, temporary);
  if (!target.startsWith(".matrix-sas-characterization-") || target.includes("/") ||
      target.includes("\\") || isAbsolute(target)) throw new Error("UNSAFE_SAS_CHARACTERIZATION_PATH");
}
