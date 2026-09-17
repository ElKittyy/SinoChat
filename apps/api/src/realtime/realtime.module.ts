import { Global, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AssignmentsModule } from "../assignments/assignments.module";
import { ChatGateway } from "./chat.gateway";
import { RealtimeService } from "./realtime.service";
import { ClientAddressResolver } from "./client-address-resolver";
import { readTrustProxy } from "../config/runtime-config";

@Global()
@Module({
  imports: [AuthModule, AssignmentsModule],
  providers: [
    ChatGateway,
    RealtimeService,
    {
      provide: ClientAddressResolver,
      useFactory: () => new ClientAddressResolver(readTrustProxy())
    }
  ],
  exports: [RealtimeService]
})
export class RealtimeModule {}
