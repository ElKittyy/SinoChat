import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AssignmentsModule } from "../assignments/assignments.module";
import { MessagesController } from "./messages.controller";
import { MessagesService } from "./messages.service";
import { UploadGrantService } from "./upload-grant.service";
import { E2eeModule } from "../e2ee/e2ee.module";

@Module({
  imports: [AuthModule, AssignmentsModule, E2eeModule],
  controllers: [MessagesController],
  providers: [MessagesService, UploadGrantService],
  exports: [MessagesService]
})
export class MessagesModule {}
