import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import type { SessionPrincipal } from "../auth/auth.types";
import { UserRole } from "../generated/prisma/enums";
import { E2eeReleaseGuard } from "./e2ee-release.guard";
import { MatrixKeyDirectoryService } from "./matrix-key-directory.service";
import { MatrixToDeviceService } from "./matrix-to-device.service";
import { MatrixCrossSigningService } from "./matrix-cross-signing.service";

@Controller("e2ee/matrix")
@UseGuards(SessionAuthGuard, RolesGuard, E2eeReleaseGuard)
@Roles(UserRole.CLIENT, UserRole.CASHIER)
export class MatrixTransportController {
  constructor(
    private readonly keys: MatrixKeyDirectoryService,
    private readonly toDevice: MatrixToDeviceService,
    private readonly crossSigning: MatrixCrossSigningService
  ) {}

  @Get("cross-signing")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  crossSigningStatus(@CurrentUser() user: SessionPrincipal) {
    return this.crossSigning.status(user);
  }

  @Post("cross-signing/bootstrap")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  bootstrapCrossSigning(@CurrentUser() user: SessionPrincipal, @Body() body: unknown) {
    return this.crossSigning.bootstrap(user, body);
  }

  @Post("devices/registration")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  reserveDevice(@CurrentUser() user: SessionPrincipal) {
    return this.keys.reserveDevice(user);
  }

  @Post("devices/registration/:registrationId/complete")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  completeDevice(
    @CurrentUser() user: SessionPrincipal,
    @Param("registrationId", ParseUUIDPipe) registrationId: string,
    @Body() body: unknown
  ) {
    return this.keys.completeInitialUpload(user, registrationId, body);
  }

  @Post("keys/upload")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  uploadKeys(
    @CurrentUser() user: SessionPrincipal,
    @Body() body: unknown
  ) {
    if (!user.deviceId) {
      throw new ForbiddenException(
        "La sesion no esta vinculada a un dispositivo."
      );
    }
    return this.keys.uploadKeys(user, body);
  }

  @Post("keys/query")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  queryRelatedKeys(
    @CurrentUser() user: SessionPrincipal,
    @Body() body: unknown
  ) {
    return this.keys.queryRelatedKeys(user, body);
  }

  @Post("keys/claim/:requestId")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  claimRelatedKeys(
    @CurrentUser() user: SessionPrincipal,
    @Param("requestId") requestId: string,
    @Body() body: unknown
  ) {
    return this.keys.claimRelatedKeys(user, requestId, body);
  }

  @Post("conversations/:conversationId/keys/query")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  queryKeys(
    @CurrentUser() user: SessionPrincipal,
    @Param("conversationId", ParseUUIDPipe) conversationId: string,
    @Body() body: unknown
  ) {
    return this.keys.queryKeys(user, conversationId, body);
  }

  @Post("conversations/:conversationId/keys/claim/:requestId")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  claimKeys(
    @CurrentUser() user: SessionPrincipal,
    @Param("conversationId", ParseUUIDPipe) conversationId: string,
    @Param("requestId") requestId: string,
    @Body() body: unknown
  ) {
    return this.keys.claimKeys(user, conversationId, requestId, body);
  }

  @Put("sendToDevice/:eventType/:transactionId")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  sendToDevice(
    @CurrentUser() user: SessionPrincipal,
    @Param("eventType") eventType: string,
    @Param("transactionId") transactionId: string,
    @Body() body: unknown
  ) {
    return this.toDevice.send(user, eventType, transactionId, body);
  }

  @Get("sync")
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  sync(
    @CurrentUser() user: SessionPrincipal,
    @Query("since") since?: string,
    @Query("timeout") timeout?: string
  ) {
    return this.toDevice.sync(user, since, timeout);
  }
}
