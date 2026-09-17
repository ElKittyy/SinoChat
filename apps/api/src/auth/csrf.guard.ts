import {
  CanActivate,
  ExecutionContext,
  Injectable
} from "@nestjs/common";
import type { Request } from "express";
import { Reflector } from "@nestjs/core";
import { AuthService } from "./auth.service";
import { csrfCookieName, sessionCookieName } from "./auth.constants";
import { SKIP_CSRF_KEY } from "./csrf.decorator";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const skipped = this.reflector.getAllAndOverride<boolean>(SKIP_CSRF_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    if (skipped || SAFE_METHODS.has(request.method)) {
      return true;
    }

    const headerToken = request.get("x-csrf-token");
    const cookieToken = request.cookies?.[csrfCookieName()];

    if (!headerToken || headerToken !== cookieToken) {
      return false;
    }

    await this.auth.assertCsrf(
      request.cookies?.[sessionCookieName()],
      headerToken
    );
    return true;
  }
}
