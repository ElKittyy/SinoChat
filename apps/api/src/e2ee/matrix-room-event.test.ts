import { deepEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MATRIX_MEGOLM_ALGORITHM,
  MatrixRoomEventValidationError,
  parseMatrixMegolmRoomContent
} from "./matrix-room-event";

const senderKey = Buffer.alloc(32, 1)
  .toString("base64")
  .replace(/=+$/u, "");
const sessionId = Buffer.alloc(32, 2)
  .toString("base64")
  .replace(/=+$/u, "");
const ciphertext = Buffer.alloc(64, 3)
  .toString("base64")
  .replace(/=+$/u, "");

function validContent() {
  return {
    algorithm: MATRIX_MEGOLM_ALGORITHM,
    ciphertext,
    device_id: "D11111111111141118111111111111111",
    sender_key: senderKey,
    session_id: sessionId
  };
}

describe("Matrix Megolm room content parser", () => {
  it("acepta solo la forma exacta emitida por Rust Crypto", () => {
    deepEqual(parseMatrixMegolmRoomContent(validContent()), validContent());
  });

  it("rechaza downgrade, campos extra e identificadores no canonicos", () => {
    for (const invalid of [
      { ...validContent(), algorithm: "m.olm.v1.curve25519-aes-sha2" },
      { ...validContent(), plaintext: "filtracion" },
      { ...validContent(), device_id: "d11111111111141118111111111111111" },
      { ...validContent(), sender_key: `${senderKey}=` },
      { ...validContent(), session_id: sessionId.slice(0, -1) },
      { ...validContent(), ciphertext: "abcd=" },
      Object.create({ ...validContent() })
    ]) {
      throws(
        () => parseMatrixMegolmRoomContent(invalid),
        (error) => error instanceof MatrixRoomEventValidationError
      );
    }
  });
});
