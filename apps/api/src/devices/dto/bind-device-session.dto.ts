import { IsString, Length, Matches } from "class-validator";

export class BindDeviceSessionDto {
  @IsString()
  @Length(43, 43)
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  bindingSecret!: string;
}
