import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer
} from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import { AuthService } from "../auth/auth.service";
import { sessionCookieName } from "../auth/auth.constants";
import type { SessionPrincipal } from "../auth/auth.types";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import { UserRole } from "../generated/prisma/enums";
import { RealtimeService } from "./realtime.service";
import { RateLimitStorage } from "../rate-limit/rate-limit.storage";
import {
  consumeSocketPacketLocally,
  type LocalRateLimitBuckets
} from "./socket-packet-rate-limit";
import { ClientAddressResolver } from "./client-address-resolver";
import { isE2eeReleased } from "../e2ee/e2ee-release";

interface TypingPayload {
  conversationId: string;
  isTyping: boolean;
}

const SESSION_REVALIDATION_MILLISECONDS = 30_000;
const CONNECTION_IP_POLICY = {
  ttl: 60_000,
  limit: 120,
  blockDuration: 60_000
} as const;
const CONNECTION_SESSION_POLICY = {
  ttl: 60_000,
  limit: 20,
  blockDuration: 60_000
} as const;
const PACKET_POLICY = {
  ttl: 60_000,
  limit: 120,
  blockDuration: 60_000
} as const;
const TYPING_POLICY = {
  ttl: 60_000,
  limit: 60,
  blockDuration: 60_000
} as const;

@WebSocketGateway({
  namespace: "/chat",
  transports: ["websocket"],
  cors: {
    origin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
    credentials: true
  }
})
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly auth: AuthService,
    private readonly eligibility: ConversationEligibilityService,
    private readonly realtime: RealtimeService,
    private readonly rateLimits: RateLimitStorage,
    private readonly clientAddresses: ClientAddressResolver
  ) {}

  afterInit(server: Server): void {
    this.realtime.attachServer(server);
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      if (!isE2eeReleased()) {
        client.disconnect(true);
        return;
      }

      if (!this.isAllowedOrigin(client.handshake.headers.origin)) {
        client.disconnect(true);
        return;
      }

      const rawSession = this.readCookie(
        client.handshake.headers.cookie,
        sessionCookieName()
      );
      if (!rawSession) {
        client.disconnect(true);
        return;
      }
      client.data.rawSession = rawSession;
      client.data.localRateLimitBuckets = new Map<
        string,
        {
          windowStartedAt: number;
          hits: number;
          blockedUntil: number;
        }
      >();
      client.use((packet, next) => {
        const eventName =
          typeof packet[0] === "string" ? packet[0] : "";
        const buckets = client.data.localRateLimitBuckets as
          | LocalRateLimitBuckets
          | undefined;
        if (
          !buckets ||
          !consumeSocketPacketLocally(buckets, eventName)
        ) {
          next(new Error("Demasiados eventos o evento no permitido."));
          return;
        }

        void this.authorizePacket(client, eventName).then(
          (valid) => {
            if (valid) {
              next();
            } else {
              next(new Error("La solicitud no está disponible."));
            }
          },
          () => {
            client.disconnect(true);
            next(new Error("La solicitud no está disponible."));
          }
        );
      });

      const [ipLimit, sessionLimit] = await Promise.all([
        this.rateLimits.consume(
          "ws-connect-ip",
          this.clientAddresses.resolve(client.request),
          CONNECTION_IP_POLICY
        ),
        this.rateLimits.consume(
          "ws-connect-session",
          rawSession,
          CONNECTION_SESSION_POLICY
        )
      ]);
      if (ipLimit.isBlocked || sessionLimit.isBlocked) {
        client.disconnect(true);
        return;
      }

      const user = await this.auth.getSessionPrincipal(rawSession);
      if (user.role === UserRole.ADMIN || !user.deviceId) {
        client.disconnect(true);
        return;
      }

      client.data.user = user;
      const revalidationTimer = setInterval(() => {
        void this.revalidateSession(client);
      }, SESSION_REVALIDATION_MILLISECONDS);
      revalidationTimer.unref();
      client.data.revalidationTimer = revalidationTimer;
      this.scheduleExpiry(client, user.sessionExpiresAt);

      await client.join(this.realtime.userRoom(user.id));
      // Presencia es idempotente. Emitir en cada conexión evita perder el
      // cambio cuando dos instancias aceptan sockets simultáneamente.
      await this.publishPresence(user.id, "online");
    } catch {
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const revalidationTimer = client.data.revalidationTimer as
      | NodeJS.Timeout
      | undefined;
    if (revalidationTimer) {
      clearInterval(revalidationTimer);
    }
    const expiryTimer = client.data.expiryTimer as
      | NodeJS.Timeout
      | undefined;
    if (expiryTimer) {
      clearTimeout(expiryTimer);
    }

    const user = client.data.user as SessionPrincipal | undefined;
    if (!user) {
      return;
    }

    const connectedSockets =
      await this.realtime.connectedSocketCount(user.id);
    if (connectedSockets === 0) {
      await this.publishPresence(user.id, "offline");
    }
  }

  @SubscribeMessage("conversation:typing")
  async handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: unknown
  ): Promise<void> {
    const user = client.data.user as SessionPrincipal | undefined;
    const typing = this.parseTyping(payload);
    if (!user || !typing) {
      return;
    }

    const now = Date.now();
    const lastTypingAt = Number(client.data.lastTypingAt ?? 0);
    if (now - lastTypingAt < 250) {
      return;
    }
    client.data.lastTypingAt = now;

    const conversation = await this.eligibility.findCurrent(
      user.id,
      typing.conversationId
    );
    if (!conversation) {
      return;
    }

    const recipientUserId =
      conversation.clientUserId === user.id
        ? conversation.cashierUserId
        : conversation.clientUserId;
    await this.realtime.emitTyping(recipientUserId, {
      conversationId: typing.conversationId,
      userId: user.id,
      isTyping: typing.isTyping
    });
  }

  private async publishPresence(
    userId: string,
    status: "online" | "offline"
  ): Promise<void> {
    const counterpartIds =
      await this.eligibility.listCurrentCounterparts(userId);
    await this.realtime.emitPresence(counterpartIds, {
      userId,
      status,
      at: new Date().toISOString()
    });
  }

  private parseTyping(value: unknown): TypingPayload | null {
    if (!value || typeof value !== "object") {
      return null;
    }
    const candidate = value as Partial<TypingPayload>;
    if (
      typeof candidate.conversationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        candidate.conversationId
      ) ||
      typeof candidate.isTyping !== "boolean"
    ) {
      return null;
    }
    return {
      conversationId: candidate.conversationId,
      isTyping: candidate.isTyping
    };
  }

  private async revalidateSession(client: Socket): Promise<boolean> {
    const current = client.data.user as SessionPrincipal | undefined;
    const rawSession = client.data.rawSession as string | undefined;
    if (!current || !rawSession || !client.connected) {
      return false;
    }

    try {
      const refreshed = await this.auth.getSessionPrincipal(rawSession);
      if (
        refreshed.id !== current.id ||
        refreshed.role === UserRole.ADMIN
      ) {
        client.disconnect(true);
        return false;
      }
      client.data.user = refreshed;
      this.scheduleExpiry(client, refreshed.sessionExpiresAt);
      return true;
    } catch {
      client.disconnect(true);
      return false;
    }
  }

  private async authorizePacket(
    client: Socket,
    eventName: string
  ): Promise<boolean> {
    const current = client.data.user as SessionPrincipal | undefined;
    const rawSession = client.data.rawSession as string | undefined;
    if (!current || !rawSession) {
      return false;
    }

    const packetLimit = await this.rateLimits.consume(
      "ws-packet-user",
      current.id,
      PACKET_POLICY
    );
    if (packetLimit.isBlocked) {
      return false;
    }
    if (eventName === "conversation:typing") {
      const typingLimit = await this.rateLimits.consume(
        "ws-typing-user",
        current.id,
        TYPING_POLICY
      );
      if (typingLimit.isBlocked) {
        return false;
      }
    }

    return this.revalidateSession(client);
  }

  private scheduleExpiry(client: Socket, expiresAt: Date): void {
    const currentTimer = client.data.expiryTimer as
      | NodeJS.Timeout
      | undefined;
    if (currentTimer) {
      clearTimeout(currentTimer);
    }

    const remaining = expiresAt.getTime() - Date.now();
    if (remaining <= 0) {
      client.disconnect(true);
      return;
    }

    const timer = setTimeout(
      () => {
        void this.revalidateSession(client);
      },
      Math.min(remaining, 2_147_000_000)
    );
    timer.unref();
    client.data.expiryTimer = timer;
  }

  private readCookie(
    header: string | undefined,
    name: string
  ): string | undefined {
    if (!header) {
      return undefined;
    }
    for (const part of header.split(";")) {
      const separator = part.indexOf("=");
      if (separator < 0) {
        continue;
      }
      const key = part.slice(0, separator).trim();
      if (key !== name) {
        continue;
      }
      const value = part.slice(separator + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
    return undefined;
  }

  private isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) {
      return process.env.NODE_ENV !== "production";
    }
    try {
      const expected = new URL(
        process.env.WEB_ORIGIN ?? "http://localhost:5173"
      ).origin;
      return new URL(origin).origin === expected;
    } catch {
      return false;
    }
  }
}
