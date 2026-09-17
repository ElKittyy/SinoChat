import { Module } from "@nestjs/common";
import { AssignmentsService } from "./assignments.service";
import { SubscriptionExpiryWorker } from "./subscription-expiry.worker";
import { ConversationEligibilityService } from "./conversation-eligibility.service";

@Module({
  providers: [
    AssignmentsService,
    ConversationEligibilityService,
    SubscriptionExpiryWorker
  ],
  exports: [AssignmentsService, ConversationEligibilityService]
})
export class AssignmentsModule {}
