import { Module, type ExecutionContext } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import {
  ThrottlerGuard,
  ThrottlerModule
} from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health.controller";
import { InvitationsModule } from "./invitations/invitations.module";
import { AdminModule } from "./admin/admin.module";
import { CashierModule } from "./cashier/cashier.module";
import { CsrfGuard } from "./auth/csrf.guard";
import { BrowserMutationGuard } from "./auth/browser-mutation.guard";
import { DevicesModule } from "./devices/devices.module";
import { StorageModule } from "./storage/storage.module";
import { MessagesModule } from "./messages/messages.module";
import { RetentionModule } from "./retention/retention.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { LegalModule } from "./legal/legal.module";
import { RateLimitModule } from "./rate-limit/rate-limit.module";
import { RateLimitStorage } from "./rate-limit/rate-limit.storage";
import { E2eeModule } from "./e2ee/e2ee.module";

@Module({
  imports: [
    RateLimitModule,
    ThrottlerModule.forRootAsync({
      imports: [RateLimitModule],
      inject: [RateLimitStorage],
      useFactory: (storage: RateLimitStorage) => ({
        storage,
        skipIf: (context: ExecutionContext) =>
          context.getType() !== "http",
        throttlers: [
          {
            ttl: 60_000,
            limit: 120,
            blockDuration: 60_000
          }
        ]
      })
    }),
    DatabaseModule,
    StorageModule,
    E2eeModule,
    AuthModule,
    RealtimeModule,
    InvitationsModule,
    AdminModule,
    CashierModule,
    DevicesModule,
    MessagesModule,
    NotificationsModule,
    LegalModule,
    RetentionModule
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard
    },
    {
      provide: APP_GUARD,
      useExisting: BrowserMutationGuard
    },
    {
      provide: APP_GUARD,
      useExisting: CsrfGuard
    }
  ]
})
export class AppModule {}
