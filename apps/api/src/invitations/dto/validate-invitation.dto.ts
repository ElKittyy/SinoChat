import { Transform } from "class-transformer";
import { IsIn, IsString, Length, Matches } from "class-validator";

export class ValidateInvitationDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value
  )
  @IsString()
  @Length(8, 64)
  @Matches(/^[A-Z0-9][A-Z0-9-]{6,62}[A-Z0-9]$/)
  code!: string;

  @IsIn(["cliente", "cajero"])
  role!: "cliente" | "cajero";
}
