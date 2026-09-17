import assert from "node:assert/strict";
import { test } from "node:test";
import { createMatrixBrowserRelay } from "./matrix-browser-relay.mjs";

const OLM = "m.olm.v1.curve25519-aes-sha2";
const MEGOLM = "m.megolm.v1.aes-sha2";
const ACTORS = ["sender", "recipient", "outsider"];

// Synthetic public-looking bytes only: not real keys, signatures or plaintext.
// Actual cryptographic interoperability is covered by the browser runner.
function fixture({ oneTimeKeys = 1, fallback = false } = {}) {
  const relay = createMatrixBrowserRelay();
  const actors = {};
  for (const [index, actor] of ACTORS.entries()) {
    const user = `@u${String(index + 1).repeat(32)}:sinochat.invalid`;
    const device = `D${String(index + 1).repeat(32)}`;
    const signatures = { [user]: { [`ed25519:${device}`]: encoded(64, index + 1) } };
    const bundle = {
      user_id: user,
      device_id: device,
      algorithms: [OLM, MEGOLM],
      keys: {
        [`curve25519:${device}`]: encoded(32, index + 1),
        [`ed25519:${device}`]: encoded(32, index + 4),
      },
      signatures,
    };
    const upload = {
      device_keys: bundle,
      one_time_keys: Object.fromEntries(Array.from({ length: oneTimeKeys }, (_, number) => [
        `signed_curve25519:k${number}`,
        { key: encoded(32, index + number + 7), signatures },
      ])),
      ...(fallback ? { fallback_keys: { "signed_curve25519:fallback": { key: encoded(32, index + 100), signatures, fallback: true } } } : {}),
    };
    actors[actor] = { user, device, bundle, upload };
    relay.handle(actor, "upload", upload);
  }
  const claim = (requestId = "claim1", target = "recipient") => ({
    requestId,
    body: { one_time_keys: { [actors[target].user]: { [actors[target].device]: "signed_curve25519" } } },
  });
  const send = (transactionId = "send1", target = "recipient") => ({
    eventType: "m.room.encrypted",
    transactionId,
    body: { messages: { [actors[target].user]: { [actors[target].device]: {
      algorithm: OLM,
      sender_key: actors.sender.bundle.keys[`curve25519:${actors.sender.device}`],
      "org.matrix.msgid": "a".repeat(32),
      ciphertext: { [actors[target].bundle.keys[`curve25519:${actors[target].device}`]]: { type: 0, body: encoded(80, 42) } },
    } } } },
  });
  return { relay, actors, claim, send };
}

function encoded(length, value) { return Buffer.alloc(length, value).toString("base64").replace(/=+$/, ""); }
function content(request) { return Object.values(Object.values(request.body.messages)[0])[0]; }

test("upload accepts key replenishment without device_keys and preserves immutable identity", () => {
  const { relay, actors } = fixture();
  const response = relay.handle("sender", "upload", { one_time_keys: {
    "signed_curve25519:new": { key: encoded(32, 30), signatures: actors.sender.bundle.signatures },
  } });
  assert.equal(response.one_time_key_counts.signed_curve25519, 2);
  const changed = structuredClone(actors.sender.bundle);
  changed.keys[`ed25519:${changed.device_id}`] = encoded(32, 31);
  assert.throws(() => relay.handle("sender", "upload", { device_keys: changed }), /IDENTITY_IMMUTABLE/);
  assert.throws(() => relay.handle("sender", "upload", { private_key: "forbidden" }), /FIELDS_INVALID/);
  assert.throws(() => createMatrixBrowserRelay().handle("sender", "upload", { one_time_keys: {} }), /INITIAL_DEVICE_KEYS_REQUIRED/);
});

test("claim retries consume one OTK exactly once, and re-upload cannot resurrect it", () => {
  const { relay, actors, claim } = fixture();
  const first = relay.handle("sender", "claim", claim());
  assert.deepEqual(relay.handle("sender", "claim", claim()), first);
  assert.equal(relay.snapshot().claimedOneTimeKeyCount, 1);
  assert.equal(relay.snapshot().claimReplayCount, 1);
  assert.throws(() => relay.handle("sender", "claim", claim("claim1", "outsider")), /IDEMPOTENCY_CONFLICT/);
  relay.handle("recipient", "upload", { one_time_keys: actors.recipient.upload.one_time_keys });
  assert.equal(relay.snapshot().actors.recipient.remainingOneTimeKeyCount, 0);
  assert.deepEqual(relay.handle("sender", "claim", claim("claim2")), { one_time_keys: {}, failures: {} });
});

test("fallback keys remain reusable but sync stops advertising them as unused", () => {
  const { relay, claim } = fixture({ oneTimeKeys: 0, fallback: true });
  const firstSync = relay.handle("recipient", "sync", {});
  assert.deepEqual(firstSync.device_unused_fallback_key_types, ["signed_curve25519"]);
  const firstClaim = relay.handle("sender", "claim", claim());
  assert.deepEqual(relay.handle("sender", "claim", claim("claim2")), firstClaim);
  assert.equal(relay.snapshot().claimedOneTimeKeyCount, 0);
  const afterClaim = relay.handle("recipient", "sync", { since: firstSync.next_batch });
  assert.deepEqual(afterClaim.device_unused_fallback_key_types, []);
});

test("query routes only requested public bundles and rejects unknown actors/extra fields", () => {
  const { relay, actors } = fixture();
  const response = relay.handle("sender", "query", { device_keys: { [actors.recipient.user]: [] } });
  assert.deepEqual(response.device_keys, { [actors.recipient.user]: { [actors.recipient.device]: actors.recipient.bundle } });
  assert.deepEqual(response.master_keys, {});
  assert.throws(() => relay.handle("admin", "query", {}), /ACTOR_INVALID/);
  assert.throws(() => relay.handle("sender", "query", { device_keys: {}, private_key: "forbidden" }), /FIELDS_INVALID/);
  assert.throws(() => relay.handle("sender", "query", { device_keys: { [actors.recipient.user]: [actors.recipient.device, actors.recipient.device] } }), /QUERY_DEVICES_INVALID/);
});

test("Olm send requires SDK msgid and exact encrypted exterior, and retries do not duplicate", () => {
  const { relay, send } = fixture();
  const request = send();
  assert.deepEqual(relay.handle("sender", "send", request), {});
  assert.deepEqual(relay.handle("sender", "send", request), {});
  assert.equal(relay.snapshot().enqueuedEventCount, 1);
  assert.equal(relay.snapshot().sendReplayCount, 1);
  const changed = structuredClone(request);
  content(changed)["org.matrix.msgid"] = "b".repeat(32);
  assert.throws(() => relay.handle("sender", "send", changed), /IDEMPOTENCY_CONFLICT/);
  const missingId = send("missing");
  delete content(missingId)["org.matrix.msgid"];
  assert.throws(() => relay.handle("sender", "send", missingId), /FIELDS_INVALID/);
  const invalidId = send("invalid");
  content(invalidId)["org.matrix.msgid"] = "not-a-message-id";
  assert.throws(() => relay.handle("sender", "send", invalidId), /MESSAGE_ID_INVALID/);
  const plaintext = send("plaintext");
  content(plaintext).text = "forbidden";
  assert.throws(() => relay.handle("sender", "send", plaintext), /FIELDS_INVALID/);
  assert.throws(() => relay.handle("sender", "send", { ...send("event"), eventType: "com.sinochat.message.v1" }), /EVENT_TYPE_FORBIDDEN/);
  assert.equal(relay.snapshot().enqueuedEventCount, 1);
});

test("a bad later destination cannot partially enqueue an earlier valid message", () => {
  const { relay, actors, send } = fixture();
  const request = send();
  request.body.messages[actors.outsider.user] = { [actors.outsider.device]: {} };
  assert.throws(() => relay.handle("sender", "send", request), /FIELDS_INVALID/);
  assert.equal(relay.snapshot().enqueuedEventCount, 0);
});

test("sync pages 100+1 events, retries identical batches, acknowledges only received cursors", () => {
  const { relay, send } = fixture();
  const initial = relay.handle("recipient", "sync", {});
  assert.match(initial.next_batch, /^sct1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  for (let index = 0; index < 101; index += 1) relay.handle("sender", "send", send(`tx${index}`));
  assert.deepEqual(relay.handle("recipient", "sync", {}), initial);
  const firstPage = relay.handle("recipient", "sync", { since: initial.next_batch });
  assert.equal(firstPage.to_device.events.length, 100);
  assert.deepEqual(relay.handle("recipient", "sync", { since: initial.next_batch }), firstPage);
  assert.equal(relay.snapshot().actors.recipient.acknowledgedEventCount, 0);
  const secondPage = relay.handle("recipient", "sync", { since: firstPage.next_batch });
  assert.equal(secondPage.to_device.events.length, 1);
  assert.equal(relay.snapshot().actors.recipient.acknowledgedEventCount, 100);
  relay.handle("recipient", "sync", { since: secondPage.next_batch });
  assert.equal(relay.snapshot().actors.recipient.acknowledgedEventCount, 101);
  assert.throws(() => relay.handle("outsider", "sync", { since: firstPage.next_batch }), /SYNC_TOKEN_INVALID/);
  assert.throws(() => relay.handle("recipient", "sync", { since: "forged" }), /SYNC_TOKEN_INVALID/);
});

test("responses and snapshots never expose mutable references to relay state", () => {
  const { relay, send } = fixture();
  relay.handle("sender", "send", send());
  const first = relay.handle("recipient", "sync", {});
  first.to_device.events.length = 0;
  assert.equal(relay.handle("recipient", "sync", {}).to_device.events.length, 1);
  const snapshot = relay.snapshot();
  snapshot.encryptedEvents.length = 0;
  snapshot.deviceKeys[0].device_id = "mutated";
  assert.equal(relay.snapshot().encryptedEvents.length, 1);
  assert.notEqual(relay.snapshot().deviceKeys[0].device_id, "mutated");
});
