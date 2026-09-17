import { IsString, Length } from "class-validator";

export class LoginDto {
  @IsString()
  @Length(3, 64)
  username!: string;

  @IsString()
  @Length(10, 128)
  password!: string;
}

