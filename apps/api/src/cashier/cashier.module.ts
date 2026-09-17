import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AssignmentsModule } from "../assignments/assignments.module";
import { InvitationsModule } from "../invitations/invitations.module";
import { CashierInvitationsController } from "./cashier-invitations.controller";
import { CashierInvitationsService } from "./cashier-invitations.service";

@Module({
  imports: [AuthModule, InvitationsModule, AssignmentsModule],
  controllers: [CashierInvitationsController],
  providers: [CashierInvitationsService]
})
export class CashierModule {}
