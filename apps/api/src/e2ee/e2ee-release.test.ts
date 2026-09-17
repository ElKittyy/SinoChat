import { deepEqual, equal, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { ServiceUnavailableException } from "@nestjs/common";
import { E2EE_RELEASE, isE2eeReleased } from "./e2ee-release";
import { E2eeReleaseGuard } from "./e2ee-release.guard";

describe("E2EE release gate", () => {
  it("permanece cerrado y no admite un bypass por configuracion", () => {
    const previous = process.env.E2EE_CHAT_ENABLED;
    process.env.E2EE_CHAT_ENABLED = "true";

    try {
      equal(isE2eeReleased(), false);
      equal(E2EE_RELEASE.state, "BLOCKED");
      equal(E2EE_RELEASE.clientLibraryVersion, "18.6.0");
    } finally {
      if (previous === undefined) {
        delete process.env.E2EE_CHAT_ENABLED;
      } else {
        process.env.E2EE_CHAT_ENABLED = previous;
      }
    }
  });

  it("devuelve un 503 estructurado para toda operacion de chat", () => {
    const guard = new E2eeReleaseGuard();

    throws(
      () => guard.canActivate(),
      (error: unknown) => {
        if (!(error instanceof ServiceUnavailableException)) {
          return false;
        }
        deepEqual(error.getResponse(), {
          statusCode: 503,
          error: "E2EE_INTEGRATION_INCOMPLETE",
          message: E2EE_RELEASE.message
        });
        return true;
      }
    );
  });
});
