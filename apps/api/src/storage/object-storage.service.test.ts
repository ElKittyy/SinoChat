import {
  DeleteObjectsCommand,
  GetBucketVersioningCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { deepEqual, equal, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import { ObjectStorageService } from "./object-storage.service";

describe("ObjectStorageService", () => {
  it("firma PUT de una sola escritura para impedir reemplazos y replays", async () => {
    const databaseNow = new Date("2026-08-02T15:04:05.000Z");
    const client = new S3Client({
      endpoint: "https://storage.example.invalid",
      forcePathStyle: true,
      region: "test-1",
      credentials: {
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key"
      }
    });
    const service = configuredService(client, "disabled");

    const result = await service.presignUpload(
      "ephemeral/photo",
      42,
      "ab".repeat(32),
      databaseNow
    );
    const signedUrl = new URL(result.url);
    const signedHeaders = signedUrl.searchParams.get(
      "X-Amz-SignedHeaders"
    );

    equal((result.headers as Record<string, unknown>)["if-none-match"], "*");
    equal(signedHeaders?.split(";").includes("if-none-match"), true);
    equal(signedUrl.searchParams.get("X-Amz-Date"), "20260802T150405Z");
  });

  it("relista desde el inicio hasta purgar todas las versiones de la clave exacta", async () => {
    const commands: object[] = [];
    const remaining = new Map([
      ["v2", "version"],
      ["marker", "marker"],
      ["v1", "version"]
    ]);
    const client = {
      send: async (command: object) => {
        commands.push(command);
        if (command instanceof ListObjectVersionsCommand) {
          const page = [...remaining.entries()].slice(0, 2);
          return {
            IsTruncated: remaining.size > page.length,
            Versions: [
              ...page
                .filter(([, kind]) => kind === "version")
                .map(([versionId]) => ({
                  Key: "ephemeral/photo",
                  VersionId: versionId
                })),
              {
                Key: "ephemeral/photo-preview",
                VersionId: "other"
              }
            ],
            DeleteMarkers: page
              .filter(([, kind]) => kind === "marker")
              .map(([versionId]) => ({
                Key: "ephemeral/photo",
                VersionId: versionId
              }))
          };
        }
        if (command instanceof DeleteObjectsCommand) {
          for (const object of command.input.Delete?.Objects ?? []) {
            if (object.VersionId) {
              remaining.delete(object.VersionId);
            }
          }
          return {};
        }
        throw new Error("Comando inesperado");
      }
    } as unknown as S3Client;
    const service = configuredService(client, "purge-all");

    await service.delete("ephemeral/photo");

    const deletions = commands
      .filter(
        (command): command is DeleteObjectsCommand =>
          command instanceof DeleteObjectsCommand
      )
      .map((command) => command.input.Delete?.Objects);
    deepEqual(deletions, [
      [
        { Key: "ephemeral/photo", VersionId: "v2" },
        { Key: "ephemeral/photo", VersionId: "marker" }
      ],
      [{ Key: "ephemeral/photo", VersionId: "v1" }]
    ]);
    deepEqual([...remaining], []);
    for (const command of commands) {
      if (command instanceof ListObjectVersionsCommand) {
        equal(command.input.KeyMarker, undefined);
        equal(command.input.VersionIdMarker, undefined);
        equal(command.input.MaxKeys, 1_000);
      }
    }
  });

  it("reanuda una purga versionada desde lo que quedó tras un fallo parcial", async () => {
    const remaining = new Set(["v2", "v1"]);
    let deletionAttempt = 0;
    const client = {
      send: async (command: object) => {
        if (command instanceof ListObjectVersionsCommand) {
          const versionId = remaining.values().next().value as
            | string
            | undefined;
          return {
            IsTruncated: remaining.size > 1,
            Versions: versionId
              ? [{ Key: "ephemeral/photo", VersionId: versionId }]
              : []
          };
        }
        if (command instanceof DeleteObjectsCommand) {
          deletionAttempt += 1;
          if (deletionAttempt === 2) {
            throw new Error("simulated-storage-outage");
          }
          for (const object of command.input.Delete?.Objects ?? []) {
            if (object.VersionId) {
              remaining.delete(object.VersionId);
            }
          }
          return {};
        }
        throw new Error("Comando inesperado");
      }
    } as unknown as S3Client;
    const service = configuredService(client, "purge-all");

    await rejects(
      service.delete("ephemeral/photo"),
      /simulated-storage-outage/
    );
    deepEqual([...remaining], ["v1"]);

    await service.delete("ephemeral/photo");

    deepEqual([...remaining], []);
  });

  it("falla reintentable si el backend no hace visible ningun borrado", async () => {
    const client = {
      send: async (command: object) => {
        if (command instanceof ListObjectVersionsCommand) {
          return {
            Versions: [
              { Key: "ephemeral/photo", VersionId: "stuck-version" }
            ]
          };
        }
        if (command instanceof DeleteObjectsCommand) {
          return {};
        }
        throw new Error("Comando inesperado");
      }
    } as unknown as S3Client;
    const service = configuredService(client, "purge-all");

    await rejects(
      service.delete("ephemeral/photo"),
      /OBJECT_VERSION_DELETE_NOT_VISIBLE/
    );
  });

  it("rechaza un objeto sin la política no-store exacta", async () => {
    const checksumHex = "ab".repeat(32);
    const client = {
      send: async (command: object) => {
        equal(command instanceof HeadObjectCommand, true);
        return {
          ContentLength: 42,
          ContentType: "application/octet-stream",
          CacheControl: "private, max-age=60",
          ChecksumSHA256: Buffer.from(checksumHex, "hex").toString(
            "base64"
          )
        };
      }
    } as unknown as S3Client;
    const service = configuredService(client, "disabled");

    await rejects(
      service.assertUploaded("ephemeral/photo", 42, checksumHex),
      /verificaci/
    );
  });

  it("falla cerrado si disabled apunta a un bucket versionado", async () => {
    const previousEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const client = {
        send: async (command: object) => {
          equal(command instanceof GetBucketVersioningCommand, true);
          return { Status: "Enabled" };
        }
      } as unknown as S3Client;
      const service = configuredService(client, "disabled");

      await rejects(
        service.assertProductionConfiguration(),
        /nunca haya habilitado versionado/
      );
    } finally {
      if (previousEnvironment === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousEnvironment;
      }
    }
  });
});

function configuredService(
  client: S3Client,
  versioningMode: "disabled" | "purge-all"
): ObjectStorageService {
  const service = new ObjectStorageService();
  (
    service as unknown as {
      configuration: {
        bucket: string;
        client: S3Client;
        versioningMode: "disabled" | "purge-all";
      };
    }
  ).configuration = {
    bucket: "sinochat-test",
    client,
    versioningMode
  };
  return service;
}
