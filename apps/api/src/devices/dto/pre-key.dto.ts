import {
  IsBase64,
  IsInt,
  IsOptional,
  Max,
  Min
} from "class-validator";

export class PreKeyDto {
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  keyId!: number;

  @IsBase64()
  publicKey!: string;

  @IsOptional()
  @IsBase64()
  signature?: string;
}
