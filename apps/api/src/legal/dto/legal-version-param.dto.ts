import { IsString, Matches } from "class-validator";

export class LegalVersionParamDto {
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/)
  version!: string;
}
