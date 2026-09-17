import { IsBoolean, IsDateString, IsOptional } from "class-validator";

export class AdminActionDto {
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}

export class ActivateSubscriptionDto extends AdminActionDto {
  @IsOptional()
  @IsDateString({ strict: true })
  endsAt?: string;
}
