import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, limit: number) {
    const now = await this.databaseNow();
    const [items, unreadCount] = await Promise.all([
      this.prisma.inAppNotification.findMany({
        where: {
          userId,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          type: true,
          relatedEntityId: true,
          messageId: true,
          createdAt: true,
          readAt: true,
          expiresAt: true
        }
      }),
      this.prisma.inAppNotification.count({
        where: {
          userId,
          readAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
        }
      })
    ]);

    return { items, unreadCount };
  }

  async markRead(userId: string, notificationId: string) {
    const now = await this.databaseNow();
    const result = await this.prisma.inAppNotification.updateMany({
      where: {
        id: notificationId,
        userId,
        readAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
      },
      data: { readAt: now }
    });
    if (result.count === 0) {
      const exists = await this.prisma.inAppNotification.findFirst({
        where: { id: notificationId, userId },
        select: { readAt: true }
      });
      if (!exists) {
        throw new NotFoundException("Aviso no encontrado.");
      }
    }
  }

  async markAllRead(userId: string) {
    const now = await this.databaseNow();
    const result = await this.prisma.inAppNotification.updateMany({
      where: {
        userId,
        readAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
      },
      data: { readAt: now }
    });
    return { updated: result.count };
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
