import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested
} from "class-validator";
import { MessageKind } from "../../generated/prisma/enums";
import { MessageEnvelopeDto } from "./message-envelope.dto";

export class SendMessageDto {
  @IsUUID("4")
  clientMessageId!: string;

  @IsUUID("4")
  senderDeviceId!: string;

  @IsEnum(MessageKind)
  kind!: MessageKind;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => MessageEnvelopeDto)
  envelopes!: MessageEnvelopeDto[];

  @IsOptional()
  @IsString()
  @MaxLength(4_096)
  attachmentGrantToken?: string;
}
