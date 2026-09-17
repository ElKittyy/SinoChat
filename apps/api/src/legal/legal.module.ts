import { Module } from "@nestjs/common";
import { LegalDocumentsController } from "./legal-documents.controller";
import { LegalDocumentsService } from "./legal-documents.service";

@Module({
  controllers: [LegalDocumentsController],
  providers: [LegalDocumentsService]
})
export class LegalModule {}
