import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";
import { AdminActionDto } from "./admin-action.dto";

export const CASHIER_ONBOARDING_INVITATION_STATUSES = [
  "ACTIVE",
  "EXPIRED",
  "REDEEMED",
  "REVOKED"
] as const;

export type CashierOnboardingInvitationStatus =
  (typeof CASHIER_ONBOARDING_INVITATION_STATUSES)[number];

export class CashierOnboardingInvitationsQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value
  )
  @IsIn(CASHIER_ONBOARDING_INVITATION_STATUSES)
  status?: CashierOnboardingInvitationStatus;

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

export class RevokeCashierOnboardingInvitationDto extends AdminActionDto {}
