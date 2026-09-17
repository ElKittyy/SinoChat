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
import { MatrixDeviceVerificationController } from "./matrix-device-verification.controller";
import { MatrixDeviceVerificationService } from "./matrix-device-verification.service";

process.env.NODE_ENV = "test";
process.env.WEB_ORIGIN = "http://localhost:5173";
process.env.SESSION_COOKIE_NAME = "sinochat_session";
process.env.CSRF_COOKIE_NAME = "sinochat_csrf";

const CANDIDATE = "55555555-5555-4555-8555-555555555555";
const FLOW = "synthetic-sas-flow";
const HTTP_TRANSACTION = "synthetic-http-request";
const PREFIX = "/api/e2ee/matrix/device-verification-flows";
const PATH = `/${CANDIDATE}/${FLOW}/${HTTP_TRANSACTION}`;
const CSRF = "synthetic-csrf-not-a-user-token";
const VALID_SESSIONS = ["client", "cashier", "client-bound", "cashier-bound", "admin"];

describe("HTTP de apertura SAS: guards reales y gate compilado BLOCKED", () => {
  it("declara solo PUT, roles propios, guards en orden y no-store sin abrir el gate", () => {
    const controller = MatrixDeviceVerificationController;
    equal(Reflect.getMetadata(PATH_METADATA, controller), "e2ee/matrix/device-verification-flows");
    deepEqual(Reflect.getMetadata(GUARDS_METADATA, controller), [SessionAuthGuard, RolesGuard, E2eeReleaseGuard]);
    deepEqual(Reflect.getMetadata(ROLES_KEY, controller), ["CLIENT", "CASHIER"]);
    const routes = Object.values(Object.getOwnPropertyDescriptors(controller.prototype))
      .map((descriptor) => descriptor.value)
      .filter((value) => typeof value === "function" && Reflect.hasMetadata(METHOD_METADATA, value));
    equal(routes.length, 1);
    equal(Reflect.getMetadata(METHOD_METADATA, routes[0]), RequestMethod.PUT);
    equal(Reflect.getMetadata(PATH_METADATA, routes[0]), ":candidateId/:flowId/:transactionId");
    const headers = Reflect.getMetadata(HEADERS_METADATA, routes[0]) as Array<{ name: string; value: string }>;
    ok(headers.some((header) => header.name.toLowerCase() === "cache-control" && header.value === "no-store"));
    // @Header applies after guards. This metadata assertion does NOT claim that
    // a gate-generated 503 response has passed through the controller handler.
    equal(E2EE_RELEASE.state, "BLOCKED");
  });

  it("PUT sin cookies ni CSRF no llega al servicio ni a resolver identidad", () => withHttp(async (f) => {
    const options = put("client");
    delete (options.headers as Record<string, string>).cookie;
    delete (options.headers as Record<string, string>)["x-csrf-token"];
    const result = await f.request(PATH, options);
    equal(result.status, 403);
    equal(f.calls.csrf, 0);
    equal(f.calls.principal, 0);
  }));

  it("CSRF coincidente sin cookie de sesion sigue exigiendo una identidad valida", () => withHttp(async (f) => {
    const options = put("client");
    (options.headers as Record<string, string>).cookie = `sinochat_csrf=${CSRF}`;
    const result = await f.request(PATH, options);
    equal(result.status, 401);
    equal(f.calls.csrf, 1);
    equal(f.calls.principal, 0);
  }));

  for (const token of ["expired", "revoked", "unknown"]) {
    it(`sesion ${token} no abre ni revela el flujo SAS`, () => withHttp(async (f) => {
      const result = await f.request(PATH, put(token));
      equal(result.status, 401);
      equal(f.calls.csrf, 1);
      equal(f.calls.principal, 0);
      assertNoScopeDisclosure(result.body);
    }));
  }

  it("SessionAuthGuard revalida identidad despues de superar CSRF", () => withHttp(async (f) => {
    // The store double models revocation between the two guard checks.
    const result = await f.request(PATH, put("stale-after-csrf"));
    equal(result.status, 401);
    equal(result.body.code, "SESSION_INVALID");
    equal(f.calls.csrf, 1);
    equal(f.calls.principal, 1);
    assertNoScopeDisclosure(result.body);
  }));

  it("ADMIN autenticado no alcanza el gate ni el servicio de apertura", () => withHttp(async (f) => {
    const result = await f.request(PATH, put("admin"));
    equal(result.status, 403);
    equal(f.calls.csrf, 1);
    equal(f.calls.principal, 1);
    ok(result.body.error !== "E2EE_INTEGRATION_INCOMPLETE");
    assertNoScopeDisclosure(result.body);
  }));

  for (const token of ["client", "cashier", "client-bound", "cashier-bound"]) {
    it(`${token}: el gate real devuelve 503 sin ejecutar open`, () => withHttp(async (f) => {
      const result = await f.request(PATH, put(token));
      equal(result.status, 503);
      equal(result.body.error, "E2EE_INTEGRATION_INCOMPLETE");
      equal(f.calls.csrf, 1);
      equal(f.calls.principal, 1);
      equal(E2EE_RELEASE.state, "BLOCKED");
      assertNoScopeDisclosure(result.body);
    }));
  }

  for (const failure of ["header", "cookie", "mismatch", "server-session-binding"] as const) {
    it(`CSRF ${failure} se rechaza antes de SessionAuthGuard`, () => withHttp(async (f) => {
      const options = put("client");
      const headers = options.headers as Record<string, string>;
      if (failure === "header") delete headers["x-csrf-token"];
      if (failure === "cookie") headers.cookie = "sinochat_session=client";
      if (failure === "mismatch") headers["x-csrf-token"] = "different";
      if (failure === "server-session-binding") {
        headers.cookie = "sinochat_session=client; sinochat_csrf=unbound";
        headers["x-csrf-token"] = "unbound";
      }
      const result = await f.request(PATH, options);
      equal(result.status, failure === "server-session-binding" ? 401 : 403);
      equal(f.calls.principal, 0);
      equal(f.calls.csrf, failure === "server-session-binding" ? 1 : 0);
    }));
  }

  for (const header of ["origin", "sec-fetch-site"] as const) {
    it(`PUT de origen ajeno rechazado mediante ${header}`, () => withHttp(async (f) => {
      const options = put("client");
      (options.headers as Record<string, string>)[header] = header === "origin" ? "https://foreign.invalid" : "cross-site";
      const result = await f.request(PATH, options);
      equal(result.status, 403);
      equal(f.calls.csrf, 0);
      equal(f.calls.principal, 0);
    }));
  }

  for (const contentType of ["text/plain", "application/x-www-form-urlencoded"]) {
    it(`PUT no acepta formularios ${contentType}`, () => withHttp(async (f) => {
      const options = put("client");
      (options.headers as Record<string, string>)["content-type"] = contentType;
      const result = await f.request(PATH, options);
      equal(result.status, 415);
      equal(f.calls.csrf, 0);
      equal(f.calls.principal, 0);
    }));
  }

  it("cabeceras o campos de identidad aportados por el cliente no evitan el gate", () => withHttp(async (f) => {
    const options = put("client");
    Object.assign(options.headers as Record<string, string>, { "x-user-role": "ADMIN", "x-device-id": CANDIDATE });
    options.body = JSON.stringify({ role: "ADMIN", deviceId: CANDIDATE, flowId: FLOW, approved: true });
    const result = await f.request(PATH, options);
    equal(result.status, 503);
    equal(result.body.error, "E2EE_INTEGRATION_INCOMPLETE");
    deepEqual(f.calls.principalTokens, ["client"]);
  }));

  it("limite HTTP real de cinco PUT por minuto no se evita cambiando IDs de ruta", () => withHttp(async (f) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      equal((await f.request(PATH, put("client"))).status, 503);
    }
    const result = await f.request(PATH, put("client"));
    equal(result.status, 429);
    ok(Number(result.headers.get("retry-after")) > 0);
    const changedPath = "/66666666-6666-4666-8666-666666666666/another-synthetic-flow/another-http-request";
    equal((await f.request(changedPath, put("client"))).status, 429);
    equal(f.calls.principal, 5);
    equal(f.calls.csrf, 5);
  }));

  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    it(`no existe una variante ${method} de apertura`, () => withHttp(async (f) => {
      const options = put("client");
      options.method = method;
      if (method === "GET") delete options.body;
      equal((await f.request(PATH, options)).status, 404);
    }));
  }

  for (const action of ["approve", "activate", "consume"]) {
    it(`no existe ruta ${action} que promueva el candidato`, () => withHttp(async (f) => {
      equal((await f.request(`${PATH}/${action}`, put("client"))).status, 404);
    }));
  }
});

function put(token: string): RequestInit {
  return {
    method: "PUT",
    headers: {
      cookie: `sinochat_session=${token}; sinochat_csrf=${CSRF}`,
      "content-type": "application/json", "x-csrf-token": CSRF, origin: "http://localhost:5173",
    },
    // Guards, not event validation, are under test. The real gate must prevent
    // business execution even when the parsed JSON is not a valid SAS request.
    body: "{}",
  };
}

function assertNoScopeDisclosure(body: unknown): void {
  const encoded = JSON.stringify(body);
  for (const value of [CANDIDATE, FLOW, HTTP_TRANSACTION, CSRF]) ok(!encoded.includes(value));
}

async function withHttp(run: (fixture: {
  calls: { principal: number; csrf: number; service: number; principalTokens: Array<string | undefined> };
  request: (path: string, options?: RequestInit) => Promise<{ status: number; headers: Headers; body: any }>;
}) => Promise<void>) {
  const calls = { principal: 0, csrf: 0, service: 0, principalTokens: [] as Array<string | undefined> };
  // Only account/session persistence and the unreachable business service are
  // doubles. Real Nest routing, parsers, CSRF, roles, throttling and release gate
  // run over loopback. No READY override, environment bypass, API or database.
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
    async assertCsrf(session: string | undefined, csrf: string | undefined) {
      calls.csrf++;
      if (!session || (!VALID_SESSIONS.includes(session) && session !== "stale-after-csrf") || csrf !== CSRF) {
        throw new UnauthorizedException();
      }
    },
  };
  function unexpected(): never {
    calls.service++;
    throw new Error("GATE_DID_NOT_PROTECT_DEVICE_VERIFICATION_SERVICE");
  }
  const module = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])],
    controllers: [MatrixDeviceVerificationController],
    providers: [
      { provide: AuthService, useValue: auth },
      { provide: MatrixDeviceVerificationService, useValue: { open: unexpected } },
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
