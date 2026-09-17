import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards
} from "@nestjs/common";
import type { PublicUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { ListNotificationsQueryDto } from "./dto/list-notifications-query.dto";
import { NotificationsService } from "./notifications.service";

@Controller("notifications")
@UseGuards(SessionAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentUser() user: PublicUser,
    @Query() query: ListNotificationsQueryDto
  ) {
    return this.notifications.list(user.id, query.limit);
  }

  @Patch("read-all")
  markAllRead(@CurrentUser() user: PublicUser) {
    return this.notifications.markAllRead(user.id);
  }

  @Patch(":notificationId/read")
  @HttpCode(204)
  async markRead(
    @CurrentUser() user: PublicUser,
    @Param("notificationId", ParseUUIDPipe) notificationId: string
  ): Promise<void> {
    await this.notifications.markRead(user.id, notificationId);
  }
}
