import {
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { readDeviceBindingHmacSecret } from "../config/runtime-config";

const SECRET_BYTES = 32;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const DEVICE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVALID_HASH = Buffer.alloc(32);
const MATRIX_BINDING_DOMAIN = "sinochat:matrix-device-binding:v1:";

export interface IssuedDeviceBindingSecret {
  secret: string;
  hash: string;
}

export function issueDeviceBindingSecret(
  environment: NodeJS.ProcessEnv = process.env
): IssuedDeviceBindingSecret {
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return {
    secret,
    hash: hashDeviceBindingSecret(secret, environment)
  };
}

/**
 * La confirmacion Matrix debe poder repetirse tras perder la respuesta HTTP.
 * El UUID reservado aporta unicidad y el HMAC del servidor mantiene 256 bits
 * no predecibles sin persistir el bearer. La derivacion esta separada del hash
 * de verificacion y solo se usa para el flujo Matrix versionado.
 */
export function deriveMatrixDeviceBindingSecret(
  deviceId: string,
  environment: NodeJS.ProcessEnv = process.env
): IssuedDeviceBindingSecret {
  if (!DEVICE_UUID_PATTERN.test(deviceId)) {
    throw new Error("El deviceId Matrix debe ser un UUID v4 canonico.");
  }
  const secret = createHmac(
    "sha256",
    readDeviceBindingHmacSecret(environment)
  )
    .update(MATRIX_BINDING_DOMAIN, "utf8")
    .update(deviceId.toLowerCase(), "ascii")
    .digest("base64url");
  return {
    secret,
    hash: hashDeviceBindingSecret(secret, environment)
  };
}

export function hashDeviceBindingSecret(
  secret: string,
  environment: NodeJS.ProcessEnv = process.env
): string {
  return createHmac(
    "sha256",
    readDeviceBindingHmacSecret(environment)
  )
    .update(secret, "utf8")
    .digest("hex");
}

export function verifyDeviceBindingSecret(
  secret: string,
  expectedHash: string,
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  const candidate = Buffer.from(
    hashDeviceBindingSecret(secret, environment),
    "hex"
  );
  const expectedIsValid = HASH_PATTERN.test(expectedHash);
  const expected = expectedIsValid
    ? Buffer.from(expectedHash, "hex")
    : INVALID_HASH;

  return timingSafeEqual(candidate, expected) && expectedIsValid;
}
