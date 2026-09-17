import { equal, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  matrixDeviceIdFromUuid,
  sinochatDeviceIdFromMatrixDeviceId
} from "../dist/index.js";

const SINOCHAT_DEVICE_ID = "01234567-89ab-4cde-8fab-0123456789ab";
const MATRIX_DEVICE_ID = "D0123456789AB4CDE8FAB0123456789AB";

describe("identificador de dispositivo Matrix de SinoChat", () => {
  it("conserva un UUID v4 canonico en el round-trip", () => {
    equal(matrixDeviceIdFromUuid(SINOCHAT_DEVICE_ID), MATRIX_DEVICE_ID);
    equal(
      sinochatDeviceIdFromMatrixDeviceId(MATRIX_DEVICE_ID),
      SINOCHAT_DEVICE_ID
    );
  });

  it("rechaza prefijo, casing y longitud no canonicos", () => {
    for (const invalid of [
      `d${MATRIX_DEVICE_ID.slice(1)}`,
      MATRIX_DEVICE_ID.replace("AB", "ab"),
      MATRIX_DEVICE_ID.slice(0, -1),
      `${MATRIX_DEVICE_ID}0`,
      ` ${MATRIX_DEVICE_ID}`,
      `${MATRIX_DEVICE_ID} `
    ]) {
      throws(
        () => sinochatDeviceIdFromMatrixDeviceId(invalid),
        /MATRIX_DEVICE_ID_INVALID/
      );
    }

    throws(
      () =>
        sinochatDeviceIdFromMatrixDeviceId({
          toString: () => MATRIX_DEVICE_ID
        }),
      /MATRIX_DEVICE_ID_INVALID/
    );
  });

  it("rechaza UUID aplanados con version o variante no canonicas", () => {
    for (const invalid of [
      "D0123456789AB1CDE8FAB0123456789AB",
      "D0123456789AB4CDE7FAB0123456789AB",
      "D0123456789AB4CDECFAB0123456789AB",
      "D00000000000000000000000000000000",
      "D01234567-89AB-4CDE-8FAB-0123456789AB"
    ]) {
      throws(
        () => sinochatDeviceIdFromMatrixDeviceId(invalid),
        /MATRIX_DEVICE_ID_INVALID/
      );
    }
  });
});
