import { equal } from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateFirstDeviceRegistration } from "./device-registration.policy";

describe("first device registration policy", () => {
  it("permite únicamente una cuenta sin historial y una sesión libre", () => {
    equal(evaluateFirstDeviceRegistration(0, null), "ALLOW");
  });

  it("bloquea cualquier dispositivo histórico, incluso revocado", () => {
    equal(
      evaluateFirstDeviceRegistration(1, null),
      "DEVICE_HISTORY_EXISTS"
    );
    equal(
      evaluateFirstDeviceRegistration(4, "existing-device-id"),
      "DEVICE_HISTORY_EXISTS"
    );
  });

  it("bloquea una sesión que ya está vinculada", () => {
    equal(
      evaluateFirstDeviceRegistration(0, "existing-device-id"),
      "SESSION_ALREADY_BOUND"
    );
  });
});
