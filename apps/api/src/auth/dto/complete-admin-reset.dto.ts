import { Transform } from "class-transformer";
import { IsString, Length, Matches } from "class-validator";
import { CASHIER_RECOVERY_CODE_PATTERN } from "../cashier-recovery-code";
import { STRONG_PASSWORD_PATTERN } from "../password-policy";

export class CompleteAdminResetDto {
  @IsString()
  @Length(3, 64)
  username!: string;

  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value
  )
  @Length(26, 26)
  @Matches(CASHIER_RECOVERY_CODE_PATTERN, {
    message: "El codigo de recuperacion no tiene un formato valido."
  })
  recoveryCode!: string;

  @IsString()
  @Length(12, 128)
  @Matches(STRONG_PASSWORD_PATTERN, {
    message:
      "La nueva contraseña debe incluir mayúscula, minúscula, número y símbolo, sin espacios."
  })
  newPassword!: string;
}
