import { ForbiddenException, Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client";
import { PrismaService } from "../database/prisma.service";
import type { MessageKind } from "../generated/prisma/enums";

const CURRENT_CLOCK = Prisma.sql`
  WITH "current_clock" AS MATERIALIZED (
    SELECT clock_timestamp() AS "now"
  )
`;

const ELIGIBILITY_JOINS = Prisma.sql`
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
`;

const ELIGIBILITY_PREDICATES = Prisma.sql`
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
`;

export interface CurrentConversationAccess {
  id: string;
  assignmentId: string;
  clientUserId: string;
  cashierUserId: string;
  subscriptionEndsAt: Date | null;
}

export interface CurrentMessageEvent {
  id: string;
  conversationId: string;
  senderUserId: string;
  serverSequence: bigint;
  kind: MessageKind;
  createdAt: Date;
  expiresAt: Date;
  clientUserId: string;
  cashierUserId: string;
}

export interface CurrentCashierAccess {
  userId: string;
  subscriptionEndsAt: Date | null;
}

type QueryClient = PrismaService | Prisma.TransactionClient;

@Injectable()
export class ConversationEligibilityService {
  constructor(private readonly prisma: PrismaService) {}

  async lockOperationalUser(
    transaction: Prisma.TransactionClient,
    userId: string
  ): Promise<void> {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT u."id"
          FROM "users" u
         WHERE u."id" = ${userId}::uuid
           AND u."status" NOT IN ('SUSPENDED', 'DELETED')
           AND u."password_reset_required" = FALSE
         FOR SHARE OF u
      `
    );
    if (rows.length !== 1) {
      throw new ForbiddenException("La cuenta no está disponible para esta acción.");
    }
  }

  async findCurrent(
    userId: string,
    conversationId: string,
    client: QueryClient = this.prisma
  ): Promise<CurrentConversationAccess | null> {
    const rows = await client.$queryRaw<CurrentConversationAccess[]>(
      Prisma.sql`
        ${CURRENT_CLOCK}
        SELECT
          c."id",
          a."id" AS "assignmentId",
          a."client_user_id" AS "clientUserId",
          a."cashier_user_id" AS "cashierUserId",
          cs."ends_at" AS "subscriptionEndsAt"
          FROM "conversations" c
          JOIN "assignments" a ON a."id" = c."assignment_id"
          ${ELIGIBILITY_JOINS}
         WHERE c."id" = ${conversationId}::uuid
           AND c."status" = 'ACTIVE'
           AND a."ended_at" IS NULL
           AND ${userId}::uuid IN (
             a."client_user_id",
             a."cashier_user_id"
           )
           ${ELIGIBILITY_PREDICATES}
      `
    );
    return this.singleOrNull(rows);
  }

  async requireCurrent(
    userId: string,
    conversationId: string,
    client: QueryClient = this.prisma
  ): Promise<CurrentConversationAccess> {
    const conversation = await this.findCurrent(
      userId,
      conversationId,
      client
    );
    if (!conversation) {
      throw new ForbiddenException("Conversacion no disponible.");
    }
    return conversation;
  }

  async lockCurrent(
    transaction: Prisma.TransactionClient,
    userId: string,
    conversationId: string,
    deviceId?: string
  ): Promise<CurrentConversationAccess> {
    const rows = deviceId
      ? await transaction.$queryRaw<CurrentConversationAccess[]>(
          Prisma.sql`
            ${CURRENT_CLOCK}
            SELECT
              c."id",
              a."id" AS "assignmentId",
              a."client_user_id" AS "clientUserId",
              a."cashier_user_id" AS "cashierUserId",
              cs."ends_at" AS "subscriptionEndsAt"
              FROM "conversations" c
              JOIN "assignments" a ON a."id" = c."assignment_id"
              JOIN "devices" d ON d."id" = ${deviceId}::uuid
              ${ELIGIBILITY_JOINS}
             WHERE c."id" = ${conversationId}::uuid
               AND c."status" = 'ACTIVE'
               AND a."ended_at" IS NULL
               AND ${userId}::uuid IN (
                 a."client_user_id",
                 a."cashier_user_id"
               )
               AND d."user_id" = ${userId}::uuid
               AND d."status" = 'ACTIVE'
               ${ELIGIBILITY_PREDICATES}
             FOR SHARE OF c, a, d, cp, cashier_user, client_user, cs
          `
        )
      : await transaction.$queryRaw<CurrentConversationAccess[]>(
          Prisma.sql`
            ${CURRENT_CLOCK}
            SELECT
              c."id",
              a."id" AS "assignmentId",
              a."client_user_id" AS "clientUserId",
              a."cashier_user_id" AS "cashierUserId",
              cs."ends_at" AS "subscriptionEndsAt"
              FROM "conversations" c
              JOIN "assignments" a ON a."id" = c."assignment_id"
              ${ELIGIBILITY_JOINS}
             WHERE c."id" = ${conversationId}::uuid
               AND c."status" = 'ACTIVE'
               AND a."ended_at" IS NULL
               AND ${userId}::uuid IN (
                 a."client_user_id",
                 a."cashier_user_id"
               )
               ${ELIGIBILITY_PREDICATES}
             FOR SHARE OF c, a, cp, cashier_user, client_user, cs
          `
        );
    const conversation = this.singleOrNull(rows);
    if (!conversation) {
      throw new ForbiddenException("Conversacion no disponible.");
    }
    return conversation;
  }

  async lockCurrentByParticipants(
    transaction: Prisma.TransactionClient,
    clientUserId: string,
    cashierUserId: string
  ): Promise<CurrentConversationAccess> {
    const rows = await transaction.$queryRaw<CurrentConversationAccess[]>(
      Prisma.sql`
        ${CURRENT_CLOCK}
        SELECT
          c."id",
          a."id" AS "assignmentId",
          a."client_user_id" AS "clientUserId",
          a."cashier_user_id" AS "cashierUserId",
          cs."ends_at" AS "subscriptionEndsAt"
          FROM "conversations" c
          JOIN "assignments" a ON a."id" = c."assignment_id"
          ${ELIGIBILITY_JOINS}
         WHERE a."client_user_id" = ${clientUserId}::uuid
           AND a."cashier_user_id" = ${cashierUserId}::uuid
           AND a."ended_at" IS NULL
           AND c."status" = 'ACTIVE'
           ${ELIGIBILITY_PREDICATES}
         FOR SHARE OF c, a, cp, cashier_user, client_user, cs
      `
    );
    const conversation = this.singleOrNull(rows);
    if (!conversation) {
      throw new ForbiddenException("Conversacion no disponible.");
    }
    return conversation;
  }

  async lockCurrentCashier(
    transaction: Prisma.TransactionClient,
    cashierUserId: string
  ): Promise<CurrentCashierAccess> {
    const rows = await transaction.$queryRaw<CurrentCashierAccess[]>(
      Prisma.sql`
        ${CURRENT_CLOCK}
        SELECT
          cp."user_id" AS "userId",
          cs."ends_at" AS "subscriptionEndsAt"
          FROM "cashier_profiles" cp
          JOIN "users" cashier_user
            ON cashier_user."id" = cp."user_id"
          JOIN "cashier_subscriptions" cs
            ON cs."cashier_user_id" = cp."user_id"
           AND cs."status" = 'ACTIVE'
          CROSS JOIN "current_clock"
         WHERE cp."user_id" = ${cashierUserId}::uuid
           AND cp."approval_status" = 'APPROVED'
           AND cp."email_verified_at" IS NOT NULL
           AND cp."phone_verified_at" IS NOT NULL
           AND cashier_user."role" = 'CASHIER'
           AND cashier_user."status" = 'ACTIVE'
           AND cashier_user."password_reset_required" = FALSE
           AND cs."starts_at" <= "current_clock"."now"
           AND (cs."ends_at" IS NULL OR cs."ends_at" > "current_clock"."now")
         FOR SHARE OF cp, cashier_user, cs
      `
    );
    const cashier = this.singleOrNull(rows);
    if (!cashier) {
      throw new ForbiddenException(
        "El cajero no esta disponible para esta accion."
      );
    }
    return cashier;
  }

  async listCurrentCounterparts(userId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ userId: string }>>(
      Prisma.sql`
        ${CURRENT_CLOCK}
        SELECT CASE
          WHEN a."client_user_id" = ${userId}::uuid
            THEN a."cashier_user_id"
          ELSE a."client_user_id"
        END AS "userId"
          FROM "conversations" c
          JOIN "assignments" a ON a."id" = c."assignment_id"
          ${ELIGIBILITY_JOINS}
         WHERE c."status" = 'ACTIVE'
           AND a."ended_at" IS NULL
           AND ${userId}::uuid IN (
             a."client_user_id",
             a."cashier_user_id"
           )
           ${ELIGIBILITY_PREDICATES}
      `
    );
    return [...new Set(rows.map((row) => row.userId))];
  }

  async findCurrentNewMessage(
    messageId: string,
    conversationId: string,
    senderUserId: string
  ): Promise<CurrentMessageEvent | null> {
    const rows = await this.prisma.$queryRaw<CurrentMessageEvent[]>(
      Prisma.sql`
        ${CURRENT_CLOCK}
        SELECT
          m."id",
          m."conversation_id" AS "conversationId",
          m."sender_user_id" AS "senderUserId",
          m."server_sequence" AS "serverSequence",
          m."kind",
          m."created_at" AS "createdAt",
          m."expires_at" AS "expiresAt",
          a."client_user_id" AS "clientUserId",
          a."cashier_user_id" AS "cashierUserId"
          FROM "messages" m
          JOIN "conversations" c ON c."id" = m."conversation_id"
          JOIN "assignments" a ON a."id" = c."assignment_id"
          ${ELIGIBILITY_JOINS}
         WHERE m."id" = ${messageId}::uuid
           AND m."conversation_id" = ${conversationId}::uuid
           AND m."sender_user_id" = ${senderUserId}::uuid
           AND m."expires_at" > "current_clock"."now"
           AND c."status" = 'ACTIVE'
           AND a."ended_at" IS NULL
           AND ${senderUserId}::uuid IN (
             a."client_user_id",
             a."cashier_user_id"
           )
           ${ELIGIBILITY_PREDICATES}
      `
    );
    return this.singleOrNull(rows);
  }

  async findCurrentReceiptMessage(
    messageId: string,
    recipientUserId: string
  ): Promise<Pick<
    CurrentMessageEvent,
    "conversationId" | "senderUserId"
  > | null> {
    const rows = await this.prisma.$queryRaw<
      Array<Pick<CurrentMessageEvent, "conversationId" | "senderUserId">>
    >(
      Prisma.sql`
        ${CURRENT_CLOCK}
        SELECT
          m."conversation_id" AS "conversationId",
          m."sender_user_id" AS "senderUserId"
          FROM "messages" m
          JOIN "message_receipts" mr
            ON mr."message_id" = m."id"
           AND mr."recipient_user_id" = ${recipientUserId}::uuid
          JOIN "conversations" c ON c."id" = m."conversation_id"
          JOIN "assignments" a ON a."id" = c."assignment_id"
          ${ELIGIBILITY_JOINS}
         WHERE m."id" = ${messageId}::uuid
           AND m."expires_at" > "current_clock"."now"
           AND c."status" = 'ACTIVE'
           AND a."ended_at" IS NULL
           AND ${recipientUserId}::uuid IN (
             a."client_user_id",
             a."cashier_user_id"
           )
           ${ELIGIBILITY_PREDICATES}
      `
    );
    return this.singleOrNull(rows);
  }

  async assertPeriodStillActive(
    client: QueryClient,
    subscriptionEndsAt: Date | null
  ): Promise<Date> {
    const now = await this.databaseNow(client);
    if (subscriptionEndsAt && subscriptionEndsAt <= now) {
      throw new ForbiddenException("La suscripcion del cajero vencio.");
    }
    return now;
  }

  async databaseNow(client: QueryClient = this.prisma): Promise<Date> {
    const rows = await client.$queryRaw<Array<{ now: Date }>>(
      Prisma.sql`SELECT clock_timestamp() AS "now"`
    );
    const now = rows[0]?.now;
    if (!(now instanceof Date)) {
      throw new Error("No se pudo consultar el reloj de PostgreSQL.");
    }
    return now;
  }

  private singleOrNull<T>(rows: T[]): T | null {
    if (rows.length > 1) {
      throw new Error("Se detecto mas de una elegibilidad activa.");
    }
    return rows[0] ?? null;
  }
}
