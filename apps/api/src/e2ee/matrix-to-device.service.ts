import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { SessionPrincipal } from "../auth/auth.types";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import {
  AccountStatus,
  DeviceStatus,
  UserRole
} from "../generated/prisma/enums";
import { hashMatrixCanonicalJson } from "./matrix-key-upload";
import {
  MatrixToDeviceValidationError,
  matrixToDeviceHashInput,
  parseMatrixToDeviceRequest,
  type MatrixOlmToDeviceContent,
  type MatrixToDeviceRequest
} from "./matrix-to-device";
import {
  MatrixSyncTokenValidationError,
  issueMatrixSyncToken,
  parseMatrixSyncTokenBatchId,
  verifyMatrixSyncToken,
  type MatrixSyncTokenData
} from "./matrix-sync-token";

const TO_DEVICE_TTL_MS = 48 * 60 * 60 * 1_000;
const MAX_SYNC_EVENTS = 100;
const MAX_SYNC_TIMEOUT_MS = 30_000;
const MAX_PENDING_TO_DEVICE_EVENTS_PER_DEVICE = 2_000;

type MatrixTransaction = Prisma.TransactionClient;

interface ResolvedTarget {
  deviceId: string;
  userId: string;
  matrixUserId: string;
  matrixDeviceId: string;
  curve25519Key: string;
  content: MatrixOlmToDeviceContent;
  conversationId: string | null;
}

interface SyncBatchRecord extends MatrixSyncTokenData {
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  acknowledgedAt: Date | null;
}

interface SyncContext {
  now: Date;
  latestSequence: bigint;
  deviceListPosition: bigint;
}

@Injectable()
export class MatrixToDeviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: ConversationEligibilityService
  ) {}

  async send(
    principal: SessionPrincipal,
    rawEventType: string,
    rawTransactionId: string,
    value: unknown
  ): Promise<Record<string, never>> {
    const deviceId = this.requireBoundDevice(principal);
    const request = this.parseRequest(
      rawEventType,
      rawTransactionId,
      value
    );
    const requestSha256 = hashMatrixCanonicalJson(
      matrixToDeviceHashInput(request)
    );

    try {
      return await this.runTransaction(async (transaction) => {
        await this.lockTransactionId(
          transaction,
          deviceId,
          request.eventType,
          request.transactionId
        );
        const previous =
          await transaction.matrixToDeviceTransaction.findUnique({
            where: {
              senderDeviceId_eventType_transactionId: {
                senderDeviceId: deviceId,
                eventType: request.eventType,
                transactionId: request.transactionId
              }
            },
            select: { requestSha256: true }
          });
        if (previous) {
          if (previous.requestSha256 !== requestSha256) {
            throw new ConflictException(
              "El identificador sendToDevice ya pertenece a otro contenido."
            );
          }
          return {};
        }

        await this.eligibility.lockOperationalUser(
          transaction,
          principal.id
        );
        const now = await this.databaseNow(transaction);
        const sender = await this.requireCurrentSender(
          transaction,
          principal,
          deviceId,
          now
        );
        const targets = await this.resolveTargets(
          transaction,
          principal,
          request,
          sender.curve25519Key
        );
        await this.lockRecipientCursors(transaction, targets, now);

        const tombstone =
          await transaction.matrixToDeviceTransaction.create({
            data: {
              senderSessionId: principal.sessionId,
              senderDeviceId: deviceId,
              transactionId: request.transactionId,
              eventType: request.eventType,
              requestSha256,
              createdAt: now
            },
            select: { id: true }
          });
        const expiresAt = new Date(now.getTime() + TO_DEVICE_TTL_MS);
        for (const target of targets) {
          const cursor = await transaction.matrixToDeviceCursor.update({
            where: { deviceId: target.deviceId },
            data: { latestSequence: { increment: 1 } },
            select: { latestSequence: true }
          });
          await transaction.matrixToDeviceEvent.create({
            data: {
              transactionRowId: tombstone.id,
              recipientUserId: target.userId,
              recipientDeviceId: target.deviceId,
              recipientSequence: cursor.latestSequence,
              conversationId: target.conversationId,
              content:
                target.content as unknown as Prisma.InputJsonValue,
              contentSha256: hashMatrixCanonicalJson(target.content),
              createdAt: now,
              expiresAt
            }
          });
        }
        return {};
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          "El identificador sendToDevice ya fue utilizado."
        );
      }
      throw error;
    }
  }

  async sync(
    principal: SessionPrincipal,
    rawSince: unknown,
    rawTimeout: unknown
  ) {
    const deviceId = this.requireBoundDevice(principal);
    this.parseSyncTimeout(rawTimeout);
    const since = this.parseSince(rawSince);

    return this.runTransaction(async (transaction) => {
      const context = await this.lockSyncContext(
        transaction,
        principal,
        deviceId
      );
      let batch: SyncBatchRecord;
      let incremental = false;

      if (since) {
        incremental = true;
        const parent = await this.requireSyncBatch(
          transaction,
          deviceId,
          since,
          context.now
        );
        const existingChild =
          await transaction.matrixToDeviceSyncBatch.findUnique({
            where: { previousBatchId: parent.id },
            select: this.syncBatchSelection()
          });
        if (existingChild) {
          if (existingChild.expiresAt <= context.now) {
            throw this.unknownSyncPosition();
          }
          batch = existingChild;
        } else {
          if (parent.acknowledgedAt !== null) {
            throw this.unknownSyncPosition();
          }
          batch = await this.createSyncBatch(
            transaction,
            principal.id,
            deviceId,
            parent.id,
            parent.upToSequence,
            parent.deviceListPosition,
            context
          );
          const acknowledged =
            await transaction.matrixToDeviceSyncBatch.updateMany({
              where: { id: parent.id, acknowledgedAt: null },
              data: { acknowledgedAt: context.now }
            });
          if (acknowledged.count !== 1) {
            throw new ConflictException(
              "El token de sincronizacion cambio durante el ACK."
            );
          }
          await transaction.matrixToDeviceEvent.deleteMany({
            where: {
              recipientDeviceId: deviceId,
              recipientSequence: { lte: parent.upToSequence }
            }
          });
        }
      } else {
        const openInitial =
          await transaction.matrixToDeviceSyncBatch.findFirst({
            where: {
              deviceId,
              previousBatchId: null,
              acknowledgedAt: null,
              expiresAt: { gt: context.now }
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: this.syncBatchSelection()
          });
        batch =
          openInitial ??
          (await this.createSyncBatch(
            transaction,
            principal.id,
            deviceId,
            null,
            0n,
            0n,
            context
          ));
      }

      return this.buildSyncResponse(
        transaction,
        principal,
        batch,
        incremental,
        context.now
      );
    });
  }

  private async createSyncBatch(
    transaction: MatrixTransaction,
    userId: string,
    deviceId: string,
    previousBatchId: string | null,
    fromSequence: bigint,
    fromDeviceListPosition: bigint,
    context: SyncContext
  ): Promise<SyncBatchRecord> {
    const eventWindow = await transaction.matrixToDeviceEvent.findMany({
      where: {
        recipientDeviceId: deviceId,
        recipientSequence: {
          gt: fromSequence,
          lte: context.latestSequence
        },
        expiresAt: { gt: context.now }
      },
      select: { recipientSequence: true, expiresAt: true },
      orderBy: { recipientSequence: "asc" },
      take: MAX_SYNC_EVENTS
    });
    const upToSequence =
      eventWindow.length < MAX_SYNC_EVENTS
        ? context.latestSequence
        : eventWindow[eventWindow.length - 1]!.recipientSequence;

    const deviceChanges = await transaction.matrixDeviceListChange.findMany({
      where: {
        recipientUserId: userId,
        streamPosition: {
          gt: fromDeviceListPosition,
          lte: context.deviceListPosition
        }
      },
      select: { streamPosition: true },
      orderBy: { streamPosition: "asc" },
      take: MAX_SYNC_EVENTS
    });
    const deviceListPosition =
      deviceChanges.length < MAX_SYNC_EVENTS
        ? context.deviceListPosition
        : deviceChanges[deviceChanges.length - 1]!.streamPosition;

    const oneTimeKeyCount = await transaction.matrixOneTimeKey.count({
      where: {
        deviceId,
        algorithm: "signed_curve25519",
        claimedAt: null
      }
    });
    const fallback = await transaction.matrixFallbackKeySlot.findUnique({
      where: {
        deviceId_algorithm: {
          deviceId,
          algorithm: "signed_curve25519"
        }
      },
      select: { currentKey: { select: { firstClaimedAt: true } } }
    });
    const unusedFallbackKey = fallback?.currentKey.firstClaimedAt === null;
    const eventExpiry = eventWindow.reduce<number>(
      (earliest, event) => Math.min(earliest, event.expiresAt.getTime()),
      Number.POSITIVE_INFINITY
    );
    const expiresAt = new Date(
      Math.min(
        context.now.getTime() + TO_DEVICE_TTL_MS,
        eventExpiry
      )
    );
    if (expiresAt <= context.now) {
      throw new UnauthorizedException(
        "La sesion no conserva una ventana valida de sincronizacion."
      );
    }

    const id = randomUUID();
    const tokenData: MatrixSyncTokenData = {
      id,
      deviceId,
      previousBatchId,
      fromSequence,
      upToSequence,
      fromDeviceListPosition,
      deviceListPosition,
      oneTimeKeyCount,
      unusedFallbackKey
    };
    const issued = issueMatrixSyncToken(tokenData);
    return transaction.matrixToDeviceSyncBatch.create({
      data: {
        ...tokenData,
        tokenHash: issued.tokenHash,
        createdAt: context.now,
        expiresAt
      },
      select: this.syncBatchSelection()
    });
  }

  private async buildSyncResponse(
    transaction: MatrixTransaction,
    principal: SessionPrincipal,
    batch: SyncBatchRecord,
    incremental: boolean,
    now: Date
  ) {
    const nextBatch = this.reconstructSyncToken(batch);
    const events = await transaction.$queryRaw<
      Array<{
        sender: string;
        type: string;
        content: Prisma.JsonValue;
      }>
    >(Prisma.sql`
      SELECT sender_keys."matrix_user_id" AS "sender",
             t."event_type" AS "type",
             e."content"
        FROM "matrix_to_device_events" e
        JOIN "matrix_to_device_transactions" t
          ON t."id" = e."transaction_row_id"
        JOIN "devices" sender_device
          ON sender_device."id" = t."sender_device_id"
        JOIN "matrix_device_keys" sender_keys
          ON sender_keys."device_id" = sender_device."id"
        JOIN "users" sender_user
          ON sender_user."id" = sender_device."user_id"
        JOIN "devices" recipient_device
          ON recipient_device."id" = e."recipient_device_id"
         AND recipient_device."user_id" = e."recipient_user_id"
        JOIN "users" recipient_user
          ON recipient_user."id" = recipient_device."user_id"
       WHERE e."recipient_device_id" = ${batch.deviceId}::uuid
         AND e."recipient_sequence" > ${batch.fromSequence}
         AND e."recipient_sequence" <= ${batch.upToSequence}
         AND e."expires_at" > ${now}
         AND sender_device."status" = 'ACTIVE'
         AND recipient_device."status" = 'ACTIVE'
         AND sender_user."status" = 'ACTIVE'
         AND recipient_user."status" = 'ACTIVE'
         AND sender_user."password_reset_required" = FALSE
         AND recipient_user."password_reset_required" = FALSE
         AND (
           (
             sender_user."id" = recipient_user."id"
             AND e."conversation_id" IS NULL
           )
           OR EXISTS (
             SELECT 1
               FROM "conversations" c
               JOIN "assignments" a ON a."id" = c."assignment_id"
               JOIN "users" client_user
                 ON client_user."id" = a."client_user_id"
               JOIN "users" cashier_user
                 ON cashier_user."id" = a."cashier_user_id"
               JOIN "cashier_profiles" cp
                 ON cp."user_id" = a."cashier_user_id"
              WHERE c."id" = e."conversation_id"
                AND c."status" = 'ACTIVE'
                AND a."ended_at" IS NULL
                AND sender_user."id" IN (
                  a."client_user_id", a."cashier_user_id"
                )
                AND recipient_user."id" IN (
                  a."client_user_id", a."cashier_user_id"
                )
                AND sender_user."id" <> recipient_user."id"
                AND client_user."role" = 'CLIENT'
                AND client_user."status" = 'ACTIVE'
                AND client_user."password_reset_required" = FALSE
                AND cashier_user."role" = 'CASHIER'
                AND cashier_user."status" = 'ACTIVE'
                AND cashier_user."password_reset_required" = FALSE
                AND cp."approval_status" = 'APPROVED'
                AND cp."email_verified_at" IS NOT NULL
                AND cp."phone_verified_at" IS NOT NULL
                AND EXISTS (
                  SELECT 1
                    FROM "cashier_subscriptions" cs
                   WHERE cs."cashier_user_id" = a."cashier_user_id"
                     AND cs."status" = 'ACTIVE'
                     AND cs."starts_at" <= ${now}
                     AND (cs."ends_at" IS NULL OR cs."ends_at" > ${now})
                )
           )
         )
       ORDER BY e."recipient_sequence" ASC
    `);

    const response: Record<string, unknown> = {
      next_batch: nextBatch,
      to_device: { events },
      device_one_time_keys_count: {
        signed_curve25519: batch.oneTimeKeyCount
      },
      device_unused_fallback_key_types: batch.unusedFallbackKey
        ? ["signed_curve25519"]
        : []
    };
    if (incremental) {
      response.device_lists = await this.buildDeviceListChanges(
        transaction,
        principal.id,
        batch
      );
    }
    return response;
  }

  private async buildDeviceListChanges(
    transaction: MatrixTransaction,
    userId: string,
    batch: SyncBatchRecord
  ): Promise<{ changed: string[]; left: string[] }> {
    const rows = await transaction.matrixDeviceListChange.findMany({
      where: {
        recipientUserId: userId,
        streamPosition: {
          gt: batch.fromDeviceListPosition,
          lte: batch.deviceListPosition
        }
      },
      select: {
        changeType: true,
        subject: {
          select: {
            matrixDeviceListState: { select: { matrixUserId: true } }
          }
        }
      },
      orderBy: { streamPosition: "asc" }
    });
    const latest = new Map<string, string>();
    for (const row of rows) {
      const matrixUserId = row.subject.matrixDeviceListState?.matrixUserId;
      if (matrixUserId) latest.set(matrixUserId, row.changeType);
    }
    return {
      changed: [...latest]
        .filter(([, changeType]) => changeType === "CHANGED")
        .map(([matrixUserId]) => matrixUserId)
        .sort(),
      left: [...latest]
        .filter(([, changeType]) => changeType === "LEFT")
        .map(([matrixUserId]) => matrixUserId)
        .sort()
    };
  }

  private async lockSyncContext(
    transaction: MatrixTransaction,
    principal: SessionPrincipal,
    deviceId: string
  ): Promise<SyncContext> {
    const rows = await transaction.$queryRaw<SyncContext[]>(Prisma.sql`
      WITH current_clock AS MATERIALIZED (
        SELECT clock_timestamp() AS "now"
      )
      SELECT current_clock."now",
             cursor."latest_sequence" AS "latestSequence",
             stream."position" AS "deviceListPosition"
        FROM "auth_sessions" s
        JOIN "users" u ON u."id" = s."user_id"
        JOIN "devices" d ON d."id" = s."device_id"
        JOIN "matrix_device_keys" keys ON keys."device_id" = d."id"
        JOIN "matrix_to_device_cursors" cursor
          ON cursor."device_id" = d."id"
        JOIN "matrix_device_list_stream" stream ON stream."id" = 1
        CROSS JOIN current_clock
       WHERE s."id" = ${principal.sessionId}::uuid
         AND s."user_id" = ${principal.id}::uuid
         AND s."device_id" = ${deviceId}::uuid
         AND s."revoked_at" IS NULL
         AND s."expires_at" > current_clock."now"
         AND s."session_version" = u."session_version"
         AND u."status" = 'ACTIVE'
         AND u."password_reset_required" = FALSE
         AND d."status" = 'ACTIVE'
       FOR UPDATE OF s, u, d, cursor
    `);
    if (rows.length !== 1) {
      throw new UnauthorizedException("La sesion Matrix ya no esta vigente.");
    }
    return rows[0]!;
  }

  private async requireSyncBatch(
    transaction: MatrixTransaction,
    deviceId: string,
    token: string,
    now: Date
  ): Promise<SyncBatchRecord> {
    let id: string;
    try {
      id = parseMatrixSyncTokenBatchId(token);
    } catch (error) {
      if (error instanceof MatrixSyncTokenValidationError) {
        throw this.unknownSyncPosition();
      }
      throw error;
    }
    const batch = await transaction.matrixToDeviceSyncBatch.findUnique({
      where: { id },
      select: this.syncBatchSelection()
    });
    if (
      !batch ||
      batch.deviceId !== deviceId ||
      batch.expiresAt <= now ||
      !verifyMatrixSyncToken(token, batch.tokenHash, batch)
    ) {
      throw this.unknownSyncPosition();
    }
    return batch;
  }

  private reconstructSyncToken(batch: SyncBatchRecord): string {
    const issued = issueMatrixSyncToken(batch);
    if (!verifyMatrixSyncToken(issued.token, batch.tokenHash, batch)) {
      throw new Error("MATRIX_SYNC_BATCH_TOKEN_HASH_MISMATCH");
    }
    return issued.token;
  }

  private syncBatchSelection() {
    return {
      id: true,
      deviceId: true,
      previousBatchId: true,
      tokenHash: true,
      fromSequence: true,
      upToSequence: true,
      fromDeviceListPosition: true,
      deviceListPosition: true,
      oneTimeKeyCount: true,
      unusedFallbackKey: true,
      createdAt: true,
      expiresAt: true,
      acknowledgedAt: true
    } as const;
  }

  private parseSince(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length > 160) {
      throw this.unknownSyncPosition();
    }
    return value;
  }

  private parseSyncTimeout(value: unknown): void {
    if (value === undefined) return;
    if (
      typeof value !== "string" ||
      !/^(?:0|[1-9][0-9]{0,4})$/.test(value) ||
      Number(value) > MAX_SYNC_TIMEOUT_MS
    ) {
      throw new BadRequestException({
        error: "Timeout de sincronizacion invalido.",
        errcode: "M_INVALID_PARAM"
      });
    }
  }

  private unknownSyncPosition(): BadRequestException {
    return new BadRequestException({
      error: "Token de sincronizacion invalido o vencido.",
      errcode: "M_UNKNOWN_POS"
    });
  }

  private async resolveTargets(
    transaction: MatrixTransaction,
    principal: SessionPrincipal,
    request: MatrixToDeviceRequest,
    senderCurve25519Key: string
  ): Promise<ResolvedTarget[]> {
    const requested = Object.entries(request.messages).flatMap(
      ([matrixUserId, devices]) =>
        Object.entries(devices).map(([matrixDeviceId, content]) => ({
          matrixUserId,
          matrixDeviceId,
          content
        }))
    );
    const identities = await transaction.matrixDeviceKey.findMany({
      where: {
        OR: requested.map((target) => ({
          matrixUserId: target.matrixUserId,
          matrixDeviceId: target.matrixDeviceId
        })),
        device: { status: DeviceStatus.ACTIVE }
      },
      select: {
        deviceId: true,
        userId: true,
        matrixUserId: true,
        matrixDeviceId: true,
        curve25519Key: true
      }
    });
    const identityByAddress = new Map(
      identities.map((identity) => [
        this.matrixAddress(identity.matrixUserId, identity.matrixDeviceId),
        identity
      ])
    );
    if (identityByAddress.size !== requested.length) {
      throw new ForbiddenException(
        "La solicitud contiene un dispositivo Matrix no autorizado."
      );
    }

    const conversations = new Map<string, string | null>([
      [principal.id, null]
    ]);
    for (const recipientUserId of [
      ...new Set(identities.map((identity) => identity.userId))
    ].sort()) {
      if (recipientUserId === principal.id) continue;
      const conversation =
        principal.role === UserRole.CLIENT
          ? await this.eligibility.lockCurrentByParticipants(
              transaction,
              principal.id,
              recipientUserId
            )
          : await this.eligibility.lockCurrentByParticipants(
              transaction,
              recipientUserId,
              principal.id
            );
      conversations.set(recipientUserId, conversation.id);
    }

    const targets = requested.map((target) => {
      const identity = identityByAddress.get(
        this.matrixAddress(target.matrixUserId, target.matrixDeviceId)
      );
      if (!identity) {
        throw new ForbiddenException(
          "La solicitud contiene un dispositivo Matrix no autorizado."
        );
      }
      if (target.content.sender_key !== senderCurve25519Key) {
        throw new ForbiddenException(
          "El sender_key no pertenece al dispositivo remitente."
        );
      }
      const ciphertextKeys = Object.keys(target.content.ciphertext);
      if (
        ciphertextKeys.length !== 1 ||
        ciphertextKeys[0] !== identity.curve25519Key
      ) {
        throw new BadRequestException(
          "El ciphertext Olm no esta dirigido al dispositivo indicado."
        );
      }
      const conversationId = conversations.get(identity.userId);
      if (conversationId === undefined) {
        throw new ForbiddenException(
          "La contraparte Matrix no tiene una conversacion vigente."
        );
      }
      return {
        ...identity,
        content: target.content,
        conversationId
      };
    });
    return targets.sort((left, right) =>
      left.deviceId.localeCompare(right.deviceId)
    );
  }

  private async lockRecipientCursors(
    transaction: MatrixTransaction,
    targets: ResolvedTarget[],
    now: Date
  ): Promise<void> {
    for (const target of targets) {
      const rows = await transaction.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT d."id"
            FROM "devices" d
            JOIN "matrix_device_keys" k ON k."device_id" = d."id"
            JOIN "matrix_to_device_cursors" c ON c."device_id" = d."id"
           WHERE d."id" = ${target.deviceId}::uuid
             AND d."user_id" = ${target.userId}::uuid
             AND d."status" = 'ACTIVE'
           FOR UPDATE OF d, c
        `
      );
      if (rows.length !== 1) {
        throw new ConflictException(
          "Un dispositivo destinatario dejo de estar disponible."
        );
      }
      const pending = await transaction.matrixToDeviceEvent.count({
        where: {
          recipientDeviceId: target.deviceId,
          expiresAt: { gt: now }
        }
      });
      if (pending >= MAX_PENDING_TO_DEVICE_EVENTS_PER_DEVICE) {
        throw new HttpException(
          "La cola Matrix del dispositivo destinatario esta completa.",
          HttpStatus.TOO_MANY_REQUESTS
        );
      }
    }
  }

  private async requireCurrentSender(
    transaction: MatrixTransaction,
    principal: SessionPrincipal,
    deviceId: string,
    now: Date
  ): Promise<{ curve25519Key: string; sessionExpiresAt: Date }> {
    const session = await transaction.authSession.findUnique({
      where: { id: principal.sessionId },
      select: {
        userId: true,
        deviceId: true,
        expiresAt: true,
        revokedAt: true,
        sessionVersion: true,
        user: {
          select: {
            status: true,
            passwordResetRequired: true,
            sessionVersion: true
          }
        },
        device: {
          select: {
            status: true,
            matrixDeviceKey: { select: { curve25519Key: true } }
          }
        }
      }
    });
    if (
      !session ||
      session.userId !== principal.id ||
      session.deviceId !== deviceId ||
      session.revokedAt !== null ||
      session.expiresAt <= now ||
      session.sessionVersion !== session.user.sessionVersion ||
      session.user.status !== AccountStatus.ACTIVE ||
      session.user.passwordResetRequired ||
      session.device?.status !== DeviceStatus.ACTIVE ||
      !session.device.matrixDeviceKey
    ) {
      throw new UnauthorizedException("La sesion Matrix ya no esta vigente.");
    }
    return {
      curve25519Key: session.device.matrixDeviceKey.curve25519Key,
      sessionExpiresAt: session.expiresAt
    };
  }

  private async lockTransactionId(
    transaction: MatrixTransaction,
    deviceId: string,
    eventType: string,
    transactionId: string
  ): Promise<void> {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          'sinochat:matrix:to-device:' || ${deviceId}::text || ':' ||
          ${eventType} || ':' || ${transactionId},
          0
        )
      )
    `;
  }

  private async databaseNow(transaction: MatrixTransaction): Promise<Date> {
    const [clock] = await transaction.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS "now"
    `;
    if (!clock) throw new Error("No se pudo obtener el reloj PostgreSQL.");
    return clock.now;
  }

  private requireBoundDevice(principal: SessionPrincipal): string {
    if (!principal.deviceId) {
      throw new ForbiddenException(
        "La sesion no esta vinculada a un dispositivo Matrix."
      );
    }
    return principal.deviceId;
  }

  private parseRequest(
    eventType: string,
    transactionId: string,
    value: unknown
  ): MatrixToDeviceRequest {
    try {
      return parseMatrixToDeviceRequest(eventType, transactionId, value);
    } catch (error) {
      if (error instanceof MatrixToDeviceValidationError) {
        throw new BadRequestException({
          error: "Solicitud sendToDevice invalida.",
          errcode: error.code
        });
      }
      throw error;
    }
  }

  private matrixAddress(userId: string, deviceId: string): string {
    return `${userId}\u0000${deviceId}`;
  }

  private runTransaction<T>(
    operation: (transaction: MatrixTransaction) => Promise<T>
  ): Promise<T> {
    return this.prisma.$transaction(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: 30_000
    });
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    );
  }
}
