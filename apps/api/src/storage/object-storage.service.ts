import {
  DeleteObjectsCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetBucketVersioningCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  Injectable,
  ServiceUnavailableException
} from "@nestjs/common";
import { readObjectStorageForcePathStyle } from "../config/runtime-config";

interface StorageConfiguration {
  bucket: string;
  client: S3Client;
  versioningMode: "disabled" | "purge-all";
}

const PRIVATE_NO_STORE = "private, no-store, max-age=0";
const MAX_VERSION_PURGE_BATCHES = 10_000;

@Injectable()
export class ObjectStorageService {
  private configuration?: StorageConfiguration;
  private productionVerification?: Promise<void>;

  async presignUpload(
    key: string,
    ciphertextBytes: number,
    ciphertextSha256Hex: string,
    signingDate: Date
  ): Promise<{ url: string; expiresInSeconds: number; headers: object }> {
    const { client, bucket } = this.getConfiguration();
    const expiresInSeconds = 5 * 60;
    const checksumBase64 = Buffer.from(
      ciphertextSha256Hex,
      "hex"
    ).toString("base64");

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: "application/octet-stream",
      CacheControl: PRIVATE_NO_STORE,
      ContentLength: ciphertextBytes,
      ChecksumSHA256: checksumBase64,
      // A presigned PUT is otherwise reusable until its signature expires.
      // Keeping the key present and requiring non-existence prevents a replay
      // from replacing evidence or an attachment that was already verified.
      IfNoneMatch: "*"
    });

    return {
      url: await getSignedUrl(client, command, {
        expiresIn: expiresInSeconds,
        signingDate,
        signableHeaders: new Set([
          "cache-control",
          "content-length",
          "content-type",
          "if-none-match",
          "x-amz-checksum-sha256"
        ])
      }),
      expiresInSeconds,
      headers: {
        "cache-control": PRIVATE_NO_STORE,
        "content-length": ciphertextBytes,
        "content-type": "application/octet-stream",
        "if-none-match": "*",
        "x-amz-checksum-sha256": checksumBase64
      }
    };
  }

  async assertUploaded(
    key: string,
    ciphertextBytes: number,
    ciphertextSha256Hex: string
  ): Promise<void> {
    const { client, bucket } = this.getConfiguration();
    const result = await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
        ChecksumMode: "ENABLED"
      })
    );

    const expectedChecksum = Buffer.from(
      ciphertextSha256Hex,
      "hex"
    ).toString("base64");

    if (
      result.ContentLength !== ciphertextBytes ||
      result.ContentType !== "application/octet-stream" ||
      result.CacheControl !== PRIVATE_NO_STORE ||
      result.ChecksumSHA256 !== expectedChecksum
    ) {
      throw new ServiceUnavailableException(
        "La foto cifrada no superó la verificación de integridad."
      );
    }
  }

  async presignDownload(
    key: string,
    expiresInSeconds: number,
    signingDate?: Date
  ): Promise<string> {
    const { client, bucket } = this.getConfiguration();
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseCacheControl: PRIVATE_NO_STORE
      }),
      {
        expiresIn: Math.max(1, Math.min(60, expiresInSeconds)),
        ...(signingDate ? { signingDate } : {})
      }
    );
  }

  async delete(key: string): Promise<void> {
    const {
      client,
      bucket,
      versioningMode
    } = this.getConfiguration();

    if (versioningMode === "purge-all") {
      let previousBatchFingerprint: string | undefined;
      for (let batch = 0; batch < MAX_VERSION_PURGE_BATCHES; batch += 1) {
        // Volvemos a listar desde el inicio despues de cada borrado. Los
        // marcadores de una pagina describen el conjunto anterior al delete;
        // reutilizarlos despues de mutarlo puede saltar versiones en backends
        // compatibles con S3. Relistar tambien funciona como verificacion de
        // que la clave exacta ya no conserva versiones ni delete markers.
        const page = await client.send(
          new ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: key,
            MaxKeys: 1_000
          })
        );
        const versions = [
          ...(page.Versions ?? []),
          ...(page.DeleteMarkers ?? [])
        ]
          .filter(
            (version) =>
              version.Key === key && Boolean(version.VersionId)
          )
          .map((version) => ({
            Key: key,
            VersionId: version.VersionId
          }));
        if (versions.length === 0) {
          return;
        }
        const fingerprint = versions
          .map((version) => `${version.Key}\0${version.VersionId}`)
          .sort()
          .join("\n");
        if (fingerprint === previousBatchFingerprint) {
          throw new Error("OBJECT_VERSION_DELETE_NOT_VISIBLE");
        }
        previousBatchFingerprint = fingerprint;

        const removed = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Objects: versions,
              Quiet: true
            }
          })
        );
        if (removed.Errors?.length) {
          throw new Error(
            `OBJECT_VERSION_DELETE_FAILED:${removed.Errors[0]?.Code ?? "UNKNOWN"}`
          );
        }
      }
      throw new Error("OBJECT_VERSION_PURGE_LIMIT_REACHED");
    }

    // En modo disabled, el contrato operativo prohíbe versiones históricas.
    await client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key
      })
    );
  }

  async assertProductionConfiguration(): Promise<void> {
    if (process.env.NODE_ENV !== "production") {
      return;
    }
    this.productionVerification ??=
      this.verifyProductionBucketConfiguration();
    await this.productionVerification;
  }

  private async verifyProductionBucketConfiguration(): Promise<void> {
    const { bucket, client, versioningMode } =
      this.getConfiguration();
    const versioning = await client.send(
      new GetBucketVersioningCommand({ Bucket: bucket })
    );

    if (
      versioningMode === "disabled" &&
      versioning.Status !== undefined
    ) {
      throw new Error(
        "El modo disabled exige un bucket que nunca haya habilitado versionado."
      );
    }
    if (versioningMode === "purge-all") {
      await client.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: "__sinochat_versioning_capability_probe__",
          MaxKeys: 1
        })
      );
    }
  }

  private getConfiguration(): StorageConfiguration {
    if (this.configuration) {
      return this.configuration;
    }

    const endpoint = process.env.OBJECT_STORAGE_ENDPOINT;
    const bucket = process.env.OBJECT_STORAGE_BUCKET;
    const accessKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY_ID;
    const secretAccessKey = process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
    const region = process.env.OBJECT_STORAGE_REGION ?? "auto";
    const configuredVersioningMode =
      process.env.OBJECT_STORAGE_VERSIONING_MODE?.trim();
    const versioningMode =
      configuredVersioningMode ||
      (process.env.NODE_ENV === "production" ? undefined : "disabled");

    if (
      !endpoint ||
      !bucket ||
      !accessKeyId ||
      !secretAccessKey ||
      !versioningMode
    ) {
      throw new ServiceUnavailableException(
        "El almacenamiento privado de fotos no está configurado."
      );
    }
    if (
      versioningMode !== "disabled" &&
      versioningMode !== "purge-all"
    ) {
      throw new Error(
        "OBJECT_STORAGE_VERSIONING_MODE debe ser disabled o purge-all."
      );
    }

    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      throw new Error("OBJECT_STORAGE_ENDPOINT debe ser una URL válida.");
    }

    if (
      process.env.NODE_ENV === "production" &&
      parsedEndpoint.protocol !== "https:"
    ) {
      throw new Error(
        "OBJECT_STORAGE_ENDPOINT debe usar HTTPS en producción."
      );
    }

    this.configuration = {
      bucket,
      versioningMode,
      client: new S3Client({
        endpoint: parsedEndpoint.toString(),
        forcePathStyle: readObjectStorageForcePathStyle(process.env),
        region,
        maxAttempts: 3,
        requestHandler: new NodeHttpHandler({
          connectionTimeout: 5_000,
          requestTimeout: 15_000,
          socketTimeout: 15_000,
          throwOnRequestTimeout: true
        }),
        credentials: {
          accessKeyId,
          secretAccessKey
        }
      })
    };
    return this.configuration;
  }
}
