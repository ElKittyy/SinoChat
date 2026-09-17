import { Module } from "@nestjs/common";
import { InvitationsController } from "./invitations.controller";
import { InvitationsService } from "./invitations.service";
import { InvitationCryptoService } from "./invitation-crypto.service";
import { InvitationKeyringAuditService } from "./invitation-keyring-audit.service";

@Module({
  controllers: [InvitationsController],
  providers: [
    InvitationsService,
    InvitationCryptoService,
    InvitationKeyringAuditService
  ],
  exports: [InvitationsService, InvitationCryptoService]
})
export class InvitationsModule {}
