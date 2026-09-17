import { deepEqual, equal, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MatrixKeyRequestValidationError,
  parseMatrixClaimRequestId,
  parseMatrixKeysClaim,
  parseMatrixKeysQuery
} from "./matrix-key-requests";

const USER = "@u11111111111141118111111111111111:sinochat.invalid";
const DEVICE = "D22222222222242228222222222222222";

describe("Matrix keys/query contract", () => {
  it("acepta todos los dispositivos o una lista concreta", () => {
    deepEqual(
      parseMatrixKeysQuery({
        device_keys: { [USER]: [] },
        timeout: 10_000
      }),
      { deviceKeys: { [USER]: [] }, timeout: 10_000 }
    );
    deepEqual(
      parseMatrixKeysQuery({ device_keys: { [USER]: [DEVICE] } }),
      { deviceKeys: { [USER]: [DEVICE] } }
    );
  });

  it("rechaza wildcard, duplicados, terceros masivos y campos libres", () => {
    throwsCode(
      () => parseMatrixKeysQuery({ device_keys: { [USER]: ["*"] } }),
      "MATRIX_DEVICE_ID_INVALID"
    );
    throwsCode(
      () =>
        parseMatrixKeysQuery({
          device_keys: { [USER]: [DEVICE, DEVICE] }
        }),
      "MATRIX_KEYS_QUERY_DEVICES_INVALID"
    );
    throwsCode(
      () => parseMatrixKeysQuery({ device_keys: {}, token: "libre" }),
      "MATRIX_KEYS_QUERY_FIELDS_INVALID"
    );
    throwsCode(
      () =>
        parseMatrixKeysQuery({
          device_keys: Object.fromEntries(
            Array.from({ length: 21 }, (_, index) => [
              `@u${index.toString(16).padStart(32, "0")}:sinochat.invalid`,
              []
            ])
          )
        }),
      "MATRIX_KEYS_QUERY_USER_LIMIT_INVALID"
    );
  });
});

describe("Matrix keys/claim contract", () => {
  it("acepta exclusivamente signed_curve25519 y request IDs privados", () => {
    const parsed = parseMatrixKeysClaim({
      one_time_keys: {
        [USER]: { [DEVICE]: "signed_curve25519" }
      }
    });
    equal(parsed.oneTimeKeys[USER]?.[DEVICE], "signed_curve25519");
    equal(parseMatrixClaimRequestId("olm-request_01"), "olm-request_01");
  });

  it("rechaza algoritmos, dispositivos y request IDs no permitidos", () => {
    throwsCode(
      () =>
        parseMatrixKeysClaim({
          one_time_keys: { [USER]: { [DEVICE]: "curve25519" } }
        }),
      "MATRIX_KEYS_CLAIM_ALGORITHM_INVALID"
    );
    throwsCode(
      () =>
        parseMatrixKeysClaim({
          one_time_keys: { [USER]: { "*": "signed_curve25519" } }
        }),
      "MATRIX_DEVICE_ID_INVALID"
    );
    throwsCode(
      () => parseMatrixClaimRequestId("contiene espacios"),
      "MATRIX_KEYS_CLAIM_REQUEST_ID_INVALID"
    );
  });
});

function throwsCode(action: () => unknown, code: string): void {
  throws(action, (error: unknown) => {
    return (
      error instanceof MatrixKeyRequestValidationError && error.code === code
    );
  });
}
