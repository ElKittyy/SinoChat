import { Module } from "@nestjs/common";
import { AssignmentsModule } from "../assignments/assignments.module";
import { AuthModule } from "../auth/auth.module";
import { E2eeController } from "./e2ee.controller";
import { E2eeReleaseGuard } from "./e2ee-release.guard";
import { MatrixKeyDirectoryService } from "./matrix-key-directory.service";
import { MatrixToDeviceService } from "./matrix-to-device.service";
import { MatrixTransportController } from "./matrix-transport.controller";
import { MatrixCrossSigningService } from "./matrix-cross-signing.service";
import { MatrixDeviceCandidatesController } from "./matrix-device-candidates.controller";
import { MatrixDeviceCandidatesService } from "./matrix-device-candidates.service";
import { MatrixDeviceCandidateReviewController } from "./matrix-device-candidate-review.controller";
import { MatrixDeviceCandidateReviewService } from "./matrix-device-candidate-review.service";
import { MatrixDeviceVerificationController } from "./matrix-device-verification.controller";
import { MatrixDeviceVerificationService } from "./matrix-device-verification.service";
import { MatrixDeviceVerificationInboxController } from "./matrix-device-verification-inbox.controller";
import { MatrixDeviceVerificationInboxService } from "./matrix-device-verification-inbox.service";

@Module({
  imports: [AuthModule, AssignmentsModule],
  controllers: [E2eeController, MatrixTransportController, MatrixDeviceCandidatesController, MatrixDeviceCandidateReviewController,
    MatrixDeviceVerificationController, MatrixDeviceVerificationInboxController],
  providers: [
    E2eeReleaseGuard,
    MatrixKeyDirectoryService,
    MatrixCrossSigningService,
    MatrixDeviceCandidatesService,
    MatrixDeviceCandidateReviewService,
    MatrixDeviceVerificationService,
    MatrixDeviceVerificationInboxService,
    MatrixToDeviceService
  ],
  exports: [
    E2eeReleaseGuard,
    MatrixKeyDirectoryService,
    MatrixCrossSigningService,
    MatrixToDeviceService
  ]
})
export class E2eeModule {}
