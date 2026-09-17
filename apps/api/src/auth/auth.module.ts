import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { PasswordService } from "./password.service";
import { SessionTokenService } from "./session-token.service";
import { CsrfGuard } from "./csrf.guard";
import { RolesGuard } from "./roles.guard";
import { SessionAuthGuard } from "./session-auth.guard";
import { AuthNoStoreInterceptor } from "./auth-no-store.interceptor";
import { BrowserMutationGuard } from "./browser-mutation.guard";
import { AdminMfaService } from "./admin-mfa.service";
import { AdminWebAuthnCrypto } from "./admin-webauthn.crypto";
import { AdminMfaRecentGuard } from "./admin-mfa-recent.guard";

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    SessionTokenService,
    BrowserMutationGuard,
    CsrfGuard,
    SessionAuthGuard,
    RolesGuard,
    AuthNoStoreInterceptor,
    AdminWebAuthnCrypto,
    AdminMfaService,
    AdminMfaRecentGuard
  ],
  exports: [
    AuthService,
    PasswordService,
    BrowserMutationGuard,
    CsrfGuard,
    SessionAuthGuard,
    RolesGuard,
    AdminMfaService,
    AdminMfaRecentGuard
  ]
})
export class AuthModule {}
