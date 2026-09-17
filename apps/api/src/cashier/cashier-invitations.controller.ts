import {
  Controller,
  HttpCode,
  Post,
  UseGuards
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { UserRole } from "../generated/prisma/enums";
import { CurrentUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import type { PublicUser } from "../auth/auth.types";
import { CashierInvitationsService } from "./cashier-invitations.service";

@Controller("cashier/invitation")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(UserRole.CASHIER)
export class CashierInvitationsController {
  constructor(private readonly invitations: CashierInvitationsService) {}

  @Post("reveal")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  getCurrent(@CurrentUser() cashier: PublicUser) {
    return this.invitations.getCurrent(cashier.id);
  }

  @Post("rotate")
  rotate(@CurrentUser() cashier: PublicUser) {
    return this.invitations.rotate(cashier.id);
  }
}
