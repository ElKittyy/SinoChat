import { deepEqual, equal, notEqual, ok, rejects, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpException } from "@nestjs/common";
import { GUARDS_METADATA, HEADERS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { matrixDeviceIdFromUuid, matrixUserIdFromUuid } from "@sinochat/contracts";
import type { SessionPrincipal } from "../auth/auth.types";
import { RolesGuard } from "../auth/roles.guard";
import { ROLES_KEY } from "../auth/roles.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { Prisma } from "../generated/prisma/client";
import { E2eeReleaseGuard } from "./e2ee-release.guard";
import { parseMatrixDeviceCandidate } from "./matrix-device-candidate";
import { MatrixDeviceCandidateReviewController } from "./matrix-device-candidate-review.controller";
import { MatrixDeviceCandidateReviewService } from "./matrix-device-candidate-review.service";
import { candidateFixture } from "./testing/matrix-candidate.fixture";

process.env.NODE_ENV = "test";
process.env.MATRIX_SERVER_NAME = "sinochat.invalid";
const USER = "11111111-1111-4111-8111-111111111111";
const DEVICE = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const REQUESTER = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-09-12T18:00:00Z");
const MATRIX_USER = matrixUserIdFromUuid(USER, "sinochat.invalid");
const summaryKeys = ["candidateId", "createdAt", "expiresAt", "matrixDeviceId", "matrixUserId", "state"];
function http(status: number) { return (error: unknown) => error instanceof HttpException && error.getStatus() === status; }

describe("revisión propia de candidatos: nunca autoriza dispositivos", () => {
  it("lista metadatos y entrega solo snapshot público original a la sesión confiable", async () => {
    const f = fixture();
    const { pending } = await f.service.pending(f.principal);
    ok(pending); equal(pending.state, "PENDING");
    deepEqual(Object.keys(pending).sort(), summaryKeys);
    const detail = await f.detail();
    deepEqual(Object.keys(detail).sort(), [...summaryKeys, "deviceKeys"].sort());
    deepEqual(detail.deviceKeys, f.candidate.body.device_keys);
    notEqual(detail.deviceKeys, f.state.row.deviceKeys);
    ok(Object.isFrozen(detail.deviceKeys.keys));
    throws(() => { detail.deviceKeys.keys["ed25519:fake"] = "replacement"; });
    equal(f.state.updates, 0); equal(f.state.operationalWrites, 0);
    deepEqual(f.order.slice(0, 5), ["device-lock", "user-lock", "actor-lock", "candidate-lock", "requester-lock"]);
  });
  for (const action of ["pending", "detail", "reject"] as const) {
    for (const invalid of ["admin", "unbound", "invalid-device"] as const) {
      it(`${action} rechaza ${invalid} antes de abrir transacción`, async () => {
        const f = fixture();
        if (invalid === "admin") f.principal.role = "ADMIN";
        if (invalid === "unbound") f.principal.deviceId = null;
        if (invalid === "invalid-device") f.principal.deviceId = "not-uuid";
        await rejects(f.service[action](f.principal, f.candidate.id), http(403));
        equal(f.state.transactions, 0);
      });
    }
  }
  for (const id of ["invalid", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "11111111-1111-1111-8111-111111111111"]) {
    it("detalle/rechazo validan UUID v4 canónico", async () => {
      const f = fixture();
      await rejects(f.service.detail(f.principal, id), http(400));
      await rejects(f.service.reject(f.principal, id), http(400)); equal(f.state.transactions, 0);
    });
  }
  for (const source of ["missing", "namespace", "other-device"] as const) {
    it(`exige pin del dispositivo bootstrap propio: ${source}`, async () => {
      const f = fixture();
      if (source === "missing") f.state.identity = null;
      if (source === "namespace") f.state.identity.matrixUserId = "foreign";
      if (source === "other-device") f.principal.deviceId = OTHER;
      await rejects(f.detail(), http(403)); equal(f.state.candidateReads, 0);
    });
  }
  it("sesión/dispositivo/directorio/certificado ausentes en join fallan cerrados", async () => {
    const f = fixture(); f.state.actorLocked = false;
    await rejects(f.detail(), http(401)); equal(f.state.candidateReads, 0);
  });
  for (const mutation of ["missing", "owner", "device", "revoked", "expired", "version", "role", "status", "reset"] as const) {
    it(`relee autoridad del revisor: ${mutation}`, async () => {
      const f = fixture(); const s = f.state.actor;
      if (mutation === "missing") f.state.actor = null;
      if (mutation === "owner") s.userId = OTHER;
      if (mutation === "device") s.deviceId = OTHER;
      if (mutation === "revoked") s.revokedAt = NOW;
      if (mutation === "expired") s.expiresAt = NOW;
      if (mutation === "version") s.user.sessionVersion++;
      if (mutation === "role") s.user.role = "ADMIN";
      if (mutation === "status") s.user.status = "PENDING";
      if (mutation === "reset") s.user.passwordResetRequired = true;
      await rejects(f.detail(), http(401)); equal(f.state.candidateReads, 0);
    });
  }
  for (const mutation of ["missing", "owner", "trusted-device"] as const) {
    it(`no busca claves fuera del ámbito propio: ${mutation}`, async () => {
      const f = fixture();
      if (mutation === "missing") f.state.row = null;
      if (mutation === "owner") f.state.row.userId = OTHER;
      if (mutation === "trusted-device") f.state.row.trustedDeviceId = OTHER;
      deepEqual(await f.service.pending(f.principal), { pending: null });
      await rejects(f.detail(), http(404)); await rejects(f.service.reject(f.principal, f.candidate.id), http(404));
      equal(f.state.candidateReads, 0); equal(f.state.updates, 0);
    });
  }
  for (const mutation of ["missing", "lock-missing", "owner", "bound", "revoked", "expired", "version", "candidate-version"] as const) {
    it(`no presenta candidato con solicitante inválido: ${mutation}`, async () => {
      const f = fixture(); const s = f.state.requester;
      if (mutation === "missing") f.state.requester = null;
      if (mutation === "lock-missing") f.state.requesterLocked = false;
      if (mutation === "owner") s.userId = OTHER;
      if (mutation === "bound") s.deviceId = OTHER;
      if (mutation === "revoked") s.revokedAt = NOW;
      if (mutation === "expired") s.expiresAt = NOW;
      if (mutation === "version") s.sessionVersion++;
      if (mutation === "candidate-version") { s.sessionVersion++; f.state.row.sessionVersion++; }
      deepEqual(await f.service.pending(f.principal), { pending: null });
      await rejects(f.detail(), http(404)); equal(f.state.row.status, "PENDING");
      equal(f.state.updates, 0);
    });
  }
  for (const mutation of ["pin", "matrix-user", "matrix-device", "hash", "ed25519", "curve25519", "private-key", "signature", "resigned-keys"] as const) {
    it(`no devuelve snapshot discrepante: ${mutation}`, async () => {
      const f = fixture(); const row = f.state.row;
      if (mutation === "pin") row.identityBootstrapSha256 = "b".repeat(64);
      if (mutation === "matrix-user") row.matrixUserId = "foreign";
      if (mutation === "matrix-device") row.matrixDeviceId = matrixDeviceIdFromUuid(OTHER);
      if (mutation === "hash") row.canonicalSha256 = "b".repeat(64);
      if (mutation === "ed25519") row.ed25519Key = "a".repeat(43);
      if (mutation === "curve25519") row.curve25519Key = "a".repeat(43);
      if (mutation === "private-key") row.deviceKeys.private_key = "synthetic-only";
      if (mutation === "signature") row.deviceKeys.signatures[MATRIX_USER][`ed25519:${row.matrixDeviceId}`] = "a".repeat(86);
      if (mutation === "resigned-keys") row.deviceKeys = candidateFixture(MATRIX_USER, f.candidate.id).body.device_keys;
      await rejects(f.detail(), http(409)); await rejects(f.service.pending(f.principal), http(409)); equal(f.state.updates, 0);
    });
  }
  it("la expiración inclusiva persiste aunque detalle termine en 404", async () => {
    const f = fixture(); f.state.now = f.state.row.expiresAt;
    await rejects(f.detail(), http(404)); equal(f.state.row.status, "EXPIRED"); equal(f.state.updates, 1);
    f.state.now = NOW;
    deepEqual(await f.service.pending(f.principal), { pending: null });
    await rejects(f.detail(), http(404));
    deepEqual(await f.service.reject(f.principal, f.candidate.id), { candidateId: f.candidate.id, state: "EXPIRED" });
    equal(f.state.updates, 1);
  });
  it("la lista también persiste expiración y no revive al retroceder el reloj", async () => {
    const f = fixture(); f.state.now = f.state.row.expiresAt;
    deepEqual(await f.service.pending(f.principal), { pending: null }); equal(f.state.row.status, "EXPIRED");
    f.state.now = NOW; deepEqual(await f.service.pending(f.principal), { pending: null });
  });
  it("vence mientras se leen/verifican claves: no se entregan", async () => {
    const f = fixture(); f.state.clocks = [NOW, f.state.row.expiresAt];
    await rejects(f.detail(), http(404)); equal(f.state.row.status, "EXPIRED");
  });
  it("vencimiento del solicitante tras la lectura no expone claves", async () => {
    const f = fixture(); f.state.requester.expiresAt = new Date(NOW.getTime() + 1000);
    f.state.clocks = [NOW, f.state.requester.expiresAt];
    await rejects(f.detail(), http(404)); equal(f.state.updates, 0);
  });
  for (const action of ["detail", "reject"] as const) {
    it(`sesión revisora vence durante ${action}: revierte y falla cerrada`, async () => {
      const f = fixture(); f.state.actor.expiresAt = new Date(NOW.getTime() + 1000);
      f.state.clocks = action === "reject" ? [NOW, NOW, f.state.actor.expiresAt] : [NOW, f.state.actor.expiresAt];
      await rejects(f.service[action](f.principal, f.candidate.id), http(401));
      equal(f.state.row.status, "PENDING");
    });
  }
  it("caducidad de sesión revisora después de terminalizar expiración revierte la escritura", async () => {
    const f = fixture(); const expiry = f.state.row.expiresAt;
    f.state.actor.expiresAt = new Date(expiry.getTime() + 1000);
    f.state.clocks = [NOW, expiry, f.state.actor.expiresAt];
    await rejects(f.detail(), http(401)); equal(f.state.row.status, "PENDING");
  });
  it("rechazar no pide motivo, es idempotente y no expone claves ni sesión", async () => {
    const f = fixture();
    const rejected = await f.service.reject(f.principal, f.candidate.id);
    deepEqual(rejected, { candidateId: f.candidate.id, state: "CANCELLED" });
    deepEqual(await f.service.reject(f.principal, f.candidate.id), rejected);
    deepEqual(await f.service.pending(f.principal), { pending: null }); await rejects(f.detail(), http(404));
    equal(f.state.updates, 1); equal(f.state.operationalWrites, 0);
  });
  it("permite descartar tras logout del solicitante sin concederle autoridad", async () => {
    const f = fixture(); f.state.requester.revokedAt = NOW;
    await rejects(f.detail(), http(404));
    equal((await f.service.reject(f.principal, f.candidate.id)).state, "CANCELLED");
    equal(f.state.requester.deviceId, null); equal(f.state.operationalWrites, 0);
  });
  it("vencimiento gana sobre rechazo, incluso durante espera", async () => {
    const f = fixture(); f.state.clocks = [NOW, f.state.row.expiresAt];
    equal((await f.service.reject(f.principal, f.candidate.id)).state, "EXPIRED");
  });
  it("el revisor cajero necesita elegibilidad además de sesión", async () => {
    const f = fixture(); f.principal.role = "CASHIER"; f.state.actor.user.role = "CASHIER";
    ok(await f.detail()); ok(f.order.includes("cashier-lock"));
    f.state.subscriptionEndsAt = NOW; await rejects(f.detail(), http(401));
  });
  it("suscripción vencida después de rechazar revierte la cancelación", async () => {
    const f = fixture(); f.principal.role = "CASHIER"; f.state.actor.user.role = "CASHIER";
    f.state.subscriptionEndsAt = new Date(NOW.getTime() + 1000);
    f.state.clocks = [NOW, NOW, f.state.subscriptionEndsAt];
    await rejects(f.service.reject(f.principal, f.candidate.id), http(401)); equal(f.state.row.status, "PENDING");
  });
  it("falla ante reloj ausente/no finito", async () => {
    for (const now of [null, new Date(NaN), "2026-09-12"]) {
      const f = fixture(); f.state.now = now;
      await rejects(f.detail(), { message: "MATRIX_DATABASE_CLOCK_UNAVAILABLE" }); equal(f.state.candidateReads, 0);
    }
  });
  for (const code of ["P2002", "P2034", "P2010"]) {
    it(`mapea conflicto ${code} sin repetir la transacción`, async () => {
      const f = fixture(); f.state.error = new Prisma.PrismaClientKnownRequestError("synthetic", { code, clientVersion: "test", meta: { code: "40P01" } });
      await rejects(f.detail(), http(409)); equal(f.state.transactions, 1);
    });
  }
  it("no disfraza errores desconocidos", async () => {
    const f = fixture(); const error = new Error("synthetic"); f.state.error = error;
    await rejects(f.detail(), (caught) => caught === error);
  });
  it("rutas limitadas a sesión/roles/gate, sin caché ni endpoint approve", () => {
    const controller = MatrixDeviceCandidateReviewController;
    deepEqual(Reflect.getMetadata(GUARDS_METADATA, controller), [SessionAuthGuard, RolesGuard, E2eeReleaseGuard]);
    deepEqual(Reflect.getMetadata(ROLES_KEY, controller), ["CLIENT", "CASHIER"]);
    equal(Reflect.getMetadata(PATH_METADATA, controller), "e2ee/matrix/device-candidate-reviews");
    deepEqual(Object.getOwnPropertyNames(controller.prototype).sort(), ["constructor", "detail", "pending", "reject"]);
    for (const [method, limit] of [["pending", 30], ["detail", 10], ["reject", 10]] as const) {
      deepEqual(Reflect.getMetadata(HEADERS_METADATA, controller.prototype[method]), [{ name: "Cache-Control", value: "no-store" }]);
      equal(Reflect.getMetadata("THROTTLER:LIMITdefault", controller.prototype[method]), limit);
      equal(Reflect.getMetadata("THROTTLER:TTLdefault", controller.prototype[method]), 60_000);
    }
  });
});

function fixture() {
  const candidate = candidateFixture(MATRIX_USER);
  const parsed = parseMatrixDeviceCandidate(candidate.body, { userId: MATRIX_USER, deviceId: candidate.body.device_keys.device_id });
  const principal: SessionPrincipal = { id: USER, username: "review-fixture", role: "CLIENT", status: "ACTIVE", sessionId: SESSION,
    deviceId: DEVICE, sessionExpiresAt: new Date(NOW.getTime() + 3_600_000) };
  const order: string[] = [];
  const state: any = { now: NOW, clocks: [], actorLocked: true, requesterLocked: true, transactions: 0, candidateReads: 0,
    updates: 0, operationalWrites: 0, subscriptionEndsAt: null, error: null,
    identity: { userId: USER, matrixUserId: MATRIX_USER, bootstrapDeviceId: DEVICE, bootstrapSha256: "a".repeat(64) },
    actor: { userId: USER, deviceId: DEVICE, revokedAt: null, expiresAt: principal.sessionExpiresAt, sessionVersion: 1,
      user: { role: "CLIENT", status: "ACTIVE", sessionVersion: 1, passwordResetRequired: false } },
    requester: { userId: USER, deviceId: null, revokedAt: null, expiresAt: principal.sessionExpiresAt, sessionVersion: 1 },
    row: { id: candidate.id, userId: USER, trustedDeviceId: DEVICE, sessionId: REQUESTER, sessionVersion: 1,
      matrixUserId: MATRIX_USER, matrixDeviceId: candidate.body.device_keys.device_id, identityBootstrapSha256: "a".repeat(64),
      ...structuredClone(parsed), status: "PENDING", createdAt: NOW, expiresAt: new Date(NOW.getTime() + 600_000), resolvedAt: null }
  };
  function operationalWrite(): never { state.operationalWrites++; throw new Error("UNEXPECTED_OPERATIONAL_WRITE"); }
  const tx: any = {
    async $queryRaw(query: any, ...parameters: unknown[]) {
      const sql: string = Array.isArray(query) ? query.join("?") : query.sql;
      const values = Array.isArray(query) ? parameters : query.values;
      if (sql.includes("pg_advisory")) { order.push("device-lock"); return []; }
      if (sql.includes('SELECT s."id"')) { order.push("actor-lock"); return state.actorLocked ? [{ id: SESSION }] : []; }
      if (sql.includes('SELECT q."id"')) {
        order.push("candidate-lock");
        const row = state.row;
        return row && row.userId === values[0] && row.trustedDeviceId === values[1] &&
          (values.length === 3 ? row.id === values[2] : row.status === "PENDING") ? [{ id: row.id }] : [];
      }
      if (sql.includes('SELECT r."id"')) { order.push("requester-lock"); return state.requesterLocked ? [{ id: REQUESTER }] : []; }
      if (sql.includes("clock_timestamp")) return [{ now: state.clocks.length ? state.clocks.shift() : state.now }];
      throw new Error("UNEXPECTED_SQL");
    },
    matrixCrossSigningIdentity: { async findUnique() { return state.identity; }, create: operationalWrite, update: operationalWrite },
    authSession: { async findUnique({ where }: any) { return structuredClone(where.id === SESSION ? state.actor : state.requester); }, update: operationalWrite },
    matrixDeviceCandidate: {
      async findUnique() { state.candidateReads++; return structuredClone(state.row); },
      async update({ where, data }: any) { equal(where.id, state.row.id); state.updates++; Object.assign(state.row, data); return structuredClone(state.row); }
    },
    device: { create: operationalWrite, update: operationalWrite },
    matrixDeviceKey: { create: operationalWrite, update: operationalWrite },
    matrixDeviceCrossSigning: { create: operationalWrite },
    matrixDeviceRegistration: { create: operationalWrite },
    matrixOneTimeKey: { create: operationalWrite },
    matrixToDeviceCursor: { create: operationalWrite },
    matrixDeviceListChange: { create: operationalWrite }
  };
  const prisma: any = { async $transaction(operation: any) {
    state.transactions++; if (state.error) throw state.error;
    const row = structuredClone(state.row);
    try { return await operation(tx); } catch (error) { state.row = row; throw error; }
  } };
  const eligibility: any = { async lockOperationalUser() { order.push("user-lock"); },
    async lockCurrentCashier() { order.push("cashier-lock"); return { subscriptionEndsAt: state.subscriptionEndsAt }; } };
  const service = new MatrixDeviceCandidateReviewService(prisma, eligibility);
  return { service, principal, state, order, candidate, detail: () => service.detail(principal, candidate.id) };
}
