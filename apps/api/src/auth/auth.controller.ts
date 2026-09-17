import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors
} from "@nestjs/common";
import type { Request, Response } from "express";
import { Throttle } from "@nestjs/throttler";
import { AuthService } from "./auth.service";
import {
  csrfCookieName,
  csrfCookieOptions,
  sessionCookieName,
  sessionCookieOptions
} from "./auth.constants";
import { LoginDto } from "./dto/login.dto";
import { CompleteAdminResetDto } from "./dto/complete-admin-reset.dto";
import { RegisterCashierDto } from "./dto/register-cashier.dto";
import { RegisterClientDto } from "./dto/register-client.dto";
import { RotateRecoveryCodesDto } from "./dto/rotate-recovery-codes.dto";
import { CurrentUser } from "./current-user.decorator";
import { SessionAuthGuard } from "./session-auth.guard";
import type { SessionPrincipal } from "./auth.types";
import { SkipCsrf } from "./csrf.decorator";
import { AuthNoStoreInterceptor } from "./auth-no-store.interceptor";
import { RolesGuard } from "./roles.guard";
import { Roles } from "./roles.decorator";
import { UserRole } from "../generated/prisma/enums";
import { AdminMfaService } from "./admin-mfa.service";
import { AdminMfaRecentGuard } from "./admin-mfa-recent.guard";
import {
  AdminMfaRecoveryDto,
  AdminWebAuthnVerifyDto
} from "./dto/admin-webauthn.dto";

@Controller("auth")
@UseInterceptors(AuthNoStoreInterceptor)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly adminMfa: AdminMfaService
  ) {}

  @Post("clients/register")
  @SkipCsrf()
  @Throttle({ default: { limit: 5, ttl: 10 * 60_000 } })
  async registerClient(
    @Body() input: RegisterClientDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    const result = await this.auth.registerClient(input, this.metadata(request));
    this.setAuthCookies(
      response,
      result.sessionToken,
      result.csrfToken,
      result.expiresAt
    );

    return {
      user: result.user,
      csrfToken: result.csrfToken,
      expiresAt: result.expiresAt
    };
  }

  @Post("cashiers/register")
  @SkipCsrf()
  @Throttle({ default: { limit: 3, ttl: 10 * 60_000 } })
  async registerCashier(
    @Body() input: RegisterCashierDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    const result = await this.auth.registerCashier(input, this.metadata(request));
    this.setAuthCookies(
      response,
      result.sessionToken,
      result.csrfToken,
      result.expiresAt
    );

    return {
      user: result.user,
      csrfToken: result.csrfToken,
      expiresAt: result.expiresAt,
      recoveryCodes: result.recoveryCodes,
      recoveryCodesExpireAt: result.recoveryCodesExpireAt
    };
  }

  @Post("login")
  @SkipCsrf()
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(
    @Body() input: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    const result = await this.auth.login(input, this.metadata(request));
    this.setAuthCookies(
      response,
      result.sessionToken,
      result.csrfToken,
      result.expiresAt
    );

    return {
      user: result.user,
      csrfToken: result.csrfToken,
      expiresAt: result.expiresAt
    };
  }

  @Post("complete-admin-reset")
  @SkipCsrf()
  @HttpCode(204)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async completeAdminReset(
    @Body() input: CompleteAdminResetDto
  ): Promise<void> {
    await this.auth.completeAdminReset(input);
  }

  @Post("admin/mfa/registration/options")
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 10 * 60_000 } })
  adminMfaRegistrationOptions(@CurrentUser() user: SessionPrincipal) {
    return this.adminMfa.registrationOptions(user);
  }

  @Post("admin/mfa/registration/verify")
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 10 * 60_000 } })
  adminMfaVerifyRegistration(
    @CurrentUser() user: SessionPrincipal,
    @Body() input: AdminWebAuthnVerifyDto,
    @Req() request: Request
  ) {
    return this.adminMfa.verifyRegistration(
      user,
      input.challengeId,
      input.response,
      this.metadata(request)
    );
  }

  @Post("admin/mfa/authentication/options")
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 10 * 60_000 } })
  adminMfaAuthenticationOptions(@CurrentUser() user: SessionPrincipal) {
    return this.adminMfa.authenticationOptions(user);
  }

  @Post("admin/mfa/authentication/verify")
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 10 * 60_000 } })
  adminMfaVerifyAuthentication(
    @CurrentUser() user: SessionPrincipal,
    @Body() input: AdminWebAuthnVerifyDto
  ) {
    return this.adminMfa.verifyAuthentication(
      user,
      input.challengeId,
      input.response
    );
  }

  @Post("admin/mfa/recover")
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60 * 60_000 } })
  adminMfaRecover(
    @CurrentUser() user: SessionPrincipal,
    @Body() input: AdminMfaRecoveryDto,
    @Req() request: Request
  ) {
    return this.adminMfa.recover(
      user,
      input.recoveryCode,
      this.metadata(request)
    );
  }

  @Get("admin/mfa/passkeys")
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  adminMfaPasskeys(@CurrentUser() user: SessionPrincipal) {
    return this.adminMfa.listPasskeys(user);
  }

  @Delete("admin/mfa/passkeys/:credentialId")
  @UseGuards(SessionAuthGuard, RolesGuard, AdminMfaRecentGuard)
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 5, ttl: 10 * 60_000 } })
  adminMfaRevokePasskey(
    @CurrentUser() user: SessionPrincipal,
    @Param("credentialId", new ParseUUIDPipe({ version: "4" }))
    credentialId: string,
    @Req() request: Request
  ) {
    return this.adminMfa.revokePasskey(
      user,
      credentialId,
      this.metadata(request)
    );
  }

  @Post("cashiers/recovery-codes/rotate")
  @HttpCode(200)
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles(UserRole.CASHIER)
  @Throttle({ default: { limit: 3, ttl: 10 * 60_000 } })
  rotateCashierRecoveryCodes(
    @CurrentUser() user: SessionPrincipal,
    @Body() input: RotateRecoveryCodesDto
  ) {
    return this.auth.rotateCashierRecoveryCodes(user, input);
  }

  @Get("me")
  @UseGuards(SessionAuthGuard)
  async me(@CurrentUser() user: SessionPrincipal) {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      deviceId: user.deviceId,
      adminMfa:
        user.role === UserRole.ADMIN
          ? await this.adminMfa.state(user)
          : null
    };
  }

  @Get("sessions")
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  listSessions(@CurrentUser() user: SessionPrincipal) {
    return this.auth.listOwnAdminSessions(user);
  }

  @Delete("sessions/:sessionId")
  @UseGuards(SessionAuthGuard, RolesGuard, AdminMfaRecentGuard)
  @Roles(UserRole.ADMIN)
  async revokeSession(
    @CurrentUser() user: SessionPrincipal,
    @Param("sessionId", new ParseUUIDPipe({ version: "4" })) sessionId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    const result = await this.auth.revokeOwnAdminSession(
      user,
      sessionId,
      this.metadata(request)
    );
    if (result.currentSession) {
      this.clearAuthCookies(response);
    }
    return result;
  }

  @Post("sessions/revoke-others")
  @HttpCode(200)
  @UseGuards(SessionAuthGuard, RolesGuard, AdminMfaRecentGuard)
  @Roles(UserRole.ADMIN)
  revokeOtherSessions(
    @CurrentUser() user: SessionPrincipal,
    @Req() request: Request
  ) {
    return this.auth.revokeOtherAdminSessions(user, this.metadata(request));
  }

  @Post("logout")
  @HttpCode(204)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ): Promise<void> {
    await this.auth.logout(request.cookies?.[sessionCookieName()]);
    this.clearAuthCookies(response);
  }

  private clearAuthCookies(response: Response): void {
    response.clearCookie(sessionCookieName(), {
      ...sessionCookieOptions(),
      maxAge: undefined
    });
    response.clearCookie(csrfCookieName(), {
      ...csrfCookieOptions(),
      maxAge: undefined
    });
  }

  private setAuthCookies(
    response: Response,
    sessionToken: string,
    csrfToken: string,
    expiresAt: Date
  ): void {
    const maxAge = Math.max(0, expiresAt.getTime() - Date.now());
    response.cookie(
      sessionCookieName(),
      sessionToken,
      sessionCookieOptions(maxAge)
    );
    response.cookie(csrfCookieName(), csrfToken, csrfCookieOptions(maxAge));
  }

  private metadata(request: Request) {
    return {
      ip: request.ip,
      userAgent: request.get("user-agent")
    };
  }
}
