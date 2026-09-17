import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsString,
  Length,
  Matches
} from "class-validator";

export class RegisterCashierDto {
  @IsString()
  @Length(8, 128)
  invitationCode!: string;

  @IsEmail()
  @Length(5, 254)
  email!: string;

  @IsString()
  @Matches(/^[a-zA-Z0-9_.-]+$/)
  @Length(3, 32)
  username!: string;

  @IsString()
  @Length(10, 128)
  password!: string;

  @Matches(/^\+[1-9]\d{7,14}$/)
  phone!: string;

  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateOfBirth!: string;

  @IsBoolean()
  termsAccepted!: boolean;

  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/)
  termsVersion!: string;

  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  termsContentHash!: string;
}
