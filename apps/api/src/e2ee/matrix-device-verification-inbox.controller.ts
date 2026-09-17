import { Controller, Get, Header, Param, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { SessionPrincipal } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { UserRole } from "../generated/prisma/enums";
import { E2eeReleaseGuard } from "./e2ee-release.guard";
import { MatrixDeviceVerificationInboxService } from "./matrix-device-verification-inbox.service";

@Controller("e2ee/matrix/device-verification-inbox")
@UseGuards(SessionAuthGuard, RolesGuard, E2eeReleaseGuard)
@Roles(UserRole.CLIENT, UserRole.CASHIER)
export class MatrixDeviceVerificationInboxController {
  constructor(private readonly inbox: MatrixDeviceVerificationInboxService) {}

  @Get(":candidateId")
  @Header("Cache-Control", "no-store")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  poll(@CurrentUser() user: SessionPrincipal, @Param("candidateId") id: string) { return this.inbox.poll(user, id); }
}
