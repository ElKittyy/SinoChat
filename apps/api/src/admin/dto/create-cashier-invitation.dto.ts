import { IsInt, Max, Min } from "class-validator";

export class CreateCashierInvitationDto {
  @IsInt()
  @Min(1)
  @Max(720)
  expiresInHours = 72;
}
