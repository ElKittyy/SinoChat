import "../config/load-env";
import {
  GetBucketVersioningCommand,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { strictEqual } from "node:assert";
import { readObjectStorageForcePathStyle } from "../config/runtime-config";
import { ObjectStorageService } from "../storage/object-storage.service";

const ADMIN_CONTROL_BUCKET = "sinochat-admin-control";

async function checkObjectStorage(): Promise<void> {
  const endpoint = required("OBJECT_STORAGE_ENDPOINT");
  const region = required("OBJECT_STORAGE_REGION");
  const bucket = required("OBJECT_STORAGE_BUCKET");
  const accessKeyId = required("OBJECT_STORAGE_ACCESS_KEY_ID");
  const secretAccessKey = required("OBJECT_STORAGE_SECRET_ACCESS_KEY");
  const webOrigin = required("WEB_ORIGIN");
  const parsedEndpoint = new URL(endpoint);

  if (
    process.env.NODE_ENV === "production" ||
    parsedEndpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(parsedEndpoint.hostname)
  ) {
    throw new Error("LOCAL_ENDPOINT_REQUIRED");
  }
  if (
    bucket !== "sinochat-ephemeral" ||
    process.env.OBJECT_STORAGE_VERSIONING_MODE !== "purge-all"
  ) {
    throw new Error("LOCAL_PURGE_ALL_BUCKET_REQUIRED");
  }

  const forcePathStyle = readObjectStorageForcePathStyle(process.env);
  strictEqual(forcePathStyle, true, "LOCAL_PATH_STYLE_REQUIRED");
  const client = new S3Client({
    endpoint: parsedEndpoint.toString(),
    region,
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey }
  });
  const storage = new ObjectStorageService();
  const key = `checks/${randomUUID()}.bin`;
  const payload = randomBytes(1_024);
  const checksumHex = createHash("sha256").update(payload).digest("hex");
  let uploadMayExist = false;

  try {
    const bucketVersioning = await client.send(
      new GetBucketVersioningCommand({ Bucket: bucket })
    );
    strictEqual(bucketVersioning.Status, "Enabled", "VERSIONING_NOT_ENABLED");
    console.log("[OK] Bucket privado con versionado habilitado.");

    let controlBucketWasVisible = false;
    try {
      const visibleBuckets = await client.send(new ListBucketsCommand({}));
      controlBucketWasVisible = Boolean(
        visibleBuckets.Buckets?.some(
          (visibleBucket) => visibleBucket.Name === ADMIN_CONTROL_BUCKET
        )
      );
    } catch (error) {
      if (httpStatus(error) !== 403) {
        throw error;
      }
    }

    strictEqual(
      controlBucketWasVisible,
      false,
      "ADMIN_CONTROL_BUCKET_WAS_VISIBLE"
    );
    let controlBucketAccessWasDenied = false;
    try {
      await client.send(
        new ListObjectVersionsCommand({
          Bucket: ADMIN_CONTROL_BUCKET,
          MaxKeys: 1
        })
      );
    } catch (error) {
      controlBucketAccessWasDenied = httpStatus(error) === 403;
    }
    strictEqual(
      controlBucketAccessWasDenied,
      true,
      "ADMIN_CONTROL_BUCKET_ACCESS_NOT_DENIED"
    );
    console.log("[OK] Credencial de la API limitada al bucket de SinoChat.");

    const upload = await storage.presignUpload(
      key,
      payload.byteLength,
      checksumHex,
      new Date()
    );
    const uploadHeaders = Object.fromEntries(
      Object.entries(upload.headers).map(([name, value]) => [
        name,
        String(value)
      ])
    );
    const preflightHeaders = Object.keys(uploadHeaders)
      .filter((name) => name !== "content-length")
      .join(",");
    const preflight = await fetch(upload.url, {
      method: "OPTIONS",
      headers: {
        Origin: webOrigin,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": preflightHeaders
      }
    });
    await preflight.body?.cancel();
    strictEqual(preflight.ok, true, "CORS_PREFLIGHT_REJECTED");
    strictEqual(
      preflight.headers.get("access-control-allow-origin"),
      webOrigin,
      "CORS_ORIGIN_MISMATCH"
    );
    console.log("[OK] CORS permite cargas solo desde el origen web configurado.");

    const directObjectUrl = new URL(
      `${bucket}/${key}`,
      `${parsedEndpoint.toString().replace(/\/$/, "")}/`
    );
    const anonymousRead = await fetch(directObjectUrl);
    await anonymousRead.body?.cancel();
    strictEqual(anonymousRead.status, 403, "ANONYMOUS_ACCESS_NOT_DENIED");
    console.log("[OK] El acceso anonimo al bucket esta bloqueado.");

    uploadMayExist = true;
    const uploaded = await fetch(upload.url, {
      method: "PUT",
      headers: uploadHeaders,
      body: payload
    });
    await uploaded.body?.cancel();
    strictEqual(uploaded.ok, true, `UPLOAD_FAILED_${uploaded.status}`);
    await storage.assertUploaded(key, payload.byteLength, checksumHex);
    console.log("[OK] Carga firmada e integridad SHA-256 verificadas.");

    const replay = await fetch(upload.url, {
      method: "PUT",
      headers: uploadHeaders,
      body: payload
    });
    await replay.body?.cancel();
    strictEqual(replay.status, 412, "UPLOAD_REPLAY_NOT_REJECTED");
    console.log("[OK] Reutilizar la autorizacion de carga devuelve 412.");

    const downloadUrl = await storage.presignDownload(key, 60);
    const downloaded = await fetch(downloadUrl);
    strictEqual(downloaded.ok, true, `DOWNLOAD_FAILED_${downloaded.status}`);
    strictEqual(
      downloaded.headers.get("cache-control"),
      "private, no-store, max-age=0",
      "DOWNLOAD_CACHE_POLICY_MISMATCH"
    );
    const downloadedBytes = Buffer.from(await downloaded.arrayBuffer());
    strictEqual(downloadedBytes.equals(payload), true, "DOWNLOAD_BYTES_MISMATCH");
    console.log("[OK] Descarga privada sin cache y bytes identicos.");

    await storage.delete(key);
    uploadMayExist = false;
    const versions = await client.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key })
    );
    const remaining = [
      ...(versions.Versions ?? []),
      ...(versions.DeleteMarkers ?? [])
    ].filter((entry) => entry.Key === key);
    strictEqual(remaining.length, 0, "OBJECT_VERSIONS_REMAIN_AFTER_PURGE");

    const afterPurge = await fetch(downloadUrl);
    await afterPurge.body?.cancel();
    strictEqual(afterPurge.status, 404, "PURGED_OBJECT_STILL_READABLE");
    console.log("[OK] Purga permanente: cero versiones y descarga 404.");
  } finally {
    if (uploadMayExist) {
      await storage.delete(key);
    }
    client.destroy();
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`MISSING_${name}`);
  }
  return value;
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const metadata = (error as { $metadata?: { httpStatusCode?: number } })
    .$metadata;
  return metadata?.httpStatusCode;
}

function safeErrorSummary(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "UNKNOWN";
  }
  const name = (error as { name?: unknown }).name;
  const status = httpStatus(error);
  const message = (error as { message?: unknown }).message;
  const assertionCode =
    typeof message === "string"
      ? message.match(/^[A-Z][A-Z0-9_]+/)?.[0]
      : undefined;
  return `${assertionCode ?? (typeof name === "string" ? name : "Error")}${
    status ? `_HTTP_${status}` : ""
  }`;
}

void checkObjectStorage().catch((error: unknown) => {
  console.error(
    `[ERROR] Fallo la comprobacion integral del almacenamiento (${safeErrorSummary(error)}).`
  );
  process.exitCode = 1;
});
