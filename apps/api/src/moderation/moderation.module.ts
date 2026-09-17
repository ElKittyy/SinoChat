import { Module } from "@nestjs/common";
import { AssignmentsModule } from "../assignments/assignments.module";
import { AuthModule } from "../auth/auth.module";
import { AdminReportsController } from "./admin-reports.controller";
import { AdminReportsService } from "./admin-reports.service";
import { EvidenceGrantService } from "./evidence-grant.service";
import { ModerationController } from "./moderation.controller";
import { ModerationService } from "./moderation.service";
import { ReportClosureWorker } from "./report-closure.worker";

@Module({
  imports: [AuthModule, AssignmentsModule],
  controllers: [ModerationController, AdminReportsController],
  providers: [
    EvidenceGrantService,
    ModerationService,
    ReportClosureWorker,
    AdminReportsService
  ]
})
export class ModerationModule {}
