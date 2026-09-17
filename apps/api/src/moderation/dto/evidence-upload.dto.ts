import { Type } from "class-transformer";
import {
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength
} from "class-validator";

export const MAX_REPORT_EVIDENCE_BYTES = 512 * 1024 * 1024;

export class RequestEvidenceUploadDto {
  @IsUUID("4")
  investigationKeyId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_REPORT_EVIDENCE_BYTES)
  ciphertextByteSize!: number;

  @Matches(/^[a-f0-9]{64}$/i)
  ciphertextSha256!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9._+/-]+$/)
  cipherSuite!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  manifestVersion!: number;
}
