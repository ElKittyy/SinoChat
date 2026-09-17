import { Transform } from "class-transformer";
import {
  IsEnum,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength
} from "class-validator";
import { ReportOutcome } from "../../generated/prisma/enums";

export class ModerationReasonDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value
  )
  @IsString()
  @Length(20, 1000)
  @Matches(/[\p{L}\p{N}]/u)
  reason!: string;
}

export class ReportCashierDto extends ModerationReasonDto {
  @IsString()
  @MinLength(40)
  @MaxLength(4096)
  evidenceGrantToken!: string;
}

export class CloseReportDto {
  @IsEnum(ReportOutcome)
  outcome!: ReportOutcome;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value
  )
  @IsString()
  @Length(1, 2000)
  @Matches(/[\p{L}\p{N}]/u)
  resolutionSummary!: string;
}

export class EvidenceAccessDto {
  @IsString()
  @Length(10, 128)
  currentPassword!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value
  )
  @IsString()
  @Length(20, 1000)
  @Matches(/[\p{L}\p{N}]/u)
  reason!: string;
}
