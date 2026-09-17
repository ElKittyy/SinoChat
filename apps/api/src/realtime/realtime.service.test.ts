import { equal, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Server } from "socket.io";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import { PrismaService } from "../database/prisma.service";
import { RealtimeService } from "./realtime.service";

describe("RealtimeService subscription boundary", () => {
  it("no emite mensaje ni recibo cuando la elegibilidad post-commit vencio", async () => {
    let newMessageChecks = 0;
    let receiptChecks = 0;
    const eligibility = {
      findCurrentNewMessage: async () => {
        newMessageChecks += 1;
        return null;
      },
      findCurrentReceiptMessage: async () => {
        receiptChecks += 1;
        return null;
      }
    } as unknown as ConversationEligibilityService;
    const service = new RealtimeService(
      {} as PrismaService,
      eligibility
    );
    service.attachServer({} as Server);

    await service.notifyMessage("conversation", "sender", {
      id: "message",
      serverSequence: "1",
      kind: "TEXT",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000)
    });
    await service.notifyReceipt("message", "recipient", {});

    equal(newMessageChecks, 1);
    equal(receiptChecks, 1);
  });

  it("falla cerrado si no puede comprobar la elegibilidad", async () => {
    const eligibility = {
      findCurrentNewMessage: async () => {
        throw new Error("DATABASE_UNAVAILABLE");
      }
    } as unknown as ConversationEligibilityService;
    const service = new RealtimeService(
      {} as PrismaService,
      eligibility
    );
    service.attachServer({} as Server);

    await rejects(() =>
      service.notifyMessage("conversation", "sender", {
        id: "message",
        serverSequence: "1",
        kind: "TEXT",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000)
      })
    );
  });

  it("revalida despues de las sesiones y antes del emit sincronico", async () => {
    let messageChecks = 0;
    let receiptChecks = 0;
    let emits = 0;
    const eligibility = {
      findCurrentNewMessage: async () => {
        messageChecks += 1;
        return messageChecks === 1
          ? {
              id: "message",
              conversationId: "conversation",
              senderUserId: "sender",
              serverSequence: 1n,
              kind: "TEXT",
              createdAt: new Date(),
              expiresAt: new Date(Date.now() + 60_000),
              clientUserId: "sender",
              cashierUserId: "recipient"
            }
          : null;
      },
      findCurrentReceiptMessage: async () => {
        receiptChecks += 1;
        return receiptChecks === 1
          ? {
              conversationId: "conversation",
              senderUserId: "sender"
            }
          : null;
      }
    } as unknown as ConversationEligibilityService;
    const prisma = {
      $queryRaw: async () => [{ now: new Date() }],
      authSession: {
        findMany: async (input: { where: { id: { in: string[] } } }) =>
          input.where.id.in.map((id) => ({
            id,
            sessionVersion: 1,
            user: { sessionVersion: 1 }
          }))
      }
    } as unknown as PrismaService;
    const socket = {
      data: { user: { sessionId: "session" } },
      disconnect: () => undefined,
      emit: () => {
        emits += 1;
      }
    };
    const server = {
      in: () => ({ fetchSockets: async () => [socket] })
    } as unknown as Server;
    const service = new RealtimeService(prisma, eligibility);
    service.attachServer(server);

    await service.notifyMessage("conversation", "sender", {
      id: "message",
      serverSequence: "1",
      kind: "TEXT",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000)
    });
    await service.notifyReceipt("message", "recipient", {});

    equal(messageChecks, 2);
    equal(receiptChecks, 2);
    equal(emits, 0);
  });
});
