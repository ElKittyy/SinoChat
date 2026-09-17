import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type {
  PublicUser,
  SessionPrincipal
} from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { UserRole } from "../generated/prisma/enums";
import { ListConversationsQueryDto } from "./dto/list-conversations-query.dto";
import { ListMessagesQueryDto } from "./dto/list-messages-query.dto";
import { MessageReceiptDto } from "./dto/message-receipt.dto";
import { RequestUploadDto } from "./dto/request-upload.dto";
import { SendMessageDto } from "./dto/send-message.dto";
import { MessagesService } from "./messages.service";
import { RealtimeService } from "../realtime/realtime.service";
import { E2eeReleaseGuard } from "../e2ee/e2ee-release.guard";

@Controller()
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(UserRole.CLIENT, UserRole.CASHIER)
export class MessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly realtime: RealtimeService
  ) {}

  @Get("conversations")
  listConversations(
    @CurrentUser() user: PublicUser,
    @Query() query: ListConversationsQueryDto
  ) {
    return this.messages.listConversations(user.id, user.role, query);
  }

  @Get("conversations/:conversationId/messages")
  @UseGuards(E2eeReleaseGuard)
  listMessages(
    @CurrentUser() user: SessionPrincipal,
    @Param("conversationId", ParseUUIDPipe) conversationId: string,
    @Query() query: ListMessagesQueryDto
  ) {
    this.assertSessionDevice(user, query.deviceId);
    return this.messages.listMessages(user.id, conversationId, query);
  }

  @Post("conversations/:conversationId/attachments/upload-grant")
  @UseGuards(E2eeReleaseGuard)
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  requestUpload(
    @CurrentUser() user: SessionPrincipal,
    @Param("conversationId", ParseUUIDPipe) conversationId: string,
    @Body() input: RequestUploadDto
  ) {
    this.assertSessionDevice(user);
    return this.messages.requestUpload(user.id, conversationId, input);
  }

  @Post("conversations/:conversationId/messages")
  @UseGuards(E2eeReleaseGuard)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async send(
    @CurrentUser() user: SessionPrincipal,
    @Param("conversationId", ParseUUIDPipe) conversationId: string,
    @Body() input: SendMessageDto
  ) {
    this.assertSessionDevice(user, input.senderDeviceId);
    const result = await this.messages.send(
      user.id,
      conversationId,
      input
    );
    if (result.created) {
      await this.realtime.notifyMessage(conversationId, user.id, result);
    }
    return result;
  }

  @Patch("messages/:messageId/receipt")
  @UseGuards(E2eeReleaseGuard)
  async updateReceipt(
    @CurrentUser() user: SessionPrincipal,
    @Param("messageId", ParseUUIDPipe) messageId: string,
    @Body() input: MessageReceiptDto
  ) {
    this.assertSessionDevice(user);
    const result = await this.messages.updateReceipt(
      user.id,
      messageId,
      input
    );
    await this.realtime.notifyReceipt(messageId, user.id, result);
    return result;
  }

  private assertSessionDevice(
    user: SessionPrincipal,
    requestedDeviceId?: string
  ): asserts user is SessionPrincipal & { deviceId: string } {
    if (
      !user.deviceId ||
      (requestedDeviceId !== undefined &&
        requestedDeviceId !== user.deviceId)
    ) {
      throw new ForbiddenException(
        "La sesión no está vinculada al dispositivo solicitado."
      );
    }
  }
}
