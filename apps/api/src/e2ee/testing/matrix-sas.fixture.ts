import { strict as assert } from "node:assert";
import { DeviceId, DeviceLists, OlmMachine, RequestType, UserId, VerificationMethod, initAsync,
  type Sas, type VerificationRequest, type ToDeviceRequest } from "@matrix-org/matrix-sdk-crypto-wasm";

export const SAS_FIXTURE_USER = "@u11111111111141118111111111111111:sinochat.invalid";
export const SAS_FIXTURE_TRUSTED = "D22222222222242228222222222222222";
export const SAS_FIXTURE_CANDIDATE = "D33333333333343338333333333333333";
export interface SasFixtureEvent {
  eventType: string;
  transactionId: string;
  body: { messages: Record<string, Record<string, Record<string, any>>> };
  expected: { userId: string; senderDeviceId: string; recipientDeviceId: string; flowId: string; pinnedMasterKey: string };
}
const TYPES = new Set(["request", "ready", "start", "accept", "key", "mac", "done", "cancel"].map((type) => `m.key.verification.${type}`));

/** Synthetic SDK machines only. No database, network, private-key export or logs. */
export async function runMatrixSasFixture(validate?: (event: SasFixtureEvent) => void, cancelCode?: string,
  initiator: "CANDIDATE" | "TRUSTED" = "CANDIDATE"): Promise<SasFixtureEvent[]> {
  await initAsync();
  const peers: Array<{ machine: OlmMachine; id: string; original: any }> = [];
  let firstRequest: VerificationRequest | undefined, secondRequest: VerificationRequest | undefined;
  let firstSas: Sas | undefined, secondSas: Sas | undefined;
  try {
    for (const id of [SAS_FIXTURE_TRUSTED, SAS_FIXTURE_CANDIDATE]) {
      const user = new UserId(SAS_FIXTURE_USER), device = new DeviceId(id);
      let machine: OlmMachine;
      try { machine = await OlmMachine.initialize(user, device); } finally { user.free(); device.free(); }
      const peer = { machine, id, original: undefined as any }; peers.push(peer);
      const requests = await machine.outgoingRequests();
      try {
        const upload = requests.find((request) => request.type === RequestType.KeysUpload);
        assert.ok(upload?.id);
        const body = JSON.parse(upload.body); peer.original = body.device_keys;
        await machine.markRequestAsSent(upload.id, upload.type, JSON.stringify({ one_time_key_counts: { signed_curve25519: Object.keys(body.one_time_keys).length } }));
      } finally { requests.forEach((request) => request.free()); }
    }
    const [first, second] = peers;
    const bootstrap = await first.machine.bootstrapCrossSigning(false);
    const signingRequest = bootstrap.uploadSigningKeysRequest, signatureRequest = bootstrap.uploadSignaturesRequest;
    const optionalKeys = bootstrap.uploadKeysRequest;
    let signing: any, signed: any;
    try {
      assert.equal(optionalKeys, undefined);
      signing = JSON.parse(signingRequest.body); signed = JSON.parse(signatureRequest.body)[SAS_FIXTURE_USER][first.id];
    } finally { optionalKeys?.free(); signingRequest.free(); signatureRequest.free(); bootstrap.free(); }
    const trustedKeys = { ...first.original, signatures: { [SAS_FIXTURE_USER]: { ...first.original.signatures[SAS_FIXTURE_USER], ...signed.signatures[SAS_FIXTURE_USER] } } };
    const directory = { device_keys: { [SAS_FIXTURE_USER]: { [first.id]: trustedKeys, [second.id]: second.original } },
      master_keys: { [SAS_FIXTURE_USER]: signing.master_key }, self_signing_keys: { [SAS_FIXTURE_USER]: signing.self_signing_key },
      user_signing_keys: { [SAS_FIXTURE_USER]: signing.user_signing_key }, failures: {} };
    const pinnedMasterKey = Object.values(signing.master_key.keys)[0] as string;
    for (const peer of peers) {
      // queryKeysForUsers consumes the UserId handles.
      const request = peer.machine.queryKeysForUsers([new UserId(SAS_FIXTURE_USER)]);
      try { await peer.machine.markRequestAsSent(request.id, request.type, JSON.stringify(directory)); } finally { request.free(); }
    }
    const starter = initiator === "TRUSTED" ? first : second;
    const responder = starter === first ? second : first;
    const user = new UserId(SAS_FIXTURE_USER), device = new DeviceId(responder.id);
    let initial;
    try { initial = await starter.machine.getDevice(user, device, 0); } finally { user.free(); device.free(); }
    assert.ok(initial);
    let outgoing: ToDeviceRequest;
    let starterRequest: VerificationRequest;
    try { [starterRequest, outgoing] = initial.requestVerification([VerificationMethod.SasV1]); } finally { initial.free(); }
    if (starter === first) firstRequest = starterRequest; else secondRequest = starterRequest;
    const flowId = starterRequest.flowId;
    const events: SasFixtureEvent[] = [], seen = new Map<string, string>();
    async function send(sender: typeof first, request: ToDeviceRequest): Promise<void> {
      try {
        assert.equal(request.type, RequestType.ToDevice);
        assert.equal(TYPES.has(request.event_type), true);
        assert.ok(request.id);
        const token = `${sender.id}:${request.id}`;
        const recipient = sender === first ? second : first;
        const body = JSON.parse(request.body);
        assert.equal(Object.keys(body.messages).join(), SAS_FIXTURE_USER);
        assert.equal(Object.keys(body.messages[SAS_FIXTURE_USER]).join(), recipient.id);
        const event = { eventType: request.event_type, transactionId: request.txn_id, body,
          expected: { userId: SAS_FIXTURE_USER, senderDeviceId: sender.id, recipientDeviceId: recipient.id, flowId, pinnedMasterKey } };
        assert.equal(request.id, request.txn_id);
        validate?.(structuredClone(event));
        const fingerprint = JSON.stringify({ type: event.eventType, body });
        if (seen.has(token)) {
          assert.equal(seen.get(token) === fingerprint, true, "SAS_FIXTURE_RETRY_MISMATCH");
          return;
        }
        events.push(structuredClone(event));
        const changed = new DeviceLists();
        try {
          const processed = await recipient.machine.receiveSyncChanges(JSON.stringify([{ sender: SAS_FIXTURE_USER, type: request.event_type,
            content: body.messages[SAS_FIXTURE_USER][recipient.id] }]), changed, new Map(), new Set());
          processed.forEach((item) => item.free?.());
        } finally { changed.free(); }
        await sender.machine.markRequestAsSent(request.id, request.type, "{}"); seen.set(token, fingerprint);
      } finally { request.free(); }
    }
    async function flush(): Promise<void> {
      for (let round = 0; round < 20; round++) {
        let delivered = false;
        for (const peer of peers) {
          const requests = await peer.machine.outgoingRequests();
          let index = 0;
          try {
            while (index < requests.length) {
              const request = requests[index++];
              if (request.type === RequestType.ToDevice && TYPES.has((request as ToDeviceRequest).event_type)) {
                delivered ||= !seen.has(`${peer.id}:${request.id}`); await send(peer, request as ToDeviceRequest);
              } else request.free(); // No certificate publication or secret relay/ACK.
            }
          } finally { requests.slice(index).forEach((request) => request.free()); }
        }
        if (!delivered) return;
      }
      throw new Error("SAS_FIXTURE_DID_NOT_SETTLE");
    }
    await send(starter, outgoing);
    const responderUser = new UserId(SAS_FIXTURE_USER);
    let responderRequest: VerificationRequest | undefined;
    try { responderRequest = responder.machine.getVerificationRequest(responderUser, flowId); } finally { responderUser.free(); }
    if (responder === first) firstRequest = responderRequest; else secondRequest = responderRequest;
    assert.ok(responderRequest);
    const ready = responderRequest.acceptWithMethods([VerificationMethod.SasV1]); assert.ok(ready); await send(responder, ready);
    const started = await starterRequest.startSas(); assert.ok(started);
    const [starterSas, start] = started;
    if (starter === first) firstSas = starterSas; else secondSas = starterSas;
    await send(starter, start);
    const sasUser = new UserId(SAS_FIXTURE_USER);
    let responderSas: Sas | undefined;
    try { responderSas = responder.machine.getVerification(sasUser, flowId) as Sas | undefined; } finally { sasUser.free(); }
    if (responder === first) firstSas = responderSas; else secondSas = responderSas;
    assert.ok(responderSas); assert.ok(firstSas); assert.ok(secondSas);
    const accept = responderSas.accept(); assert.ok(accept); await send(responder, accept); await flush();
    assert.equal(firstSas.canBePresented(), true); assert.equal(secondSas.canBePresented(), true);
    assert.equal(JSON.stringify(Array.from(firstSas.decimals()!)) === JSON.stringify(Array.from(secondSas.decimals()!)), true, "SAS_FIXTURE_COMPARISON_MISMATCH");
    if (cancelCode) {
      const cancel = firstSas.cancelWithCode(cancelCode); assert.ok(cancel); await send(first, cancel); await flush();
      assert.equal(firstSas.isCancelled(), true); assert.equal(secondSas.isCancelled(), true);
    } else {
      for (const [peer, sas] of [[first, firstSas], [second, secondSas]] as const) {
        const requests = await sas.confirm();
        let index = 0;
        try { while (index < requests.length) { const request = requests[index++];
          if (request.type === RequestType.ToDevice) await send(peer, request); else request.free();
        } } finally { requests.slice(index).forEach((request) => request.free()); }
      }
      await flush(); assert.equal(firstSas.isDone(), true); assert.equal(secondSas.isDone(), true);
    }
    const secrets = await second.machine.crossSigningStatus();
    try { assert.equal(secrets.hasMaster || secrets.hasSelfSigning || secrets.hasUserSigning, false); } finally { secrets.free(); }
    return events;
  } finally {
    firstSas?.free(); secondSas?.free(); firstRequest?.free(); secondRequest?.free();
    peers.forEach((peer) => peer.machine.close());
  }
}
