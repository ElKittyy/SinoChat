import { equal } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Socket } from "socket.io";
import type { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import type { AuthService } from "../auth/auth.service";
import { UserRole } from "../generated/prisma/enums";
import { ChatGateway } from "./chat.gateway";
import type { RealtimeService } from "./realtime.service";
import type { RateLimitStorage } from "../rate-limit/rate-limit.storage";
import type { ClientAddressResolver } from "./client-address-resolver";

describe("ChatGateway subscription boundary", () => {
  it("no emite typing ni presencia hacia conversaciones vencidas", async () => {
    let typingEmits = 0;
    let presenceEmits = 0;
    let conversationChecks = 0;
    let presenceChecks = 0;
    const eligibility = {
      findCurrent: async () => {
        conversationChecks += 1;
        return null;
      },
      listCurrentCounterparts: async () => {
        presenceChecks += 1;
        return [];
      }
    } as unknown as ConversationEligibilityService;
    const realtime = {
      emitTyping: async () => {
        typingEmits += 1;
      },
      emitPresence: async (recipients: string[]) => {
        presenceEmits += recipients.length;
      }
    } as unknown as RealtimeService;
    const gateway = new ChatGateway(
      {} as AuthService,
      eligibility,
      realtime,
      {
        consume: async () => ({
          totalHits: 1,
          timeToExpire: 60,
          isBlocked: false,
          timeToBlockExpire: 0
        })
      } as unknown as RateLimitStorage,
      {
        resolve: () => "203.0.113.10"
      } as unknown as ClientAddressResolver
    );
    const socket = {
      data: {
        user: {
          id: "11111111-1111-4111-8111-111111111111",
          role: UserRole.CLIENT
        }
      }
    } as unknown as Socket;

    await gateway.handleTyping(socket, {
      conversationId: "22222222-2222-4222-8222-222222222222",
      isTyping: true
    });
    await (
      gateway as unknown as {
        publishPresence(
          userId: string,
          status: "online" | "offline"
        ): Promise<void>;
      }
    ).publishPresence(
      "11111111-1111-4111-8111-111111111111",
      "online"
    );

    equal(conversationChecks, 1);
    equal(presenceChecks, 1);
    equal(typingEmits, 0);
    equal(presenceEmits, 0);
  });

  it("aplica el límite distribuido antes de revalidar la sesión en DB", async () => {
    let sessionQueries = 0;
    const auth = {
      getSessionPrincipal: async () => {
        sessionQueries += 1;
        throw new Error("no debe consultar la DB");
      }
    } as unknown as AuthService;
    const rateLimits = {
      consume: async (scope: string) => ({
        totalHits: 121,
        timeToExpire: 60,
        isBlocked: scope === "ws-packet-user",
        timeToBlockExpire: 60
      })
    } as unknown as RateLimitStorage;
    const gateway = new ChatGateway(
      auth,
      {} as ConversationEligibilityService,
      {} as RealtimeService,
      rateLimits,
      {
        resolve: () => "203.0.113.10"
      } as unknown as ClientAddressResolver
    );
    const socket = {
      connected: true,
      data: {
        rawSession: "session-token-high-entropy",
        user: {
          id: "11111111-1111-4111-8111-111111111111",
          role: UserRole.CLIENT
        }
      }
    } as unknown as Socket;

    const allowed = await (
      gateway as unknown as {
        authorizePacket(client: Socket, eventName: string): Promise<boolean>;
      }
    ).authorizePacket(socket, "conversation:typing");

    equal(allowed, false);
    equal(sessionQueries, 0);
  });
});
