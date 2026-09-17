import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards
} from "@nestjs/common";
import { UserRole } from "../generated/prisma/enums";
import { CurrentUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import type { PublicUser } from "../auth/auth.types";
import { AdminInvitationsService } from "./admin-invitations.service";
import { CreateCashierInvitationDto } from "./dto/create-cashier-invitation.dto";
import {
  CashierOnboardingInvitationsQueryDto,
  RevokeCashierOnboardingInvitationDto
} from "./dto/cashier-onboarding-invitations.dto";

@Controller("admin/cashier-invitations")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminInvitationsController {
  constructor(private readonly invitations: AdminInvitationsService) {}

  @Get()
  list(@Query() query: CashierOnboardingInvitationsQueryDto) {
    return this.invitations.listCashierInvitations(query);
  }

  @Post()
  create(
    @CurrentUser() admin: PublicUser,
    @Body() input: CreateCashierInvitationDto
  ) {
    return this.invitations.createCashierInvitation(
      admin.id,
      input.expiresInHours
    );
  }

  @Patch(":invitationId/revoke")
  revoke(
    @CurrentUser() admin: PublicUser,
    @Param("invitationId", new ParseUUIDPipe({ version: "4" }))
    invitationId: string,
    @Body() _input: RevokeCashierOnboardingInvitationDto
  ) {
    return this.invitations.revokeCashierInvitation(
      admin.id,
      invitationId
    );
  }
}
