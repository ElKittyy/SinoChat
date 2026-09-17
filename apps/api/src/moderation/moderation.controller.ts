import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { PublicUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { UserRole } from "../generated/prisma/enums";
import { RequestEvidenceUploadDto } from "./dto/evidence-upload.dto";
import {
  ModerationReasonDto,
  ReportCashierDto
} from "./dto/moderation-action.dto";
import { ModerationService } from "./moderation.service";

@Controller("moderation")
@UseGuards(SessionAuthGuard, RolesGuard)
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Get("investigation-key")
  @Roles(UserRole.CLIENT)
  activeInvestigationKey() {
    return this.moderation.activeInvestigationKey();
  }

  @Post("report-evidence/upload-grant")
  @Roles(UserRole.CLIENT)
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  requestEvidenceUpload(
    @CurrentUser() client: PublicUser,
    @Body() input: RequestEvidenceUploadDto
  ) {
    return this.moderation.requestEvidenceUpload(client.id, input);
  }

  @Post("report-cashier")
  @Roles(UserRole.CLIENT)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  reportCashier(
    @CurrentUser() client: PublicUser,
    @Body() input: ReportCashierDto
  ) {
    return this.moderation.reportCashier(client.id, input);
  }

  @Post("cashier/clients/:clientId/block")
  @Roles(UserRole.CASHIER)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  blockClient(
    @CurrentUser() cashier: PublicUser,
    @Param("clientId", new ParseUUIDPipe({ version: "4" }))
    clientId: string,
    @Body() input: ModerationReasonDto
  ) {
    return this.moderation.blockClient(
      cashier.id,
      clientId,
      input
    );
  }
}
