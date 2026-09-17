import { equal, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MatrixSyncTokenValidationError,
  issueMatrixSyncToken,
  parseMatrixSyncTokenBatchId,
  verifyMatrixSyncToken,
  type MatrixSyncTokenData
} from "./matrix-sync-token";

const environment = {
  NODE_ENV: "test",
  DEVICE_BINDING_HMAC_SECRET: "d".repeat(32),
  MATRIX_SYNC_TOKEN_SECRET: "s".repeat(32)
};
const data: MatrixSyncTokenData = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  previousBatchId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  fromSequence: 7n,
  upToSequence: 11n,
  fromDeviceListPosition: 3n,
  deviceListPosition: 5n,
  oneTimeKeyCount: 17,
  unusedFallbackKey: true
};

describe("Matrix sync token", () => {
  it("es determinista, opaco, ligado al batch y no guarda el bearer", () => {
    const first = issueMatrixSyncToken(data, environment);
    const second = issueMatrixSyncToken(data, environment);

    equal(first.token, second.token);
    equal(first.tokenHash, second.tokenHash);
    equal(parseMatrixSyncTokenBatchId(first.token), data.id);
    equal(first.token.includes(environment.MATRIX_SYNC_TOKEN_SECRET), false);
    equal(
      verifyMatrixSyncToken(first.token, first.tokenHash, data, environment),
      true
    );
  });

  it("rechaza alteraciones del bearer, hash, dispositivo o rango", () => {
    const issued = issueMatrixSyncToken(data, environment);
    equal(
      verifyMatrixSyncToken(
        `${issued.token.slice(0, -1)}A`,
        issued.tokenHash,
        data,
        environment
      ),
      false
    );
    equal(
      verifyMatrixSyncToken(issued.token, "0".repeat(64), data, environment),
      false
    );
    equal(
      verifyMatrixSyncToken(
        issued.token,
        issued.tokenHash,
        { ...data, upToSequence: 12n },
        environment
      ),
      false
    );
  });

  it("rechaza formato y rangos imposibles", () => {
    throws(
      () => parseMatrixSyncTokenBatchId("sct1.invalid.invalid"),
      (error: unknown) =>
        error instanceof MatrixSyncTokenValidationError &&
        error.code === "MATRIX_SYNC_TOKEN_FORMAT_INVALID"
    );
    throws(
      () =>
        issueMatrixSyncToken(
          { ...data, fromSequence: 12n },
          environment
        ),
      (error: unknown) =>
        error instanceof MatrixSyncTokenValidationError &&
        error.code === "MATRIX_SYNC_TOKEN_DATA_INVALID"
    );
  });
});
