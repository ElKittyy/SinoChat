import {
  equal,
  match,
  notEqual,
  throws
} from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveMatrixDeviceBindingSecret,
  hashDeviceBindingSecret,
  issueDeviceBindingSecret,
  verifyDeviceBindingSecret
} from "./device-binding-secret";

const environment = {
  DEVICE_BINDING_HMAC_SECRET: "k".repeat(32)
};

describe("device binding secret", () => {
  it("emite credenciales CSPRNG de 256 bits y hashes HMAC-SHA-256", () => {
    const first = issueDeviceBindingSecret(environment);
    const second = issueDeviceBindingSecret(environment);

    match(first.secret, /^[A-Za-z0-9_-]{43}$/);
    equal(Buffer.from(first.secret, "base64url").byteLength, 32);
    match(first.hash, /^[0-9a-f]{64}$/);
    notEqual(first.secret, second.secret);
    notEqual(first.hash, second.hash);
    notEqual(first.hash, first.secret);
  });

  it("verifica la credencial exacta y rechaza alteraciones", () => {
    const issued = issueDeviceBindingSecret(environment);
    const altered =
      (issued.secret[0] === "A" ? "B" : "A") + issued.secret.slice(1);

    equal(
      verifyDeviceBindingSecret(
        issued.secret,
        issued.hash,
        environment
      ),
      true
    );
    equal(
      verifyDeviceBindingSecret(altered, issued.hash, environment),
      false
    );
    equal(
      verifyDeviceBindingSecret(issued.secret, "inválido", environment),
      false
    );
  });

  it("deriva de forma estable y separada el secreto reintentable Matrix", () => {
    const deviceId = "11111111-1111-4111-8111-111111111111";
    const first = deriveMatrixDeviceBindingSecret(deviceId, environment);
    const retry = deriveMatrixDeviceBindingSecret(deviceId, environment);
    const other = deriveMatrixDeviceBindingSecret(
      "22222222-2222-4222-8222-222222222222",
      environment
    );

    equal(first.secret, retry.secret);
    equal(first.hash, retry.hash);
    notEqual(first.secret, other.secret);
    match(first.secret, /^[A-Za-z0-9_-]{43}$/);
    equal(
      verifyDeviceBindingSecret(first.secret, first.hash, environment),
      true
    );
    throws(
      () => deriveMatrixDeviceBindingSecret("no-es-uuid", environment),
      /UUID v4/
    );
  });

  it("separa hashes por clave HMAC y exige al menos 32 bytes", () => {
    const secret = "A".repeat(43);
    notEqual(
      hashDeviceBindingSecret(secret, environment),
      hashDeviceBindingSecret(secret, {
        DEVICE_BINDING_HMAC_SECRET: "z".repeat(32)
      })
    );
    throws(
      () =>
        hashDeviceBindingSecret(secret, {
          DEVICE_BINDING_HMAC_SECRET: "débil"
        }),
      /al menos 32 bytes/
    );
    throws(
      () => hashDeviceBindingSecret(secret, {}),
      /DEVICE_BINDING_HMAC_SECRET es obligatorio/
    );
  });
});
