import { Body, Controller, Header, Param, Put, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { SessionPrincipal } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { UserRole } from "../generated/prisma/enums";
import { E2eeReleaseGuard } from "./e2ee-release.guard";
import { MatrixDeviceVerificationService } from "./matrix-device-verification.service";

@Controller("e2ee/matrix/device-verification-flows")
@UseGuards(SessionAuthGuard, RolesGuard, E2eeReleaseGuard)
@Roles(UserRole.CLIENT, UserRole.CASHIER)
export class MatrixDeviceVerificationController {
  constructor(private readonly verification: MatrixDeviceVerificationService) {}

  @Put(":candidateId/:flowId/:transactionId")
  @Header("Cache-Control", "no-store")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  open(@CurrentUser() user: SessionPrincipal, @Param("candidateId") candidateId: string,
    @Param("flowId") flowId: string, @Param("transactionId") transactionId: string, @Body() body: unknown) {
    return this.verification.open(user, candidateId, flowId, transactionId, body);
  }
}
