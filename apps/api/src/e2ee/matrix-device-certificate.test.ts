import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { before, describe, it } from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { DeviceId, OlmMachine, RequestType, UserId, initAsync } from "@matrix-org/matrix-sdk-crypto-wasm";
import {
  MatrixCrossSigningValidationError,
  parseMatrixCrossSigningBootstrap,
  parseMatrixDeviceCertificate,
  type MatrixCrossSigningPublicIdentity,
  type MatrixDeviceCertificateExpectation,
} from "./matrix-cross-signing";
import { encodeMatrixCanonicalJson, hashMatrixCanonicalJson, verifyMatrixSignedObject } from "./matrix-key-upload";

const USER = "@u11111111111141118111111111111111:sinochat.invalid";
const TRUSTED = "D22222222222242228222222222222222";
const CANDIDATE = "D33333333333343338333333333333333";
const THIRD = "D44444444444444448444444444444444";
const OTHER_USER = "@u55555555555545558555555555555555:sinochat.invalid";
const DEVICE_KEY = `ed25519:${CANDIDATE}`;
type Json = Record<string, any>;
type Fixture = { original: Json; signatures: Json; pin: MatrixCrossSigningPublicIdentity };
type SyntheticSigner = { publicKey: string; signCore: (value: Json) => string };
let fixture: Fixture;
let repeated: Json;

describe("certificado de un dispositivo adicional: validación, no autorización", () => {
  before(async () => { ({ fixture, repeated } = await realCertificates()); });

  it("valida Device.verify del SDK real y conserva la autofirma del candidato", () => {
    const parsed = parse(fixture);
    const selfId = `ed25519:${fixture.pin.selfSigningKey}`;
    deepEqual(Object.keys(fixture.signatures[USER][CANDIDATE].signatures[USER]), [selfId]);
    deepEqual(parsed.identity, fixture.pin);
    deepEqual(Object.keys(parsed.signedDeviceKeys.signatures[USER]).sort(), [selfId, DEVICE_KEY].sort());
    equal(parsed.signedDeviceKeys.signatures[USER][DEVICE_KEY], fixture.original.signatures[USER][DEVICE_KEY]);
    verifyMatrixSignedObject(parsed.signedDeviceKeys, USER, DEVICE_KEY, fixture.original.keys[DEVICE_KEY], "ORIGINAL_INVALID");
    verifyMatrixSignedObject(parsed.signedDeviceKeys, USER, selfId, fixture.pin.selfSigningKey, "CERTIFICATE_INVALID");
    deepEqual(Object.keys(parsed).sort(), ["identity", "signedDeviceKeys"]);
    ok(!Object.hasOwn(parsed, "approved"));
  });

  it("un certificado idéntico sigue siendo válido: no acredita frescura ni consumo único", () => {
    const first = parse(fixture);
    const retry = parse({ ...fixture, signatures: repeated });
    deepEqual(first, retry);
    equal(hashMatrixCanonicalJson(first), hashMatrixCanonicalJson(retry));
    // A service must bind this public certificate to a separate expiring,
    // one-use ceremony. A pure signature parser cannot detect a replay.
  });

  it("no modifica ni comparte referencias con el candidato, pin o solicitud", () => {
    const copy = structuredClone(fixture);
    freezeDeep(copy);
    const parsed = parse(copy);
    parsed.identity.masterKey = "changed";
    parsed.signedDeviceKeys.keys[DEVICE_KEY] = "changed";
    parsed.signedDeviceKeys.signatures[USER][DEVICE_KEY] = "changed";
    parsed.signedDeviceKeys.algorithms.reverse();
    deepEqual(copy, fixture);
  });

  for (const missing of [null, undefined]) {
    it(`no inicializa una raíz cuando falta el pin: ${missing}`, () => {
      rejects(() => parse(fixture, { pinnedIdentity: missing as any }), "OBJECT_INVALID");
    });
  }
  for (const field of ["userId", "deviceId"] as const) {
    it(`rechaza identificador del contexto inválido: ${field}`, () => {
      rejects(() => parse(fixture, { [field]: "untrusted" }), "EXPECTED_ID_INVALID");
    });
  }

  const mutations: [string, (f: Fixture) => void, string][] = [
    ["otro propietario del pin", (f) => { f.pin.userId = OTHER_USER; }, "USER_MISMATCH"],
    ["campo privado en el pin", (f) => { (f.pin as any).seed = "never-log-secret"; }, "FIELDS_INVALID"],
    ["otro destinatario de la firma", (f) => { f.signatures[OTHER_USER] = f.signatures[USER]; delete f.signatures[USER]; }, "FIELDS_INVALID"],
    ["lote con otro usuario", (f) => { f.signatures[OTHER_USER] = {}; }, "FIELDS_INVALID"],
    ["lote con otro dispositivo", (f) => { f.signatures[USER][THIRD] = f.signatures[USER][CANDIDATE]; }, "FIELDS_INVALID"],
    ["certificado sin usuario", (f) => { delete f.signatures[USER][CANDIDATE].user_id; }, "FIELDS_INVALID"],
    ["usuario diferente en certificado", (f) => { f.signatures[USER][CANDIDATE].user_id = OTHER_USER; }, "DEVICE_IDENTITY_MISMATCH"],
    ["ID diferente en certificado", (f) => { f.signatures[USER][CANDIDATE].device_id = THIRD; }, "DEVICE_IDENTITY_MISMATCH"],
    ["algoritmos degradados", (f) => { f.signatures[USER][CANDIDATE].algorithms = ["plaintext"]; }, "ARRAY_INVALID"],
    ["campos no autenticados", (f) => { f.signatures[USER][CANDIDATE].unsigned = { approved: true }; }, "FIELDS_INVALID"],
    ["secretos dentro del certificado", (f) => { f.signatures[USER][CANDIDATE].private_key = "never-log-secret"; }, "FIELDS_INVALID"],
    ["intento de reiniciar raíces", (f) => { f.signatures.master_key = {}; }, "FIELDS_INVALID"],
    ["firma duplicada/autofirma enviada por aprobador", (f) => { f.signatures[USER][CANDIDATE].signatures[USER][DEVICE_KEY] = f.original.signatures[USER][DEVICE_KEY]; }, "FIELDS_INVALID"],
    ["firma de otro propietario", (f) => { f.signatures[USER][CANDIDATE].signatures[OTHER_USER] = {}; }, "FIELDS_INVALID"],
    ["firma ausente", (f) => { f.signatures[USER][CANDIDATE].signatures = {}; }, "FIELDS_INVALID"],
    ["autofirma original ausente", (f) => { f.original.signatures = {}; }, "FIELDS_INVALID"],
    ["autofirma original manipulada", (f) => { f.original.signatures[USER][DEVICE_KEY] = base64(Buffer.alloc(64)); }, "DEVICE_SIGNATURE_INVALID"],
    ["algoritmo original inválido", (f) => { f.original.algorithms.reverse(); }, "ARRAY_INVALID"],
    ["prototipo ajeno", (f) => { Object.setPrototypeOf(f.signatures, { approved: true }); }, "OBJECT_INVALID"],
    ["campo no enumerable", (f) => { Object.defineProperty(f.signatures, "secret", { value: "never-log-secret" }); }, "FIELDS_INVALID"],
    ["símbolo oculto", (f) => { f.signatures[Symbol("secret") as any] = "never-log-secret"; }, "FIELDS_INVALID"],
    ["array alterado", (f) => { f.original.algorithms.extra = "never-log-secret"; }, "ARRAY_INVALID"],
    ["firma truncada", (f) => { f.signatures[USER][CANDIDATE].signatures[USER][`ed25519:${f.pin.selfSigningKey}`] = "AA"; }, "BASE64_INVALID"],
    ["firma con padding", (f) => { f.signatures[USER][CANDIDATE].signatures[USER][`ed25519:${f.pin.selfSigningKey}`] += "=="; }, "BASE64_INVALID"],
    ["firma falsificada", (f) => { f.signatures[USER][CANDIDATE].signatures[USER][`ed25519:${f.pin.selfSigningKey}`] = base64(Buffer.alloc(64)); }, "DEVICE_CERTIFICATE_INVALID"],
    ["claves reutilizadas en el pin", (f) => { f.pin.masterKey = f.pin.selfSigningKey; }, "KEY_REUSED"],
    ["clave del dispositivo reutilizada en el pin", (f) => { f.pin.masterKey = f.original.keys[DEVICE_KEY]; }, "KEY_REUSED"],
  ];
  for (const [label, mutate, code] of mutations) {
    it(`rechaza ${label}`, () => {
      const copy = structuredClone(fixture);
      mutate(copy);
      rejects(() => parse(copy), code);
    });
  }

  for (const field of ["masterKey", "selfSigningKey", "userSigningKey"] as const) {
    it(`rechaza punto débil incluso en un subcertificado no usado: ${field}`, () => {
      const copy = structuredClone(fixture);
      copy.pin[field] = base64(Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]));
      rejects(() => parse(copy), "PUBLIC_KEY_INVALID");
    });

    it(`rechaza un punto no canonico en el pin: ${field}`, () => {
      const copy = structuredClone(fixture);
      // y = 2^255 - 19 (the field modulus), not a canonical field element.
      copy.pin[field] = base64(Buffer.from("ed" + "ff".repeat(30) + "7f", "hex"));
      rejects(() => parse(copy), "PUBLIC_KEY_INVALID");
    });

    it(`rechaza bits Base64 no canonicos en el pin: ${field}`, () => {
      const copy = structuredClone(fixture);
      const encoded = copy.pin[field];
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      const lastIndex = alphabet.indexOf(encoded.at(-1)!);
      copy.pin[field] = encoded.slice(0, -1) + alphabet[lastIndex + 1];
      deepEqual(Buffer.from(copy.pin[field], "base64"), Buffer.from(encoded, "base64"));
      rejects(() => parse(copy), "BASE64_INVALID");
    });
  }

  for (const target of ["original", "certificate"] as const) {
    for (const part of ["ed25519", "curve25519"] as const) {
      it(`rechaza cambiar solo ${part} en ${target} aunque ambas firmas sean validas`, () => {
        const synthetic = independentFixture();
        const copy = structuredClone(synthetic.fixture);
        const selfId = `ed25519:${copy.pin.selfSigningKey}`;
        const replacement = newSyntheticSigner();
        const before = target === "original" ? copy.original : copy.signatures[USER][CANDIDATE];
        const changed = structuredClone(before);
        const keyId = `${part}:${CANDIDATE}`;
        changed.keys[keyId] = part === "ed25519" ? replacement.publicKey : newCurvePublicKey();
        ok(changed.keys[keyId] !== before.keys[keyId]);

        // Assert that precisely one public-key field changed. In particular,
        // the Curve25519 case MUST keep the same Ed25519 identity and signer.
        const unchangedFields = structuredClone(changed);
        unchangedFields.keys[keyId] = before.keys[keyId];
        deepEqual(unchangedFields, before);
        if (target === "original") {
          copy.original = signedDevice(changed, DEVICE_KEY, part === "ed25519" ? replacement : synthetic.candidate);
        } else {
          copy.signatures[USER][CANDIDATE] = signedDevice(changed, selfId, synthetic.self);
        }
        verifyBothSignatures(copy);
        rejects(() => parse(copy), "DEVICE_IDENTITY_MISMATCH");
      });
    }
  }

  const signedFieldMutations: [string, (certificate: Json) => void, string][] = [
    ["user_id", (certificate) => { certificate.user_id = OTHER_USER; }, "DEVICE_IDENTITY_MISMATCH"],
    ["device_id", (certificate) => { certificate.device_id = THIRD; }, "DEVICE_IDENTITY_MISMATCH"],
    ["algorithms", (certificate) => { certificate.algorithms.reverse(); }, "ARRAY_INVALID"],
  ];
  for (const [field, mutate, code] of signedFieldMutations) {
    it(`rechaza ${field} sustituido incluso con firma self-signing valida`, () => {
      const synthetic = independentFixture();
      const copy = structuredClone(synthetic.fixture);
      mutate(copy.signatures[USER][CANDIDATE]);
      copy.signatures[USER][CANDIDATE] = signedDevice(
        copy.signatures[USER][CANDIDATE], `ed25519:${copy.pin.selfSigningKey}`, synthetic.self,
      );
      verifyBothSignatures(copy);
      rejects(() => parse(copy), code);
    });
  }

  for (const labelAsPinned of [false, true]) {
    it(`rechaza firma valida de otra self-signing, etiqueta del pin: ${labelAsPinned}`, () => {
      const synthetic = independentFixture();
      const copy = structuredClone(synthetic.fixture);
      const attacker = newSyntheticSigner();
      const signatureId = `ed25519:${labelAsPinned ? copy.pin.selfSigningKey : attacker.publicKey}`;
      const signed = signedDevice(copy.original, signatureId, attacker);
      verifyMatrixSignedObject(signed, USER, signatureId, attacker.publicKey, "SYNTHETIC_ATTACKER_SIGNATURE_INVALID");
      copy.signatures[USER][CANDIDATE] = signed;
      rejects(() => parse(copy), labelAsPinned ? "DEVICE_CERTIFICATE_INVALID" : "FIELDS_INVALID");
    });
  }

  for (const field of ["masterKey", "userSigningKey"] as const) {
    it(`el certificado consume ${field} del contexto confiable, no autentica un pin enviado por el cliente`, () => {
      const synthetic = independentFixture();
      const changedPin = { ...synthetic.fixture.pin, [field]: newSyntheticSigner().publicKey };
      const parsed = parse(synthetic.fixture, { pinnedIdentity: changedPin });
      deepEqual(parsed.identity, changedPin);
      // Device certificates are signed by self_signing only. This validator
      // cannot reconstruct the master -> self/user chain from a public triplet.
      // Only an already authenticated, immutable SERVER pin is valid context;
      // accepting a body-supplied triplet would defeat this trust boundary.
    });
  }

  it("un certificado correcto solo devuelve claves publicas, no autoridad ni contexto de aprobacion", () => {
    const synthetic = independentFixture();
    const parsed = parse(synthetic.fixture);
    deepEqual(Object.keys(parsed).sort(), ["identity", "signedDeviceKeys"]);
    deepEqual(Object.keys(parsed.identity).sort(), ["masterKey", "selfSigningKey", "userId", "userSigningKey"]);
    deepEqual(Object.keys(parsed.signedDeviceKeys).sort(), ["algorithms", "device_id", "keys", "signatures", "user_id"]);
    const fieldNames = [
      ...Object.keys(parsed), ...Object.keys(parsed.identity), ...Object.keys(parsed.signedDeviceKeys),
    ];
    ok(fieldNames.every((name) => !/private|seed|secret|challenge|ceremony|approved|session|expires/i.test(name)));
    verifyBothSignatures(synthetic.fixture);
  });

  for (const field of ["challenge", "ceremonyId", "approvingSessionId", "expiresAt", "privateKey"] as const) {
    it(`no acepta ${field} como extension del certificado ni lo filtra en errores`, () => {
      const copy = structuredClone(fixture);
      copy.signatures[USER][CANDIDATE][field] = "never-log-secret";
      rejects(() => parse(copy), "FIELDS_INVALID");
    });
  }

  it("rechaza getters en candidato, certificado y pin sin ejecutarlos", () => {
    for (const select of [(f: Fixture) => f.original, (f: Fixture) => f.signatures[USER][CANDIDATE], (f: Fixture) => f.pin]) {
      const copy = structuredClone(fixture);
      const target = select(copy);
      let reads = 0;
      Object.defineProperty(target, Object.keys(target)[0], { enumerable: true, get() { reads++; throw new Error("never-log-secret"); } });
      rejects(() => parse(copy), "FIELDS_INVALID");
      equal(reads, 0);
    }
  });
});

function independentFixture(): { fixture: Fixture; candidate: SyntheticSigner; self: SyntheticSigner } {
  const candidate = newSyntheticSigner();
  const self = newSyntheticSigner();
  const pin: MatrixCrossSigningPublicIdentity = {
    userId: USER,
    masterKey: newSyntheticSigner().publicKey,
    selfSigningKey: self.publicKey,
    userSigningKey: newSyntheticSigner().publicKey,
  };
  const core = {
    algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
    device_id: CANDIDATE,
    keys: { [DEVICE_KEY]: candidate.publicKey, [`curve25519:${CANDIDATE}`]: newCurvePublicKey() },
    user_id: USER,
  };
  const original = signedDevice(core, DEVICE_KEY, candidate);
  const signatures = { [USER]: { [CANDIDATE]: signedDevice(core, `ed25519:${self.publicKey}`, self) } };
  const result = { original, signatures, pin };
  // Validate the independent fixture before mutation so a malformed baseline
  // cannot make an adversarial case pass for an unrelated reason.
  verifyBothSignatures(result);
  deepEqual(parse(result).identity, pin);
  return { fixture: result, candidate, self };
}

function newSyntheticSigner(): SyntheticSigner {
  // Fresh test-only private KeyObjects stay in memory inside this closure.
  // Do not export private bytes, persist them, or add them to a public fixture.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: base64(publicKey.export({ type: "spki", format: "der" }).subarray(-32)),
    signCore: (value) => base64(sign(null, encodeMatrixCanonicalJson(value), privateKey)),
  };
}

function newCurvePublicKey(): string {
  const { publicKey } = generateKeyPairSync("x25519");
  return base64(publicKey.export({ type: "spki", format: "der" }).subarray(-32));
}

function signedDevice(value: Json, signatureId: string, signer: SyntheticSigner): Json {
  const { signatures: _signatures, ...core } = structuredClone(value);
  return { ...core, signatures: { [USER]: { [signatureId]: signer.signCore(core) } } };
}

function verifyBothSignatures(value: Fixture): void {
  verifyMatrixSignedObject(
    value.original, USER, DEVICE_KEY, value.original.keys[DEVICE_KEY], "SYNTHETIC_DEVICE_SIGNATURE_INVALID",
  );
  verifyMatrixSignedObject(
    value.signatures[USER][CANDIDATE], USER, `ed25519:${value.pin.selfSigningKey}`,
    value.pin.selfSigningKey, "SYNTHETIC_CERTIFICATE_SIGNATURE_INVALID",
  );
}

function parse(value: Fixture, overrides: Partial<MatrixDeviceCertificateExpectation> = {}) {
  return parseMatrixDeviceCertificate(value.signatures, {
    userId: USER, deviceId: CANDIDATE, originalDeviceKeys: value.original, pinnedIdentity: value.pin, ...overrides,
  });
}
function rejects(action: () => unknown, code: string) {
  throws(action, (error: unknown) => {
    ok(error instanceof MatrixCrossSigningValidationError);
    ok(error.code.includes(code), `Expected ${code}, got ${error.code}`);
    equal(error.message, error.code);
    ok(!error.message.includes("never-log-secret"));
    ok(!JSON.stringify(error).includes("never-log-secret"));
    ok(!Object.hasOwn(error, "cause"));
    ok(!Object.hasOwn(error, "input"));
    return true;
  });
}
function base64(value: Buffer): string { return value.toString("base64").replace(/=+$/, ""); }
function freezeDeep(value: unknown): void {
  if (!value || typeof value !== "object") return;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
}
async function realCertificates(): Promise<{ fixture: Fixture; repeated: Json }> {
  await initAsync();
  const machines: OlmMachine[] = [];
  const uploads: Json[] = [];
  try {
    for (const deviceId of [TRUSTED, CANDIDATE]) {
      const user = new UserId(USER);
      const device = new DeviceId(deviceId);
      let machine: OlmMachine;
      try { machine = await OlmMachine.initialize(user, device); }
      finally { user.free(); device.free(); }
      machines.push(machine);
      const requests = await machine.outgoingRequests();
      try {
        const upload = requests.find((request) => request.type === RequestType.KeysUpload);
        ok(upload);
        const body = JSON.parse(upload.body);
        uploads.push(body);
        await machine.markRequestAsSent(upload.id!, upload.type, JSON.stringify({ one_time_key_counts: { signed_curve25519: Object.keys(body.one_time_keys).length } }));
      } finally { requests.forEach((request) => request.free()); }
    }
    const bootstrap = await machines[0].bootstrapCrossSigning(false);
    const signing = bootstrap.uploadSigningKeysRequest;
    const signatures = bootstrap.uploadSignaturesRequest;
    const initialKeys = bootstrap.uploadKeysRequest;
    try {
      equal(initialKeys, undefined);
      const parsed = parseMatrixCrossSigningBootstrap(JSON.parse(signing.body), JSON.parse(signatures.body), {
        userId: USER, deviceId: TRUSTED, registeredDeviceKeys: uploads[0].device_keys, pinnedIdentity: null,
      });
      const query = machines[0].queryKeysForUsers([new UserId(USER)]);
      try {
        await machines[0].markRequestAsSent(query.id, query.type, JSON.stringify({
          device_keys: { [USER]: { [TRUSTED]: parsed.signedDeviceKeys, [CANDIDATE]: uploads[1].device_keys } },
          master_keys: { [USER]: parsed.signingKeys.master_key },
          self_signing_keys: { [USER]: parsed.signingKeys.self_signing_key },
          user_signing_keys: { [USER]: parsed.signingKeys.user_signing_key }, failures: {},
        }));
      } finally { query.free(); }
      const user = new UserId(USER);
      const candidateId = new DeviceId(CANDIDATE);
      let candidate;
      try { candidate = await machines[0].getDevice(user, candidateId); }
      finally { user.free(); candidateId.free(); }
      ok(candidate);
      try {
        const upload = await candidate.verify();
        const retry = await candidate.verify();
        try {
          return {
            fixture: { original: uploads[1].device_keys, signatures: JSON.parse(upload.body), pin: parsed.identity },
            repeated: JSON.parse(retry.body),
          };
        } finally { upload.free(); retry.free(); }
      } finally { candidate.free(); }
    } finally { initialKeys?.free(); signing.free(); signatures.free(); bootstrap.free(); }
  } finally { machines.forEach((machine) => machine.close()); }
}
