import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { matrixDeviceIdFromUuid } from "@sinochat/contracts";
import { encodeMatrixCanonicalJson, MATRIX_MEGOLM_ALGORITHM, MATRIX_OLM_ALGORITHM } from "../matrix-key-upload";

/** Disposable test signer. Returns public data only; never exports a private key. */
export function candidateFixture(userId: string, id: string = randomUUID()) {
  const deviceId = matrixDeviceIdFromUuid(id);
  const ed = generateKeyPairSync("ed25519"), curve = generateKeyPairSync("x25519");
  const edKey = ed.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64").replace(/=+$/, "");
  const curveKey = curve.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64").replace(/=+$/, "");
  const core = { user_id: userId, device_id: deviceId, algorithms: [MATRIX_OLM_ALGORITHM, MATRIX_MEGOLM_ALGORITHM],
    keys: { [`ed25519:${deviceId}`]: edKey, [`curve25519:${deviceId}`]: curveKey } };
  const signature = sign(null, encodeMatrixCanonicalJson(core), ed.privateKey).toString("base64").replace(/=+$/, "");
  return { id, body: { device_keys: { ...core, signatures: { [userId]: { [`ed25519:${deviceId}`]: signature } } } } };
}
