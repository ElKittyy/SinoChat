import { deepEqual, equal, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MATRIX_OLM_ALGORITHM,
  MATRIX_OLM_EVENT_TYPE,
  MatrixToDeviceValidationError,
  matrixToDeviceHashInput,
  parseMatrixToDeviceRequest
} from "./matrix-to-device";

const userId = "@u11111111111111111111111111111111:sinochat.invalid";
const deviceId = "D22222222222222222222222222222222";
const senderKey = "A".repeat(43);
const recipientKey = "B".repeat(43);

function requestBody() {
  return {
    messages: {
      [userId]: {
        [deviceId]: {
          algorithm: MATRIX_OLM_ALGORITHM,
          ciphertext: {
            [recipientKey]: { body: "QUJDRA==", type: 0 }
          },
          "org.matrix.msgid": "c".repeat(32),
          sender_key: senderKey
        }
      }
    }
  };
}

describe("Matrix sendToDevice parser", () => {
  it("acepta la forma Olm explicita que consume el transporte privado", () => {
    const parsed = parseMatrixToDeviceRequest(
      MATRIX_OLM_EVENT_TYPE,
      "txn-123",
      requestBody()
    );
    equal(parsed.targetCount, 1);
    deepEqual(matrixToDeviceHashInput(parsed), {
      event_type: MATRIX_OLM_EVENT_TYPE,
      messages: parsed.messages
    });
  });

  it("rechaza wildcard, mapas vacios, campos extra y rutas no canonicas", () => {
    const wildcard = requestBody();
    (wildcard.messages as Record<string, Record<string, unknown>>)[userId] = {
      "*": wildcard.messages[userId]![deviceId]!
    };
    rejects(wildcard, "MATRIX_TO_DEVICE_DEVICE_ID_INVALID");
    rejects({ messages: { [userId]: {} } }, "MATRIX_TO_DEVICE_DEVICES_INVALID");
    rejects(
      { ...requestBody(), extra: true },
      "MATRIX_TO_DEVICE_BODY_FIELDS_INVALID"
    );
    throws(
      () =>
        parseMatrixToDeviceRequest(
          "m.secret.send",
          "txn-123",
          requestBody()
        ),
      validationCode("MATRIX_TO_DEVICE_EVENT_TYPE_INVALID")
    );
    throws(
      () =>
        parseMatrixToDeviceRequest(
          MATRIX_OLM_EVENT_TYPE,
          "../txn",
          requestBody()
        ),
      validationCode("MATRIX_TO_DEVICE_TRANSACTION_ID_INVALID")
    );
  });

  it("rechaza sobres con remitente, destinatario o ciphertext ambiguos", () => {
    const wrongSender = requestBody();
    wrongSender.messages[userId]![deviceId]!.sender_key = "short";
    rejects(wrongSender, "MATRIX_TO_DEVICE_OLM_ENVELOPE_INVALID");

    const wrongMessageId = requestBody();
    wrongMessageId.messages[userId]![deviceId]!["org.matrix.msgid"] =
      "no-canonico";
    rejects(wrongMessageId, "MATRIX_TO_DEVICE_OLM_ENVELOPE_INVALID");

    const ambiguous = requestBody();
    ambiguous.messages[userId]![deviceId]!.ciphertext["C".repeat(43)] = {
      body: "QUJDRA==",
      type: 1
    };
    rejects(ambiguous, "MATRIX_TO_DEVICE_CIPHERTEXT_INVALID");

    const extra = requestBody();
    const content = extra.messages[userId]![deviceId]! as unknown as Record<
      string,
      unknown
    >;
    content.chat_message = "prohibido";
    rejects(extra, "MATRIX_TO_DEVICE_CONTENT_FIELDS_INVALID");
  });
});

function rejects(value: unknown, code: string): void {
  throws(
    () =>
      parseMatrixToDeviceRequest(
        MATRIX_OLM_EVENT_TYPE,
        "txn-123",
        value
      ),
    validationCode(code)
  );
}

function validationCode(code: string) {
  return (error: unknown) =>
    error instanceof MatrixToDeviceValidationError && error.code === code;
}
