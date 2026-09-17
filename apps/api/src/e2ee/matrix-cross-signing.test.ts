import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { before, describe, it } from "node:test";
import { DeviceId, OlmMachine, RequestType, UserId, initAsync } from "@matrix-org/matrix-sdk-crypto-wasm";
import {
  MatrixCrossSigningBootstrapExpectation,
  MatrixCrossSigningValidationError,
  parseMatrixCrossSigningBootstrap
} from "./matrix-cross-signing";
import { verifyMatrixSignedObject } from "./matrix-key-upload";

const USER = "@u11111111111141118111111111111111:sinochat.invalid";
const DEVICE = "D22222222222242228222222222222222";
const OTHER_USER = "@u33333333333343338333333333333333:sinochat.invalid";
const DEVICE_KEY_ID = "ed25519:" + DEVICE;
type JsonObject = Record<string, any>;
type Fixture = { deviceKeys: JsonObject; signingKeys: JsonObject; signatures: JsonObject };
let real: Fixture;
let retried: Fixture;

describe("cross-signing bootstrap del SDK Matrix Rust Crypto 18.6", () => {
  before(async () => { [real, retried] = await bootstrapFixtures(); });

  it("valida las cinco firmas del bootstrap real y conserva la firma original del dispositivo", () => {
    const parsed = parse(real);
    const selfKeyId = "ed25519:" + parsed.identity.selfSigningKey;
    deepEqual(Object.keys(real.signatures[USER][DEVICE].signatures[USER]), [selfKeyId]);
    deepEqual(parsed.signingKeys, real.signingKeys);
    deepEqual(Object.keys(parsed.signedDeviceKeys.signatures[USER]).sort(), [selfKeyId, DEVICE_KEY_ID].sort());
    equal(parsed.signedDeviceKeys.signatures[USER][DEVICE_KEY_ID], real.deviceKeys.signatures[USER][DEVICE_KEY_ID]);
    verifyMatrixSignedObject(parsed.signedDeviceKeys, USER, DEVICE_KEY_ID, real.deviceKeys.keys[DEVICE_KEY_ID], "INVALID_ORIGINAL_SIGNATURE");
    verifyMatrixSignedObject(parsed.signedDeviceKeys, USER, selfKeyId, parsed.identity.selfSigningKey, "INVALID_NEW_SIGNATURE");
    equal(new Set([parsed.identity.masterKey, parsed.identity.selfSigningKey, parsed.identity.userSigningKey]).size, 3);
  });

  it("bootstrap(false) repetido conserva el triplete y acepta el pin persistido", () => {
    const first = parse(real);
    deepEqual(parse(retried, { pinnedIdentity: first.identity }), first);
  });

  it("no modifica ni comparte objetos mutables con las solicitudes o el directorio", () => {
    const fixture = structuredClone(real);
    const original = structuredClone(fixture);
    freezeDeep(fixture);
    const parsed = parse(fixture);
    parsed.signingKeys.master_key.usage[0] = "user_signing";
    parsed.signingKeys.self_signing_key.signatures[USER].extra = "changed";
    parsed.signedDeviceKeys.keys[DEVICE_KEY_ID] = "changed";
    parsed.signedDeviceKeys.signatures[USER][DEVICE_KEY_ID] = "changed";
    parsed.signedDeviceKeys.algorithms.reverse();
    deepEqual(fixture, original);
  });

  it("acepta diccionarios JSON sin prototipo", () => {
    deepEqual(parse(withNullPrototypes(real) as Fixture), parse(real));
  });

  const mutations: [string, (fixture: Fixture) => void, string][] = [
    ["upload de claves null", (f) => { f.signingKeys = null as any; }, "OBJECT_INVALID"],
    ["upload de firmas array", (f) => { f.signatures = [] as any; }, "OBJECT_INVALID"],
    ["triplete incompleto", (f) => { delete f.signingKeys.user_signing_key; }, "FIELDS_INVALID"],
    ["auth inesperado en el cuerpo publico", (f) => { f.signingKeys.auth = { password: "never-log-this-secret" }; }, "FIELDS_INVALID"],
    ["seed privado junto a una clave", (f) => { f.signingKeys.master_key.seed = "never-log-this-secret"; }, "FIELDS_INVALID"],
    ["unsigned inesperado", (f) => { f.signingKeys.master_key.unsigned = {}; }, "FIELDS_INVALID"],
    ["propietario diferente", (f) => { f.signingKeys.self_signing_key.user_id = OTHER_USER; }, "USER_MISMATCH"],
    ["uso incorrecto", (f) => { f.signingKeys.self_signing_key.usage = ["user_signing"]; }, "ARRAY_INVALID"],
    ["multiples usos", (f) => { f.signingKeys.master_key.usage.push("master"); }, "ARRAY_INVALID"],
    ["uso ausente", (f) => { f.signingKeys.master_key.usage = []; }, "ARRAY_INVALID"],
    ["uso en string", (f) => { f.signingKeys.master_key.usage = "master"; }, "ARRAY_INVALID"],
    ["clave publica ausente", (f) => { f.signingKeys.master_key.keys = {}; }, "PUBLIC_KEY_INVALID"],
    ["dos claves publicas por uso", (f) => { f.signingKeys.master_key.keys.other = "extra"; }, "PUBLIC_KEY_INVALID"],
    ["ID que no corresponde al valor publico", (f) => { const key = Object.values(f.signingKeys.master_key.keys)[0]; f.signingKeys.master_key.keys = { "ed25519:wrong": key }; }, "KEY_ID_INVALID"],
    ["Base64 con padding", (f) => { replaceMasterPublicValue(f, (v) => v + "="); }, "BASE64_INVALID"],
    ["Base64 URL-safe", (f) => { replaceMasterPublicValue(f, (v) => "_" + v.slice(1)); }, "BASE64_INVALID"],
    ["clave demasiado grande", (f) => { replaceMasterPublicValue(f, () => "A".repeat(4096)); }, "BASE64_INVALID"],
    ["clave publica no string", (f) => { replaceMasterPublicValue(f, () => null); }, "BASE64_INVALID"],
    ["firma no canonica", (f) => { f.signingKeys.master_key.signatures[USER][DEVICE_KEY_ID] += "="; }, "BASE64_INVALID"],
    ["firma truncada", (f) => { f.signingKeys.master_key.signatures[USER][DEVICE_KEY_ID] = "AA"; }, "BASE64_INVALID"],
    ["master sin respaldo del dispositivo", (f) => { delete f.signingKeys.master_key.signatures[USER][DEVICE_KEY_ID]; }, "FIELDS_INVALID"],
    ["master sin autofirma", (f) => { delete f.signingKeys.master_key.signatures[USER][Object.keys(f.signingKeys.master_key.keys)[0]]; }, "FIELDS_INVALID"],
    ["firma extra del dispositivo en subclave", (f) => { f.signingKeys.self_signing_key.signatures[USER][DEVICE_KEY_ID] = f.deviceKeys.signatures[USER][DEVICE_KEY_ID]; }, "FIELDS_INVALID"],
    ["firma de otro usuario", (f) => { f.signingKeys.master_key.signatures[OTHER_USER] = {}; }, "FIELDS_INVALID"],
    ["upload para otro usuario", (f) => { f.signatures[OTHER_USER] = {}; }, "FIELDS_INVALID"],
    ["upload para otro dispositivo", (f) => { f.signatures[USER].OTHER_DEVICE = f.signatures[USER][DEVICE]; }, "FIELDS_INVALID"],
    ["certificado con dispositivo cambiado", (f) => { f.signatures[USER][DEVICE].device_id = "D33333333333343338333333333333333"; }, "DEVICE_IDENTITY_MISMATCH"],
    ["certificado con usuario cambiado", (f) => { f.signatures[USER][DEVICE].user_id = OTHER_USER; }, "DEVICE_IDENTITY_MISMATCH"],
    ["certificado con algoritmo degradado", (f) => { f.signatures[USER][DEVICE].algorithms = ["plaintext"]; }, "ARRAY_INVALID"],
    ["certificado que intenta agregar una autofirma", (f) => { f.signatures[USER][DEVICE].signatures[USER][DEVICE_KEY_ID] = f.deviceKeys.signatures[USER][DEVICE_KEY_ID]; }, "FIELDS_INVALID"],
    ["certificado con campo no autenticado", (f) => { f.signatures[USER][DEVICE].unsigned = { trusted: true }; }, "FIELDS_INVALID"],
    ["directorio con autofirma manipulada", (f) => { f.deviceKeys.signatures[USER][DEVICE_KEY_ID] = Buffer.alloc(64).toString("base64").replace(/=+$/, ""); }, "MATRIX_DEVICE_SIGNATURE_INVALID"],
    ["directorio sin autofirma", (f) => { f.deviceKeys.signatures = {}; }, "FIELDS_INVALID"],
    ["prototipo no JSON", (f) => { Object.setPrototypeOf(f.signingKeys.master_key, { private_key: "secret" }); }, "OBJECT_INVALID"],
    ["propiedad simbolica", (f) => { f.signingKeys.master_key[Symbol("private_key") as any] = "secret"; }, "FIELDS_INVALID"],
    ["propiedad no enumerable", (f) => { Object.defineProperty(f.signingKeys, "private_key", { value: "secret" }); }, "FIELDS_INVALID"],
    ["propiedad extra del array", (f) => { f.signingKeys.master_key.usage.extra = "secret"; }, "ARRAY_INVALID"],
    ["array con hueco", (f) => { delete f.signingKeys.master_key.usage[0]; }, "ARRAY_INVALID"],
    ["array con prototipo modificado", (f) => { Object.setPrototypeOf(f.signingKeys.master_key.usage, null); }, "ARRAY_INVALID"],
    ["campo ciclico no permitido", (f) => { f.signingKeys.master_key.keys = f.signingKeys; }, "PUBLIC_KEY_INVALID"]
  ];
  for (const [name, mutate, code] of mutations) {
    it("rechaza " + name, () => {
      const fixture = structuredClone(real);
      mutate(fixture);
      rejects(() => parse(fixture), code);
    });
  }

  it("rechaza bits de padding no canonicos aunque Base64 decodifique los mismos bytes", () => {
    const fixture = structuredClone(real);
    const key = Object.values(fixture.signingKeys.master_key.keys)[0] as string;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const bad = key.slice(0, -1) + alphabet[alphabet.indexOf(key.at(-1)!) + 1];
    deepEqual(Buffer.from(bad, "base64"), Buffer.from(key, "base64"));
    replaceMasterPublicValue(fixture, () => bad);
    rejects(() => parse(fixture), "BASE64_INVALID");
  });

  it("rechaza getters sin ejecutarlos en objetos ni arrays", () => {
    for (const target of ["key", "usage"] as const) {
      const fixture = structuredClone(real);
      let reads = 0;
      const parent = target === "key" ? fixture.signingKeys.master_key : fixture.signingKeys.master_key.usage;
      const key = target === "key" ? "keys" : "0";
      Object.defineProperty(parent, key, { enumerable: true, get() { reads += 1; throw new Error("secret"); } });
      rejects(() => parse(fixture), target === "key" ? "FIELDS_INVALID" : "ARRAY_INVALID");
      equal(reads, 0);
    }
  });

  it("requiere una decision explicita de identidad inicial, no undefined", () => {
    rejects(() => parse(real, { pinnedIdentity: undefined as any }), "OBJECT_INVALID");
  });

  it("el pin pertenece al mismo usuario y no admite propiedades inesperadas", () => {
    const pinned = parse(real).identity;
    rejects(() => parse(real, { pinnedIdentity: { ...pinned, userId: OTHER_USER } }), "USER_MISMATCH");
    rejects(() => parse(real, { pinnedIdentity: { ...pinned, private_key: "secret" } as any }), "FIELDS_INVALID");
  });

  it("rechaza IDs del contexto que no pertenecen al namespace interno", () => {
    rejects(() => parse(real, { userId: "@admin:example.com" }), "EXPECTED_ID_INVALID");
    rejects(() => parse(real, { deviceId: "OTHER" }), "EXPECTED_ID_INVALID");
  });
});

function parse(fixture: Fixture, overrides: Partial<MatrixCrossSigningBootstrapExpectation> = {}) {
  return parseMatrixCrossSigningBootstrap(fixture.signingKeys, fixture.signatures, {
    userId: USER, deviceId: DEVICE, registeredDeviceKeys: fixture.deviceKeys, pinnedIdentity: null, ...overrides
  });
}
function rejects(action: () => unknown, code: string): void {
  throws(action, (error: unknown) => {
    ok(error instanceof MatrixCrossSigningValidationError);
    ok(error.code.includes(code), "Expected " + code + ", received " + error.code);
    equal(error.message, error.code);
    ok(!error.message.includes("never-log-this-secret"));
    return true;
  });
}
function replaceMasterPublicValue(fixture: Fixture, replacement: (value: string) => unknown): void {
  const keys = fixture.signingKeys.master_key.keys;
  const keyId = Object.keys(keys)[0];
  keys[keyId] = replacement(keys[keyId]);
}
function freezeDeep(value: unknown): void {
  if (!value || typeof value !== "object") return;
  Object.freeze(value);
  Object.values(value).forEach(freezeDeep);
}
function withNullPrototypes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withNullPrototypes);
  if (!value || typeof value !== "object") return value;
  return Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([key, child]) => [key, withNullPrototypes(child)])));
}
async function bootstrapFixtures(): Promise<[Fixture, Fixture]> {
  await initAsync();
  const user = new UserId(USER);
  const device = new DeviceId(DEVICE);
  let machine: OlmMachine | undefined;
  try {
    machine = await OlmMachine.initialize(user, device);
    const initial = await machine.outgoingRequests();
    let deviceKeys: JsonObject | undefined;
    try {
      const upload = initial.find((request) => request.type === RequestType.KeysUpload);
      ok(upload);
      const body = JSON.parse(upload.body);
      deviceKeys = body.device_keys;
      await machine.markRequestAsSent(upload.id!, upload.type, JSON.stringify({ one_time_key_counts: {
        signed_curve25519: Object.keys(body.one_time_keys).length
      } }));
    } finally { initial.forEach((request) => request.free()); }
    ok(deviceKeys);
    const fixtures: Fixture[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const bootstrap = await machine.bootstrapCrossSigning(false);
      const keys = bootstrap.uploadKeysRequest;
      const signing = bootstrap.uploadSigningKeysRequest;
      const signatures = bootstrap.uploadSignaturesRequest;
      try {
        // Never request or export private cross-signing material.
        fixtures.push({ deviceKeys, signingKeys: JSON.parse(signing.body), signatures: JSON.parse(signatures.body) });
      } finally { keys?.free(); signing.free(); signatures.free(); bootstrap.free(); }
    }
    return [fixtures[0], fixtures[1]];
  } finally { machine?.close(); user.free(); device.free(); }
}
