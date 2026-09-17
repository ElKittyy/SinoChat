import { Transform } from "class-transformer";
import {
  IsEmail,
  IsString,
  Length,
  Matches,
  ValidateIf,
} from "class-validator";
import { AdminActionDto } from "./admin-action.dto";

export class UpdateAdminUserDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value,
  )
  @IsString()
  @Matches(/^[a-zA-Z0-9_.-]+$/)
  @Length(3, 32)
  username?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value,
  )
  @IsEmail()
  @Length(5, 254)
  email?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value,
  )
  @IsString()
  @Matches(/^\+[1-9]\d{7,14}$/)
  phone?: string;
}

export class DeleteAdminUserDto extends AdminActionDto {}

/** El administrador inicia el flujo, pero nunca define una credencial. */
export class ResetAdminPasswordDto extends AdminActionDto {}
