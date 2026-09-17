import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBase64,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested
} from "class-validator";
import { Type } from "class-transformer";
import { PreKeyDto } from "./pre-key.dto";

export class RegisterDeviceDto {
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  registrationId!: number;

  @IsBase64()
  identityPublicKey!: string;

  @Matches(/^[a-f0-9]{64}$/i)
  identityKeyFingerprint!: string;

  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  signedPreKeyId!: number;

  @IsBase64()
  signedPreKeyPublic!: string;

  @IsBase64()
  signedPreKeySignature!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-z0-9._-]+$/i)
  protocolVersion!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PreKeyDto)
  oneTimePreKeys!: PreKeyDto[];
}
