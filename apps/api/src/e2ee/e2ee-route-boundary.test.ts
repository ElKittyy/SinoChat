import { equal, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import type { Socket } from "socket.io";
import type { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import type { AuthService } from "../auth/auth.service";
import { DevicesController } from "../devices/devices.controller";
import { MessagesController } from "../messages/messages.controller";
import type { ClientAddressResolver } from "../realtime/client-address-resolver";
import { ChatGateway } from "../realtime/chat.gateway";
import type { RealtimeService } from "../realtime/realtime.service";
import type { RateLimitStorage } from "../rate-limit/rate-limit.storage";
import { E2eeReleaseGuard } from "./e2ee-release.guard";
import { MatrixTransportController } from "./matrix-transport.controller";

describe("E2EE route boundary", () => {
  it("protege dispositivos y cada ruta HTTP que entrega contenido", () => {
    includesReleaseGuard(DevicesController);
    includesReleaseGuard(MatrixTransportController);
    includesReleaseGuard(MessagesController.prototype.listMessages);
    includesReleaseGuard(MessagesController.prototype.requestUpload);
    includesReleaseGuard(MessagesController.prototype.send);
    includesReleaseGuard(MessagesController.prototype.updateReceipt);

    const conversationListGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      MessagesController.prototype.listConversations
    ) as unknown[] | undefined;
    equal(conversationListGuards, undefined);
  });

  it("rechaza WebSocket antes de consultar sesion, origen o Redis", async () => {
    let disconnected = false;
    const gateway = new ChatGateway(
      {} as AuthService,
      {} as ConversationEligibilityService,
      {} as RealtimeService,
      {} as RateLimitStorage,
      {} as ClientAddressResolver
    );
    const socket = {
      disconnect(force: boolean) {
        equal(force, true);
        disconnected = true;
      }
    } as unknown as Socket;

    await gateway.handleConnection(socket);
    equal(disconnected, true);
  });
});

function includesReleaseGuard(target: object): void {
  const guards = Reflect.getMetadata(GUARDS_METADATA, target) as
    | unknown[]
    | undefined;
  ok(guards?.includes(E2eeReleaseGuard));
}
