import "reflect-metadata";
import { deepEqual, equal, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { RequestMethod, UnauthorizedException } from "@nestjs/common";
import { GUARDS_METADATA, HEADERS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import cookieParser = require("cookie-parser");
import { AuthService } from "../auth/auth.service";
import type { SessionPrincipal } from "../auth/auth.types";
import { BrowserMutationGuard } from "../auth/browser-mutation.guard";
import { CsrfGuard } from "../auth/csrf.guard";
import { ROLES_KEY } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { E2EE_RELEASE } from "./e2ee-release";
import { E2eeReleaseGuard } from "./e2ee-release.guard";
import { MatrixDeviceVerificationInboxController } from "./matrix-device-verification-inbox.controller";
import { MatrixDeviceVerificationInboxService } from "./matrix-device-verification-inbox.service";

process.env.NODE_ENV = "test";
process.env.WEB_ORIGIN = "http://localhost:5173";
process.env.SESSION_COOKIE_NAME = "sinochat_session";
process.env.CSRF_COOKIE_NAME = "sinochat_csrf";

const CANDIDATE = "55555555-5555-4555-8555-555555555555";
const OTHER_CANDIDATE = "66666666-6666-4666-8666-666666666666";
const PREFIX = "/api/e2ee/matrix/device-verification-inbox";
const VALID_SESSIONS = ["client", "cashier", "client-bound", "cashier-bound", "admin"];

describe("HTTP de bandeja SAS: solo lectura y gate compilado BLOCKED", () => {
  it("declara un unico GET con roles propios, guards en orden y no-store", () => {
    const controller = MatrixDeviceVerificationInboxController;
    equal(Reflect.getMetadata(PATH_METADATA, controller), "e2ee/matrix/device-verification-inbox");
    deepEqual(Reflect.getMetadata(GUARDS_METADATA, controller), [SessionAuthGuard, RolesGuard, E2eeReleaseGuard]);
    deepEqual(Reflect.getMetadata(ROLES_KEY, controller), ["CLIENT", "CASHIER"]);
    const routes = Object.values(Object.getOwnPropertyDescriptors(controller.prototype))
      .map((descriptor) => descriptor.value)
      .filter((value) => typeof value === "function" && Reflect.hasMetadata(METHOD_METADATA, value));
    equal(routes.length, 1);
    equal(Reflect.getMetadata(METHOD_METADATA, routes[0]), RequestMethod.GET);
    equal(Reflect.getMetadata(PATH_METADATA, routes[0]), ":candidateId");
    const headers = Reflect.getMetadata(HEADERS_METADATA, routes[0]) as Array<{ name: string; value: string }>;
    ok(headers.some((header) => header.name.toLowerCase() === "cache-control" && header.value === "no-store"));
    // @Header is handler metadata, not a claim that guard-generated errors
    // execute the handler or inherit its response headers.
    equal(E2EE_RELEASE.state, "BLOCKED");
  });

  it("GET sin cookie exige una sesion valida, sin pedir CSRF", () => withHttp(async (f) => {
    const result = await f.request(`/${CANDIDATE}`);
    equal(result.status, 401);
    equal(result.body.code, "SESSION_INVALID");
    equal(f.calls.principal, 1);
    equal(f.calls.csrf, 0);
    assertNoScopeDisclosure(result.body);
  }));

  for (const token of ["expired", "revoked", "unknown"]) {
    it(`sesion ${token} no puede consultar la solicitud de verificacion`, () => withHttp(async (f) => {
      const result = await f.request(`/${CANDIDATE}`, session(token));
      equal(result.status, 401);
      equal(result.body.code, "SESSION_INVALID");
      equal(f.calls.principal, 1);
      equal(f.calls.csrf, 0);
      assertNoScopeDisclosure(result.body);
    }));
  }

  it("ADMIN autenticado queda fuera antes del gate", () => withHttp(async (f) => {
    const result = await f.request(`/${CANDIDATE}`, session("admin"));
    equal(result.status, 403);
    equal(f.calls.principal, 1);
    equal(f.calls.csrf, 0);
    ok(result.body.error !== "E2EE_INTEGRATION_INCOMPLETE");
    assertNoScopeDisclosure(result.body);
  }));

  for (const token of ["client", "cashier", "client-bound", "cashier-bound"]) {
    it(`${token}: gate real devuelve 503 sin ejecutar poll y sin CSRF para GET`, () => withHttp(async (f) => {
      // Deliberately no CSRF cookie/header: this route only polls. It cannot
      // confer device authority or open/approve a verification ceremony.
      const result = await f.request(`/${CANDIDATE}`, session(token));
      equal(result.status, 503);
      equal(result.body.error, "E2EE_INTEGRATION_INCOMPLETE");
      equal(f.calls.principal, 1);
      equal(f.calls.csrf, 0);
      assertNoScopeDisclosure(result.body);
    }));
  }

  it("cabeceras y parametros de identidad aportados por el cliente no evitan el gate", () => withHttp(async (f) => {
    const options = session("client");
    Object.assign(options.headers as Record<string, string>, { "x-user-role": "ADMIN", "x-device-id": OTHER_CANDIDATE });
    const result = await f.request(`/${CANDIDATE}?role=ADMIN&approved=true&deviceId=${OTHER_CANDIDATE}`, options);
    equal(result.status, 503);
    equal(result.body.error, "E2EE_INTEGRATION_INCOMPLETE");
    deepEqual(f.calls.principalTokens, ["client"]);
    equal(f.calls.csrf, 0);
    assertNoScopeDisclosure(result.body);
  }));

  it("treinta GET por minuto comparten limite aunque cambie candidateId", () => withHttp(async (f) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const id = attempt % 2 === 0 ? CANDIDATE : OTHER_CANDIDATE;
      equal((await f.request(`/${id}`, session("client"))).status, 503);
    }
    const result = await f.request(`/${OTHER_CANDIDATE}`, session("client"));
    equal(result.status, 429);
    ok(Number(result.headers.get("retry-after")) > 0);
    equal((await f.request(`/${CANDIDATE}`, session("client"))).status, 429);
    equal(f.calls.principal, 30);
    equal(f.calls.csrf, 0);
  }));

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    it(`no existe una variante ${method} de la bandeja`, () => withHttp(async (f) => {
      equal((await f.request(`/${CANDIDATE}`, { ...session("client"), method })).status, 404);
      equal(f.calls.principal, 0);
      equal(f.calls.csrf, 0);
    }));
  }

  for (const action of ["approve", "activate", "consume"]) {
    for (const method of ["GET", "POST"]) {
      it(`no existe ${method} ${action} para promover ni consumir el candidato`, () => withHttp(async (f) => {
        equal((await f.request(`/${CANDIDATE}/${action}`, { ...session("client"), method })).status, 404);
        equal(f.calls.principal, 0);
        equal(f.calls.csrf, 0);
      }));
    }
  }

  it("no existe una lista general de solicitudes sin candidateId", () => withHttp(async (f) => {
    equal((await f.request("", session("client"))).status, 404);
    equal(f.calls.principal, 0);
    equal(f.calls.csrf, 0);
  }));
});

function session(token: string): RequestInit {
  return { headers: { cookie: `sinochat_session=${token}` } };
}

function assertNoScopeDisclosure(body: unknown): void {
  const encoded = JSON.stringify(body);
  for (const value of [CANDIDATE, OTHER_CANDIDATE, "synthetic-http"]) ok(!encoded.includes(value));
}

async function withHttp(run: (fixture: {
  calls: { principal: number; csrf: number; service: number; principalTokens: Array<string | undefined> };
  request: (path: string, options?: RequestInit) => Promise<{ status: number; headers: Headers; body: any }>;
}) => Promise<void>) {
  const calls = { principal: 0, csrf: 0, service: 0, principalTokens: [] as Array<string | undefined> };
  // Only session persistence and the unreachable business service are doubles.
  // Routing, JSON/cookie parsing, guards and the in-memory HTTP throttler are
  // real. The release guard is never overridden: no enabled ceremony is tested.
  const auth = {
    async getSessionPrincipal(token: string | undefined): Promise<SessionPrincipal> {
      calls.principal++;
      calls.principalTokens.push(token);
      if (!token || !VALID_SESSIONS.includes(token)) throw new UnauthorizedException();
      return {
        id: "11111111-1111-4111-8111-111111111111", username: "synthetic-http",
        role: token === "admin" ? "ADMIN" : token.startsWith("cashier") ? "CASHIER" : "CLIENT",
        status: "ACTIVE", sessionId: "33333333-3333-4333-8333-333333333333",
        deviceId: token.endsWith("-bound") || token === "admin" ? "22222222-2222-4222-8222-222222222222" : null,
        sessionExpiresAt: new Date("2099-01-01"),
      };
    },
    async assertCsrf() {
      calls.csrf++;
      throw new Error("READ_ONLY_INBOX_MUST_NOT_VALIDATE_CSRF");
    },
  };
  function unexpected(): never {
    calls.service++;
    throw new Error("GATE_DID_NOT_PROTECT_DEVICE_VERIFICATION_INBOX_SERVICE");
  }
  const module = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])],
    controllers: [MatrixDeviceVerificationInboxController],
    providers: [
      { provide: AuthService, useValue: auth },
      { provide: MatrixDeviceVerificationInboxService, useValue: { poll: unexpected } },
      SessionAuthGuard, RolesGuard, E2eeReleaseGuard,
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      { provide: APP_GUARD, useClass: BrowserMutationGuard },
      { provide: APP_GUARD, useClass: CsrfGuard },
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  try {
    app.use(cookieParser());
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const origin = await app.getUrl();
    await run({ calls, async request(path, options) {
      const response = await fetch(`${origin}${PREFIX}${path}`, { ...options, signal: AbortSignal.timeout(5000) });
      return { status: response.status, headers: response.headers, body: await response.json() };
    } });
    equal(calls.service, 0);
    equal(E2EE_RELEASE.state, "BLOCKED");
  } finally { await app.close(); }
}
