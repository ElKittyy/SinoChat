import { equal, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  matrixDeviceIdFromUuid,
  matrixUserIdFromUuid,
  sinochatDeviceIdFromMatrixDeviceId,
  sinochatUserIdFromMatrixUserId
} from "@sinochat/contracts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "01234567-89ab-4cde-8fab-0123456789ab";

describe("identidades Matrix internas", () => {
  it("invierte sin perdida el namespace UUID de SinoChat", () => {
    const matrixUserId = matrixUserIdFromUuid(
      USER_ID,
      "SinoChat.Invalid"
    );
    equal(
      matrixUserId,
      "@u11111111111141118111111111111111:sinochat.invalid"
    );
    equal(
      sinochatUserIdFromMatrixUserId(matrixUserId, "sinochat.invalid"),
      USER_ID
    );
  });

  it("invierte sin perdida el device ID canonico de un UUID v4", () => {
    const matrixDeviceId = matrixDeviceIdFromUuid(DEVICE_ID);

    equal(matrixDeviceId, "D0123456789AB4CDE8FAB0123456789AB");
    equal(sinochatDeviceIdFromMatrixDeviceId(matrixDeviceId), DEVICE_ID);
  });

  it("rechaza prefijo, casing o longitud no canonicos del device ID", () => {
    const canonical = matrixDeviceIdFromUuid(DEVICE_ID);

    for (const invalid of [
      `d${canonical.slice(1)}`,
      canonical.replace("AB", "ab"),
      canonical.slice(0, -1),
      `${canonical}0`,
      ` ${canonical}`,
      `${canonical} `
    ]) {
      throws(
        () => sinochatDeviceIdFromMatrixDeviceId(invalid),
        /MATRIX_DEVICE_ID_INVALID/
      );
    }
  });

  it("rechaza UUID aplanados que no sean UUID v4 canonicos", () => {
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

  it("rechaza otro servidor, namespace o longitud", () => {
    throws(() =>
      sinochatUserIdFromMatrixUserId(
        "@u11111111111141118111111111111111:evil.invalid",
        "sinochat.invalid"
      )
    );
    throws(() =>
      sinochatUserIdFromMatrixUserId(
        "@admin:sinochat.invalid",
        "sinochat.invalid"
      )
    );
    throws(() =>
      sinochatUserIdFromMatrixUserId(
        "@u1111:sinochat.invalid",
        "sinochat.invalid"
      )
    );
  });
});
