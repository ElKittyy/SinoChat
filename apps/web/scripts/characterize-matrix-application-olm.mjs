import assert from "node:assert/strict";
import {
  DeviceId,
  DeviceLists,
  OlmMachine,
  ProcessedToDeviceEventType,
  RequestType,
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
const senderSecondaryIdentity = {
  userId: senderIdentity.userId,
  deviceId: "D33333333333343338333333333333333",
};

await initAsync();

const sender = await createMachine(senderIdentity);
const recipient = await createMachine(recipientIdentity);
const senderSecondary = await createMachine(senderSecondaryIdentity);

try {
  const senderUpload = await completeInitialUpload(sender);
  const recipientUpload = await completeInitialUpload(recipient);
  const senderSecondaryUpload = await completeInitialUpload(senderSecondary);

  await characterizeCurrentDeviceEnvelope(
    sender,
    senderIdentity,
    senderUpload.one_time_keys,
  );

  await teachUserDevices(sender, senderIdentity.userId, {
    [senderIdentity.deviceId]: senderUpload.device_keys,
    [senderSecondaryIdentity.deviceId]: senderSecondaryUpload.device_keys,
  });
  await teachUserDevices(senderSecondary, senderIdentity.userId, {
    [senderIdentity.deviceId]: senderUpload.device_keys,
    [senderSecondaryIdentity.deviceId]: senderSecondaryUpload.device_keys,
  });
  await establishOutboundSession(
    sender,
    senderSecondaryIdentity,
    senderSecondaryUpload.one_time_keys,
  );
  const secondaryEnvelope = await encryptApplicationContent(
    sender,
    senderSecondaryIdentity,
    {
      version: 1,
      conversationId: "33333333-3333-4333-8333-333333333333",
      clientMessageId: "66666666-6666-4666-8666-666666666666",
      kind: "TEXT",
      text: "sincronizacion con otro dispositivo propio",
    },
  );
  assert.equal(
    secondaryEnvelope.algorithm,
    "m.olm.v1.curve25519-aes-sha2",
  );
  assert.equal(
    secondaryEnvelope.sender_key,
    senderUpload.device_keys.keys[
      `curve25519:${senderIdentity.deviceId}`
    ],
    "El sobre para otro dispositivo propio debe autenticar el dispositivo emisor actual",
  );
  assert.deepEqual(Object.keys(secondaryEnvelope.ciphertext), [
    senderSecondaryUpload.device_keys.keys[
      `curve25519:${senderSecondaryIdentity.deviceId}`
    ],
  ]);
  assert.match(secondaryEnvelope["org.matrix.msgid"], /^[0-9a-f]{32}$/);
  const secondaryDecrypted = await receiveApplicationEnvelope(
    senderSecondary,
    senderIdentity.userId,
    secondaryEnvelope,
    {
      eventId: "$m66666666666646668666666666666666:sinochat.invalid",
      originServerTs: 1_786_000_000_002,
    },
  );
  try {
    assert.equal(
      secondaryDecrypted.type,
      ProcessedToDeviceEventType.Decrypted,
      "Otro dispositivo del remitente si debe recibir un sobre Olm",
    );
    const secondaryRaw = JSON.parse(secondaryDecrypted.rawEvent);
    assert.equal(secondaryRaw.sender, senderIdentity.userId);
    assert.equal(secondaryRaw.recipient, senderIdentity.userId);
    assert.equal(
      secondaryRaw.sender_device_keys.device_id,
      senderIdentity.deviceId,
    );
    assert.equal(
      secondaryRaw.content.text,
      "sincronizacion con otro dispositivo propio",
    );
  } finally {
    secondaryDecrypted.free();
  }

  await teachDevice(sender, recipientIdentity, recipientUpload.device_keys);
  await teachDevice(recipient, senderIdentity, senderUpload.device_keys);
  await establishOutboundSession(
    sender,
    recipientIdentity,
    recipientUpload.one_time_keys,
  );

  const recipientUserId = new UserId(recipientIdentity.userId);
  const recipientDeviceId = new DeviceId(recipientIdentity.deviceId);
  let recipientDevice;
  try {
    recipientDevice = await sender.getDevice(
      recipientUserId,
      recipientDeviceId,
    );
  } finally {
    recipientUserId.free();
    recipientDeviceId.free();
  }
  assert.ok(recipientDevice, "El dispositivo destinatario debe estar en el directorio local");

  let encryptedContent;
  try {
    encryptedContent = JSON.parse(
      await recipientDevice.encryptToDeviceEvent(
        "com.sinochat.message.v1",
        {
          version: 1,
          conversationId: "33333333-3333-4333-8333-333333333333",
          clientMessageId: "44444444-4444-4444-8444-444444444444",
          kind: "TEXT",
          text: "mensaje cifrado de caracterizacion",
        },
      ),
    );
  } finally {
    recipientDevice.free();
  }

  assert.equal(encryptedContent.algorithm, "m.olm.v1.curve25519-aes-sha2");
  assert.equal(typeof encryptedContent.sender_key, "string");
  assert.deepEqual(Object.keys(encryptedContent).sort(), [
    "algorithm",
    "ciphertext",
    "org.matrix.msgid",
    "sender_key",
  ]);
  assert.match(
    encryptedContent["org.matrix.msgid"],
    /^[0-9a-f]{32}$/,
    "Rust Crypto agrega el identificador antirreplay org.matrix.msgid",
  );
  assert.deepEqual(Object.keys(encryptedContent.ciphertext), [
    recipientUpload.device_keys.keys[
      `curve25519:${recipientIdentity.deviceId}`
    ],
  ]);
  assert.equal(
    encryptedContent.ciphertext[
      recipientUpload.device_keys.keys[
        `curve25519:${recipientIdentity.deviceId}`
      ]
    ].type,
    0,
    "El primer mensaje debe abrir la sesion con un pre-key message Olm",
  );

  const decrypted = await receiveApplicationEnvelope(
    recipient,
    senderIdentity.userId,
    encryptedContent,
    {
      eventId: "$m44444444444444448444444444444444:sinochat.invalid",
      originServerTs: 1_786_000_000_000,
    },
  );
  try {
    assert.equal(decrypted.type, ProcessedToDeviceEventType.Decrypted);
    const raw = JSON.parse(decrypted.rawEvent);
    assert.deepEqual(Object.keys(raw).sort(), [
      "content",
      "keys",
      "recipient",
      "recipient_keys",
      "sender",
      "sender_device_keys",
      "type",
    ]);
    assert.equal(raw.type, "com.sinochat.message.v1");
    assert.equal(raw.sender, senderIdentity.userId);
    assert.equal(raw.recipient, recipientIdentity.userId);
    assert.equal(
      raw.sender_device_keys.device_id,
      senderIdentity.deviceId,
    );
    assert.equal(
      raw.sender_device_keys.user_id,
      senderIdentity.userId,
    );
    assert.equal(raw.event_id, undefined);
    assert.equal(raw.origin_server_ts, undefined);
    assert.equal(raw.content.text, "mensaje cifrado de caracterizacion");
    const encryptionInfo = decrypted.encryptionInfo;
    try {
      const senderUserId = encryptionInfo.sender;
      const senderDeviceId = encryptionInfo.senderDevice;
      try {
        assert.equal(senderUserId.toString(), senderIdentity.userId);
        assert.equal(senderDeviceId?.toString(), senderIdentity.deviceId);
      } finally {
        senderUserId.free();
        senderDeviceId?.free();
      }
    } finally {
      encryptionInfo.free();
    }
  } finally {
    decrypted.free();
  }

  const replayed = await receiveApplicationEnvelope(
    recipient,
    senderIdentity.userId,
    encryptedContent,
    {
      eventId: "$m44444444444444448444444444444444:sinochat.invalid",
      originServerTs: 1_786_000_000_000,
    },
  );
  try {
    assert.equal(
      replayed.type,
      ProcessedToDeviceEventType.UnableToDecrypt,
      "Rust Crypto debe rechazar el replay exacto del sobre persistido",
    );
  } finally {
    replayed.free();
  }

  const wrongSenderContent = await encryptApplicationContent(
    sender,
    recipientIdentity,
    {
      version: 1,
      conversationId: "33333333-3333-4333-8333-333333333333",
      clientMessageId: "55555555-5555-4555-8555-555555555555",
      kind: "TEXT",
      text: "sender exterior alterado",
    },
  );
  const mismatched = await receiveApplicationEnvelope(
    recipient,
    recipientIdentity.userId,
    wrongSenderContent,
    {
      eventId: "$m55555555555545558555555555555555:sinochat.invalid",
      originServerTs: 1_786_000_000_001,
    },
  );
  try {
    assert.equal(
      mismatched.type,
      ProcessedToDeviceEventType.UnableToDecrypt,
      "Rust Crypto debe rechazar un sender exterior distinto del autenticado",
    );
  } finally {
    mismatched.free();
  }

  console.log(
    "[OK] Olm funciona entre dispositivos, incluso de una misma cuenta; el dispositivo actual no puede cifrar para si mismo. Tambien autentica sender/dispositivo y rechaza sender alterado y replay; event_id/timestamp no forman parte de la salida autenticada.",
  );
} finally {
  sender.close();
  recipient.close();
  senderSecondary.close();
}

async function createMachine(identity) {
  const userId = new UserId(identity.userId);
  const deviceId = new DeviceId(identity.deviceId);
  try {
    return await OlmMachine.initialize(userId, deviceId);
  } finally {
    userId.free();
    deviceId.free();
  }
}

async function completeInitialUpload(machine) {
  const requests = await machine.outgoingRequests();
  try {
    const upload = requests.find(
      (request) => request.type === RequestType.KeysUpload,
    );
    assert.ok(upload, "Debe existir el upload inicial");
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
    const query = requests.find(
      (request) => request.type === RequestType.KeysQuery,
    );
    assert.ok(query, "Debe existir keys/query para el usuario seguido");
    await machine.markRequestAsSent(
      query.id,
      query.type,
      JSON.stringify({
        device_keys: {
          [identity.userId]: {
            [identity.deviceId]: deviceKeys,
          },
        },
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

async function teachUserDevices(machine, matrixUserId, deviceKeys) {
  const userId = new UserId(matrixUserId);
  let query;
  try {
    query = machine.queryKeysForUsers([userId]);
  } catch (error) {
    userId.free();
    throw error;
  }
  try {
    await machine.markRequestAsSent(
      query.id,
      query.type,
      JSON.stringify({
        device_keys: { [matrixUserId]: deviceKeys },
        failures: {},
        master_keys: {},
        self_signing_keys: {},
        user_signing_keys: {},
      }),
    );
  } finally {
    query.free();
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
  assert.ok(claim, "Debe existir keys/claim antes del primer mensaje Olm");
  try {
    const requestBody = JSON.parse(claim.body);
    const requestedAlgorithm =
      requestBody.one_time_keys[identity.userId][identity.deviceId];
    assert.equal(requestedAlgorithm, "signed_curve25519");
    const oneTimeKeyEntry = Object.entries(oneTimeKeys).find(([keyId]) =>
      keyId.startsWith(`${requestedAlgorithm}:`),
    );
    assert.ok(oneTimeKeyEntry, "El destinatario debe ofrecer una OTK solicitada");
    await machine.markRequestAsSent(
      claim.id,
      claim.type,
      JSON.stringify({
        failures: {},
        one_time_keys: {
          [identity.userId]: {
            [identity.deviceId]: {
              [oneTimeKeyEntry[0]]: oneTimeKeyEntry[1],
            },
          },
        },
      }),
    );
  } finally {
    claim.free();
  }
}

async function characterizeCurrentDeviceEnvelope(
  machine,
  identity,
  oneTimeKeys,
) {
  const userId = new UserId(identity.userId);
  const deviceId = new DeviceId(identity.deviceId);
  let ownDevice;
  try {
    ownDevice = await machine.getDevice(userId, deviceId);
  } finally {
    userId.free();
    deviceId.free();
  }
  assert.ok(ownDevice, "La maquina debe conocer su dispositivo actual");
  try {
    await assert.rejects(
      ownDevice.encryptToDeviceEvent(
        "com.sinochat.message.v1",
        { version: 1, text: "self probe" },
      ),
      /does not have a valid Olm session with us/,
      "El SDK no debe aparentar que cifra para el dispositivo actual",
    );
  } finally {
    ownDevice.free();
  }

  const selfUserId = new UserId(identity.userId);
  let claim;
  try {
    claim = await machine.getMissingSessions([selfUserId]);
  } catch (error) {
    selfUserId.free();
    throw error;
  }
  assert.equal(
    claim,
    null,
    "getMissingSessions excluye el dispositivo actual y no puede crear una sesion consigo mismo",
  );
  assert.ok(
    Object.keys(oneTimeKeys).length > 0,
    "La ausencia de sesion propia no debe confundirse con falta de OTK publicadas",
  );
}

async function encryptApplicationContent(machine, identity, content) {
  const userId = new UserId(identity.userId);
  const deviceId = new DeviceId(identity.deviceId);
  let device;
  try {
    device = await machine.getDevice(userId, deviceId);
  } finally {
    userId.free();
    deviceId.free();
  }
  assert.ok(device, "El dispositivo destinatario debe estar disponible");
  try {
    return JSON.parse(
      await device.encryptToDeviceEvent(
        "com.sinochat.message.v1",
        content,
      ),
    );
  } finally {
    device.free();
  }
}

async function receiveApplicationEnvelope(machine, sender, content, metadata) {
  const lists = new DeviceLists([], []);
  try {
    const events = await machine.receiveSyncChanges(
      JSON.stringify([
        {
          type: "m.room.encrypted",
          sender,
          content,
          event_id: metadata.eventId,
          origin_server_ts: metadata.originServerTs,
        },
      ]),
      lists,
      new Map(),
      new Set(),
    );
    assert.equal(events.length, 1);
    return events[0];
  } finally {
    lists.free();
  }
}
