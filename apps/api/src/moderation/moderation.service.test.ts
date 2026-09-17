import { equal, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import { AssignmentsService } from "../assignments/assignments.service";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import { PrismaService } from "../database/prisma.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import { EvidenceGrantService } from "./evidence-grant.service";
import { ModerationService } from "./moderation.service";

describe("ModerationService", () => {
  it("firma la evidencia con el mismo reloj DB que origina su grant", async () => {
    const clientUserId = "11111111-1111-4111-8111-111111111111";
    const assignmentId = "22222222-2222-4222-8222-222222222222";
    const conversationId = "33333333-3333-4333-8333-333333333333";
    const investigationKeyId = "44444444-4444-4444-8444-444444444444";
    const databaseNow = new Date("2026-08-02T16:04:05.000Z");
    const grantExpiresAt = databaseNow.getTime() + 10 * 60_000;
    let grantClock: Date | undefined;
    let signingDate: Date | undefined;
    let persistedGrantExpiresAt: Date | undefined;
    const grant = {
      version: 1 as const,
      reservationId: "55555555-5555-4555-8555-555555555555",
      clientUserId,
      assignmentId,
      conversationId,
      investigationKeyId,
      objectKey:
        "investigations/report-evidence/55555555-5555-4555-8555-555555555555",
      ciphertextByteSize: 48,
      ciphertextSha256: "cd".repeat(32),
      cipherSuite: "X25519-AESGCM",
      manifestVersion: 1,
      expiresAt: grantExpiresAt
    };
    const prisma = {
      $queryRaw: async () => [{ now: databaseNow }],
      assignment: {
        findFirst: async () => ({
          id: assignmentId,
          conversation: { id: conversationId }
        })
      },
      investigationKey: {
        findFirst: async () => ({
          id: investigationKeyId,
          version: 1,
          algorithm: "X25519",
          publicKey: Buffer.from("public-key"),
          fingerprint: "ef".repeat(32)
        })
      },
      pendingReportEvidenceUpload: {
        findFirst: async () => null,
        create: async ({
          data
        }: {
          data: { grantExpiresAt: Date };
        }) => {
          persistedGrantExpiresAt = data.grantExpiresAt;
          return {};
        }
      }
    } as unknown as PrismaService;
    const storage = {
      presignUpload: async (
        _key: string,
        _bytes: number,
        _sha256: string,
        clock: Date
      ) => {
        signingDate = clock;
        return {
          url: "https://storage.invalid/upload",
          expiresInSeconds: 300,
          headers: {}
        };
      }
    } as unknown as ObjectStorageService;
    const evidenceGrants = {
      create: (
        _clientUserId: string,
        _assignmentId: string,
        _conversationId: string,
        _input: unknown,
        clock: Date
      ) => {
        grantClock = clock;
        return { grant, token: "evidence-grant-token" };
      }
    } as unknown as EvidenceGrantService;
    const service = new ModerationService(
      prisma,
      {} as AssignmentsService,
      storage,
      evidenceGrants,
      {} as ConversationEligibilityService
    );

    const result = await service.requestEvidenceUpload(clientUserId, {
      investigationKeyId,
      ciphertextByteSize: 48,
      ciphertextSha256: "cd".repeat(32),
      cipherSuite: "X25519-AESGCM",
      manifestVersion: 1
    });

    equal(grantClock, databaseNow);
    equal(signingDate, databaseNow);
    equal(persistedGrantExpiresAt?.getTime(), grantExpiresAt);
    equal(result.grantExpiresAt.getTime(), grantExpiresAt);
  });

  it("revierte el bloqueo si endsAt se alcanza durante la transaccion", async () => {
    const boundary = new Date("2026-08-02T18:00:00.000Z");
    let blocksCreated = 0;
    let reassignments = 0;
    const tx = {
      $queryRaw: async (query: { sql?: string }) => {
        const sql = String(query.sql ?? query);
        if (sql.includes('FROM "conversations"')) {
          return [
            {
              id: "33333333-3333-4333-8333-333333333333",
              assignmentId: "44444444-4444-4444-8444-444444444444",
              clientUserId: "11111111-1111-4111-8111-111111111111",
              cashierUserId: "22222222-2222-4222-8222-222222222222",
              subscriptionEndsAt: boundary
            }
          ];
        }
        return [{ now: boundary }];
      },
      block: {
        create: async () => {
          blocksCreated += 1;
          return { id: "55555555-5555-4555-8555-555555555555" };
        },
        findMany: async () => [
          { cashierUserId: "22222222-2222-4222-8222-222222222222" }
        ]
      }
    };
    const assignments = {
      runSerializable: async (
        operation: (transaction: typeof tx) => Promise<unknown>
      ) => operation(tx),
      reassignAfterModerationInTransaction: async () => {
        reassignments += 1;
        return {};
      }
    } as unknown as AssignmentsService;
    const eligibility = new ConversationEligibilityService(
      {} as PrismaService
    );
    const service = new ModerationService(
      {} as PrismaService,
      assignments,
      {} as ObjectStorageService,
      {} as EvidenceGrantService,
      eligibility
    );

    await rejects(() =>
      service.blockClient(
        "22222222-2222-4222-8222-222222222222",
        "11111111-1111-4111-8111-111111111111",
        { reason: "Motivo valido de bloqueo" }
      )
    );

    equal(blocksCreated, 1);
    equal(reassignments, 0);
  });
});
