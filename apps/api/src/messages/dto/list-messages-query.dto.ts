import { Type } from "class-transformer";
import {
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min
} from "class-validator";

export class ListMessagesQueryDto {
  @IsUUID("4")
  deviceId!: string;

  @IsOptional()
  @Matches(/^\d{1,20}$/)
  afterSequence?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}
