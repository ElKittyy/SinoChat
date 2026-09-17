import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma } from "../generated/prisma/client";

export type MatrixDeviceListChangeType = "CHANGED" | "LEFT";

/**
 * Publica posiciones Matrix dentro de la misma transaccion que cambia un
 * dispositivo o una relacion. El singleton de stream y la fila de estado se
 * bloquean en PostgreSQL; asi un commit nunca anuncia una vista intermedia.
 */
@Injectable()
export class MatrixDeviceListPublisher {
  async publishDeviceSetChanged(
    transaction: Prisma.TransactionClient,
    subjectUserId: string,
    sourceDeviceId: string,
    createdAt: Date
  ): Promise<void> {
    const recipients = await this.currentRelationshipRecipients(
      transaction,
      subjectUserId
    );
    await this.publish(
      transaction,
      subjectUserId,
      recipients,
      "CHANGED",
      createdAt,
      sourceDeviceId,
      true
    );
  }

  /**
   * Al dar de alta el primer dispositivo, el nuevo usuario tambien necesita
   * descubrir las listas ya existentes de sus contrapartes. Los cambios
   * historicos anteriores a su primer /sync no alcanzan para eso.
   */
  async publishCurrentPeersToRecipient(
    transaction: Prisma.TransactionClient,
    recipientUserId: string,
    createdAt: Date
  ): Promise<void> {
    const peers = (
      await this.currentRelationshipRecipients(transaction, recipientUserId)
    ).filter((userId) => userId !== recipientUserId);
    for (const subjectUserId of peers.sort()) {
      await this.publish(
        transaction,
        subjectUserId,
        [recipientUserId],
        "CHANGED",
        createdAt,
        null,
        false
      );
    }
  }

  async publishRelationshipChanged(
    transaction: Prisma.TransactionClient,
    clientUserId: string,
    cashierUserId: string,
    changeType: MatrixDeviceListChangeType,
    createdAt: Date
  ): Promise<void> {
    await this.publish(
      transaction,
      clientUserId,
      [cashierUserId],
      changeType,
      createdAt,
      null,
      false
    );
    await this.publish(
      transaction,
      cashierUserId,
      [clientUserId],
      changeType,
      createdAt,
      null,
      false
    );
  }

  async publishCurrentRelationshipsForUser(
    transaction: Prisma.TransactionClient,
    userId: string,
    changeType: MatrixDeviceListChangeType,
    createdAt: Date
  ): Promise<void> {
    const relationships = await transaction.$queryRaw<
      Array<{ clientUserId: string; cashierUserId: string }>
    >(Prisma.sql`
      SELECT a."client_user_id" AS "clientUserId",
             a."cashier_user_id" AS "cashierUserId"
        FROM "assignments" a
        JOIN "conversations" c ON c."assignment_id" = a."id"
       WHERE a."ended_at" IS NULL
         AND c."status" = 'ACTIVE'
         AND ${userId}::uuid IN (
           a."client_user_id", a."cashier_user_id"
         )
       ORDER BY a."client_user_id", a."cashier_user_id"
    `);
    for (const relationship of relationships) {
      await this.publishRelationshipChanged(
        transaction,
        relationship.clientUserId,
        relationship.cashierUserId,
        changeType,
        createdAt
      );
    }
  }

  private async publish(
    transaction: Prisma.TransactionClient,
    subjectUserId: string,
    rawRecipientUserIds: string[],
    changeType: MatrixDeviceListChangeType,
    createdAt: Date,
    sourceDeviceId: string | null,
    bumpSubjectVersion: boolean
  ): Promise<void> {
    const recipientUserIds = [...new Set(rawRecipientUserIds)].sort();
    if (recipientUserIds.length === 0) return;

    const [lockedState] = await transaction.$queryRaw<
      Array<{ version: bigint }>
    >(Prisma.sql`
      SELECT s."version"
        FROM "matrix_device_list_states" s
       WHERE s."user_id" = ${subjectUserId}::uuid
       FOR UPDATE
    `);
    if (!lockedState) return;

    const subjectVersion = bumpSubjectVersion
      ? (
          await transaction.matrixDeviceListState.update({
            where: { userId: subjectUserId },
            data: { version: { increment: 1 }, updatedAt: createdAt },
            select: { version: true }
          })
        ).version
      : lockedState.version;
    if (subjectVersion < 1n) {
      // Una lista version 0 aun no publico ningun dispositivo y no debe
      // aparecer como contraparte utilizable.
      return;
    }

    const stream = await transaction.matrixDeviceListStream.update({
      where: { id: 1 },
      data: { position: { increment: 1 } },
      select: { position: true }
    });
    const changeId = randomUUID();
    await transaction.matrixDeviceListChange.createMany({
      data: recipientUserIds.map((recipientUserId) => ({
        id: randomUUID(),
        changeId,
        streamPosition: stream.position,
        recipientUserId,
        subjectUserId,
        subjectVersion,
        changeType,
        sourceDeviceId,
        createdAt
      }))
    });
  }

  private async currentRelationshipRecipients(
    transaction: Prisma.TransactionClient,
    userId: string
  ): Promise<string[]> {
    const rows = await transaction.$queryRaw<Array<{ userId: string }>>(
      Prisma.sql`
        SELECT CASE
                 WHEN a."client_user_id" = ${userId}::uuid
                   THEN a."cashier_user_id"
                 ELSE a."client_user_id"
               END AS "userId"
          FROM "conversations" c
          JOIN "assignments" a ON a."id" = c."assignment_id"
         WHERE c."status" = 'ACTIVE'
           AND a."ended_at" IS NULL
           AND ${userId}::uuid IN (
             a."client_user_id", a."cashier_user_id"
           )
      `
    );
    return [...new Set([userId, ...rows.map((row) => row.userId)])].sort();
  }
}
