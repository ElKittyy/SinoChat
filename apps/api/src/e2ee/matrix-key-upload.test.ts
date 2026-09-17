import { equal, ok, throws } from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import {
  DeviceId,
  OlmMachine,
  RequestType,
  UserId,
  initAsync
} from "@matrix-org/matrix-sdk-crypto-wasm";
import {
  MatrixKeyUploadValidationError,
  encodeMatrixCanonicalJson,
  hashMatrixCanonicalJson,
  parseMatrixKeyUpload,
  parseInitialMatrixKeyUpload
} from "./matrix-key-upload";

const MATRIX_USER_ID = "@u11111111111141118111111111111111:sinochat.invalid";
const MATRIX_DEVICE_ID = "D22222222222242228222222222222222";

describe("Matrix canonical JSON", () => {
  it("reproduce los vectores basicos de la especificacion", () => {
    equal(encodeMatrixCanonicalJson({}).toString(), "{}");
    equal(
      encodeMatrixCanonicalJson({ two: "Two", one: 1 }).toString(),
      '{"one":1,"two":"Two"}'
    );
    equal(
      encodeMatrixCanonicalJson({ a: "日" }).toString(),
      '{"a":"日"}'
    );
  });

  it("rechaza numeros que Matrix no permite", () => {
    throws(() => encodeMatrixCanonicalJson(1.5), /NUMBER_INVALID/);
    throws(() => encodeMatrixCanonicalJson(-0), /NUMBER_INVALID/);
    throws(
      () => encodeMatrixCanonicalJson(Number.MAX_SAFE_INTEGER + 1),
      /NUMBER_INVALID/
    );
  });

  it("produce un hash estable sobre la representacion canonica", () => {
    equal(
      hashMatrixCanonicalJson({ two: "Two", one: 1 }),
      hashMatrixCanonicalJson({ one: 1, two: "Two" })
    );
    equal(hashMatrixCanonicalJson({}).length, 64);
  });
});

describe("initial Matrix key upload", () => {
  it("acepta y verifica criptograficamente la salida real de OlmMachine", async () => {
    const body = await createUploadBody();
    const parsed = parseInitialMatrixKeyUpload(body, {
      userId: MATRIX_USER_ID,
      deviceId: MATRIX_DEVICE_ID
    });

    equal(parsed.deviceKeys.user_id, MATRIX_USER_ID);
    equal(parsed.deviceKeys.device_id, MATRIX_DEVICE_ID);
    ok(Object.keys(parsed.oneTimeKeys).length > 0);
    equal(Object.keys(parsed.fallbackKeys).length, 0);
  });

  it("rechaza firma alterada, downgrade y campos inesperados", async () => {
    const body = await createUploadBody();
    const tampered = structuredClone(body) as Record<string, any>;
    const signature =
      tampered.device_keys.signatures[MATRIX_USER_ID][
        `ed25519:${MATRIX_DEVICE_ID}`
      ] as string;
    tampered.device_keys.signatures[MATRIX_USER_ID][
      `ed25519:${MATRIX_DEVICE_ID}`
    ] = `${signature.slice(0, -1)}${signature.endsWith("A") ? "Q" : "A"}`;

    throwsMatrixCode(
      () =>
        parseInitialMatrixKeyUpload(tampered, {
          userId: MATRIX_USER_ID,
          deviceId: MATRIX_DEVICE_ID
        }),
      "MATRIX_DEVICE_SIGNATURE_INVALID"
    );

    const downgraded = structuredClone(body) as Record<string, any>;
    downgraded.device_keys.algorithms[0] = "m.olm.v1.curve25519-aes-sha1";
    throwsMatrixCode(
      () =>
        parseInitialMatrixKeyUpload(downgraded, {
          userId: MATRIX_USER_ID,
          deviceId: MATRIX_DEVICE_ID
        }),
      "MATRIX_DEVICE_ALGORITHMS_INVALID"
    );

    const extended = structuredClone(body) as Record<string, any>;
    extended.private_key = "nunca";
    throwsMatrixCode(
      () =>
        parseInitialMatrixKeyUpload(extended, {
          userId: MATRIX_USER_ID,
          deviceId: MATRIX_DEVICE_ID
        }),
      "MATRIX_UPLOAD_FIELDS_INVALID"
    );
  });

  it("acepta una reposicion parcial solo contra la identidad persistida", async () => {
    const body = await createUploadBody();
    const initial = parseInitialMatrixKeyUpload(body, {
      userId: MATRIX_USER_ID,
      deviceId: MATRIX_DEVICE_ID
    });
    const ed25519 = initial.deviceKeys.keys[`ed25519:${MATRIX_DEVICE_ID}`];
    ok(ed25519);

    const replenishment = {
      one_time_keys: structuredClone(body.one_time_keys)
    };
    const parsed = parseMatrixKeyUpload(replenishment, {
      userId: MATRIX_USER_ID,
      deviceId: MATRIX_DEVICE_ID,
      existingEd25519PublicKey: ed25519
    });

    equal(parsed.deviceKeys, undefined);
    equal(
      Object.keys(parsed.oneTimeKeys).length,
      Object.keys(initial.oneTimeKeys).length
    );
    equal(Object.keys(parsed.fallbackKeys).length, 0);
  });

  it("rechaza reposicion sin confianza previa y sustitucion de identidad", async () => {
    const body = await createUploadBody();
    // Test identity substitution with another VALID key. All-zero bytes are
    // a small-order point and now correctly fail the earlier key validation.
    const otherPublicKey = generateKeyPairSync("ed25519").publicKey
      .export({ format: "der", type: "spki" }).subarray(-32)
      .toString("base64").replace(/=+$/u, "");
    throwsMatrixCode(
      () =>
        parseMatrixKeyUpload(
          { one_time_keys: body.one_time_keys },
          { userId: MATRIX_USER_ID, deviceId: MATRIX_DEVICE_ID }
        ),
      "MATRIX_DEVICE_KEYS_REQUIRED"
    );
    throwsMatrixCode(
      () =>
        parseMatrixKeyUpload(body, {
          userId: MATRIX_USER_ID,
          deviceId: MATRIX_DEVICE_ID,
          existingEd25519PublicKey: otherPublicKey
        }),
      "MATRIX_DEVICE_IDENTITY_CHANGE_FORBIDDEN"
    );
  });
});

async function createUploadBody(): Promise<Record<string, unknown>> {
  await initAsync();
  const userId = new UserId(MATRIX_USER_ID);
  const deviceId = new DeviceId(MATRIX_DEVICE_ID);
  let machine: OlmMachine | undefined;
  try {
    machine = await OlmMachine.initialize(userId, deviceId);
    const requests = await machine.outgoingRequests();
    const upload = requests.find(
      (request) => request.type === RequestType.KeysUpload
    );
    ok(upload, "OlmMachine debe crear KeysUploadRequest");
    return JSON.parse(upload.body) as Record<string, unknown>;
  } finally {
    machine?.close();
    userId.free();
    deviceId.free();
  }
}

function throwsMatrixCode(action: () => unknown, code: string): void {
  throws(action, (error: unknown) => {
    return (
      error instanceof MatrixKeyUploadValidationError && error.code === code
    );
  });
}
