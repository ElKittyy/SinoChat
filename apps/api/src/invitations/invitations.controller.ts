import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { SkipCsrf } from "../auth/csrf.decorator";
import { ValidateInvitationDto } from "./dto/validate-invitation.dto";
import { InvitationsService } from "./invitations.service";

@Controller("invitations")
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post("validate")
  @SkipCsrf()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  validate(@Body() input: ValidateInvitationDto) {
    return this.invitations.validate(input.code, input.role);
  }
}
