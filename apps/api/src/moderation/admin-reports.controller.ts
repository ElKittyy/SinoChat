import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { PublicUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { AdminMfaRecentGuard } from "../auth/admin-mfa-recent.guard";
import { UserRole } from "../generated/prisma/enums";
import { AdminReportsService } from "./admin-reports.service";
import { AdminReportsQueryDto } from "./dto/admin-reports-query.dto";
import {
  CloseReportDto,
  EvidenceAccessDto
} from "./dto/moderation-action.dto";

@Controller("admin/reports")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminReportsController {
  constructor(private readonly reports: AdminReportsService) {}

  @Get()
  list(@Query() query: AdminReportsQueryDto) {
    return this.reports.list(query);
  }

  @Patch(":reportId/review")
  beginReview(
    @CurrentUser() admin: PublicUser,
    @Param("reportId", new ParseUUIDPipe({ version: "4" }))
    reportId: string
  ) {
    return this.reports.beginReview(admin.id, reportId);
  }

  @Post(":reportId/evidence-access")
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(AdminMfaRecentGuard)
  evidence(
    @CurrentUser() admin: PublicUser,
    @Param("reportId", new ParseUUIDPipe({ version: "4" }))
    reportId: string,
    @Body() input: EvidenceAccessDto
  ) {
    return this.reports.evidenceDownload(admin.id, reportId, input);
  }

  @Patch(":reportId/close")
  @HttpCode(202)
  close(
    @CurrentUser() admin: PublicUser,
    @Param("reportId", new ParseUUIDPipe({ version: "4" }))
    reportId: string,
    @Body() input: CloseReportDto
  ) {
    return this.reports.close(admin.id, reportId, input);
  }
}
