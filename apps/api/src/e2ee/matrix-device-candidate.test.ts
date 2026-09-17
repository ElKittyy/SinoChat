import { deepEqual, equal, notEqual, ok, throws } from "node:assert/strict";
import { before, describe, it } from "node:test";
import { DeviceId, OlmMachine, RequestType, UserId, initAsync } from "@matrix-org/matrix-sdk-crypto-wasm";
import { parseMatrixDeviceCandidate, type MatrixDeviceCandidateExpectation } from "./matrix-device-candidate";
import {
  MatrixKeyUploadValidationError,
  encodeMatrixCanonicalJson,
  hashMatrixCanonicalJson,
  verifyMatrixSignedObject
} from "./matrix-key-upload";

const USER = "@u11111111111141118111111111111111:sinochat.invalid";
const DEVICE = "D22222222222242228222222222222222";
const OTHER_USER = "@u33333333333343338333333333333333:sinochat.invalid";
const OTHER_DEVICE = "D44444444444444448444444444444444";
const SIGNING_ID = `ed25519:${DEVICE}`;
const CURVE_ID = `curve25519:${DEVICE}`;
type Json = Record<string, any>;
let fixture: Json;

describe("candidato Matrix: snapshot publico en cuarentena, nunca autorizacion", () => {
  before(async () => { fixture = await realCandidate(); });

  it("acepta las claves y autofirma del SDK real, sin preclaves ni secretos", () => {
    const result = parse(fixture);
    deepEqual(result.deviceKeys, fixture.device_keys);
    deepEqual(Object.keys(result).sort(), ["canonicalSha256", "curve25519Key", "deviceKeys", "ed25519Key"]);
    equal(result.ed25519Key, fixture.device_keys.keys[SIGNING_ID]);
    equal(result.curve25519Key, fixture.device_keys.keys[CURVE_ID]);
    equal(result.canonicalSha256, hashMatrixCanonicalJson(result.deviceKeys));
    ok(/^[a-f0-9]{64}$/.test(result.canonicalSha256));
    verifyMatrixSignedObject(result.deviceKeys, USER, SIGNING_ID, result.ed25519Key, "TEST_SIGNATURE_INVALID");
    ok(!Object.hasOwn(result, "approved"));
    ok(!Object.hasOwn(result, "device"));
  });

  it("el hash incluye la autofirma y no depende del orden de propiedades", () => {
    const result = parse(fixture);
    const reordered = reverseRecords(fixture);
    equal(parse(reordered).canonicalSha256, result.canonicalSha256);
    equal(encodeMatrixCanonicalJson(parse(reordered).deviceKeys).equals(encodeMatrixCanonicalJson(result.deviceKeys)), true);
    const { signatures: _signatures, ...unsignedCore } = fixture.device_keys;
    notEqual(result.canonicalSha256, hashMatrixCanonicalJson(unsignedCore));
  });

  it("el snapshot completo esta congelado y no comparte contenedores con la entrada", () => {
    const input = structuredClone(fixture);
    freezeDeep(input);
    const result = parse(input);
    for (const value of [result, result.deviceKeys, result.deviceKeys.algorithms, result.deviceKeys.keys, result.deviceKeys.signatures, result.deviceKeys.signatures[USER]]) {
      ok(Object.isFrozen(value));
    }
    notEqual(result.deviceKeys, input.device_keys);
    notEqual(result.deviceKeys.algorithms, input.device_keys.algorithms);
    notEqual(result.deviceKeys.keys, input.device_keys.keys);
    notEqual(result.deviceKeys.signatures, input.device_keys.signatures);
    notEqual(result.deviceKeys.signatures[USER], input.device_keys.signatures[USER]);
    throws(() => { result.deviceKeys.keys[SIGNING_ID] = "changed"; }, TypeError);
    throws(() => { result.deviceKeys.algorithms.reverse(); }, TypeError);
    throws(() => { result.deviceKeys.signatures[USER][SIGNING_ID] = "changed"; }, TypeError);
    throws(() => { result.canonicalSha256 = "changed"; }, TypeError);
    deepEqual(input, fixture);
  });

  it("cambiar la entrada despues de parsear no modifica el snapshot ni su hash", () => {
    const input = structuredClone(fixture);
    const result = parse(input);
    input.device_keys.keys[SIGNING_ID] = "changed";
    input.device_keys.signatures[USER][SIGNING_ID] = "changed";
    input.device_keys.algorithms.reverse();
    deepEqual(result.deviceKeys, fixture.device_keys);
    equal(result.canonicalSha256, hashMatrixCanonicalJson(fixture.device_keys));
  });

  it("acepta registros JSON de prototipo nulo y claves reordenadas", () => {
    const input = mapContainers(fixture, (value) => Object.assign(Object.create(null), value));
    deepEqual(parse(input), parse(fixture));
  });

  const invalidBodies: [string, unknown][] = [
    ["ausente", undefined], ["null", null], ["array", []], ["string", "never-log-secret"],
    ["numero", 1], ["booleano", true], ["Date", new Date(0)], ["vacia", {}]
  ];
  for (const [label, value] of invalidBodies) {
    it(`rechaza envoltura invalida (${label})`, () => {
      rejects(() => parse(value), "MATRIX_CANDIDATE_BODY_INVALID");
    });
  }

  for (const field of ["one_time_keys", "fallback_keys", "master_key", "self_signing_key", "user_signing_key", "private_key", "seed", "challenge", "approved", "deviceKeys"]) {
    it(`rechaza cualquier campo adicional en la envoltura: ${field}`, () => {
      rejects(() => parse({ ...fixture, [field]: "never-log-secret" }), "MATRIX_CANDIDATE_BODY_INVALID");
    });
  }

  const mutations: [string, (input: Json) => void, string][] = [
    ["claves ausentes", (f) => { f.device_keys = null; }, "MATRIX_DEVICE_KEYS_NOT_OBJECT"],
    ["campo de dispositivo ausente", (f) => { delete f.device_keys.user_id; }, "MATRIX_DEVICE_KEYS_FIELDS_INVALID"],
    ["dato no autenticado unsigned", (f) => { f.device_keys.unsigned = {}; }, "MATRIX_DEVICE_KEYS_FIELDS_INVALID"],
    ["secreto dentro del dispositivo", (f) => { f.device_keys.seed = "never-log-secret"; }, "MATRIX_DEVICE_KEYS_FIELDS_INVALID"],
    ["otro usuario", (f) => { f.device_keys.user_id = OTHER_USER; }, "MATRIX_DEVICE_IDENTITY_MISMATCH"],
    ["otro dispositivo", (f) => { f.device_keys.device_id = OTHER_DEVICE; }, "MATRIX_DEVICE_IDENTITY_MISMATCH"],
    ["algoritmos invertidos", (f) => { f.device_keys.algorithms.reverse(); }, "MATRIX_DEVICE_ALGORITHMS_INVALID"],
    ["algoritmo ajeno", (f) => { f.device_keys.algorithms[0] = "plaintext"; }, "MATRIX_DEVICE_ALGORITHMS_INVALID"],
    ["clave publica adicional", (f) => { f.device_keys.keys.extra = "never-log-secret"; }, "MATRIX_DEVICE_PUBLIC_KEYS_INVALID"],
    ["clave publica ausente", (f) => { delete f.device_keys.keys[CURVE_ID]; }, "MATRIX_DEVICE_PUBLIC_KEYS_INVALID"],
    ["otro firmante", (f) => { f.device_keys.signatures[OTHER_USER] = {}; }, "MATRIX_SIGNATURES_INVALID"],
    ["firma self-signing no permitida aun", (f) => { f.device_keys.signatures[USER]["ed25519:other"] = "never-log-secret"; }, "MATRIX_SIGNATURES_INVALID"],
    ["firma ausente", (f) => { f.device_keys.signatures = {}; }, "MATRIX_SIGNATURES_INVALID"],
    ["firma truncada", (f) => { f.device_keys.signatures[USER][SIGNING_ID] = "AA"; }, "MATRIX_SIGNATURE_ENCODING_INVALID"],
    ["firma con padding", (f) => { f.device_keys.signatures[USER][SIGNING_ID] += "=="; }, "MATRIX_SIGNATURE_ENCODING_INVALID"],
    ["firma criptograficamente alterada", (f) => {
      const signature = Buffer.from(f.device_keys.signatures[USER][SIGNING_ID], "base64");
      signature[63] ^= 1;
      f.device_keys.signatures[USER][SIGNING_ID] = signature.toString("base64").replace(/=+$/, "");
    }, "MATRIX_DEVICE_SIGNATURE_INVALID"],
    ["punto Ed25519 de orden pequeno", (f) => { f.device_keys.keys[SIGNING_ID] = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]).toString("base64").replace(/=+$/, ""); }, "MATRIX_DEVICE_SIGNATURE_INVALID"],
    ["clave Curve25519 no canonica", (f) => { f.device_keys.keys[CURVE_ID] += "="; }, "MATRIX_CURVE25519_KEY_INVALID"],
    ["sustitucion Curve25519 sin nueva firma", (f) => {
      const key = Buffer.from(f.device_keys.keys[CURVE_ID], "base64");
      key[0] ^= 1;
      f.device_keys.keys[CURVE_ID] = key.toString("base64").replace(/=+$/, "");
    }, "MATRIX_DEVICE_SIGNATURE_INVALID"]
  ];
  for (const [label, mutation, code] of mutations) {
    it(`rechaza ${label}`, () => {
      const input = structuredClone(fixture);
      mutation(input);
      rejects(() => parse(input), code);
    });
  }

  const nodes: [string, (input: Json) => Json, string, string][] = [
    ["envoltura", (f) => f, "device_keys", "MATRIX_CANDIDATE_BODY_INVALID"],
    ["dispositivo", (f) => f.device_keys, "keys", "MATRIX_DEVICE_KEYS_FIELDS_INVALID"],
    ["claves", (f) => f.device_keys.keys, SIGNING_ID, "MATRIX_DEVICE_PUBLIC_KEYS_INVALID"],
    ["mapa de firmas", (f) => f.device_keys.signatures, USER, "MATRIX_SIGNATURES_INVALID"],
    ["firma", (f) => f.device_keys.signatures[USER], SIGNING_ID, "MATRIX_SIGNATURES_INVALID"],
    ["algoritmos", (f) => f.device_keys.algorithms, "0", "MATRIX_DEVICE_ALGORITHMS_INVALID"]
  ];
  for (const [label, node, key, code] of nodes) {
    it(`no ejecuta un getter en ${label}`, () => {
      const input = structuredClone(fixture);
      let invoked = false;
      Object.defineProperty(node(input), key, { enumerable: true, get() { invoked = true; throw new Error("never-log-secret"); } });
      rejects(() => parse(input), code);
      equal(invoked, false);
    });
    it(`rechaza una propiedad requerida oculta en ${label}`, () => {
      const input = structuredClone(fixture);
      Object.defineProperty(node(input), key, { enumerable: false });
      rejects(() => parse(input), code);
    });
    it(`rechaza propiedades extra no enumerables en ${label}`, () => {
      const input = structuredClone(fixture);
      Object.defineProperty(node(input), "extra", { value: "never-log-secret" });
      rejects(() => parse(input), code);
    });
    it(`rechaza simbolos en ${label}`, () => {
      const input = structuredClone(fixture);
      node(input)[Symbol("private") as any] = "never-log-secret";
      rejects(() => parse(input), code);
    });
    it(`rechaza prototipos ajenos en ${label}`, () => {
      const input = structuredClone(fixture);
      Object.setPrototypeOf(node(input), { private_key: "never-log-secret" });
      const objectCode = label === "dispositivo" ? "MATRIX_DEVICE_KEYS_NOT_OBJECT" : code;
      rejects(() => parse(input), objectCode);
    });
  }

  it("rechaza un array disperso antes de que Array.some pueda omitir un algoritmo", () => {
    const input = structuredClone(fixture);
    delete input.device_keys.algorithms[0];
    rejects(() => parse(input), "MATRIX_DEVICE_ALGORITHMS_INVALID");
  });

  it("rechaza un proxy sin ejecutar sus trampas", () => {
    let invoked = false;
    const trapped = new Proxy(fixture, {
      get() { invoked = true; throw new Error("never-log-secret"); },
      getPrototypeOf() { invoked = true; throw new Error("never-log-secret"); },
      ownKeys() { invoked = true; throw new Error("never-log-secret"); },
      getOwnPropertyDescriptor() { invoked = true; throw new Error("never-log-secret"); }
    });
    rejects(() => parse(trapped), "MATRIX_CANDIDATE_BODY_INVALID");
    equal(invoked, false);
  });

  it("rechaza un proxy revocado sin filtrar un TypeError del motor", () => {
    const revoked = Proxy.revocable(fixture, {});
    revoked.revoke();
    rejects(() => parse(revoked.proxy), "MATRIX_CANDIDATE_BODY_INVALID");
  });

  it("rechaza un proxy anidado sin leer propiedades ni ejecutar trampas", () => {
    const input = structuredClone(fixture);
    let invoked = false;
    input.device_keys.keys = new Proxy(input.device_keys.keys, { getPrototypeOf() { invoked = true; throw new Error("never-log-secret"); } });
    rejects(() => parse(input), "MATRIX_DEVICE_PUBLIC_KEYS_INVALID");
    equal(invoked, false);
  });

  for (const field of ["userId", "deviceId"] as const) {
    it(`rechaza un identificador del servidor invalido: ${field}`, () => {
      rejects(() => parseMatrixDeviceCandidate(fixture, { userId: USER, deviceId: DEVICE, [field]: "untrusted" }), "MATRIX_EXPECTED_ID_INVALID");
    });
    it(`no coacciona un identificador del servidor a string: ${field}`, () => {
      let invoked = false;
      const scope: Json = { userId: USER, deviceId: DEVICE, [field]: { toString() { invoked = true; throw new Error("never-log-secret"); } } };
      rejects(() => parseMatrixDeviceCandidate(fixture, scope as MatrixDeviceCandidateExpectation), "MATRIX_EXPECTED_ID_INVALID");
      equal(invoked, false);
    });
  }

  it("no invoca getters del contexto esperado", () => {
    let invoked = false;
    const scope = { userId: USER, get deviceId(): string { invoked = true; throw new Error("never-log-secret"); } };
    rejects(() => parseMatrixDeviceCandidate(fixture, scope), "MATRIX_EXPECTED_ID_INVALID");
    equal(invoked, false);
  });
});

function parse(value: unknown) { return parseMatrixDeviceCandidate(value, { userId: USER, deviceId: DEVICE }); }
function rejects(action: () => unknown, code: string): void {
  throws(action, (error: unknown) => {
    ok(error instanceof MatrixKeyUploadValidationError);
    equal(error.code, code);
    equal(error.message, code);
    ok(!Object.hasOwn(error, "cause"));
    ok(!Object.hasOwn(error, "input"));
    ok(!JSON.stringify(error).includes("never-log-secret"));
    return true;
  });
}
function freezeDeep(value: any): void {
  if (!value || typeof value !== "object") return;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
}
function mapContainers(value: any, convert: (value: Json) => Json): any {
  if (Array.isArray(value)) return value.map((child) => mapContainers(child, convert));
  if (!value || typeof value !== "object") return value;
  return convert(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapContainers(child, convert)])));
}
function reverseRecords(value: any): any {
  return mapContainers(value, (record) => Object.fromEntries(Object.entries(record).reverse()));
}
async function realCandidate(): Promise<Json> {
  await initAsync();
  const user = new UserId(USER);
  const device = new DeviceId(DEVICE);
  let machine: OlmMachine;
  try { machine = await OlmMachine.initialize(user, device); }
  finally { user.free(); device.free(); }
  try {
    const requests = await machine.outgoingRequests();
    try {
      const upload = requests.find((request) => request.type === RequestType.KeysUpload);
      ok(upload);
      const body = JSON.parse(upload.body);
      ok(Object.keys(body.one_time_keys).length > 0);
      return { device_keys: body.device_keys };
    } finally { requests.forEach((request) => request.free()); }
  } finally { machine.close(); }
}
