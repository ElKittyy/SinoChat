import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { AdminMfaService } from "./admin-mfa.service";

@Injectable()
export class AdminMfaRecentGuard implements CanActivate {
  constructor(private readonly adminMfa: AdminMfaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.user) return false;
    await this.adminMfa.assertRecentMfa(request.user);
    return true;
  }
}
