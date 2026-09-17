import { IsString, Length } from "class-validator";

export class RotateRecoveryCodesDto {
  @IsString()
  @Length(10, 128)
  currentPassword!: string;
}
