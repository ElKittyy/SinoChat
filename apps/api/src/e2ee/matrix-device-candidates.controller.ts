import { Body, Controller, Get, Param, Post, Put, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import type { SessionPrincipal } from "../auth/auth.types";
import { UserRole } from "../generated/prisma/enums";
import { E2eeReleaseGuard } from "./e2ee-release.guard";
import { MatrixDeviceCandidatesService } from "./matrix-device-candidates.service";

@Controller("e2ee/matrix/device-candidates")
@UseGuards(SessionAuthGuard, RolesGuard, E2eeReleaseGuard)
@Roles(UserRole.CLIENT, UserRole.CASHIER)
export class MatrixDeviceCandidatesController {
  constructor(private readonly candidates: MatrixDeviceCandidatesService) {}

  @Put(":candidateId")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  reserve(@CurrentUser() user: SessionPrincipal, @Param("candidateId") id: string, @Body() body: unknown) {
    return this.candidates.reserve(user, id, body);
  }

  @Get(":candidateId")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  status(@CurrentUser() user: SessionPrincipal, @Param("candidateId") id: string) {
    return this.candidates.status(user, id);
  }

  @Post(":candidateId/cancel")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  cancel(@CurrentUser() user: SessionPrincipal, @Param("candidateId") id: string) {
    return this.candidates.cancel(user, id);
  }
}
