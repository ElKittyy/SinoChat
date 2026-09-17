import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import {
  AccountStatus,
  AttachmentUploadStatus,
  MessageDeliveryStatus,
  MessageKind,
  NotificationType,
  UserRole
} from "../generated/prisma/enums";
import { Prisma } from "../generated/prisma/client";
import { ObjectStorageService } from "../storage/object-storage.service";
import type { ListConversationsQueryDto } from "./dto/list-conversations-query.dto";
import type { ListMessagesQueryDto } from "./dto/list-messages-query.dto";
import type { MessageReceiptDto } from "./dto/message-receipt.dto";
import type { RequestUploadDto } from "./dto/request-upload.dto";
import type { SendMessageDto } from "./dto/send-message.dto";
import {
  UploadGrantService,
  type UploadGrant
} from "./upload-grant.service";
import {
  MATRIX_MEGOLM_ALGORITHM,
  MatrixRoomEventValidationError,
  parseMatrixMegolmRoomContent
} from "../e2ee/matrix-room-event";

const MAX_ENVELOPE_BYTES = 128 * 1024;
const MAX_PENDING_ATTACHMENTS_PER_USER = 4;
const MATRIX_DEVICE_PROTOCOL_VERSION = "matrix-olm-v1";
const MATRIX_MESSAGE_PROTOCOL_VERSION = "matrix-megolm-v1";
const MATRIX_ATTACHMENT_CIPHER_SUITE = "A256CTR";

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
    private readonly uploadGrants: UploadGrantService,
    private readonly eligibility: ConversationEligibilityService
  ) {}

  async listConversations(
    userId: string,
    role: UserRole,
    query: ListConversationsQueryDto
  ) {
    const take = role === UserRole.CLIENT ? 1 : query.limit;
    const skip = role === UserRole.CLIENT ? 0 : (query.page - 1) * take;
    type ConversationRow = {
      id: string;
      participantId: string;
      participantUsername: string;
      participantStatus: AccountStatus;
      assignedAt: Date;
      unreadCount: bigint;
      lastKind: MessageKind | null;
      lastCreatedAt: Date | null;
      lastServerSequence: bigint | null;
    };
    const requestedRows = role === UserRole.CLIENT ? 1 : take + 1;
    const rows = await this.prisma.$queryRaw<ConversationRow[]>(Prisma.sql`
      WITH "current_clock" AS MATERIALIZED (
        SELECT clock_timestamp() AS "now"
      )
      SELECT
        c."id",
        participant."id" AS "participantId",
        participant."username" AS "participantUsername",
        participant."status" AS "participantStatus",
        a."started_at" AS "assignedAt",
        (
          SELECT count(*)
            FROM "messages" unread_message
            JOIN "message_receipts" unread_receipt
              ON unread_receipt."message_id" = unread_message."id"
           WHERE unread_message."conversation_id" = c."id"
             AND unread_message."expires_at" > "current_clock"."now"
             AND unread_receipt."recipient_user_id" = ${userId}::uuid
             AND unread_receipt."status" <> 'READ'
        ) AS "unreadCount",
        latest."kind" AS "lastKind",
        latest."created_at" AS "lastCreatedAt",
        latest."server_sequence" AS "lastServerSequence"
        FROM "conversations" c
        JOIN "assignments" a ON a."id" = c."assignment_id"
        JOIN "cashier_profiles" cp
          ON cp."user_id" = a."cashier_user_id"
        JOIN "users" cashier_user
          ON cashier_user."id" = cp."user_id"
        JOIN "users" client_user
          ON client_user."id" = a."client_user_id"
        JOIN "cashier_subscriptions" cs
          ON cs."cashier_user_id" = cp."user_id"
         AND cs."status" = 'ACTIVE'
        JOIN "users" participant
          ON participant."id" = CASE
            WHEN ${role}::"UserRole" = 'CLIENT'
              THEN a."cashier_user_id"
            ELSE a."client_user_id"
          END
        CROSS JOIN "current_clock"
        LEFT JOIN LATERAL (
          SELECT
            latest_message."kind",
            latest_message."created_at",
            latest_message."server_sequence"
            FROM "messages" latest_message
           WHERE latest_message."conversation_id" = c."id"
             AND latest_message."expires_at" > "current_clock"."now"
           ORDER BY latest_message."server_sequence" DESC
           LIMIT 1
        ) latest ON TRUE
       WHERE c."status" = 'ACTIVE'
         AND a."ended_at" IS NULL
         AND cp."approval_status" = 'APPROVED'
         AND cp."email_verified_at" IS NOT NULL
         AND cp."phone_verified_at" IS NOT NULL
         AND cashier_user."role" = 'CASHIER'
         AND cashier_user."status" = 'ACTIVE'
         AND cashier_user."password_reset_required" = FALSE
         AND client_user."role" = 'CLIENT'
         AND client_user."status" = 'ACTIVE'
         AND cs."starts_at" <= "current_clock"."now"
         AND (cs."ends_at" IS NULL OR cs."ends_at" > "current_clock"."now")
         AND (
           (${role}::"UserRole" = 'CLIENT' AND a."client_user_id" = ${userId}::uuid)
           OR
           (${role}::"UserRole" = 'CASHIER' AND a."cashier_user_id" = ${userId}::uuid)
       )
       ORDER BY c."created_at" DESC, c."id" DESC
       LIMIT ${requestedRows}
       OFFSET ${skip}
    `);
    const hasMore = role !== UserRole.CLIENT && rows.length > take;
    const items = rows.slice(0, take).map((row) => ({
      id: row.id,
      participant: {
        id: row.participantId,
        username: row.participantUsername,
        status: row.participantStatus
      },
      assignedAt: row.assignedAt,
      unreadCount: Number(row.unreadCount),
      lastMessage:
        row.lastKind && row.lastCreatedAt && row.lastServerSequence !== null
          ? {
              kind: row.lastKind,
              createdAt: row.lastCreatedAt,
              serverSequence: row.lastServerSequence.toString()
            }
          : null
    }));

    return {
      items,
      page: role === UserRole.CLIENT ? 1 : query.page,
      limit: take,
      hasMore
    };
  }

  async requestUpload(
    userId: string,
    conversationId: string,
    input: RequestUploadDto
  ) {
    const now = await this.databaseNow();
    const { grant, token } = this.uploadGrants.create(
      userId,
      conversationId,
      input,
      now
    );
    await this.prisma.$transaction(async (transaction) => {
      await this.lockActiveConversation(
        transaction,
        userId,
        conversationId
      );
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            'sinochat:pending-attachments:' || ${userId}::text,
            0
          )
        )
      `;
      const clockRows = await transaction.$queryRaw<{ now: Date }[]>`
        SELECT clock_timestamp() AS "now"
      `;
      const transactionNow = clockRows[0]?.now;
      if (!transactionNow) {
        throw new Error("No se pudo consultar el reloj de PostgreSQL.");
      }
      const pending =
        await transaction.pendingAttachmentUpload.count({
          where: {
            userId,
            grantExpiresAt: { gt: transactionNow },
            lastPurgeAttemptAt: null
          }
        });
      if (pending >= MAX_PENDING_ATTACHMENTS_PER_USER) {
        throw new ConflictException(
          "Ya alcanzaste el límite de fotos pendientes."
        );
      }

      await transaction.pendingAttachmentUpload.create({
        data: {
          id: grant.reservationId,
          userId,
          conversationId,
          objectKey: grant.objectKey,
          declaredMimeType: grant.declaredMimeType,
          plaintextByteSize: grant.plaintextByteSize,
          ciphertextByteSize: grant.ciphertextByteSize,
          ciphertextSha256: grant.ciphertextSha256,
          grantExpiresAt: new Date(grant.expiresAt)
        }
      });
      // Revalida con un reloj nuevo de PostgreSQL antes del commit. Esto
      // revierte la reserva si el periodo termino durante la operacion.
      await this.lockActiveConversation(
        transaction,
        userId,
        conversationId
      );
    });
    const upload = await this.storage.presignUpload(
      grant.objectKey,
      grant.ciphertextByteSize,
      grant.ciphertextSha256,
      now
    );
    // No entrega una URL generada si la elegibilidad vencio mientras el
    // proveedor de objetos firmaba la solicitud.
    await this.requireActiveConversation(userId, conversationId);

    return {
      uploadUrl: upload.url,
      uploadHeaders: upload.headers,
      uploadExpiresInSeconds: upload.expiresInSeconds,
      grantToken: token,
      grantExpiresAt: new Date(grant.expiresAt)
    };
  }

  async send(
    userId: string,
    conversationId: string,
    input: SendMessageDto
  ) {
    const existing = await this.prisma.message.findUnique({
      where: {
        senderDeviceId_clientMessageId: {
          senderDeviceId: input.senderDeviceId,
          clientMessageId: input.clientMessageId
        }
      }
    });
    if (existing) {
      return this.acknowledgeExistingMessage(
        userId,
        conversationId,
        input
      );
    }

    const grant = await this.prepareAttachment(
      userId,
      conversationId,
      input
    );

    try {
      const message = await this.prisma.$transaction(async (transaction) => {
        const locked = await this.lockConversationAndDevices(
          transaction,
          userId,
          conversationId,
          input.senderDeviceId
        );
        this.assertCompleteEnvelopes(input, locked.activeDevices);
        const recipientUserId =
          locked.clientUserId === userId
            ? locked.cashierUserId
            : locked.clientUserId;

        if (grant) {
          const clockRows = await transaction.$queryRaw<{ now: Date }[]>`
            SELECT clock_timestamp() AS "now"
          `;
          const transactionNow = clockRows[0]?.now;
          if (!transactionNow) {
            throw new Error("No se pudo consultar el reloj de PostgreSQL.");
          }
          const claimed =
            await transaction.pendingAttachmentUpload.deleteMany({
              where: {
                id: grant.reservationId,
                userId,
                conversationId,
                objectKey: grant.objectKey,
                grantExpiresAt: { gt: transactionNow },
                lastPurgeAttemptAt: null
              }
            });
          if (claimed.count !== 1) {
            throw new ConflictException(
              "El permiso de la foto ya fue utilizado o venció."
            );
          }
        }

        const created = await transaction.message.create({
          data: {
            conversationId,
            senderUserId: userId,
            senderDeviceId: input.senderDeviceId,
            clientMessageId: input.clientMessageId,
            kind: input.kind,
            envelopes: {
              create: input.envelopes.map((envelope) => ({
                recipientDeviceId: envelope.recipientDeviceId,
                protocolVersion: envelope.protocolVersion,
                cipherSuite: envelope.cipherSuite,
                ciphertext: Buffer.from(envelope.ciphertext, "base64")
              }))
            },
            receipts: {
              create: {
                recipientUserId,
                status: MessageDeliveryStatus.SENT
              }
            },
            ...(grant
              ? {
                  attachment: {
                    create: {
                      objectKey: grant.objectKey,
                      declaredMimeType: grant.declaredMimeType,
                      plaintextByteSize: grant.plaintextByteSize,
                      ciphertextByteSize: grant.ciphertextByteSize,
                      ciphertextSha256: grant.ciphertextSha256,
                      cipherSuite: MATRIX_ATTACHMENT_CIPHER_SUITE,
                      status: AttachmentUploadStatus.AVAILABLE
                    }
                  }
                }
              : {})
          }
        });
        await transaction.inAppNotification.create({
          data: {
            userId: recipientUserId,
            messageId: created.id,
            type: NotificationType.NEW_MESSAGE,
            relatedEntityId: conversationId,
            expiresAt: created.expiresAt
          }
        });
        // La carga del adjunto y la escritura de sobres pueden tomar tiempo.
        // Una segunda lectura del reloj DB hace fallar toda la transaccion si
        // endsAt se alcanzo antes de finalizar el envio.
        await this.lockActiveConversation(
          transaction,
          userId,
          conversationId,
          input.senderDeviceId
        );
        return created;
      });

      return this.messageAcknowledgement(message, true);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const duplicate = await this.prisma.message.findUnique({
          where: {
            senderDeviceId_clientMessageId: {
              senderDeviceId: input.senderDeviceId,
              clientMessageId: input.clientMessageId
            }
          }
        });
        if (duplicate) {
          return this.acknowledgeExistingMessage(
            userId,
            conversationId,
            input
          );
        }
      }
      throw error;
    }
  }

  async listMessages(
    userId: string,
    conversationId: string,
    query: ListMessagesQueryDto
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await this.lockActiveConversation(
        transaction,
        userId,
        conversationId,
        query.deviceId
      );

      const clockRows = await transaction.$queryRaw<{ now: Date }[]>`
        SELECT clock_timestamp() AS "now"
      `;
      const now = clockRows[0]?.now;
      if (!now) {
        throw new Error("No se pudo consultar el reloj de PostgreSQL.");
      }

      const messages = await transaction.message.findMany({
        where: {
          conversationId,
          expiresAt: { gt: now },
          ...(query.afterSequence
            ? { serverSequence: { gt: BigInt(query.afterSequence) } }
            : {}),
          envelopes: {
            some: {
              recipientDeviceId: query.deviceId
            }
          }
        },
        orderBy: {
          serverSequence: query.afterSequence ? "asc" : "desc"
        },
        take: query.limit,
        select: {
          id: true,
          senderUserId: true,
          senderDeviceId: true,
          clientMessageId: true,
          serverSequence: true,
          kind: true,
          createdAt: true,
          expiresAt: true,
          envelopes: {
            where: { recipientDeviceId: query.deviceId },
            select: {
              protocolVersion: true,
              cipherSuite: true,
              ciphertext: true
            }
          },
          attachment: {
            select: {
              objectKey: true,
              declaredMimeType: true,
              plaintextByteSize: true,
              ciphertextByteSize: true,
              ciphertextSha256: true,
              cipherSuite: true,
              status: true
            }
          },
          receipts: {
            select: {
              recipientUserId: true,
              status: true,
              deliveredAt: true,
              readAt: true
            }
          }
        }
      });

      if (!query.afterSequence) {
        messages.reverse();
      }

      const items = await Promise.all(
        messages.map(async (message) => {
          const envelope = message.envelopes[0];
          if (!envelope) {
            throw new NotFoundException(
              "No existe un sobre cifrado para este dispositivo."
            );
          }

          let attachment = null;
          if (
            message.attachment &&
            message.attachment.status === AttachmentUploadStatus.AVAILABLE
          ) {
            const remainingSeconds = Math.floor(
              (message.expiresAt.getTime() - now.getTime()) / 1_000
            );
            if (remainingSeconds > 0) {
              attachment = {
                declaredMimeType: message.attachment.declaredMimeType,
                plaintextByteSize: message.attachment.plaintextByteSize,
                ciphertextByteSize: message.attachment.ciphertextByteSize,
                ciphertextSha256: message.attachment.ciphertextSha256,
                cipherSuite: message.attachment.cipherSuite,
                downloadUrl: await this.storage.presignDownload(
                  message.attachment.objectKey,
                  remainingSeconds,
                  now
                )
              };
            }
          }

          return {
            id: message.id,
            senderUserId: message.senderUserId,
            senderDeviceId: message.senderDeviceId,
            clientMessageId: message.clientMessageId,
            serverSequence: message.serverSequence.toString(),
            kind: message.kind,
            createdAt: message.createdAt,
            expiresAt: message.expiresAt,
            envelope: {
              protocolVersion: envelope.protocolVersion,
              cipherSuite: envelope.cipherSuite,
              ciphertext: Buffer.from(envelope.ciphertext).toString("base64")
            },
            attachment,
            receipts: message.receipts
          };
        })
      );

      // Impide devolver mensajes o URLs firmadas si la suscripcion vencio
      // durante la lectura o durante el firmado del objeto.
      await this.lockActiveConversation(
        transaction,
        userId,
        conversationId,
        query.deviceId
      );

      return {
        items,
        nextAfterSequence:
          items.at(-1)?.serverSequence ?? query.afterSequence ?? "0"
      };
    });
  }

  async updateReceipt(
    userId: string,
    messageId: string,
    input: MessageReceiptDto
  ) {
    const requested =
      input.status === "READ"
        ? MessageDeliveryStatus.READ
        : MessageDeliveryStatus.DELIVERED;
    const requestedRank =
      requested === MessageDeliveryStatus.READ ? 2 : 1;
    type ReceiptResult = {
      messageId: string;
      status: MessageDeliveryStatus;
      deliveredAt: Date | null;
      readAt: Date | null;
    };

    const updated = await this.prisma.$queryRaw<ReceiptResult[]>`
      WITH "current_clock" AS MATERIALIZED (
        SELECT clock_timestamp() AS "now"
      )
      UPDATE "message_receipts" AS r
         SET "status" = ${requested}::"MessageDeliveryStatus",
             "delivered_at" = COALESCE(
               r."delivered_at",
               "current_clock"."now"
             ),
             "read_at" = CASE
               WHEN ${requested}::"MessageDeliveryStatus" = 'READ'
                 THEN COALESCE(r."read_at", "current_clock"."now")
               ELSE r."read_at"
             END
        FROM "messages" m
        JOIN "conversations" c ON c."id" = m."conversation_id"
        JOIN "assignments" a ON a."id" = c."assignment_id"
        JOIN "cashier_profiles" cp
          ON cp."user_id" = a."cashier_user_id"
        JOIN "users" cashier_user
          ON cashier_user."id" = cp."user_id"
        JOIN "users" client_user
          ON client_user."id" = a."client_user_id"
        JOIN "cashier_subscriptions" cs
          ON cs."cashier_user_id" = cp."user_id"
         AND cs."status" = 'ACTIVE'
        CROSS JOIN "current_clock"
       WHERE r."message_id" = ${messageId}::uuid
         AND r."recipient_user_id" = ${userId}::uuid
         AND m."id" = r."message_id"
         AND m."expires_at" > "current_clock"."now"
         AND c."status" = 'ACTIVE'
         AND a."ended_at" IS NULL
         AND cp."approval_status" = 'APPROVED'
         AND cp."email_verified_at" IS NOT NULL
         AND cp."phone_verified_at" IS NOT NULL
         AND cashier_user."role" = 'CASHIER'
         AND cashier_user."status" = 'ACTIVE'
         AND cashier_user."password_reset_required" = FALSE
         AND client_user."role" = 'CLIENT'
         AND client_user."status" = 'ACTIVE'
         AND cs."starts_at" <= "current_clock"."now"
         AND (cs."ends_at" IS NULL OR cs."ends_at" > "current_clock"."now")
         AND ${userId}::uuid IN (
           a."client_user_id",
           a."cashier_user_id"
         )
         AND CASE r."status"
               WHEN 'SENT' THEN 0
               WHEN 'DELIVERED' THEN 1
               WHEN 'READ' THEN 2
             END < ${requestedRank}
      RETURNING
        r."message_id" AS "messageId",
        r."status",
        r."delivered_at" AS "deliveredAt",
        r."read_at" AS "readAt"
    `;
    if (updated[0]) {
      return updated[0];
    }

    const current = await this.prisma.$queryRaw<ReceiptResult[]>`
      WITH "current_clock" AS MATERIALIZED (
        SELECT clock_timestamp() AS "now"
      )
      SELECT
        r."message_id" AS "messageId",
        r."status",
        r."delivered_at" AS "deliveredAt",
        r."read_at" AS "readAt"
        FROM "message_receipts" r
        JOIN "messages" m ON m."id" = r."message_id"
        JOIN "conversations" c ON c."id" = m."conversation_id"
        JOIN "assignments" a ON a."id" = c."assignment_id"
        JOIN "cashier_profiles" cp
          ON cp."user_id" = a."cashier_user_id"
        JOIN "users" cashier_user
          ON cashier_user."id" = cp."user_id"
        JOIN "users" client_user
          ON client_user."id" = a."client_user_id"
        JOIN "cashier_subscriptions" cs
          ON cs."cashier_user_id" = cp."user_id"
         AND cs."status" = 'ACTIVE'
        CROSS JOIN "current_clock"
       WHERE r."message_id" = ${messageId}::uuid
         AND r."recipient_user_id" = ${userId}::uuid
         AND m."expires_at" > "current_clock"."now"
         AND c."status" = 'ACTIVE'
         AND a."ended_at" IS NULL
         AND cp."approval_status" = 'APPROVED'
         AND cp."email_verified_at" IS NOT NULL
         AND cp."phone_verified_at" IS NOT NULL
         AND cashier_user."role" = 'CASHIER'
         AND cashier_user."status" = 'ACTIVE'
         AND cashier_user."password_reset_required" = FALSE
         AND client_user."role" = 'CLIENT'
         AND client_user."status" = 'ACTIVE'
         AND cs."starts_at" <= "current_clock"."now"
         AND (cs."ends_at" IS NULL OR cs."ends_at" > "current_clock"."now")
         AND ${userId}::uuid IN (
           a."client_user_id",
           a."cashier_user_id"
         )
    `;
    if (!current[0]) {
      throw new NotFoundException("Mensaje no disponible.");
    }
    return current[0];
  }

  async requireActiveConversation(
    userId: string,
    conversationId: string
  ) {
    const conversation = await this.eligibility.requireCurrent(
      userId,
      conversationId
    );

    return {
      id: conversation.id,
      assignment: {
        clientUserId: conversation.clientUserId,
        cashierUserId: conversation.cashierUserId
      }
    };
  }

  private assertCompleteEnvelopes(
    input: SendMessageDto,
    activeDevices: {
      id: string;
      userId: string;
      matrixDeviceId: string;
      protocolVersion: string;
      curve25519Key: string;
    }[]
  ): void {
    if (activeDevices.length === 0) {
      throw new ConflictException(
        "Los participantes deben configurar dispositivos seguros."
      );
    }

    const activeById = new Map(
      activeDevices.map((device) => [device.id, device])
    );
    const senderDevice = activeById.get(input.senderDeviceId);
    if (!senderDevice) {
      throw new ForbiddenException("Dispositivo emisor no autorizado.");
    }
    if (senderDevice.protocolVersion !== MATRIX_DEVICE_PROTOCOL_VERSION) {
      throw new ConflictException(
        "El dispositivo emisor no usa el protocolo E2EE vigente."
      );
    }
    const expectedRecipients = new Map(
      activeDevices.map((device) => [device.id, device])
    );
    if (
      ![...expectedRecipients.values()].some(
        (device) => device.userId !== senderDevice.userId
      )
    ) {
      throw new ConflictException(
        "La contraparte debe configurar un dispositivo seguro."
      );
    }
    const received = new Set<string>();
    let canonicalCiphertext: string | undefined;

    for (const envelope of input.envelopes) {
      if (received.has(envelope.recipientDeviceId)) {
        throw new BadRequestException(
          "No puede repetirse un dispositivo destinatario."
        );
      }
      received.add(envelope.recipientDeviceId);

      const expectedDevice = expectedRecipients.get(
        envelope.recipientDeviceId
      );
      if (
        !expectedDevice ||
        expectedDevice.protocolVersion !== MATRIX_DEVICE_PROTOCOL_VERSION ||
        envelope.protocolVersion !== MATRIX_MESSAGE_PROTOCOL_VERSION ||
        envelope.cipherSuite !== MATRIX_MEGOLM_ALGORITHM
      ) {
        throw new BadRequestException(
          "Los sobres no coinciden con los dispositivos activos."
        );
      }

      const ciphertextBytes = Buffer.from(envelope.ciphertext, "base64");
      const size = ciphertextBytes.byteLength;
      if (size < 16 || size > MAX_ENVELOPE_BYTES) {
        throw new BadRequestException(
          "Un sobre cifrado supera el tamaño permitido."
        );
      }
      if (ciphertextBytes.toString("base64") !== envelope.ciphertext) {
        throw new BadRequestException("Un sobre cifrado no es canónico.");
      }
      if (
        canonicalCiphertext !== undefined &&
        canonicalCiphertext !== envelope.ciphertext
      ) {
        throw new BadRequestException(
          "El ciphertext Megolm debe ser idéntico para todos los dispositivos."
        );
      }
      canonicalCiphertext = envelope.ciphertext;

      try {
        const json = new TextDecoder("utf-8", { fatal: true }).decode(
          ciphertextBytes
        );
        const content = parseMatrixMegolmRoomContent(JSON.parse(json));
        if (
          content.sender_key !== senderDevice.curve25519Key ||
          content.device_id !== senderDevice.matrixDeviceId
        ) {
          throw new BadRequestException(
            "El sobre cifrado no corresponde a los dispositivos declarados."
          );
        }
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        if (
          error instanceof SyntaxError ||
          error instanceof TypeError ||
          error instanceof MatrixRoomEventValidationError
        ) {
          throw new BadRequestException("Un ciphertext Megolm no es válido.");
        }
        throw error;
      }
    }

    if (
      received.size !== expectedRecipients.size ||
      [...expectedRecipients.keys()].some(
        (deviceId) => !received.has(deviceId)
      )
    ) {
      throw new ConflictException(
        "Debes cifrar el mensaje para todos los dispositivos activos."
      );
    }
  }

  private async prepareAttachment(
    userId: string,
    conversationId: string,
    input: SendMessageDto
  ): Promise<UploadGrant | null> {
    if (input.kind === MessageKind.TEXT) {
      if (input.attachmentGrantToken) {
        throw new BadRequestException(
          "Un mensaje de texto no puede incluir una foto."
        );
      }
      return null;
    }

    if (!input.attachmentGrantToken) {
      throw new BadRequestException(
        "El mensaje de imagen requiere una foto cifrada."
      );
    }
    const grant = this.uploadGrants.verify(input.attachmentGrantToken);
    this.uploadGrants.assertMatches(grant, userId, conversationId);
    const reservation = await this.prisma.pendingAttachmentUpload.findFirst({
      where: {
        id: grant.reservationId,
        userId,
        conversationId,
        objectKey: grant.objectKey,
        declaredMimeType: grant.declaredMimeType,
        plaintextByteSize: grant.plaintextByteSize,
        ciphertextByteSize: grant.ciphertextByteSize,
        ciphertextSha256: grant.ciphertextSha256,
        grantExpiresAt: { gt: await this.databaseNow() },
        lastPurgeAttemptAt: null
      },
      select: { id: true }
    });
    if (!reservation) {
      throw new ConflictException(
        "El permiso de la foto ya fue utilizado o venció."
      );
    }
    await this.storage.assertUploaded(
      grant.objectKey,
      grant.ciphertextByteSize,
      grant.ciphertextSha256
    );
    return grant;
  }

  private acknowledgeExistingMessage(
    userId: string,
    conversationId: string,
    input: SendMessageDto
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await this.lockConversationAndDevices(
        transaction,
        userId,
        conversationId,
        input.senderDeviceId
      );

      const existing = await transaction.message.findUnique({
        where: {
          senderDeviceId_clientMessageId: {
            senderDeviceId: input.senderDeviceId,
            clientMessageId: input.clientMessageId
          }
        }
      });
      if (!existing) {
        throw new NotFoundException("Mensaje no disponible.");
      }
      this.assertIdempotentMessageMatches(
        existing,
        userId,
        conversationId,
        input.kind
      );

      const clockRows = await transaction.$queryRaw<{ now: Date }[]>`
        SELECT clock_timestamp() AS "now"
      `;
      const now = clockRows[0]?.now;
      if (!now) {
        throw new Error("No se pudo consultar el reloj de PostgreSQL.");
      }
      if (existing.expiresAt <= now) {
        throw new NotFoundException("Mensaje no disponible.");
      }
      await this.lockConversationAndDevices(
        transaction,
        userId,
        conversationId,
        input.senderDeviceId
      );
      return this.messageAcknowledgement(existing, false);
    });
  }

  private messageAcknowledgement(message: {
    id: string;
    clientMessageId: string;
    serverSequence: bigint;
    kind: MessageKind;
    createdAt: Date;
    expiresAt: Date;
  }, created: boolean) {
    return {
      id: message.id,
      clientMessageId: message.clientMessageId,
      serverSequence: message.serverSequence.toString(),
      kind: message.kind,
      createdAt: message.createdAt,
      expiresAt: message.expiresAt,
      created
    };
  }

  private assertIdempotentMessageMatches(
    message: {
      senderUserId: string;
      conversationId: string;
      kind: MessageKind;
    },
    userId: string,
    conversationId: string,
    kind: MessageKind
  ): void {
    if (
      message.senderUserId !== userId ||
      message.conversationId !== conversationId ||
      message.kind !== kind
    ) {
      throw new ConflictException(
        "El identificador idempotente ya pertenece a otro mensaje."
      );
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    );
  }

  private async databaseNow(): Promise<Date> {
    const rows = await this.prisma.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp() AS "now"
    `;
    const now = rows[0]?.now;
    if (!now) {
      throw new Error("No se pudo consultar el reloj de PostgreSQL.");
    }
    return now;
  }

  private async lockConversationAndDevices(
    transaction: Prisma.TransactionClient,
    userId: string,
    conversationId: string,
    senderDeviceId: string
  ): Promise<{
    clientUserId: string;
    cashierUserId: string;
    activeDevices: {
      curve25519Key: string;
      id: string;
      matrixDeviceId: string;
      protocolVersion: string;
      userId: string;
    }[];
  }> {
    const conversation = await this.eligibility.lockCurrent(
      transaction,
      userId,
      conversationId,
      senderDeviceId
    );
    const participantIds = [
      conversation.clientUserId,
      conversation.cashierUserId
    ].sort();
    for (const participantId of participantIds) {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            'sinochat:devices:' || ${participantId}::text,
            0
          )
        )
      `;
    }

    const devices = await transaction.$queryRaw<
      Array<{
        curve25519Key: string;
        id: string;
        matrixDeviceId: string;
        userId: string;
        protocolVersion: string;
      }>
    >`
      SELECT
        d."id",
        d."user_id" AS "userId",
        d."protocol_version" AS "protocolVersion",
        matrix_key."curve25519_key" AS "curve25519Key",
        matrix_key."matrix_device_id" AS "matrixDeviceId"
        FROM "devices" d
        JOIN "matrix_device_keys" matrix_key
          ON matrix_key."device_id" = d."id"
       WHERE d."user_id" IN (
         ${conversation.clientUserId}::uuid,
         ${conversation.cashierUserId}::uuid
       )
         AND d."status" = 'ACTIVE'
       ORDER BY d."user_id", d."id"
       FOR SHARE OF d
    `;

    if (
      !devices.some(
        (device) =>
          device.id === senderDeviceId && device.userId === userId
      )
    ) {
      throw new ForbiddenException(
        "Dispositivo emisor no autorizado."
      );
    }

    return {
      clientUserId: conversation.clientUserId,
      cashierUserId: conversation.cashierUserId,
      activeDevices: devices.map(
        ({
          curve25519Key,
          id,
          matrixDeviceId,
          protocolVersion,
          userId: deviceUserId
        }) => ({
          curve25519Key,
          id,
          matrixDeviceId,
          protocolVersion,
          userId: deviceUserId
        })
      )
    };
  }

  private async lockActiveConversation(
    transaction: Prisma.TransactionClient,
    userId: string,
    conversationId: string,
    deviceId?: string
  ): Promise<void> {
    await this.eligibility.lockCurrent(
      transaction,
      userId,
      conversationId,
      deviceId
    );
  }
}
