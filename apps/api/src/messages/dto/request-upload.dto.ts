import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  Matches,
  Max,
  Min
} from "class-validator";

const FIVE_MEBIBYTES = 5 * 1024 * 1024;
const MAX_CIPHERTEXT_OVERHEAD = 256 * 1024;

export class RequestUploadDto {
  @IsIn(["image/jpeg", "image/png", "image/webp"])
  declaredMimeType!: "image/jpeg" | "image/png" | "image/webp";

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FIVE_MEBIBYTES)
  plaintextByteSize!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FIVE_MEBIBYTES + MAX_CIPHERTEXT_OVERHEAD)
  ciphertextByteSize!: number;

  @Matches(/^[a-f0-9]{64}$/i)
  ciphertextSha256!: string;
}
