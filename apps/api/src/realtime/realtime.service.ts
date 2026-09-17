import { Injectable } from "@nestjs/common";
import type { Server } from "socket.io";
import { PrismaService } from "../database/prisma.service";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import {
  AccountStatus,
  DeviceStatus
} from "../generated/prisma/enums";

@Injectable()
export class RealtimeService {
  private server?: Server;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: ConversationEligibilityService
  ) {}

  attachServer(server: Server): void {
    this.server = server;
  }

  async notifyMessage(
    conversationId: string,
    senderUserId: string,
    acknowledgement: {
      id: string;
      serverSequence: string;
      kind: string;
      createdAt: Date;
      expiresAt: Date;
    }
  ): Promise<void> {
    if (!this.server) {
      return;
    }

    const message = await this.eligibility.findCurrentNewMessage(
      acknowledgement.id,
      conversationId,
      senderUserId
    );
    if (!message) {
      return;
    }

    const recipientUserId =
      message.clientUserId === senderUserId
        ? message.cashierUserId
        : message.clientUserId;
    const payload = {
      conversationId,
      message: {
        id: message.id,
        serverSequence: message.serverSequence.toString(),
        kind: message.kind,
        createdAt: message.createdAt,
        expiresAt: message.expiresAt
      }
    };

    const [recipientSockets, senderSockets] = await Promise.all([
      this.authorizedSockets(recipientUserId),
      this.authorizedSockets(senderUserId)
    ]);
    if (recipientSockets.length + senderSockets.length === 0) {
      return;
    }

    // La revalidacion final queda inmediatamente antes de los emits
    // sincronicos. Asi la consulta de sesiones no abre una ventana de
    // autorizacion frente al vencimiento natural de la suscripcion.
    const finalMessage =
      await this.eligibility.findCurrentNewMessage(
        acknowledgement.id,
        conversationId,
        senderUserId
      );
    if (!finalMessage) {
      return;
    }
    this.emitToSockets(recipientSockets, "message:new", payload);
    // Tambien se avisa a los demas dispositivos autorizados del emisor.
    this.emitToSockets(senderSockets, "message:new", payload);
  }

  async notifyReceipt(
    messageId: string,
    recipientUserId: string,
    receipt: object
  ): Promise<void> {
    if (!this.server) {
      return;
    }

    const message =
      await this.eligibility.findCurrentReceiptMessage(
        messageId,
        recipientUserId
      );
    if (!message) {
      return;
    }

    const sockets = await this.authorizedSockets(message.senderUserId);
    if (sockets.length === 0) {
      return;
    }
    const finalMessage =
      await this.eligibility.findCurrentReceiptMessage(
        messageId,
        recipientUserId
      );
    if (!finalMessage) {
      return;
    }
    this.emitToSockets(sockets, "message:receipt", {
      conversationId: finalMessage.conversationId,
      messageId,
      recipientUserId,
      receipt
    });
  }

  async emitTyping(
    recipientUserId: string,
    payload: {
      conversationId: string;
      userId: string;
      isTyping: boolean;
    }
  ): Promise<void> {
    const sockets = await this.authorizedSockets(recipientUserId);
    if (sockets.length === 0) {
      return;
    }
    const conversation = await this.eligibility.findCurrent(
      payload.userId,
      payload.conversationId
    );
    if (!conversation) {
      return;
    }
    const currentRecipient =
      conversation.clientUserId === payload.userId
        ? conversation.cashierUserId
        : conversation.clientUserId;
    if (currentRecipient !== recipientUserId) {
      return;
    }
    this.emitToSockets(sockets, "conversation:typing", payload);
  }

  async emitPresence(
    recipientUserIds: string[],
    payload: {
      userId: string;
      status: "online" | "offline";
      at: string;
    }
  ): Promise<void> {
    const recipients = [...new Set(recipientUserIds)];
    const socketGroups = await Promise.all(
      recipients.map(async (userId) => ({
        userId,
        sockets: await this.authorizedSockets(userId)
      }))
    );
    if (socketGroups.every((group) => group.sockets.length === 0)) {
      return;
    }
    const currentCounterparts = new Set(
      await this.eligibility.listCurrentCounterparts(payload.userId)
    );
    for (const group of socketGroups) {
      if (currentCounterparts.has(group.userId)) {
        this.emitToSockets(
          group.sockets,
          "presence:changed",
          payload
        );
      }
    }
  }

  disconnectUser(userId: string): void {
    this.server
      ?.in(this.userRoom(userId))
      .disconnectSockets(true);
  }

  async connectedSocketCount(userId: string): Promise<number> {
    if (!this.server) {
      return 0;
    }
    const sockets = await this.server
      .in(this.userRoom(userId))
      .fetchSockets();
    return sockets.length;
  }

  userRoom(userId: string): string {
    return `user:${userId}`;
  }

  private async authorizedSockets(userId: string) {
    if (!this.server) {
      return [];
    }

    const sockets = await this.server
      .in(this.userRoom(userId))
      .fetchSockets();
    const sessionIds = [
      ...new Set(
        sockets
          .map((socket) => this.socketSessionId(socket.data))
          .filter((id): id is string => Boolean(id))
      )
    ];
    if (sessionIds.length === 0) {
      for (const socket of sockets) {
        socket.disconnect(true);
      }
      return [];
    }

    const now = await this.databaseNow();
    const sessions = await this.prisma.authSession.findMany({
      where: {
        id: { in: sessionIds },
        userId,
        revokedAt: null,
        expiresAt: { gt: now },
        deviceId: { not: null },
        user: {
          passwordResetRequired: false,
          status: {
            notIn: [AccountStatus.SUSPENDED, AccountStatus.DELETED]
          }
        },
        device: {
          is: {
            userId,
            status: DeviceStatus.ACTIVE
          }
        }
      },
      select: {
        id: true,
        sessionVersion: true,
        user: {
          select: {
            sessionVersion: true
          }
        }
      }
    });
    const authorized = new Set(
      sessions
        .filter(
          (session) =>
            session.sessionVersion === session.user.sessionVersion
        )
        .map((session) => session.id)
    );

    return sockets.filter((socket) => {
      const sessionId = this.socketSessionId(socket.data);
      if (!sessionId || !authorized.has(sessionId)) {
        socket.disconnect(true);
        return false;
      }
      return true;
    });
  }

  private emitToSockets(
    sockets: Awaited<ReturnType<RealtimeService["authorizedSockets"]>>,
    event: string,
    payload: unknown
  ): void {
    for (const socket of sockets) {
      socket.emit(event, payload);
    }
  }

  private socketSessionId(data: unknown): string | undefined {
    if (!data || typeof data !== "object" || !("user" in data)) {
      return undefined;
    }
    const user = data.user;
    if (!user || typeof user !== "object" || !("sessionId" in user)) {
      return undefined;
    }
    return typeof user.sessionId === "string"
      ? user.sessionId
      : undefined;
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
}
