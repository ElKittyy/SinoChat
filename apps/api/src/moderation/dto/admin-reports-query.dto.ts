import { Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min
} from "class-validator";
import { ReportStatus } from "../../generated/prisma/enums";

export class AdminReportsQueryDto {
  @IsOptional()
  @IsEnum(ReportStatus)
  status?: ReportStatus;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}
