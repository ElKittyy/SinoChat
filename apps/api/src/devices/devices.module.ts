import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AssignmentsModule } from "../assignments/assignments.module";
import { DevicesController } from "./devices.controller";
import { DevicesService } from "./devices.service";
import { KeyRecoveryService } from "./key-recovery.service";
import { E2eeModule } from "../e2ee/e2ee.module";

@Module({
  imports: [AuthModule, AssignmentsModule, E2eeModule],
  controllers: [DevicesController],
  providers: [DevicesService, KeyRecoveryService],
  exports: [DevicesService, KeyRecoveryService]
})
export class DevicesModule {}
