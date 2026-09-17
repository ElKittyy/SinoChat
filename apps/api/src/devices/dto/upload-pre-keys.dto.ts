import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  ValidateNested
} from "class-validator";
import { Type } from "class-transformer";
import { PreKeyDto } from "./pre-key.dto";

export class UploadPreKeysDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PreKeyDto)
  oneTimePreKeys!: PreKeyDto[];
}
