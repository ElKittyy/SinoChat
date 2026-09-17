import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { UserRole } from "../generated/prisma/enums";
import { ROLES_KEY } from "./roles.decorator";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()]
    );

    if (!requiredRoles?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    if (!request.user || !requiredRoles.includes(request.user.role)) {
      throw new ForbiddenException();
    }
    if (
      requiredRoles.includes(UserRole.ADMIN) &&
      request.user.role === UserRole.ADMIN &&
      request.user.adminMfaVerified !== true
    ) {
      throw new ForbiddenException({
        code: "ADMIN_MFA_REQUIRED",
        message: "Verifica tu passkey para acceder al panel administrativo."
      });
    }

    return true;
  }
}
