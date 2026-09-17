import { deepEqual, equal, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrismaService } from "../database/prisma.service";
import { NotificationsService } from "./notifications.service";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const NOTIFICATION_ID = "33333333-3333-4333-8333-333333333333";
const DATABASE_NOW = new Date("2026-08-02T12:00:00.000Z");

describe("NotificationsService", () => {
  it("marca lectura con el mismo reloj DB usado para autorizar", async () => {
    let update: Record<string, unknown> | undefined;
    const prisma = {
      $queryRaw: async () => [{ now: DATABASE_NOW }],
      inAppNotification: {
        updateMany: async (query: Record<string, unknown>) => {
          update = query;
          return { count: 1 };
        }
      }
    } as unknown as PrismaService;

    await new NotificationsService(prisma).markRead(
      USER_ID,
      NOTIFICATION_ID
    );

    deepEqual(update?.data, { readAt: DATABASE_NOW });
    equal(
      (update?.where as { userId?: string } | undefined)?.userId,
      USER_ID
    );
  });

  it("no permite confirmar por ID una notificación de otro usuario", async () => {
    const prisma = {
      $queryRaw: async () => [{ now: DATABASE_NOW }],
      inAppNotification: {
        updateMany: async () => ({ count: 0 }),
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          equal(where.userId, USER_ID);
          equal(where.id, NOTIFICATION_ID);
          return null;
        }
      }
    } as unknown as PrismaService;

    await rejects(
      () =>
        new NotificationsService(prisma).markRead(
          USER_ID,
          NOTIFICATION_ID
        ),
      /Aviso no encontrado/
    );
  });

  it("mantiene idempotencia cuando el aviso propio ya estaba leído", async () => {
    const prisma = {
      $queryRaw: async () => [{ now: DATABASE_NOW }],
      inAppNotification: {
        updateMany: async () => ({ count: 0 }),
        findFirst: async () => ({ readAt: DATABASE_NOW })
      }
    } as unknown as PrismaService;

    await new NotificationsService(prisma).markRead(
      USER_ID,
      NOTIFICATION_ID
    );
  });
});
