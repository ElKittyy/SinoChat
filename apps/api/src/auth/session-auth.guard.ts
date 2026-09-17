import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import type { Request } from "express";
import { AuthService } from "./auth.service";
import { sessionCookieName } from "./auth.constants";

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    try {
      request.user = await this.auth.getSessionPrincipal(
        request.cookies?.[sessionCookieName()]
      );
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw new UnauthorizedException({
          code: "SESSION_INVALID",
          message: "Tu sesión terminó. Vuelve a iniciar sesión."
        });
      }
      throw error;
    }
    return true;
  }
}
