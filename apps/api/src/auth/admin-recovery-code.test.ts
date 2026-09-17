import { equal, notEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADMIN_RECOVERY_CODE_COUNT,
  ADMIN_RECOVERY_CODE_PATTERN,
  hashAdminRecoveryCode,
  issueAdminRecoveryCodes,
  normalizeAdminRecoveryCode
} from "./admin-recovery-code";

describe("admin recovery codes", () => {
  it("emite diez factores de aproximadamente 125 bits sin caracteres ambiguos", () => {
    const codes = issueAdminRecoveryCodes();
    equal(codes.length, ADMIN_RECOVERY_CODE_COUNT);
    equal(new Set(codes).size, ADMIN_RECOVERY_CODE_COUNT);
    equal(codes.every((code) => ADMIN_RECOVERY_CODE_PATTERN.test(code)), true);
  });

  it("normaliza el formato y liga cada hash al administrador", () => {
    const code = issueAdminRecoveryCodes()[0]!;
    equal(normalizeAdminRecoveryCode(` ${code.toLowerCase()} `), code);
    const first = hashAdminRecoveryCode(
      "11111111-1111-4111-8111-111111111111",
      code
    );
    equal(first.length, 64);
    equal(
      first,
      hashAdminRecoveryCode(
        "11111111-1111-4111-8111-111111111111",
        code.toLowerCase()
      )
    );
    notEqual(
      first,
      hashAdminRecoveryCode(
        "22222222-2222-4222-8222-222222222222",
        code
      )
    );
  });
});
