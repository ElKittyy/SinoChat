import assert from "node:assert/strict";
import {
  MATRIX_ATTACHMENT_CIPHER_SUITE,
  MATRIX_MEGOLM_ALGORITHM,
  MATRIX_MESSAGE_PROTOCOL_VERSION,
  MessagePayloadError,
  parseAttachmentUploadGrant,
  parseEncryptedMessagePage,
  parseMatrixMegolmEnvelopeBase64,
  parseMessageAcknowledgement,
  parseMessageReceiptAcknowledgement,
  validateAttachmentUploadRequest,
  validateSendEncryptedMessageRequest,
} from "./messagePayload.ts";

const messageId = "11111111-1111-4111-8111-111111111111";
const senderUserId = "22222222-2222-4222-8222-222222222222";
const senderDeviceId = "33333333-3333-4333-8333-333333333333";
const clientMessageId = "44444444-4444-4444-8444-444444444444";
const recipientUserId = "55555555-5555-4555-8555-555555555555";
const createdAt = "2026-08-31T12:00:00.000Z";
const expiresAt = "2026-09-02T12:00:00.000Z";
const outerContent = {
  algorithm: MATRIX_MEGOLM_ALGORITHM,
  ciphertext: "A".repeat(22),
  device_id: "D33333333333343338333333333333333",
  sender_key: "A".repeat(43),
  session_id: "A".repeat(43),
};
const encodedOuterContent = btoa(JSON.stringify(outerContent));

const message = {
  id: messageId,
  senderUserId,
  senderDeviceId,
  clientMessageId,
  serverSequence: "7",
  kind: "TEXT",
  createdAt,
  expiresAt,
  envelope: {
    protocolVersion: MATRIX_MESSAGE_PROTOCOL_VERSION,
    cipherSuite: MATRIX_MEGOLM_ALGORITHM,
    ciphertext: encodedOuterContent,
  },
  attachment: null,
  receipts: [
    {
      recipientUserId,
      status: "DELIVERED",
      deliveredAt: "2026-08-31T12:00:01.000Z",
      readAt: null,
    },
  ],
};

const parsedPage = parseEncryptedMessagePage({
  items: [message],
  nextAfterSequence: "7",
});
assert.equal(parsedPage.items[0].envelope.content.device_id, outerContent.device_id);
assert.equal(parsedPage.items[0].expiresAt, expiresAt);
assert.ok(Object.isFrozen(parsedPage));
assert.ok(Object.isFrozen(parsedPage.items));
assert.ok(Object.isFrozen(parsedPage.items[0].envelope.content));

const parsedOuter = parseMatrixMegolmEnvelopeBase64(encodedOuterContent);
assert.deepEqual(parsedOuter.content, outerContent);

assertPayloadError(
  () =>
    parseEncryptedMessagePage({
      items: [{ ...message, plaintext: "filtracion" }],
      nextAfterSequence: "7",
    }),
  "MESSAGE_ITEM_FIELDS_INVALID",
);
assertPayloadError(
  () =>
    parseEncryptedMessagePage({
      items: [
        {
          ...message,
          envelope: { ...message.envelope, protocolVersion: "matrix-olm-v1" },
        },
      ],
      nextAfterSequence: "7",
    }),
  "MESSAGE_ENVELOPE_PROFILE_INVALID",
);
assertPayloadError(
  () =>
    parseEncryptedMessagePage({
      items: [
        {
          ...message,
          senderDeviceId: recipientUserId,
        },
      ],
      nextAfterSequence: "7",
    }),
  "MESSAGE_ENVELOPE_SENDER_DEVICE_MISMATCH",
);
assertPayloadError(
  () =>
    parseEncryptedMessagePage({
      items: [{ ...message, expiresAt: "2026-09-02T11:59:59.000Z" }],
      nextAfterSequence: "7",
    }),
  "MESSAGE_RETENTION_INVALID",
);
assertPayloadError(
  () =>
    parseEncryptedMessagePage({
      items: [message],
      nextAfterSequence: "8",
    }),
  "MESSAGE_PAGE_CURSOR_INVALID",
);
assertPayloadError(
  () =>
    parseEncryptedMessagePage({
      items: [message, { ...message, id: recipientUserId, serverSequence: "6" }],
      nextAfterSequence: "6",
    }),
  "MESSAGE_PAGE_ORDER_INVALID",
);
assertPayloadError(
  () =>
    parseEncryptedMessagePage({
      items: [
        {
          ...message,
          receipts: [
            {
              recipientUserId,
              status: "SENT",
              deliveredAt: "2026-08-31T12:00:01.000Z",
              readAt: null,
            },
          ],
        },
      ],
      nextAfterSequence: "7",
    }),
  "MESSAGE_RECEIPT_STATE_INVALID",
);
assertPayloadError(
  () =>
    parseMatrixMegolmEnvelopeBase64(
      btoa(JSON.stringify({ ...outerContent, sender_key: "B".repeat(43) })),
    ),
  "MATRIX_MEGOLM_CONTENT_INVALID",
);
assertPayloadError(
  () => parseMatrixMegolmEnvelopeBase64(`${encodedOuterContent}=`),
  "MATRIX_MEGOLM_BASE64_INVALID",
);

const imageMessage = {
  ...message,
  kind: "IMAGE",
  attachment: {
    declaredMimeType: "image/webp",
    plaintextByteSize: 32,
    ciphertextByteSize: 32,
    ciphertextSha256: "00".repeat(32),
    cipherSuite: MATRIX_ATTACHMENT_CIPHER_SUITE,
    downloadUrl: "https://storage.invalid/private/photo?signature=opaque",
  },
};
const parsedImage = parseEncryptedMessagePage({
  items: [imageMessage],
  nextAfterSequence: "7",
});
assert.equal(parsedImage.items[0].attachment.declaredMimeType, "image/webp");
assertPayloadError(
  () =>
    parseEncryptedMessagePage({
      items: [{ ...message, attachment: imageMessage.attachment }],
      nextAfterSequence: "7",
    }),
  "MESSAGE_ATTACHMENT_KIND_INVALID",
);
assertPayloadError(
  () =>
    parseEncryptedMessagePage({
      items: [
        {
          ...imageMessage,
          attachment: { ...imageMessage.attachment, downloadUrl: "javascript:alert(1)" },
        },
      ],
      nextAfterSequence: "7",
    }),
  "MESSAGE_ATTACHMENT_URL_INVALID",
);

const expectedSha256 = "00".repeat(32);
const uploadGrant = parseAttachmentUploadGrant(
  {
    uploadUrl: "https://storage.invalid/private/upload?signature=opaque",
    uploadHeaders: {
      "cache-control": "private, no-store, max-age=0",
      "content-length": 32,
      "content-type": "application/octet-stream",
      "if-none-match": "*",
      "x-amz-checksum-sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    },
    uploadExpiresInSeconds: 300,
    grantToken: `${"A".repeat(60)}.${"B".repeat(43)}`,
    grantExpiresAt: "2026-08-31T12:10:00.000Z",
  },
  { ciphertextByteSize: 32, ciphertextSha256: expectedSha256 },
);
assert.equal(uploadGrant.uploadHeaders["content-length"], 32);
assert.ok(Object.isFrozen(uploadGrant.uploadHeaders));
assertPayloadError(
  () =>
    parseAttachmentUploadGrant(
      {
        uploadUrl: "https://storage.invalid/private/upload",
        uploadHeaders: {
          ...uploadGrant.uploadHeaders,
          "content-length": 31,
        },
        uploadExpiresInSeconds: 300,
        grantToken: uploadGrant.grantToken,
        grantExpiresAt: uploadGrant.grantExpiresAt,
      },
      { ciphertextByteSize: 32, ciphertextSha256: expectedSha256 },
    ),
  "ATTACHMENT_UPLOAD_HEADERS_INVALID",
);

const acknowledgement = parseMessageAcknowledgement(
  {
    id: messageId,
    clientMessageId,
    serverSequence: "7",
    kind: "TEXT",
    createdAt,
    expiresAt,
    created: true,
  },
  { clientMessageId, kind: "TEXT" },
);
assert.equal(acknowledgement.created, true);
assertPayloadError(
  () =>
    parseMessageAcknowledgement(
      { ...acknowledgement, clientMessageId: recipientUserId },
      { clientMessageId, kind: "TEXT" },
    ),
  "MESSAGE_ACK_MISMATCH",
);

const attachmentRequest = validateAttachmentUploadRequest({
  declaredMimeType: "image/webp",
  plaintextByteSize: 32,
  ciphertextByteSize: 32,
  ciphertextSha256: expectedSha256,
});
assert.equal(attachmentRequest.ciphertextByteSize, 32);

const outbound = validateSendEncryptedMessageRequest({
  clientMessageId,
  senderDeviceId,
  kind: "TEXT",
  envelopes: [
    {
      recipientDeviceId: senderDeviceId,
      protocolVersion: MATRIX_MESSAGE_PROTOCOL_VERSION,
      cipherSuite: MATRIX_MEGOLM_ALGORITHM,
      ciphertext: encodedOuterContent,
    },
    {
      recipientDeviceId: recipientUserId,
      protocolVersion: MATRIX_MESSAGE_PROTOCOL_VERSION,
      cipherSuite: MATRIX_MEGOLM_ALGORITHM,
      ciphertext: encodedOuterContent,
    },
  ],
});
assert.equal(outbound.envelopes.length, 2);
assert.ok(Object.isFrozen(outbound.envelopes));
assertPayloadError(
  () =>
    validateSendEncryptedMessageRequest({
      ...outbound,
      envelopes: [outbound.envelopes[0], outbound.envelopes[0]],
    }),
  "SEND_MESSAGE_ENVELOPE_INVALID",
);
assertPayloadError(
  () =>
    validateSendEncryptedMessageRequest({
      ...outbound,
      senderDeviceId: recipientUserId,
    }),
  "SEND_MESSAGE_ENVELOPE_BINDING_INVALID",
);
assertPayloadError(
  () =>
    validateSendEncryptedMessageRequest({
      ...outbound,
      attachmentGrantToken: uploadGrant.grantToken,
    }),
  "SEND_MESSAGE_ATTACHMENT_GRANT_INVALID",
);

const receiptAck = parseMessageReceiptAcknowledgement(
  {
    messageId,
    status: "READ",
    deliveredAt: "2026-08-31T12:00:01.000Z",
    readAt: "2026-08-31T12:00:02.000Z",
  },
  messageId,
);
assert.equal(receiptAck.status, "READ");
assertPayloadError(
  () =>
    parseMessageReceiptAcknowledgement(
      {
        messageId,
        status: "READ",
        deliveredAt: "2026-08-31T12:00:02.000Z",
        readAt: "2026-08-31T12:00:01.000Z",
      },
      messageId,
    ),
  "MESSAGE_RECEIPT_ACK_MISMATCH",
);

console.log(
  "[OK] Los payloads HTTP de mensajes, fotos y Megolm rechazan perfiles o campos inesperados.",
);

function assertPayloadError(operation, code) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof MessagePayloadError);
    assert.equal(error.code, code);
    return true;
  });
}
