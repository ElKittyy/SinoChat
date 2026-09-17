import { plainToInstance } from "class-transformer";
import { equal } from "node:assert/strict";
import { describe, it } from "node:test";
import { validate } from "class-validator";
import { EvidenceAccessDto } from "./moderation-action.dto";

describe("EvidenceAccessDto", () => {
  it("recorta una justificacion valida y conserva la password exacta", async () => {
    const input = plainToInstance(EvidenceAccessDto, {
      currentPassword: " exact-password ",
      reason: "  Necesito investigar el riesgo documentado.  "
    });

    equal((await validate(input)).length, 0);
    equal(input.currentPassword, " exact-password ");
    equal(
      input.reason,
      "Necesito investigar el riesgo documentado."
    );
  });

  it("rechaza justificacion corta y password vacia", async () => {
    const input = plainToInstance(EvidenceAccessDto, {
      currentPassword: "",
      reason: "demasiado breve"
    });

    equal((await validate(input)).length, 2);
  });
});
