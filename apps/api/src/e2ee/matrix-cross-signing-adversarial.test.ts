import { deepEqual, equal, throws } from "node:assert/strict";
import { KeyObject, generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import {
  MatrixCrossSigningBootstrapExpectation,
  MatrixCrossSigningKey,
  MatrixCrossSigningValidationError,
  parseMatrixCrossSigningBootstrap
} from "./matrix-cross-signing";
import {
  MATRIX_MEGOLM_ALGORITHM,
  MATRIX_OLM_ALGORITHM,
  MatrixDeviceKeys,
  encodeMatrixCanonicalJson
} from "./matrix-key-upload";

const USER_ID = "@u11111111111141118111111111111111:sinochat.invalid";
const DEVICE_ID = "D22222222222242228222222222222222";
const DEVICE_KEY_ID = `ed25519:${DEVICE_ID}`;
const CURVE_KEY_ID = `curve25519:${DEVICE_ID}`;
// Public identity point A = (0, 1), with R = A and S = 0. These bytes require
// no private key and must never constitute an accepted Ed25519 certificate.
const IDENTITY_POINT_KEY = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)])
  .toString("base64").replace(/=+$/u, "");
const IDENTITY_POINT_SIGNATURE = Buffer.concat([Buffer.from([1]), Buffer.alloc(63)])
  .toString("base64").replace(/=+$/u, "");

interface SigningKey {
  publicKey: string;
  privateKey: KeyObject;
}

interface FixtureKeys {
  device: SigningKey;
  master: SigningKey;
  self: SigningKey;
  user: SigningKey;
  curve: string;
}

interface Fixture {
  keys: FixtureKeys;
  registeredDevice: MatrixDeviceKeys;
  signingKeys: {
    master_key: MatrixCrossSigningKey;
    self_signing_key: MatrixCrossSigningKey;
    user_signing_key: MatrixCrossSigningKey;
  };
  signatures: Record<string, Record<string, MatrixDeviceKeys>>;
  expected: MatrixCrossSigningBootstrapExpectation;
}

describe("cross-signing: cadenas adversariales firmadas con Ed25519 independiente", () => {
  it("acepta una cadena completa y conserva ambas firmas del dispositivo", () => {
    const fixture = createFixture();
    const parsed = parse(fixture);

    deepEqual(parsed.identity, {
      userId: USER_ID,
      masterKey: fixture.keys.master.publicKey,
      selfSigningKey: fixture.keys.self.publicKey,
      userSigningKey: fixture.keys.user.publicKey
    });
    deepEqual(parsed.signedDeviceKeys.signatures[USER_ID], {
      [`ed25519:${fixture.keys.self.publicKey}`]:
        fixture.signatures[USER_ID][DEVICE_ID].signatures[USER_ID][`ed25519:${fixture.keys.self.publicKey}`],
      [DEVICE_KEY_ID]: fixture.registeredDevice.signatures[USER_ID][DEVICE_KEY_ID]
    });
    equal(Object.keys(fixture.signatures[USER_ID][DEVICE_ID].signatures[USER_ID]).length, 1);
  });

  it("rechaza una raiz avalada por otro dispositivo aunque conserve autofirma valida", () => {
    const fixture = createFixture();
    fixture.signingKeys.master_key.signatures[USER_ID][DEVICE_KEY_ID] =
      signature(fixture.signingKeys.master_key, signingKey());

    rejects(fixture, "MATRIX_CROSS_SIGNING_DEVICE_SIGNATURE_INVALID");
  });

  it("rechaza una autofirma de raiz ajena aunque el dispositivo legitimo la avale", () => {
    const fixture = createFixture();
    fixture.signingKeys.master_key.signatures[USER_ID][`ed25519:${fixture.keys.master.publicKey}`] =
      signature(fixture.signingKeys.master_key, signingKey());

    rejects(fixture, "MATRIX_CROSS_SIGNING_MASTER_SIGNATURE_INVALID");
  });

  for (const [field, code] of [
    ["self_signing_key", "MATRIX_CROSS_SIGNING_SELF_KEY_SIGNATURE_INVALID"],
    ["user_signing_key", "MATRIX_CROSS_SIGNING_USER_KEY_SIGNATURE_INVALID"]
  ] as const) {
    it(`rechaza ${field} firmada por otra raiz bajo el identificador de la raiz legitima`, () => {
      const fixture = createFixture();
      fixture.signingKeys[field].signatures[USER_ID][`ed25519:${fixture.keys.master.publicKey}`] =
        signature(fixture.signingKeys[field], signingKey());

      rejects(fixture, code);
    });
  }

  it("rechaza el certificado del dispositivo firmado por otra clave self-signing", () => {
    const fixture = createFixture();
    const certificate = fixture.signatures[USER_ID][DEVICE_ID];
    certificate.signatures[USER_ID][`ed25519:${fixture.keys.self.publicKey}`] =
      signature(certificate, signingKey());

    rejects(fixture, "MATRIX_CROSS_SIGNING_DEVICE_CERTIFICATE_INVALID");
  });

  it("rechaza self-signing de punto identidad aunque la raiz legitima firme su clave publica", () => {
    const fixture = createFixture();
    const weakSelfKeyId = `ed25519:${IDENTITY_POINT_KEY}`;
    const self = fixture.signingKeys.self_signing_key;
    self.keys = { [weakSelfKeyId]: IDENTITY_POINT_KEY };
    self.signatures = { [USER_ID]: {
      [`ed25519:${fixture.keys.master.publicKey}`]: signature(self, fixture.keys.master)
    } };
    fixture.signatures[USER_ID][DEVICE_ID].signatures = {
      [USER_ID]: { [weakSelfKeyId]: IDENTITY_POINT_SIGNATURE }
    };

    throws(() => parse(fixture), (error: unknown) => error instanceof MatrixCrossSigningValidationError);
  });

  it("rechaza raiz de punto identidad avalada por el dispositivo con autofirma y subfirmas sin secreto", () => {
    const fixture = createFixture();
    const weakMasterKeyId = `ed25519:${IDENTITY_POINT_KEY}`;
    const master = fixture.signingKeys.master_key;
    master.keys = { [weakMasterKeyId]: IDENTITY_POINT_KEY };
    master.signatures = { [USER_ID]: {
      [DEVICE_KEY_ID]: signature(master, fixture.keys.device),
      [weakMasterKeyId]: IDENTITY_POINT_SIGNATURE
    } };
    fixture.signingKeys.self_signing_key.signatures = {
      [USER_ID]: { [weakMasterKeyId]: IDENTITY_POINT_SIGNATURE }
    };
    fixture.signingKeys.user_signing_key.signatures = {
      [USER_ID]: { [weakMasterKeyId]: IDENTITY_POINT_SIGNATURE }
    };

    throws(() => parse(fixture), (error: unknown) => error instanceof MatrixCrossSigningValidationError);
  });

  it("rechaza user-signing de punto identidad aunque su certificado de raiz sea valido", () => {
    const fixture = createFixture();
    const user = fixture.signingKeys.user_signing_key;
    user.keys = { [`ed25519:${IDENTITY_POINT_KEY}`]: IDENTITY_POINT_KEY };
    user.signatures = { [USER_ID]: {
      [`ed25519:${fixture.keys.master.publicKey}`]: signature(user, fixture.keys.master)
    } };

    throws(() => parse(fixture), (error: unknown) => error instanceof MatrixCrossSigningValidationError);
  });

  for (const [label, keyId] of [["Curve25519", CURVE_KEY_ID], ["Ed25519", DEVICE_KEY_ID]] as const) {
    it(`rechaza sustitucion de ${label} incluso con certificado self-signing valido`, () => {
      const fixture = createFixture();
      const certificate = fixture.signatures[USER_ID][DEVICE_ID];
      certificate.keys[keyId] = signingKey().publicKey;
      certificate.signatures[USER_ID][`ed25519:${fixture.keys.self.publicKey}`] =
        signature(certificate, fixture.keys.self);

      rejects(fixture, "MATRIX_CROSS_SIGNING_DEVICE_IDENTITY_MISMATCH");
    });
  }

  it("rechaza una instantanea del directorio con autofirma del dispositivo ajena", () => {
    const fixture = createFixture();
    fixture.registeredDevice.signatures[USER_ID][DEVICE_KEY_ID] =
      signature(fixture.registeredDevice, signingKey());

    rejects(fixture, "MATRIX_DEVICE_SIGNATURE_INVALID");
  });

  for (const role of ["master", "self", "user", "all"] as const) {
    it(`prohibe sustituir ${role} con firmas validas cuando ya existe identidad fijada`, () => {
      const original = createFixture();
      const pinnedIdentity = parse(original).identity;
      const replacement = role === "all"
        ? createFixture({ device: original.keys.device, curve: original.keys.curve })
        : createFixture({ ...original.keys, [role]: signingKey() });
      // Establish that the replacement is a valid chain before testing pinning.
      parse(replacement);
      replacement.expected.pinnedIdentity = pinnedIdentity;

      rejects(replacement, "MATRIX_CROSS_SIGNING_IDENTITY_CHANGE_FORBIDDEN");
    });
  }

  for (const [first, second] of [["master", "self"], ["master", "user"], ["self", "user"]] as const) {
    it(`rechaza reutilizacion de claves entre ${first} y ${second} aunque todas las firmas sean validas`, () => {
      const sharedKey = signingKey();
      const fixture = createFixture({ [first]: sharedKey, [second]: sharedKey });

      rejects(fixture, "MATRIX_CROSS_SIGNING_KEY_REUSED");
    });
  }

  for (const role of ["master", "self", "user"] as const) {
    it(`rechaza reutilizacion de la clave Ed25519 del dispositivo como ${role}`, () => {
      const sharedKey = signingKey();
      const fixture = createFixture({ device: sharedKey, [role]: sharedKey });

      rejects(fixture, "MATRIX_CROSS_SIGNING_KEY_REUSED");
    });

    it(`rechaza reutilizacion de los bytes Curve25519 del dispositivo como ${role}`, () => {
      const sharedKey = signingKey();
      const fixture = createFixture({ curve: sharedKey.publicKey, [role]: sharedKey });

      rejects(fixture, "MATRIX_CROSS_SIGNING_KEY_REUSED");
    });
  }

  it("verifica las mismas firmas tras invertir el orden de propiedades de cada objeto", () => {
    const fixture = createFixture();
    const parsed = parse(fixture);
    const reordered = parseMatrixCrossSigningBootstrap(
      reverseObjectOrder(fixture.signingKeys),
      reverseObjectOrder(fixture.signatures),
      { ...fixture.expected, registeredDeviceKeys: reverseObjectOrder(fixture.registeredDevice) }
    );

    deepEqual(reordered, parsed);
  });
});

function createFixture(overrides: Partial<FixtureKeys> = {}): Fixture {
  const keys: FixtureKeys = {
    device: overrides.device ?? signingKey(),
    master: overrides.master ?? signingKey(),
    self: overrides.self ?? signingKey(),
    user: overrides.user ?? signingKey(),
    curve: overrides.curve ?? generateKeyPairSync("x25519").publicKey
      .export({ format: "der", type: "spki" }).subarray(-32).toString("base64").replace(/=+$/u, "")
  };
  const registeredDevice: MatrixDeviceKeys = {
    user_id: USER_ID,
    device_id: DEVICE_ID,
    algorithms: [MATRIX_OLM_ALGORITHM, MATRIX_MEGOLM_ALGORITHM],
    keys: { [DEVICE_KEY_ID]: keys.device.publicKey, [CURVE_KEY_ID]: keys.curve },
    signatures: {}
  };
  registeredDevice.signatures = { [USER_ID]: { [DEVICE_KEY_ID]: signature(registeredDevice, keys.device) } };
  const master = publicCrossSigningKey(keys.master, "master");
  master.signatures = { [USER_ID]: {
    [DEVICE_KEY_ID]: signature(master, keys.device),
    [`ed25519:${keys.master.publicKey}`]: signature(master, keys.master)
  } };
  const self = publicCrossSigningKey(keys.self, "self_signing");
  self.signatures = { [USER_ID]: { [`ed25519:${keys.master.publicKey}`]: signature(self, keys.master) } };
  const user = publicCrossSigningKey(keys.user, "user_signing");
  user.signatures = { [USER_ID]: { [`ed25519:${keys.master.publicKey}`]: signature(user, keys.master) } };
  const certificate = structuredClone(registeredDevice);
  certificate.signatures = { [USER_ID]: { [`ed25519:${keys.self.publicKey}`]: signature(certificate, keys.self) } };

  return {
    keys,
    registeredDevice,
    signingKeys: { master_key: master, self_signing_key: self, user_signing_key: user },
    signatures: { [USER_ID]: { [DEVICE_ID]: certificate } },
    expected: { userId: USER_ID, deviceId: DEVICE_ID, registeredDeviceKeys: registeredDevice, pinnedIdentity: null }
  };
}

function signingKey(): SigningKey {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicKey: pair.publicKey.export({ format: "der", type: "spki" })
      .subarray(-32).toString("base64").replace(/=+$/u, ""),
    privateKey: pair.privateKey
  };
}

function signature(value: MatrixCrossSigningKey | MatrixDeviceKeys, key: SigningKey): string {
  const { signatures: _signatures, ...core } = value;
  return sign(null, encodeMatrixCanonicalJson(core), key.privateKey).toString("base64").replace(/=+$/u, "");
}

function publicCrossSigningKey(key: SigningKey, usage: MatrixCrossSigningKey["usage"][0]): MatrixCrossSigningKey {
  return {
    keys: { [`ed25519:${key.publicKey}`]: key.publicKey },
    signatures: {},
    usage: [usage],
    user_id: USER_ID
  };
}

function parse(fixture: Fixture) {
  return parseMatrixCrossSigningBootstrap(fixture.signingKeys, fixture.signatures, fixture.expected);
}

function rejects(fixture: Fixture, code: string): void {
  throws(() => parse(fixture), (error: unknown) => (
    error instanceof MatrixCrossSigningValidationError && error.code === code
  ));
}

function reverseObjectOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectOrder);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseObjectOrder(item)]));
}
