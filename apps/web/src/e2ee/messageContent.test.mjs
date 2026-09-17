import assert from "node:assert/strict";
import {
  SINOCHAT_ATTACHMENT_CIPHER_SUITE,
  SINOCHAT_MAX_IMAGE_CIPHERTEXT_BYTES,
  SINOCHAT_MAX_IMAGE_PLAINTEXT_BYTES,
  SINOCHAT_MAX_TEXT_LENGTH,
  SINOCHAT_MESSAGE_CIPHER_SUITE,
  SINOCHAT_MESSAGE_EVENT_TYPE,
  SINOCHAT_MESSAGE_PROTOCOL_VERSION,
  SinoChatMessageCodecError,
  assertSinoChatMessageBinding,
  decodeSinoChatMessageContent,
  encodeSinoChatImageMessage,
  encodeSinoChatTextMessage,
} from "./messageContent.ts";

const conversationId = "11111111-1111-4111-8111-111111111111";
const roomId = "!c11111111111141118111111111111111:sinochat.invalid";
const clientMessageId = "22222222-2222-4222-8222-222222222222";
const senderDeviceId = "33333333-3333-4333-8333-333333333333";
const senderUserId = "44444444-4444-4444-8444-444444444444";
const ciphertextSha256 =
  "5e3fd3ddb57c78a9967f03f895d2b49d9a4463c11e690f75919414424845613d";
const mediaEncryptionInfo = {
  v: "v2",
  key: {
    kty: "oct",
    key_ops: ["decrypt", "encrypt"],
    alg: "A256CTR",
    k: "lYJdU33EfIhqQwz8u1UfE_CYYXqg10umO4OC3emh434",
    ext: true,
  },
  iv: "fBrcTk+HD3gAAAAAAAAAAA",
  hashes: {
    sha256: "Xj/T3bV8eKmWfwP4ldK0nZpEY8EeaQ91kZQUQkhFYT0",
  },
};

assert.equal(SINOCHAT_MESSAGE_EVENT_TYPE, "com.sinochat.message.v1");
assert.equal(SINOCHAT_MESSAGE_PROTOCOL_VERSION, "matrix-megolm-v1");
assert.equal(SINOCHAT_ATTACHMENT_CIPHER_SUITE, "A256CTR");
assert.equal(
  SINOCHAT_MESSAGE_CIPHER_SUITE,
  "m.megolm.v1.aes-sha2",
);
assert.equal(SINOCHAT_MAX_TEXT_LENGTH, 4_000);
assert.equal(SINOCHAT_MAX_IMAGE_PLAINTEXT_BYTES, 5 * 1024 * 1024);
assert.equal(
  SINOCHAT_MAX_IMAGE_CIPHERTEXT_BYTES,
  5 * 1024 * 1024 + 256 * 1024,
);

const text = encodeSinoChatTextMessage({
  conversationId: conversationId.toUpperCase(),
  roomId,
  clientMessageId,
  senderUserId,
  senderDeviceId,
  text: "Mensaje privado de prueba",
});
assert.equal(text.eventType, SINOCHAT_MESSAGE_EVENT_TYPE);
assert.equal(text.content.conversationId, conversationId);
assert.ok(Object.isFrozen(text));
assert.ok(Object.isFrozen(text.content));
assert.deepEqual(
  decodeSinoChatMessageContent(text.eventType, text.content, {
    conversationId,
    roomId,
    clientMessageId,
    senderUserId,
    senderDeviceId,
    kind: "TEXT",
    protocolVersion: SINOCHAT_MESSAGE_PROTOCOL_VERSION,
    cipherSuite: SINOCHAT_MESSAGE_CIPHER_SUITE,
    attachment: null,
  }),
  text.content,
);

const image = encodeSinoChatImageMessage({
  conversationId,
  roomId,
  clientMessageId,
  senderUserId,
  senderDeviceId,
  declaredMimeType: "image/webp",
  plaintextByteSize: 5,
  ciphertextByteSize: 5,
  ciphertextSha256: ciphertextSha256.toUpperCase(),
  mediaEncryptionInfo: JSON.stringify(mediaEncryptionInfo),
});
assert.equal(image.content.image.ciphertextSha256, ciphertextSha256);
assert.ok(Object.isFrozen(image.content.image));
assert.ok(Object.isFrozen(image.content.image.mediaEncryptionInfo.key));
assertSinoChatMessageBinding(image.content, {
  conversationId,
  roomId,
  clientMessageId,
  senderUserId,
  senderDeviceId,
  kind: "IMAGE",
  protocolVersion: SINOCHAT_MESSAGE_PROTOCOL_VERSION,
  cipherSuite: SINOCHAT_MESSAGE_CIPHER_SUITE,
  attachment: {
    declaredMimeType: "image/webp",
    plaintextByteSize: 5,
    ciphertextByteSize: 5,
    ciphertextSha256,
    cipherSuite: SINOCHAT_ATTACHMENT_CIPHER_SUITE,
  },
});

assertCodecError(
  () =>
    decodeSinoChatMessageContent("m.room.message", text.content, {
      conversationId,
      roomId,
      clientMessageId,
      senderUserId,
      senderDeviceId,
      kind: "TEXT",
      protocolVersion: SINOCHAT_MESSAGE_PROTOCOL_VERSION,
      cipherSuite: SINOCHAT_MESSAGE_CIPHER_SUITE,
    }),
  "SINOCHAT_MESSAGE_EVENT_TYPE_INVALID",
);
assertCodecError(
  () =>
    decodeSinoChatMessageContent(
      SINOCHAT_MESSAGE_EVENT_TYPE,
      {
        ...text.content,
        plaintext: "campo inesperado",
      },
      {
        conversationId,
        roomId,
        clientMessageId,
        senderUserId,
        senderDeviceId,
        kind: "TEXT",
        protocolVersion: SINOCHAT_MESSAGE_PROTOCOL_VERSION,
        cipherSuite: SINOCHAT_MESSAGE_CIPHER_SUITE,
      },
    ),
  "SINOCHAT_MESSAGE_CONTENT_INVALID",
);
assertCodecError(
  () =>
    encodeSinoChatTextMessage({
      conversationId,
      roomId,
      clientMessageId,
      senderUserId,
      senderDeviceId,
      text: " ".repeat(20),
    }),
  "SINOCHAT_MESSAGE_CONTENT_INVALID",
);
assertCodecError(
  () =>
    encodeSinoChatTextMessage({
      conversationId,
      roomId,
      clientMessageId,
      senderUserId,
      senderDeviceId,
      text: "x".repeat(SINOCHAT_MAX_TEXT_LENGTH + 1),
    }),
  "SINOCHAT_MESSAGE_CONTENT_INVALID",
);
assertCodecError(
  () =>
    encodeSinoChatImageMessage({
      conversationId,
      roomId,
      clientMessageId,
      senderUserId,
      senderDeviceId,
      declaredMimeType: "image/svg+xml",
      plaintextByteSize: 5,
      ciphertextByteSize: 5,
      ciphertextSha256,
      mediaEncryptionInfo,
    }),
  "SINOCHAT_ATTACHMENT_INFO_INVALID",
);
assertCodecError(
  () =>
    encodeSinoChatImageMessage({
      conversationId,
      roomId,
      clientMessageId,
      senderUserId,
      senderDeviceId,
      declaredMimeType: "image/png",
      plaintextByteSize: 6,
      ciphertextByteSize: 5,
      ciphertextSha256,
      mediaEncryptionInfo,
    }),
  "SINOCHAT_ATTACHMENT_INFO_INVALID",
);
assertCodecError(
  () =>
    encodeSinoChatImageMessage({
      conversationId,
      roomId,
      clientMessageId,
      senderUserId,
      senderDeviceId,
      declaredMimeType: "image/png",
      plaintextByteSize: 5,
      ciphertextByteSize: 5,
      ciphertextSha256: "0".repeat(64),
      mediaEncryptionInfo,
    }),
  "SINOCHAT_ATTACHMENT_INFO_INVALID",
);
assertCodecError(
  () =>
    decodeSinoChatMessageContent(text.eventType, text.content, {
      conversationId,
      roomId,
      clientMessageId: "44444444-4444-4444-8444-444444444444",
      senderUserId,
      senderDeviceId,
      kind: "TEXT",
      protocolVersion: SINOCHAT_MESSAGE_PROTOCOL_VERSION,
      cipherSuite: SINOCHAT_MESSAGE_CIPHER_SUITE,
    }),
  "SINOCHAT_MESSAGE_BINDING_MISMATCH",
);
assertCodecError(
  () =>
    decodeSinoChatMessageContent(text.eventType, text.content, {
      conversationId,
      roomId: "!c11111111111141118111111111111111:otro.invalid",
      clientMessageId,
      senderUserId,
      senderDeviceId,
      kind: "TEXT",
      protocolVersion: SINOCHAT_MESSAGE_PROTOCOL_VERSION,
      cipherSuite: SINOCHAT_MESSAGE_CIPHER_SUITE,
    }),
  "SINOCHAT_MESSAGE_BINDING_MISMATCH",
);
assertCodecError(
  () =>
    decodeSinoChatMessageContent(
      text.eventType,
      { ...text.content, roomId: roomId.toUpperCase() },
      {
        conversationId,
        roomId,
        clientMessageId,
        senderUserId,
        senderDeviceId,
        kind: "TEXT",
        protocolVersion: SINOCHAT_MESSAGE_PROTOCOL_VERSION,
        cipherSuite: SINOCHAT_MESSAGE_CIPHER_SUITE,
      },
    ),
  "SINOCHAT_MESSAGE_CONTENT_INVALID",
);
assertCodecError(
  () =>
    encodeSinoChatTextMessage({
      conversationId,
      roomId: "!c22222222222242228222222222222222:sinochat.invalid",
      clientMessageId,
      senderUserId,
      senderDeviceId,
      text: "Sala incorrecta",
    }),
  "SINOCHAT_MESSAGE_CONTENT_INVALID",
);
assertCodecError(
  () =>
    decodeSinoChatMessageContent(text.eventType, text.content, {
      conversationId,
      roomId,
      clientMessageId,
      senderUserId,
      senderDeviceId,
      kind: "TEXT",
      protocolVersion: "legacy-v0",
      cipherSuite: SINOCHAT_MESSAGE_CIPHER_SUITE,
    }),
  "SINOCHAT_MESSAGE_BINDING_MISMATCH",
);
assertCodecError(
  () =>
    decodeSinoChatMessageContent(text.eventType, text.content, {
      conversationId,
      roomId,
      clientMessageId,
      senderUserId,
      senderDeviceId,
      kind: "TEXT",
      protocolVersion: SINOCHAT_MESSAGE_PROTOCOL_VERSION,
      cipherSuite: "m.megolm.v1.aes-sha1",
    }),
  "SINOCHAT_MESSAGE_BINDING_MISMATCH",
);
assertCodecError(
  () =>
    assertSinoChatMessageBinding(image.content, {
      conversationId,
      roomId,
      clientMessageId,
      senderUserId,
      senderDeviceId,
      kind: "IMAGE",
      protocolVersion: SINOCHAT_MESSAGE_PROTOCOL_VERSION,
      cipherSuite: SINOCHAT_MESSAGE_CIPHER_SUITE,
      attachment: {
        declaredMimeType: "image/webp",
        plaintextByteSize: 5,
        ciphertextByteSize: 5,
        ciphertextSha256: "0".repeat(64),
        cipherSuite: SINOCHAT_ATTACHMENT_CIPHER_SUITE,
      },
    }),
  "SINOCHAT_ATTACHMENT_BINDING_MISMATCH",
);
assertCodecError(
  () =>
    assertSinoChatMessageBinding(image.content, {
      conversationId,
      roomId,
      clientMessageId,
      senderUserId,
      senderDeviceId,
      kind: "IMAGE",
      protocolVersion: SINOCHAT_MESSAGE_PROTOCOL_VERSION,
      cipherSuite: SINOCHAT_MESSAGE_CIPHER_SUITE,
      attachment: {
        declaredMimeType: "image/webp",
        plaintextByteSize: 5,
        ciphertextByteSize: 5,
        ciphertextSha256,
        cipherSuite: SINOCHAT_MESSAGE_CIPHER_SUITE,
      },
    }),
  "SINOCHAT_ATTACHMENT_BINDING_MISMATCH",
);
assertCodecError(
  () =>
    decodeSinoChatMessageContent(text.eventType, text.content, {
      conversationId,
      roomId,
      clientMessageId,
      senderUserId: "55555555-5555-4555-8555-555555555555",
      senderDeviceId,
      kind: "TEXT",
      protocolVersion: SINOCHAT_MESSAGE_PROTOCOL_VERSION,
      cipherSuite: SINOCHAT_MESSAGE_CIPHER_SUITE,
    }),
  "SINOCHAT_MESSAGE_BINDING_MISMATCH",
);

console.log(
  "[OK] El codec interior v1 valida texto, imagen Matrix v2 y binding de transporte.",
);

function assertCodecError(operation, expectedCode) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof SinoChatMessageCodecError);
    assert.equal(error.code, expectedCode);
    return true;
  });
}
