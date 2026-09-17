import { Controller, Get, Header, Param, Post, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { SessionPrincipal } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { UserRole } from "../generated/prisma/enums";
import { E2eeReleaseGuard } from "./e2ee-release.guard";
import { MatrixDeviceCandidateReviewService } from "./matrix-device-candidate-review.service";

@Controller("e2ee/matrix/device-candidate-reviews")
@UseGuards(SessionAuthGuard, RolesGuard, E2eeReleaseGuard)
@Roles(UserRole.CLIENT, UserRole.CASHIER)
export class MatrixDeviceCandidateReviewController {
  constructor(private readonly reviews: MatrixDeviceCandidateReviewService) {}

  @Get()
  @Header("Cache-Control", "no-store")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  pending(@CurrentUser() user: SessionPrincipal) { return this.reviews.pending(user); }

  @Get(":candidateId")
  @Header("Cache-Control", "no-store")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  detail(@CurrentUser() user: SessionPrincipal, @Param("candidateId") id: string) { return this.reviews.detail(user, id); }

  @Post(":candidateId/reject")
  @Header("Cache-Control", "no-store")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  reject(@CurrentUser() user: SessionPrincipal, @Param("candidateId") id: string) { return this.reviews.reject(user, id); }
}
