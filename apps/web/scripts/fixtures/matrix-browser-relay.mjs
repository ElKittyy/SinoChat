import { randomBytes } from "node:crypto";

const ACTORS = new Set(["sender", "recipient", "outsider"]);
const OLM = "m.olm.v1.curve25519-aes-sha2";
const MEGOLM = "m.megolm.v1.aes-sha2";
const SIGNED_CURVE = "signed_curve25519";

/**
 * In-memory relay for synthetic browser tests only. This is NOT a backend,
 * authentication, authorization, a signature verifier, or an E2EE release
 * gate bypass. Actor labels are fixture routing, never user credentials.
 * Stores only public key bundles and encrypted Olm events; no private keys or
 * application plaintext. All state disappears when this fixture is discarded.
 */
export function createMatrixBrowserRelay() {
  const actors = new Map();
  const claims = new Map();
  const sends = new Map();
  const encryptedEvents = [];
  const metrics = {
    uploadCount: 0,
    queryCount: 0,
    claimCount: 0,
    claimReplayCount: 0,
    claimedOneTimeKeyCount: 0,
    sendCount: 0,
    sendReplayCount: 0,
    enqueuedEventCount: 0,
    syncCount: 0,
    syncReplayCount: 0,
  };

  function handle(actor, action, body = {}) {
    assert(ACTORS.has(actor), "FIXTURE_ACTOR_INVALID");
    record(body);
    if (action === "upload") return upload(actor, body);
    const source = actors.get(actor);
    assert(source, "FIXTURE_ACTOR_NOT_REGISTERED");
    if (action === "query") return query(body);
    if (action === "claim") return claim(actor, body);
    if (action === "send") return send(actor, source, body);
    if (action === "sync") return sync(source, body);
    fail("FIXTURE_ACTION_INVALID");
  }

  function upload(actor, body) {
    fields(body, [], ["device_keys", "one_time_keys", "fallback_keys"]);
    let source = actors.get(actor);
    const bundle = body.device_keys;
    if (bundle !== undefined) {
      validateDeviceKeys(bundle);
      if (source) {
        assert(canonical(source.bundle) === canonical(bundle), "FIXTURE_IDENTITY_IMMUTABLE");
      } else {
        for (const existing of actors.values()) {
          assert(
            !(existing.bundle.user_id === bundle.user_id && existing.bundle.device_id === bundle.device_id) &&
              curveKey(existing.bundle) !== curveKey(bundle),
            "FIXTURE_IDENTITY_ALREADY_REGISTERED",
          );
        }
        source = {
          bundle: copy(bundle),
          oneTimeKeys: new Map(),
          uploadedOneTimeKeys: new Map(),
          fallbackKeys: new Map(),
          usedFallbackKeys: new Set(),
          events: [],
          tokens: new Map(),
          batches: new Map(),
          acknowledgedOffset: 0,
        };
      }
    }
    assert(source, "FIXTURE_INITIAL_DEVICE_KEYS_REQUIRED");
    const oneTimeKeys = validateCurveKeys(body.one_time_keys ?? {}, source.bundle, false);
    const fallbackKeys = validateCurveKeys(body.fallback_keys ?? {}, source.bundle, true);
    for (const [id, key] of oneTimeKeys) {
      const previous = source.uploadedOneTimeKeys.get(id);
      assert(previous === undefined || canonical(previous) === canonical(key), "FIXTURE_ONE_TIME_KEY_IMMUTABLE");
    }
    const additions = oneTimeKeys.filter(([id]) => !source.uploadedOneTimeKeys.has(id));
    assert(source.oneTimeKeys.size + additions.length <= 100, "FIXTURE_ONE_TIME_KEY_LIMIT");
    for (const [id, key] of fallbackKeys) {
      const previous = source.fallbackKeys.get(id);
      assert(previous === undefined || canonical(previous) === canonical(key), "FIXTURE_FALLBACK_KEY_IMMUTABLE");
    }
    // Re-uploading a consumed OTK must not make it available for a second claim.
    for (const [id, key] of additions) {
      source.oneTimeKeys.set(id, copy(key));
      source.uploadedOneTimeKeys.set(id, copy(key));
    }
    if (fallbackKeys.length > 0) {
      const [id, key] = fallbackKeys[0];
      source.fallbackKeys = new Map([[id, copy(key)]]);
    }
    actors.set(actor, source);
    metrics.uploadCount += 1;
    return { one_time_key_counts: { [SIGNED_CURVE]: source.oneTimeKeys.size } };
  }

  function query(body) {
    fields(body, ["device_keys"], ["timeout"]);
    timeout(body.timeout);
    record(body.device_keys);
    entryLimit(body.device_keys, 1, 20, "FIXTURE_QUERY_USER_LIMIT");
    const deviceKeys = {};
    for (const [user, devices] of Object.entries(body.device_keys)) {
      matrixUser(user);
      assert(Array.isArray(devices) && devices.length <= 10 && devices.every(isDevice) && new Set(devices).size === devices.length, "FIXTURE_QUERY_DEVICES_INVALID");
      deviceKeys[user] = {};
      for (const source of actors.values()) {
        const bundle = source.bundle;
        if (bundle.user_id === user && (devices.length === 0 || devices.includes(bundle.device_id))) {
          deviceKeys[user][bundle.device_id] = copy(bundle);
        }
      }
    }
    metrics.queryCount += 1;
    return { device_keys: deviceKeys, failures: {}, master_keys: {}, self_signing_keys: {}, user_signing_keys: {} };
  }

  function claim(actor, request) {
    fields(request, ["requestId", "body"]);
    identifier(request.requestId, 64);
    fields(request.body, ["one_time_keys"], ["timeout"]);
    timeout(request.body.timeout);
    record(request.body.one_time_keys);
    entryLimit(request.body.one_time_keys, 1, 20, "FIXTURE_CLAIM_USER_LIMIT");
    const requestKey = `${actor}\0${request.requestId}`;
    const previous = claims.get(requestKey);
    if (previous) {
      assert(previous.body === canonical(request.body), "FIXTURE_CLAIM_IDEMPOTENCY_CONFLICT");
      metrics.claimReplayCount += 1;
      return copy(previous.response);
    }
    const targets = [];
    let requestedTargets = 0;
    for (const [user, devices] of Object.entries(request.body.one_time_keys)) {
      matrixUser(user);
      record(devices);
      entryLimit(devices, 1, 10, "FIXTURE_CLAIM_DEVICE_LIMIT");
      for (const [device, algorithm] of Object.entries(devices)) {
        assert(isDevice(device) && algorithm === SIGNED_CURVE, "FIXTURE_CLAIM_TARGET_INVALID");
        requestedTargets += 1;
        assert(requestedTargets <= 10, "FIXTURE_CLAIM_DEVICE_LIMIT");
        const target = findDevice(user, device);
        if (target) targets.push(target);
      }
    }
    const response = { one_time_keys: {}, failures: {} };
    for (const target of targets) {
      let entry = target.oneTimeKeys.entries().next().value;
      if (entry) {
        target.oneTimeKeys.delete(entry[0]);
        metrics.claimedOneTimeKeyCount += 1;
      } else {
        entry = target.fallbackKeys.entries().next().value;
        if (entry) target.usedFallbackKeys.add(entry[0]);
      }
      if (!entry) continue;
      const { user_id: user, device_id: device } = target.bundle;
      response.one_time_keys[user] ??= {};
      response.one_time_keys[user][device] = { [entry[0]]: copy(entry[1]) };
    }
    claims.set(requestKey, { body: canonical(request.body), response: copy(response) });
    metrics.claimCount += 1;
    return response;
  }

  function send(actor, source, request) {
    fields(request, ["eventType", "transactionId", "body"]);
    identifier(request.transactionId);
    assert(request.eventType === "m.room.encrypted", "FIXTURE_EVENT_TYPE_FORBIDDEN");
    fields(request.body, ["messages"]);
    record(request.body.messages);
    entryLimit(request.body.messages, 1, 10, "FIXTURE_SEND_USER_LIMIT");
    assert(Buffer.byteLength(JSON.stringify(request.body), "utf8") <= 256 * 1024, "FIXTURE_SEND_REQUEST_TOO_LARGE");
    const requestKey = `${actor}\0${request.transactionId}`;
    const previous = sends.get(requestKey);
    if (previous !== undefined) {
      assert(previous === canonical(request), "FIXTURE_SEND_IDEMPOTENCY_CONFLICT");
      metrics.sendReplayCount += 1;
      return {};
    }
    const queued = [];
    for (const [user, devices] of Object.entries(request.body.messages)) {
      matrixUser(user);
      record(devices);
      entryLimit(devices, 1, 20, "FIXTURE_SEND_DEVICE_LIMIT");
      for (const [device, content] of Object.entries(devices)) {
        assert(isDevice(device), "FIXTURE_DEVICE_ID_INVALID");
        const target = findDevice(user, device);
        assert(target, "FIXTURE_SEND_TARGET_UNKNOWN");
        fields(content, ["algorithm", "sender_key", "ciphertext", "org.matrix.msgid"]);
        assert(content.algorithm === OLM && content.sender_key === curveKey(source.bundle), "FIXTURE_OLM_SENDER_INVALID");
        assert(typeof content["org.matrix.msgid"] === "string" && /^[0-9a-f]{32}$/.test(content["org.matrix.msgid"]), "FIXTURE_OLM_MESSAGE_ID_INVALID");
        fields(content.ciphertext, [curveKey(target.bundle)]);
        const encrypted = content.ciphertext[curveKey(target.bundle)];
        fields(encrypted, ["type", "body"]);
        assert(encrypted.type === 0 || encrypted.type === 1, "FIXTURE_OLM_TYPE_INVALID");
        base64(encrypted.body, undefined, 60 * 1024);
        assert(Buffer.byteLength(JSON.stringify(content), "utf8") <= 60 * 1024, "FIXTURE_OLM_CONTENT_TOO_LARGE");
        queued.push({ target, event: { type: "m.room.encrypted", sender: source.bundle.user_id, content: copy(content) } });
        assert(queued.length <= 20, "FIXTURE_SEND_DEVICE_LIMIT");
      }
    }
    for (const { target, event } of queued) {
      target.events.push(event);
      encryptedEvents.push(copy(event));
    }
    sends.set(requestKey, canonical(request));
    metrics.sendCount += 1;
    metrics.enqueuedEventCount += queued.length;
    return {};
  }

  function sync(source, body) {
    fields(body, [], ["since", "timeout"]);
    timeout(body.timeout);
    const since = body.since;
    const offset = since === undefined ? 0 : source.tokens.get(since);
    assert(offset !== undefined, "FIXTURE_SYNC_TOKEN_INVALID");
    // Only receiving a known cursor acknowledges its previous batch. A lost
    // HTTP response can replay the exact previous batch, including its token.
    source.acknowledgedOffset = Math.max(source.acknowledgedOffset, offset);
    metrics.syncCount += 1;
    const previous = source.batches.get(since);
    if (previous) {
      metrics.syncReplayCount += 1;
      return copy(previous);
    }
    const events = source.events.slice(offset, offset + 100);
    const nextBatch = `sct1.${randomBytes(16).toString("base64url")}.${randomBytes(32).toString("base64url")}`;
    source.tokens.set(nextBatch, offset + events.length);
    const response = {
      next_batch: nextBatch,
      to_device: { events: copy(events) },
      device_lists: { changed: [], left: [] },
      device_one_time_keys_count: { [SIGNED_CURVE]: source.oneTimeKeys.size },
      device_unused_fallback_key_types: [...source.fallbackKeys.keys()].some((key) => !source.usedFallbackKeys.has(key)) ? [SIGNED_CURVE] : [],
    };
    source.batches.set(since, copy(response));
    return response;
  }

  function findDevice(user, device) {
    return [...actors.values()].find((source) => source.bundle.user_id === user && source.bundle.device_id === device);
  }

  function snapshot() {
    return {
      ...metrics,
      actorCount: actors.size,
      actors: Object.fromEntries([...actors].map(([actor, source]) => [actor, {
        remainingOneTimeKeyCount: source.oneTimeKeys.size,
        queuedEventCount: source.events.length,
        acknowledgedEventCount: source.acknowledgedOffset,
      }])),
      deviceKeys: [...actors.values()].map((source) => copy(source.bundle)),
      encryptedEvents: copy(encryptedEvents),
    };
  }

  return { handle, snapshot };
}

function validateDeviceKeys(bundle) {
  fields(bundle, ["user_id", "device_id", "algorithms", "keys", "signatures"]);
  matrixUser(bundle.user_id);
  assert(isDevice(bundle.device_id), "FIXTURE_DEVICE_ID_INVALID");
  assert(Array.isArray(bundle.algorithms) && bundle.algorithms.length === 2 && bundle.algorithms[0] === OLM && bundle.algorithms[1] === MEGOLM, "FIXTURE_ALGORITHMS_INVALID");
  fields(bundle.keys, [`curve25519:${bundle.device_id}`, `ed25519:${bundle.device_id}`]);
  for (const value of Object.values(bundle.keys)) base64(value, 32);
  signatures(bundle.signatures, bundle);
}

function validateCurveKeys(keys, bundle, fallback) {
  record(keys);
  const entries = Object.entries(keys);
  assert(entries.length <= (fallback ? 1 : 100), "FIXTURE_CURVE_KEY_LIMIT");
  for (const [id, key] of entries) {
    assert(/^signed_curve25519:[A-Za-z0-9._=-]{1,64}$/.test(id), "FIXTURE_CURVE_KEY_ID_INVALID");
    fields(key, fallback ? ["key", "signatures", "fallback"] : ["key", "signatures"]);
    if (fallback) assert(key.fallback === true, "FIXTURE_FALLBACK_INVALID");
    base64(key.key, 32);
    signatures(key.signatures, bundle);
  }
  return entries;
}

function signatures(value, bundle) {
  fields(value, [bundle.user_id]);
  fields(value[bundle.user_id], [`ed25519:${bundle.device_id}`]);
  base64(value[bundle.user_id][`ed25519:${bundle.device_id}`], 64);
}

function curveKey(bundle) { return bundle.keys[`curve25519:${bundle.device_id}`]; }
function copy(value) { return structuredClone(value); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function record(value) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), "FIXTURE_OBJECT_INVALID");
  assert(!Object.keys(value).some((key) => ["__proto__", "prototype", "constructor"].includes(key)), "FIXTURE_OBJECT_KEY_INVALID");
}
function fields(value, required, optional = []) {
  record(value);
  assert(required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key)), "FIXTURE_FIELDS_INVALID");
}
function matrixUser(value) { assert(typeof value === "string" && /^@u[0-9a-f]{32}:[^\s/@]{1,255}$/.test(value), "FIXTURE_USER_ID_INVALID"); }
function isDevice(value) { return typeof value === "string" && /^D[0-9A-F]{32}$/.test(value); }
function identifier(value, maxLength = 255) { assert(typeof value === "string" && value.length <= maxLength && /^[A-Za-z0-9._~-]+$/.test(value), "FIXTURE_REQUEST_ID_INVALID"); }
function entryLimit(value, minimum, maximum, code) { const count = Object.keys(value).length; assert(count >= minimum && count <= maximum, code); }
function timeout(value) { assert(value === undefined || (Number.isSafeInteger(value) && value >= 0 && value <= 30_000), "FIXTURE_TIMEOUT_INVALID"); }
function base64(value, bytes, maxLength = 256) {
  assert(typeof value === "string" && value.length > 0 && value.length <= maxLength && /^[A-Za-z0-9+/]+={0,2}$/.test(value), "FIXTURE_BASE64_INVALID");
  if (bytes !== undefined) {
    const decoded = Buffer.from(value, "base64");
    assert(decoded.length === bytes && decoded.toString("base64").replace(/=+$/, "") === value, "FIXTURE_PUBLIC_KEY_LENGTH_INVALID");
  }
}
function assert(condition, code) { if (!condition) fail(code); }
function fail(code) {
  const error = new Error(code);
  error.statusCode = 400;
  throw error;
}
