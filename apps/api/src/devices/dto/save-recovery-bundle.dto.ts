import {
  IsBase64,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength
} from "class-validator";
import { RecoveryBundleProtection } from "../../generated/prisma/enums";

export class SaveRecoveryBundleDto {
  @IsEnum(RecoveryBundleProtection)
  protection!: RecoveryBundleProtection;

  @IsOptional()
  @IsUUID("4")
  sourceDeviceId?: string;

  @IsString()
  @MinLength(3)
  @MaxLength(64)
  @Matches(/^[a-z0-9._+/-]+$/i)
  cipherSuite!: string;

  @IsBase64()
  ciphertext!: string;

  @IsBase64()
  nonce!: string;

  @IsOptional()
  @IsBase64()
  salt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[a-z0-9._-]+$/i)
  kdfAlgorithm?: string;

  @IsOptional()
  @IsObject()
  kdfParameters?: Record<string, string | number | boolean>;
}
