import "reflect-metadata";
import { deepEqual, equal, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import cookieParser = require("cookie-parser");
import { AuthService } from "../auth/auth.service";
import type { SessionPrincipal } from "../auth/auth.types";
import { BrowserMutationGuard } from "../auth/browser-mutation.guard";
import { CsrfGuard } from "../auth/csrf.guard";
import { RolesGuard } from "../auth/roles.guard";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { E2EE_RELEASE } from "./e2ee-release";
import { E2eeReleaseGuard } from "./e2ee-release.guard";
import { MatrixDeviceCandidateReviewController } from "./matrix-device-candidate-review.controller";
import { MatrixDeviceCandidateReviewService } from "./matrix-device-candidate-review.service";

process.env.NODE_ENV = "test";
process.env.WEB_ORIGIN = "http://localhost:5173";
process.env.SESSION_COOKIE_NAME = "sinochat_session";
process.env.CSRF_COOKIE_NAME = "sinochat_csrf";
const ID = "55555555-5555-4555-8555-555555555555";
const PREFIX = "/api/e2ee/matrix/device-candidate-reviews";
const CSRF = "synthetic-csrf-not-a-user-token";

describe("HTTP de revisión: guards reales, gate sin reemplazar", () => {
  for (const path of ["", `/${ID}`]) {
    it(`GET ${path || "/"} sin cookie exige sesión antes del gate`, () => withHttp(async (f) => {
      const result = await f.request(path);
      equal(result.status, 401); equal(result.body.code, "SESSION_INVALID"); equal(f.calls.principal, 1);
    }));
  }
  for (const token of ["expired", "revoked", "unknown"]) {
    it(`sesión ${token} no expone información de cuarentena`, () => withHttp(async (f) => {
      const result = await f.request(`/${ID}`, { headers: cookie(token) });
      equal(result.status, 401); equal(result.body.code, "SESSION_INVALID");
      ok(!JSON.stringify(result.body).includes(ID));
    }));
  }
  for (const action of ["read", "reject"] as const) {
    it(`ADMIN autenticado no alcanza revisión: ${action}`, () => withHttp(async (f) => {
      const result = action === "read" ? await f.request(`/${ID}`, { headers: cookie("admin") })
        : await f.request(`/${ID}/reject`, post("admin"));
      equal(result.status, 403); equal(f.calls.principal, 1);
    }));
  }
  for (const role of ["client", "cashier"]) {
    for (const action of ["list", "detail", "reject"] as const) {
      it(`${role}/${action}: gate compilado devuelve 503 y no invoca servicio`, () => withHttp(async (f) => {
        const result = await f.request(action === "list" ? "" : action === "detail" ? `/${ID}` : `/${ID}/reject`,
          action === "reject" ? post(role) : { headers: cookie(role) });
        equal(E2EE_RELEASE.state, "BLOCKED"); equal(result.status, 503);
        equal(result.body.error, "E2EE_INTEGRATION_INCOMPLETE");
        equal(f.calls.principal, 1); equal(f.calls.csrf, action === "reject" ? 1 : 0);
      }));
    }
  }
  for (const missing of ["header", "cookie", "mismatch", "server-session-binding"] as const) {
    it(`POST rechaza CSRF ${missing} sin llegar a autenticar al revisor`, () => withHttp(async (f) => {
      const options = post("client"); const headers = options.headers as Record<string, string>;
      if (missing === "header") delete headers["x-csrf-token"];
      if (missing === "cookie") headers.cookie = "sinochat_session=client";
      if (missing === "mismatch") headers["x-csrf-token"] = "different";
      if (missing === "server-session-binding") {
        headers.cookie = "sinochat_session=client; sinochat_csrf=unbound"; headers["x-csrf-token"] = "unbound";
      }
      const result = await f.request(`/${ID}/reject`, options);
      equal(result.status, 403); equal(f.calls.principal, 0);
      equal(f.calls.csrf, missing === "server-session-binding" ? 1 : 0);
    }));
  }
  for (const header of ["origin", "sec-fetch-site"] as const) {
    it(`POST rechaza origen ajeno mediante ${header}`, () => withHttp(async (f) => {
      const options = post("client");
      (options.headers as Record<string, string>)[header] = header === "origin" ? "https://foreign.invalid" : "cross-site";
      const result = await f.request(`/${ID}/reject`, options);
      equal(result.status, 403); equal(f.calls.csrf, 0); equal(f.calls.principal, 0);
    }));
  }
  it("POST no acepta formularios de texto", () => withHttp(async (f) => {
    const options = post("client"); (options.headers as Record<string, string>)["content-type"] = "text/plain";
    const result = await f.request(`/${ID}/reject`, options);
    equal(result.status, 415); equal(f.calls.csrf, 0); equal(f.calls.principal, 0);
  }));
  for (const [action, limit] of [["list", 30], ["detail", 10], ["reject", 10]] as const) {
    it(`límite HTTP real de ${action}: ${limit}/minuto`, () => withHttp(async (f) => {
      const path = action === "list" ? "" : action === "detail" ? `/${ID}` : `/${ID}/reject`;
      const options = action === "reject" ? post("client") : { headers: cookie("client") };
      for (let i = 0; i < limit; i++) equal((await f.request(path, options)).status, 503);
      const result = await f.request(path, options);
      equal(result.status, 429); ok(Number(result.headers.get("retry-after")) > 0);
      equal(f.calls.principal, limit);
    }));
  }
  for (const action of ["approve", "activate"]) {
    it(`no existe una ruta ${action} que permita saltar la cuarentena`, () => withHttp(async (f) => {
      const result = await f.request(`/${ID}/${action}`, post("client")); equal(result.status, 404);
    }));
  }
});

function cookie(token: string): Record<string, string> { return { cookie: `sinochat_session=${token}; sinochat_csrf=${CSRF}` }; }
function post(token: string): RequestInit {
  return { method: "POST", headers: { ...cookie(token), "content-type": "application/json", "x-csrf-token": CSRF, origin: "http://localhost:5173" }, body: "{}" };
}

async function withHttp(run: (fixture: {
  calls: { principal: number; csrf: number; service: number };
  request: (path: string, options?: RequestInit) => Promise<{ status: number; headers: Headers; body: any }>;
}) => Promise<void>) {
  const calls = { principal: 0, csrf: 0, service: 0 };
  // Only the account/session store and unreachable business service are doubles.
  // Real Nest routing, JSON/cookie parsing, guards and throttling run over loopback.
  // The release guard is never overridden; this cannot test an enabled ceremony.
  const auth = {
    async getSessionPrincipal(token: string): Promise<SessionPrincipal> {
      calls.principal++;
      if (!["client", "cashier", "admin"].includes(token)) throw new UnauthorizedException();
      return { id: "11111111-1111-4111-8111-111111111111", username: "synthetic-http", role: token === "client" ? "CLIENT" : token === "cashier" ? "CASHIER" : "ADMIN",
        status: "ACTIVE", sessionId: "33333333-3333-4333-8333-333333333333", deviceId: "22222222-2222-4222-8222-222222222222", sessionExpiresAt: new Date("2099-01-01") };
    },
    async assertCsrf(session: string, csrf: string) {
      calls.csrf++;
      if (!["client", "cashier", "admin"].includes(session) || csrf !== CSRF) throw new ForbiddenException();
    }
  };
  function unexpected(): never { calls.service++; throw new Error("GATE_DID_NOT_PROTECT_REVIEW_SERVICE"); }
  const module = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])],
    controllers: [MatrixDeviceCandidateReviewController],
    providers: [
      { provide: AuthService, useValue: auth },
      { provide: MatrixDeviceCandidateReviewService, useValue: { pending: unexpected, detail: unexpected, reject: unexpected } },
      SessionAuthGuard, RolesGuard, E2eeReleaseGuard,
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      { provide: APP_GUARD, useClass: BrowserMutationGuard },
      { provide: APP_GUARD, useClass: CsrfGuard }
    ]
  }).compile();
  const app = module.createNestApplication({ logger: false });
  try {
    app.use(cookieParser());
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const origin = await app.getUrl();
    await run({ calls, async request(path, options) {
      const response = await fetch(`${origin}${PREFIX}${path}`, { ...options, signal: AbortSignal.timeout(5000) });
      const body = await response.json();
      return { status: response.status, headers: response.headers, body };
    } });
    equal(calls.service, 0);
    deepEqual(E2EE_RELEASE.state, "BLOCKED");
  } finally { await app.close(); }
}
