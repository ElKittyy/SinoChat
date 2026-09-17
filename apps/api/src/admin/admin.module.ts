import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AssignmentsModule } from "../assignments/assignments.module";
import { InvitationsModule } from "../invitations/invitations.module";
import { ModerationModule } from "../moderation/moderation.module";
import { AdminInvitationsController } from "./admin-invitations.controller";
import { AdminInvitationsService } from "./admin-invitations.service";
import { AdminUsersController } from "./admin-users.controller";
import { AdminUsersService } from "./admin-users.service";

@Module({
  imports: [
    AuthModule,
    InvitationsModule,
    AssignmentsModule,
    ModerationModule
  ],
  controllers: [AdminInvitationsController, AdminUsersController],
  providers: [AdminInvitationsService, AdminUsersService]
})
export class AdminModule {}
