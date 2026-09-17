import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser } from "../auth/current-user.decorator";
import type { SessionPrincipal } from "../auth/auth.types";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { UserRole } from "../generated/prisma/enums";
import { DevicesService } from "./devices.service";
import { RegisterDeviceDto } from "./dto/register-device.dto";
import { UploadPreKeysDto } from "./dto/upload-pre-keys.dto";
import { SaveRecoveryBundleDto } from "./dto/save-recovery-bundle.dto";
import { KeyRecoveryService } from "./key-recovery.service";
import { BindDeviceSessionDto } from "./dto/bind-device-session.dto";
import { E2eeReleaseGuard } from "../e2ee/e2ee-release.guard";

@Controller("devices")
@UseGuards(SessionAuthGuard, RolesGuard, E2eeReleaseGuard)
@Roles(UserRole.CLIENT, UserRole.CASHIER)
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly recovery: KeyRecoveryService
  ) {}

  @Post()
  register(
    @CurrentUser() user: SessionPrincipal,
    @Body() input: RegisterDeviceDto
  ) {
    return this.devices.register(user, input);
  }

  @Post(":deviceId/bind-session")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  bindSession(
    @CurrentUser() user: SessionPrincipal,
    @Param("deviceId", ParseUUIDPipe) deviceId: string,
    @Body() input: BindDeviceSessionDto
  ) {
    return this.devices.bindSession(user, deviceId, input);
  }

  @Get()
  list(@CurrentUser() user: SessionPrincipal) {
    return this.devices.listOwn(user.id);
  }

  @Delete(":deviceId")
  revoke(
    @CurrentUser() user: SessionPrincipal,
    @Param("deviceId", ParseUUIDPipe) deviceId: string
  ) {
    this.assertSessionDevice(user, deviceId);
    return this.devices.revoke(user.id, deviceId);
  }

  @Post(":deviceId/pre-keys")
  uploadPreKeys(
    @CurrentUser() user: SessionPrincipal,
    @Param("deviceId", ParseUUIDPipe) deviceId: string,
    @Body() input: UploadPreKeysDto
  ) {
    this.assertSessionDevice(user, deviceId);
    return this.devices.uploadPreKeys(
      user.id,
      deviceId,
      input.oneTimePreKeys
    );
  }

  @Post("peer-bundles/:conversationId/claim")
  claimPeerBundles(
    @CurrentUser() user: SessionPrincipal,
    @Param("conversationId", ParseUUIDPipe) conversationId: string
  ) {
    this.assertSessionDevice(user);
    return this.devices.claimPeerBundles(
      user.id,
      user.deviceId,
      conversationId
    );
  }

  @Post("recovery-bundle")
  saveRecoveryBundle(
    @CurrentUser() user: SessionPrincipal,
    @Body() input: SaveRecoveryBundleDto
  ) {
    this.assertSessionDevice(user, input.sourceDeviceId);
    return this.recovery.save(user.id, input);
  }

  @Get("recovery-bundle")
  getRecoveryBundle(@CurrentUser() user: SessionPrincipal) {
    return this.recovery.getLatest(user.id);
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
