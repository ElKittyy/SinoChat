import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(
  webRoot,
  "src/e2ee/matrixImageAttachment.ts",
);
const temporaryDirectory = await mkdtemp(
  resolve(webRoot, ".matrix-image-attachment-test-"),
);
const outputPath = resolve(temporaryDirectory, "matrixImageAttachment.mjs");

try {
  const source = await readFile(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  assert.deepEqual(
    compiled.diagnostics ?? [],
    [],
    "La utilidad de adjuntos debe transpilar sin diagnosticos",
  );
  await writeFile(outputPath, compiled.outputText, "utf8");

  const attachmentCrypto = await import(
    `${pathToFileURL(outputPath).href}?test=${Date.now()}`
  );
  const {
    MatrixImageAttachmentError,
    decryptMatrixImageAttachment,
    detectAllowedImageMimeType,
    encryptMatrixImageAttachment,
  } = attachmentCrypto;

  const png = new Uint8Array(
    await readFile(resolve(webRoot, "public/assets/favicon-32.png")),
  );
  const jpeg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9,
  ]);
  const webp = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x0e, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c,
    0x02, 0x00, 0x00, 0x00, 0x2f, 0x00,
  ]);

  assert.equal(detectAllowedImageMimeType(jpeg), "image/jpeg");
  assert.equal(detectAllowedImageMimeType(png), "image/png");
  assert.equal(detectAllowedImageMimeType(webp), "image/webp");
  assert.equal(
    detectAllowedImageMimeType(
      new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
    ),
    undefined,
  );

  const encrypted = await encryptMatrixImageAttachment({
    bytes: png,
    mimeType: "image/png",
  });
  assert.equal(encrypted.declaredMimeType, "image/png");
  assert.equal(encrypted.plaintextByteSize, png.byteLength);
  assert.equal(encrypted.ciphertextByteSize, png.byteLength);
  assert.match(encrypted.ciphertextSha256, /^[a-f0-9]{64}$/);
  assert.notDeepEqual(encrypted.encryptedBytes, png);

  const mediaInfo = JSON.parse(encrypted.mediaEncryptionInfo);
  assert.equal(mediaInfo.v, "v2");
  assert.equal(mediaInfo.key.alg, "A256CTR");
  assert.equal(typeof mediaInfo.hashes.sha256, "string");

  const decrypted = await decryptMatrixImageAttachment(encrypted);
  assert.equal(decrypted.mimeType, "image/png");
  assert.deepEqual(decrypted.bytes, png);

  await assertRejectCode(
    () =>
      encryptMatrixImageAttachment({
        bytes: png,
        mimeType: "image/webp",
      }),
    "E2EE_IMAGE_MIME_MISMATCH",
    MatrixImageAttachmentError,
  );
  await assertRejectCode(
    () =>
      encryptMatrixImageAttachment({
        bytes: new Uint8Array(5 * 1024 * 1024 + 1),
        mimeType: "image/png",
      }),
    "E2EE_IMAGE_TOO_LARGE",
    MatrixImageAttachmentError,
  );

  const tamperedCiphertext = {
    ...encrypted,
    encryptedBytes: new Uint8Array(encrypted.encryptedBytes),
  };
  tamperedCiphertext.encryptedBytes[0] ^= 0x01;
  await assertRejectCode(
    () => decryptMatrixImageAttachment(tamperedCiphertext),
    "E2EE_IMAGE_CIPHERTEXT_HASH_INVALID",
    MatrixImageAttachmentError,
  );

  const mediaWithUnexpectedField = {
    ...mediaInfo,
    secretForServer: "never",
  };
  await assertRejectCode(
    () =>
      decryptMatrixImageAttachment({
        ...encrypted,
        mediaEncryptionInfo: JSON.stringify(mediaWithUnexpectedField),
      }),
    "E2EE_IMAGE_MEDIA_INFO_INVALID",
    MatrixImageAttachmentError,
  );

  console.log(
    "[OK] Adjuntos E2EE: MIME/binario, 5 MiB, hashes y consumo Matrix v2 verificados.",
  );
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}

async function assertRejectCode(
  operation,
  expectedCode,
  ErrorConstructor,
) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof ErrorConstructor);
    assert.equal(error.code, expectedCode);
    return true;
  });
}
