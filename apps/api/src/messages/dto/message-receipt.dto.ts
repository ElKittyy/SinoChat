import { IsIn } from "class-validator";
import type { MessageDeliveryStatus } from "../../generated/prisma/enums";

export class MessageReceiptDto {
  @IsIn(["DELIVERED", "READ"])
  status!: Extract<MessageDeliveryStatus, "DELIVERED" | "READ">;
}
