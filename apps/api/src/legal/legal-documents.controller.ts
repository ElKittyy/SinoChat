import {
  Controller,
  Get,
  Param,
  Res
} from "@nestjs/common";
import type { Response } from "express";
import { LegalVersionParamDto } from "./dto/legal-version-param.dto";
import {
  LegalDocumentsService,
  type ServedTermsDocument
} from "./legal-documents.service";

@Controller("legal/terms")
export class LegalDocumentsController {
  constructor(private readonly documents: LegalDocumentsService) {}

  @Get("current")
  async current(@Res() response: Response): Promise<void> {
    this.send(
      response,
      await this.documents.currentTerms(),
      false
    );
  }

  @Get(":version")
  async version(
    @Param() params: LegalVersionParamDto,
    @Res() response: Response
  ): Promise<void> {
    this.send(
      response,
      await this.documents.termsByVersion(params.version),
      true
    );
  }

  private send(
    response: Response,
    document: ServedTermsDocument,
    immutable: boolean
  ): void {
    response.removeHeader("Pragma");
    response.setHeader(
      "Cache-Control",
      immutable
        ? "public, max-age=31536000, immutable, no-transform"
        : "public, max-age=60, must-revalidate, no-transform"
    );
    response.setHeader(
      "Content-Type",
      `${document.contentType}; charset=utf-8`
    );
    response.setHeader("Content-Length", document.byteSize.toString());
    response.setHeader("ETag", `"sha256-${document.contentHash}"`);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "X-SinoChat-Terms-Version",
      document.version
    );
    response.setHeader(
      "X-SinoChat-Terms-SHA256",
      document.contentHash
    );
    response.send(Buffer.from(document.content));
  }
}
