import { equal, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { AccountStatus, UserRole } from "../generated/prisma/enums";
import { RolesGuard } from "./roles.guard";

describe("RolesGuard admin MFA boundary", () => {
  it("deniega el panel ADMIN hasta verificar la passkey", () => {
    const guard = new RolesGuard(reflector([UserRole.ADMIN]));
    throws(
      () =>
        guard.canActivate(
          context({
            role: UserRole.ADMIN,
            status: AccountStatus.ACTIVE,
            adminMfaVerified: false
          })
        ),
      (error: any) =>
        error?.status === 403 && error?.response?.code === "ADMIN_MFA_REQUIRED"
    );
  });

  it("admite al ADMIN verificado y no altera otros roles", () => {
    const adminGuard = new RolesGuard(reflector([UserRole.ADMIN]));
    equal(
      adminGuard.canActivate(
        context({
          role: UserRole.ADMIN,
          status: AccountStatus.ACTIVE,
          adminMfaVerified: true
        })
      ),
      true
    );
    const clientGuard = new RolesGuard(reflector([UserRole.CLIENT]));
    equal(
      clientGuard.canActivate(
        context({
          role: UserRole.CLIENT,
          status: AccountStatus.ACTIVE,
          adminMfaVerified: false
        })
      ),
      true
    );
  });
});

function reflector(roles: UserRole[]): Reflector {
  return {
    getAllAndOverride: () => roles
  } as unknown as Reflector;
}

function context(user: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => ({ user }) })
  } as unknown as ExecutionContext;
}
