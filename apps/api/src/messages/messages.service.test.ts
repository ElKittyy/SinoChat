import { deepEqual, equal, match, rejects, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { PrismaService } from "../database/prisma.service";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import {
  AccountStatus,
  MessageKind,
  UserRole
} from "../generated/prisma/enums";
import { ObjectStorageService } from "../storage/object-storage.service";
import { MessagesService } from "./messages.service";
import { UploadGrantService } from "./upload-grant.service";
import { MATRIX_MEGOLM_ALGORITHM } from "../e2ee/matrix-room-event";

const senderDeviceId = "11111111-1111-4111-8111-111111111111";
const recipientDeviceId = "22222222-2222-4222-8222-222222222222";
const secondarySenderDeviceId = "33333333-3333-4333-8333-333333333333";
const senderUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const recipientUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const senderCurve25519Key = "A".repeat(43);
const recipientCurve25519Key = "B".repeat(43);
const secondarySenderCurve25519Key = "C".repeat(43);
const senderMatrixDeviceId = "D11111111111141118111111111111111";
const recipientMatrixDeviceId = "D22222222222242228222222222222222";
const secondarySenderMatrixDeviceId = "D33333333333343338333333333333333";
const megolmSessionId = Buffer.alloc(32, 4)
  .toString("base64")
  .replace(/=+$/u, "");
const megolmCiphertext = Buffer.alloc(64, 5)
  .toString("base64")
  .replace(/=+$/u, "");

function encodedMegolmEnvelope(
  overrides: Record<string, unknown> = {}
): string {
  return Buffer.from(
    JSON.stringify({
      algorithm: MATRIX_MEGOLM_ALGORITHM,
      ciphertext: megolmCiphertext,
      device_id: senderMatrixDeviceId,
      sender_key: senderCurve25519Key,
      session_id: megolmSessionId,
      ...overrides
    }),
    "utf8"
  ).toString("base64");
}

function validMessageEnvelopes() {
  return [
    {
      recipientDeviceId: senderDeviceId,
      protocolVersion: "matrix-megolm-v1",
      cipherSuite: MATRIX_MEGOLM_ALGORITHM,
      ciphertext: encodedMegolmEnvelope()
    },
    {
      recipientDeviceId,
      protocolVersion: "matrix-megolm-v1",
      cipherSuite: MATRIX_MEGOLM_ALGORITHM,
      ciphertext: encodedMegolmEnvelope()
    }
  ];
}

function activeMatrixDevices() {
  return [
    {
      id: senderDeviceId,
      userId: senderUserId,
      matrixDeviceId: senderMatrixDeviceId,
      protocolVersion: "matrix-olm-v1",
      curve25519Key: senderCurve25519Key
    },
    {
      id: recipientDeviceId,
      userId: recipientUserId,
      matrixDeviceId: recipientMatrixDeviceId,
      protocolVersion: "matrix-olm-v1",
      curve25519Key: recipientCurve25519Key
    }
  ];
}

function renderedSql(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join("?");
  }
  if (value && typeof value === "object" && "sql" in value) {
    return String(value.sql);
  }
  return String(value);
}

function sqlValues(value: unknown): unknown[] {
  if (
    value &&
    typeof value === "object" &&
    "values" in value &&
    Array.isArray(value.values)
  ) {
    return value.values;
  }
  return [];
}

function conversationRow(index: number) {
  return {
    id: `conversation-${index}`,
    participantId: `participant-${index}`,
    participantUsername: `usuario-${index}`,
    participantStatus: AccountStatus.ACTIVE,
    assignedAt: new Date(`2026-08-${String(index).padStart(2, "0")}T10:00:00.000Z`),
    unreadCount: BigInt(index),
    lastKind: MessageKind.TEXT,
    lastCreatedAt: new Date(`2026-08-${String(index).padStart(2, "0")}T11:00:00.000Z`),
    lastServerSequence: BigInt(index * 10)
  };
}

function assertCurrentCashierEligibility(sql: string): void {
  match(sql, /cashier_subscriptions/);
  match(sql, /approval_status[^]*APPROVED/);
  match(sql, /email_verified_at[^]*IS NOT NULL/);
  match(sql, /phone_verified_at[^]*IS NOT NULL/);
  match(sql, /cashier_user[^]*role[^]*CASHIER/);
  match(sql, /cashier_user[^]*status[^]*ACTIVE/);
  match(sql, /cashier_user[^]*password_reset_required[^]*FALSE/);
  match(sql, /client_user[^]*role[^]*CLIENT/);
  match(sql, /client_user[^]*status[^]*ACTIVE/);
  match(sql, /starts_at[^]*current_clock/);
  match(sql, /ends_at[^]*current_clock/);
}

describe("MessagesService", () => {
  it("acepta solo ciphertext Megolm exacto ligado al dispositivo emisor", () => {
    const service = new MessagesService(
      {} as PrismaService,
      {} as ObjectStorageService,
      {} as UploadGrantService,
      {} as ConversationEligibilityService
    );
    const validate = (
      envelopes: ReturnType<typeof validMessageEnvelopes>
    ) =>
      (
        service as unknown as {
          assertCompleteEnvelopes(
            input: unknown,
            devices: ReturnType<typeof activeMatrixDevices>
          ): void;
        }
      ).assertCompleteEnvelopes(
        {
          clientMessageId: "33333333-3333-4333-8333-333333333333",
          senderDeviceId,
          kind: MessageKind.TEXT,
          envelopes
        },
        activeMatrixDevices()
      );

    validate(validMessageEnvelopes());

    const wrongSuite = validMessageEnvelopes();
    wrongSuite[0]!.cipherSuite = "cifrado-inventado";
    throws(() => validate(wrongSuite), /dispositivos activos/);

    const wrongDevice = validMessageEnvelopes();
    const wrongDeviceCiphertext = encodedMegolmEnvelope({
      device_id: recipientMatrixDeviceId
    });
    wrongDevice[0]!.ciphertext = wrongDeviceCiphertext;
    wrongDevice[1]!.ciphertext = wrongDeviceCiphertext;
    throws(() => validate(wrongDevice), /dispositivos declarados/);

    const wrongSender = validMessageEnvelopes();
    const wrongSenderCiphertext = encodedMegolmEnvelope({
      sender_key: Buffer.alloc(32, 7)
        .toString("base64")
        .replace(/=+$/u, "")
    });
    wrongSender[0]!.ciphertext = wrongSenderCiphertext;
    wrongSender[1]!.ciphertext = wrongSenderCiphertext;
    throws(() => validate(wrongSender), /dispositivos declarados/);

    const legacySenderDevices = activeMatrixDevices();
    legacySenderDevices[0]!.protocolVersion = "legacy-v0";
    throws(
      () =>
        (
          service as unknown as {
            assertCompleteEnvelopes(input: unknown, devices: unknown[]): void;
          }
        ).assertCompleteEnvelopes(
          {
            clientMessageId: "33333333-3333-4333-8333-333333333333",
            senderDeviceId,
            kind: MessageKind.TEXT,
            envelopes: validMessageEnvelopes()
          },
          legacySenderDevices
        ),
      /dispositivo emisor no usa el protocolo E2EE vigente/
    );
  });

  it("exige una copia Megolm identica para cada dispositivo activo", () => {
    const service = new MessagesService(
      {} as PrismaService,
      {} as ObjectStorageService,
      {} as UploadGrantService,
      {} as ConversationEligibilityService
    );
    const devices = [
      ...activeMatrixDevices(),
      {
        id: secondarySenderDeviceId,
        userId: senderUserId,
        matrixDeviceId: secondarySenderMatrixDeviceId,
        protocolVersion: "matrix-olm-v1",
        curve25519Key: secondarySenderCurve25519Key
      }
    ];
    const otherOwnEnvelope = {
      recipientDeviceId: secondarySenderDeviceId,
      protocolVersion: "matrix-megolm-v1",
      cipherSuite: MATRIX_MEGOLM_ALGORITHM,
      ciphertext: encodedMegolmEnvelope()
    };
    const validate = (
      envelopes: ReturnType<typeof validMessageEnvelopes>,
      kind: MessageKind = MessageKind.TEXT
    ) =>
      (
        service as unknown as {
          assertCompleteEnvelopes(input: unknown, devices: unknown[]): void;
        }
      ).assertCompleteEnvelopes(
        {
          clientMessageId: "44444444-4444-4444-8444-444444444444",
          senderDeviceId,
          kind,
          envelopes
        },
        devices
      );

    validate([...validMessageEnvelopes(), otherOwnEnvelope]);
    validate(
      [...validMessageEnvelopes(), otherOwnEnvelope],
      MessageKind.IMAGE
    );

    throws(
      () => validate([validMessageEnvelopes()[1]!, otherOwnEnvelope]),
      /todos los dispositivos activos/
    );
    throws(
      () => validate(validMessageEnvelopes()),
      /todos los dispositivos activos/
    );
    throws(
      () => validate([validMessageEnvelopes()[0]!, otherOwnEnvelope]),
      /todos los dispositivos activos/
    );
    const differentCiphertext = encodedMegolmEnvelope({
      ciphertext: Buffer.alloc(64, 6)
        .toString("base64")
        .replace(/=+$/u, "")
    });
    throws(
      () =>
        validate([
          ...validMessageEnvelopes(),
          { ...otherOwnEnvelope, ciphertext: differentCiphertext }
        ]),
      /debe ser idéntico/
    );
    throws(
      () =>
        (
          service as unknown as {
            assertCompleteEnvelopes(input: unknown, devices: unknown[]): void;
          }
        ).assertCompleteEnvelopes(
          {
            clientMessageId: "55555555-5555-4555-8555-555555555555",
            senderDeviceId,
            kind: MessageKind.TEXT,
            envelopes: [validMessageEnvelopes()[0]!, otherOwnEnvelope]
          },
          [devices[0], devices[2]]
        ),
      /contraparte debe configurar un dispositivo seguro/
    );
  });

  it("rechaza downgrade, campos extra y Base64 no canonico en MessageEnvelope", () => {
    const service = new MessagesService(
      {} as PrismaService,
      {} as ObjectStorageService,
      {} as UploadGrantService,
      {} as ConversationEligibilityService
    );
    const validate = (ciphertext: string) =>
      (
        service as unknown as {
          assertCompleteEnvelopes(input: unknown, devices: unknown[]): void;
        }
      ).assertCompleteEnvelopes(
        {
          clientMessageId: "33333333-3333-4333-8333-333333333333",
          senderDeviceId,
          kind: MessageKind.TEXT,
          envelopes: validMessageEnvelopes().map((envelope) => ({
            ...envelope,
            ciphertext
          }))
        },
        activeMatrixDevices()
      );

    throws(
      () =>
        validate(
          encodedMegolmEnvelope({
            algorithm: "m.megolm.v1.aes-sha1"
          })
        ),
      /ciphertext Megolm/
    );
    throws(
      () =>
        validate(
          encodedMegolmEnvelope({
            contenido: "prohibido"
          })
        ),
      /ciphertext Megolm/
    );
    throws(
      () => validate(`${encodedMegolmEnvelope()}=`),
      /canónico/
    );
  });

  it("firma la foto con el mismo reloj DB que origina su grant", async () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const conversationId = "22222222-2222-4222-8222-222222222222";
    const databaseNow = new Date("2026-08-02T15:04:05.000Z");
    const grantExpiresAt = databaseNow.getTime() + 10 * 60_000;
    let grantClock: Date | undefined;
    let signingDate: Date | undefined;
    let persistedGrantExpiresAt: Date | undefined;
    const grant = {
      version: 1 as const,
      reservationId: "33333333-3333-4333-8333-333333333333",
      userId,
      conversationId,
      objectKey: "ephemeral/messages/33333333-3333-4333-8333-333333333333",
      declaredMimeType: "image/png" as const,
      plaintextByteSize: 32,
      ciphertextByteSize: 48,
      ciphertextSha256: "ab".repeat(32),
      expiresAt: grantExpiresAt
    };
    const transaction = {
      $queryRaw: async () => [{ now: databaseNow }],
      pendingAttachmentUpload: {
        count: async () => 0,
        create: async ({
          data
        }: {
          data: { grantExpiresAt: Date };
        }) => {
          persistedGrantExpiresAt = data.grantExpiresAt;
          return {};
        }
      }
    };
    const prisma = {
      $queryRaw: async () => [{ now: databaseNow }],
      $transaction: async <T>(
        operation: (client: typeof transaction) => Promise<T>
      ) => operation(transaction)
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
    const grants = {
      create: (
        _userId: string,
        _conversationId: string,
        _input: unknown,
        clock: Date
      ) => {
        grantClock = clock;
        return { grant, token: "grant-token" };
      }
    } as unknown as UploadGrantService;
    const eligibility = {
      lockCurrent: async () => ({}),
      requireCurrent: async () => ({
        id: conversationId,
        clientUserId: userId,
        cashierUserId: "44444444-4444-4444-8444-444444444444"
      })
    } as unknown as ConversationEligibilityService;
    const service = new MessagesService(
      prisma,
      storage,
      grants,
      eligibility
    );

    const result = await service.requestUpload(userId, conversationId, {
      declaredMimeType: "image/png",
      plaintextByteSize: 32,
      ciphertextByteSize: 48,
      ciphertextSha256: "ab".repeat(32)
    });

    equal(grantClock, databaseNow);
    equal(signingDate, databaseNow);
    equal(persistedGrantExpiresAt?.getTime(), grantExpiresAt);
    equal(result.grantExpiresAt.getTime(), grantExpiresAt);
  });

  it("filtra el listado con un unico reloj de PostgreSQL", async () => {
    let sql = "";
    const prisma = {
      $queryRaw: async (query: unknown) => {
        sql = renderedSql(query);
        return [];
      }
    } as unknown as PrismaService;
    const service = new MessagesService(
      prisma,
      {} as ObjectStorageService,
      {} as UploadGrantService,
      new ConversationEligibilityService(prisma)
    );

    await service.listConversations("00000000-0000-4000-8000-000000000001", UserRole.CLIENT, {
      page: 1,
      limit: 20
    });

    assertCurrentCashierEligibility(sql);
    match(sql, /clock_timestamp/);
  });

  it("expone exclusivamente metadatos de cada conversacion", async () => {
    const row = {
      ...conversationRow(1),
      lastKind: MessageKind.IMAGE,
      ciphertext: Buffer.from("contenido-secreto"),
      content: "texto que nunca debe salir",
      envelopes: [{ ciphertext: "sobre-cifrado" }],
      messages: [{ content: "mensaje" }]
    };
    const prisma = {
      $queryRaw: async () => [row]
    } as unknown as PrismaService;
    const service = new MessagesService(
      prisma,
      {} as ObjectStorageService,
      {} as UploadGrantService,
      new ConversationEligibilityService(prisma)
    );

    const result = await service.listConversations(
      "00000000-0000-4000-8000-000000000001",
      UserRole.CASHIER,
      { page: 1, limit: 20 }
    );

    deepEqual(result, {
      items: [
        {
          id: "conversation-1",
          participant: {
            id: "participant-1",
            username: "usuario-1",
            status: AccountStatus.ACTIVE
          },
          assignedAt: row.assignedAt,
          unreadCount: 1,
          lastMessage: {
            kind: MessageKind.IMAGE,
            createdAt: row.lastCreatedAt,
            serverSequence: "10"
          }
        }
      ],
      page: 1,
      limit: 20,
      hasMore: false
    });
    equal("ciphertext" in result.items[0], false);
    equal("content" in result.items[0], false);
    equal("envelopes" in result.items[0], false);
    equal("messages" in result.items[0], false);
  });

  it("consulta limit mas uno y pagina los chats del cajero", async () => {
    let values: unknown[] = [];
    const prisma = {
      $queryRaw: async (query: unknown) => {
        values = sqlValues(query);
        return [conversationRow(1), conversationRow(2), conversationRow(3)];
      }
    } as unknown as PrismaService;
    const service = new MessagesService(
      prisma,
      {} as ObjectStorageService,
      {} as UploadGrantService,
      new ConversationEligibilityService(prisma)
    );

    const result = await service.listConversations(
      "00000000-0000-4000-8000-000000000001",
      UserRole.CASHIER,
      { page: 3, limit: 2 }
    );

    deepEqual(values.slice(-2), [3, 4]);
    deepEqual(result.items.map((item) => item.id), [
      "conversation-1",
      "conversation-2"
    ]);
    equal(result.page, 3);
    equal(result.limit, 2);
    equal(result.hasMore, true);
  });

  it("fuerza pagina uno y limite uno para el cliente", async () => {
    let values: unknown[] = [];
    const prisma = {
      $queryRaw: async (query: unknown) => {
        values = sqlValues(query);
        return [conversationRow(1), conversationRow(2)];
      }
    } as unknown as PrismaService;
    const service = new MessagesService(
      prisma,
      {} as ObjectStorageService,
      {} as UploadGrantService,
      new ConversationEligibilityService(prisma)
    );

    const result = await service.listConversations(
      "00000000-0000-4000-8000-000000000001",
      UserRole.CLIENT,
      { page: 9, limit: 75 }
    );

    deepEqual(values.slice(-2), [1, 0]);
    deepEqual(result.items.map((item) => item.id), ["conversation-1"]);
    equal(result.page, 1);
    equal(result.limit, 1);
    equal(result.hasMore, false);
  });

  it("rechaza requireActiveConversation si la consulta elegible no devuelve fila", async () => {
    let sql = "";
    const prisma = {
      $queryRaw: async (query: unknown) => {
        sql = renderedSql(query);
        return [];
      }
    } as unknown as PrismaService;
    const service = new MessagesService(
      prisma,
      {} as ObjectStorageService,
      {} as UploadGrantService,
      new ConversationEligibilityService(prisma)
    );

    await rejects(() =>
      service.requireActiveConversation(
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002"
      )
    );
    assertCurrentCashierEligibility(sql);
  });

  it("bloquea filas de elegibilidad junto con conversacion y asignacion", async () => {
    let sql = "";
    const transaction = {
      $queryRaw: async (query: unknown) => {
        sql = renderedSql(query);
        return [];
      }
    };
    const service = new MessagesService(
      {} as PrismaService,
      {} as ObjectStorageService,
      {} as UploadGrantService,
      new ConversationEligibilityService({} as PrismaService)
    );

    await rejects(() =>
      (
        service as unknown as {
          lockActiveConversation(
            tx: unknown,
            userId: string,
            conversationId: string
          ): Promise<void>;
        }
      ).lockActiveConversation(
        transaction,
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002"
      )
    );

    assertCurrentCashierEligibility(sql);
    match(
      sql,
      /FOR SHARE OF c, a, cp, cashier_user, client_user, cs/
    );
  });

  it("incluye elegibilidad tanto al actualizar como al releer recibos", async () => {
    const statements: string[] = [];
    const prisma = {
      $queryRaw: async (query: unknown) => {
        statements.push(renderedSql(query));
        return [];
      }
    } as unknown as PrismaService;
    const service = new MessagesService(
      prisma,
      {} as ObjectStorageService,
      {} as UploadGrantService,
      new ConversationEligibilityService(prisma)
    );

    await rejects(() =>
      service.updateReceipt(
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
        { status: "READ" }
      )
    );
    for (const sql of statements) {
      assertCurrentCashierEligibility(sql);
    }
  });
});
