import { Type } from "class-transformer";
import {
  IsInt,
  IsOptional,
  Max,
  Min
} from "class-validator";

export class ListConversationsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page = 1;
}
