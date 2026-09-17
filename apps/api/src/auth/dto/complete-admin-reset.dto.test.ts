import { equal } from "node:assert/strict";
import { describe, it } from "node:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CompleteAdminResetDto } from "./complete-admin-reset.dto";

const VALID = {
  username: "cajero_seguro",
  recoveryCode: "SC-ABCDE-FGHJK-MNPQR-STUVW",
  newPassword: "Nueva#Segura2026"
};

describe("CompleteAdminResetDto", () => {
  it("acepta una contraseña nueva fuerte", async () => {
    equal(
      (await validate(plainToInstance(CompleteAdminResetDto, VALID))).length,
      0
    );
  });

  it("rechaza campos ausentes y contraseñas nuevas débiles", async () => {
    const missing = await validate(
      plainToInstance(CompleteAdminResetDto, {
        username: undefined,
        recoveryCode: undefined,
        newPassword: undefined
      })
    );
    const weak = await validate(
      plainToInstance(CompleteAdminResetDto, {
        ...VALID,
        newPassword: "solo-minusculas-2026"
      })
    );

    equal(missing.length, 3);
    equal(weak.some((error) => error.property === "newPassword"), true);
  });

  it("normaliza el código y rechaza formatos ajenos a SinoChat", async () => {
    const normalized = plainToInstance(CompleteAdminResetDto, {
      ...VALID,
      recoveryCode: " sc-abcde-fghjk-mnpqr-stuvw "
    });
    const invalid = plainToInstance(CompleteAdminResetDto, {
      ...VALID,
      recoveryCode: "SC-AAAAA-AAAAA-AAAAA-AAAA0"
    });

    equal((await validate(normalized)).length, 0);
    equal(normalized.recoveryCode, VALID.recoveryCode);
    equal(
      (await validate(invalid)).some((error) => error.property === "recoveryCode"),
      true
    );
  });
});
