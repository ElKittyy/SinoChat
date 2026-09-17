import { Transform } from "class-transformer";
import { IsObject, IsString, IsUUID, Matches } from "class-validator";
import { ADMIN_RECOVERY_CODE_PATTERN } from "../admin-recovery-code";

export class AdminWebAuthnVerifyDto {
  @IsUUID("4")
  challengeId!: string;

  @IsObject()
  response!: Record<string, unknown>;
}

export class AdminMfaRecoveryDto {
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value
  )
  @IsString()
  @Matches(ADMIN_RECOVERY_CODE_PATTERN, {
    message: "El código de recuperación administrativa no es válido."
  })
  recoveryCode!: string;
}
