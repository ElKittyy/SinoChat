import { Transform, Type } from "class-transformer";
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min
} from "class-validator";

export class AdminDirectoryQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value
  )
  @IsString()
  @Length(1, 50)
  search?: string;

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

export class AdminAssignmentsQueryDto extends AdminDirectoryQueryDto {
  @IsOptional()
  @IsUUID("4")
  cashierId?: string;
}

export class AdminSubscriptionsQueryDto extends AdminDirectoryQueryDto {}
