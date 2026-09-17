import { deepEqual, equal, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type ExecutionContext,
  UnauthorizedException
} from "@nestjs/common";
import type { AuthService } from "./auth.service";
import { sessionCookieName } from "./auth.constants";
import { SessionAuthGuard } from "./session-auth.guard";

process.env.NODE_ENV = "test";

describe("SessionAuthGuard", () => {
  it("adjunta el principal autenticado a la solicitud", async () => {
    const principal = {
      id: "11111111-1111-4111-8111-111111111111",
      username: "admin",
      role: "ADMIN",
      status: "ACTIVE"
    };
    let receivedToken: string | undefined;
    const guard = new SessionAuthGuard({
      async getSessionPrincipal(token: string | undefined) {
        receivedToken = token;
        return principal;
      }
    } as unknown as AuthService);
    const request: { cookies: Record<string, string>; user?: unknown } = {
      cookies: { [sessionCookieName()]: "session-token" }
    };

    equal(await guard.canActivate(contextFor(request)), true);
    equal(receivedToken, "session-token");
    strictEqual(request.user, principal);
  });

  it("marca de forma inequívoca una sesión vencida o revocada", async () => {
    const guard = new SessionAuthGuard({
      async getSessionPrincipal() {
        throw new UnauthorizedException("detalle interno");
      }
    } as unknown as AuthService);

    await rejects(
      guard.canActivate(contextFor({ cookies: {} })),
      (error: unknown) => {
        if (!(error instanceof UnauthorizedException)) return false;
        deepEqual(error.getResponse(), {
          code: "SESSION_INVALID",
          message: "Tu sesión terminó. Vuelve a iniciar sesión."
        });
        return true;
      }
    );
  });

  it("no disfraza fallos internos como vencimientos de sesión", async () => {
    const internal = new Error("DATABASE_UNAVAILABLE");
    const guard = new SessionAuthGuard({
      async getSessionPrincipal() {
        throw internal;
      }
    } as unknown as AuthService);

    await rejects(
      guard.canActivate(contextFor({ cookies: {} })),
      (error: unknown) => error === internal
    );
  });
});

function contextFor(request: object): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request
    })
  } as unknown as ExecutionContext;
}
