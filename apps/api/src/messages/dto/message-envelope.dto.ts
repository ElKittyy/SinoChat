import {
  Equals,
  IsBase64,
  IsString,
  IsUUID
} from "class-validator";
import { MATRIX_MEGOLM_ALGORITHM } from "../../e2ee/matrix-room-event";

export class MessageEnvelopeDto {
  @IsUUID("4")
  recipientDeviceId!: string;

  @IsString()
  @Equals("matrix-megolm-v1")
  protocolVersion!: string;

  @IsString()
  @Equals(MATRIX_MEGOLM_ALGORITHM)
  cipherSuite!: string;

  @IsBase64()
  ciphertext!: string;
}
