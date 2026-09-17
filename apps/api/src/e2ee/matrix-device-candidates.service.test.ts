import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpException } from "@nestjs/common";
import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { matrixUserIdFromUuid } from "@sinochat/contracts";
import type { SessionPrincipal } from "../auth/auth.types";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { ROLES_KEY } from "../auth/roles.decorator";
import { E2eeReleaseGuard } from "./e2ee-release.guard";
import { Prisma } from "../generated/prisma/client";
import { MatrixDeviceCandidatesService } from "./matrix-device-candidates.service";
import { MatrixDeviceCandidatesController } from "./matrix-device-candidates.controller";
import { candidateFixture } from "./testing/matrix-candidate.fixture";

process.env.NODE_ENV = "test";
process.env.MATRIX_SERVER_NAME = "sinochat.invalid";
const USER = "11111111-1111-4111-8111-111111111111";
const DEVICE = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const OTHER_SESSION = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-09-12T15:00:00Z");
const MATRIX_USER = matrixUserIdFromUuid(USER, "sinochat.invalid");
function principal(): SessionPrincipal { return { id: USER, username: "fixture", role: "CLIENT", status: "ACTIVE", sessionId: SESSION, deviceId: null, sessionExpiresAt: new Date(NOW.getTime() + 3_600_000) }; }
function http(status: number, code?: string) {
  return (error: unknown) => error instanceof HttpException && error.getStatus() === status &&
    (!code || (error.getResponse() as any).code === code);
}

describe("cuarentena de candidatos: servicio y frontera HTTP", () => {
  it("registra únicamente snapshot público; metadatos y replay exactos, sin efectos operativos", async () => {
    const f = fixture();
    const first = await f.reserve();
    deepEqual(Object.keys(first).sort(), ["candidateId", "createdAt", "expiresAt", "matrixDeviceId", "matrixUserId", "state"]);
    equal(first.state, "PENDING");
    equal(new Date(first.expiresAt).getTime() - NOW.getTime(), 600_000);
    deepEqual(await f.reserve(), first);
    deepEqual(await f.service.status(f.principal, f.candidate.id), first);
    equal(f.state.creates, 1);
    equal(f.state.rows.size, 1);
    equal(f.state.session.deviceId, null);
    equal(f.state.operationalWrites, 0);
    deepEqual(f.order.slice(0, 3), ["device-lock", "user-lock", "session-device-lock"]);
  });
  for (const action of ["reserve", "status", "cancel"] as const) {
    it(`excluye ADMIN en servicio: ${action}`, async () => {
      const f = fixture(); f.principal.role = "ADMIN";
      await rejects(f.service[action](f.principal, f.candidate.id, f.candidate.body), http(403));
      equal(f.state.transactions, 0);
    });
    it(`excluye una sesión que ya tiene dispositivo: ${action}`, async () => {
      const f = fixture(); f.principal.deviceId = DEVICE;
      await rejects(f.service[action](f.principal, f.candidate.id, f.candidate.body), http(403));
      equal(f.state.transactions, 0);
    });
  }
  for (const id of ["invalid", "11111111-1111-1111-8111-111111111111", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"]) {
    it("rechaza ID no canónico antes de reservar", async () => {
      const f = fixture(); await rejects(f.service.reserve(f.principal, id, f.candidate.body), http(400)); equal(f.state.transactions, 0);
    });
  }
  it("ni otra sesión propia consulta, cancela o hereda el reintento", async () => {
    const f = fixture(); await f.reserve(); const other = { ...f.principal, sessionId: OTHER_SESSION };
    await rejects(f.service.status(other, f.candidate.id), http(404));
    await rejects(f.service.cancel(other, f.candidate.id), http(404));
    await rejects(f.service.reserve(other, f.candidate.id, f.candidate.body), http(409));
    equal(f.state.rows.get(f.candidate.id).status, "PENDING");
  });
  it("no extiende TTL ni sustituye claves con un cuerpo nuevo válidamente firmado", async () => {
    const f = fixture(); const first = await f.reserve(); f.state.now = new Date(NOW.getTime() + 100_000);
    deepEqual(await f.reserve(), first);
    await rejects(f.service.reserve(f.principal, f.candidate.id, candidateFixture(MATRIX_USER, f.candidate.id).body), http(409, "MATRIX_CANDIDATE_REPLAY_MISMATCH"));
    equal(f.state.creates, 1);
  });
  it("una PENDING por usuario sin revelar la sesión que la reservó", async () => {
    const f = fixture(); await f.reserve(); const second = candidateFixture(MATRIX_USER);
    await rejects(f.service.reserve(f.principal, second.id, second.body), http(409, "MATRIX_CANDIDATE_ALREADY_PENDING")); equal(f.state.rows.size, 1);
  });
  it("cancelación sin motivo es idempotente y terminal, incluso al reintentar reserve", async () => {
    const f = fixture(); await f.reserve(); const cancelled = await f.service.cancel(f.principal, f.candidate.id);
    equal(cancelled.state, "CANCELLED"); deepEqual(await f.service.cancel(f.principal, f.candidate.id), cancelled);
    deepEqual(await f.reserve(), cancelled); equal(f.state.updates, 1);
  });
  it("expira inclusivamente y conserva terminal tras rollback del reloj", async () => {
    const f = fixture(); const first = await f.reserve(); f.state.now = new Date(first.expiresAt);
    equal((await f.service.status(f.principal, f.candidate.id)).state, "EXPIRED");
    f.state.now = new Date(NOW.getTime() + 1000);
    equal((await f.reserve()).state, "EXPIRED"); equal(f.state.rows.get(f.candidate.id).status, "EXPIRED");
  });
  it("una nueva reserva expira la anterior sin reaprovechar su identificador", async () => {
    const f = fixture(); const first = await f.reserve(); f.state.now = new Date(first.expiresAt);
    const second = candidateFixture(MATRIX_USER);
    equal((await f.service.reserve(f.principal, second.id, second.body)).state, "PENDING");
    equal(f.state.rows.get(f.candidate.id).status, "EXPIRED"); equal(f.state.rows.size, 2);
  });
  it("vencimiento gana sobre cancelar", async () => {
    const f = fixture(); const first = await f.reserve(); f.state.now = new Date(first.expiresAt);
    equal((await f.service.cancel(f.principal, f.candidate.id)).state, "EXPIRED");
  });
  for (const source of ["session", "subscription"] as const) {
    it(`TTL acotado por ${source}`, async () => {
      const f = fixture(); const expires = new Date(NOW.getTime() + 30_000);
      if (source === "session") f.state.session.expiresAt = expires;
      else { f.principal.role = "CASHIER"; f.state.session.user.role = "CASHIER"; f.state.subscriptionEndsAt = expires; }
      equal((await f.reserve()).expiresAt, expires.toISOString());
      if (source === "subscription") ok(f.order.includes("cashier-lock"));
    });
  }
  for (const source of ["operational-id", "registration-id", "operational-key", "pin-key"] as const) {
    it(`rechaza reutilización de ${source}`, async () => {
      const f = fixture();
      if (source === "operational-id") f.state.deviceExists = true;
      if (source === "registration-id") f.state.registrationExists = true;
      if (source === "operational-key") f.state.keyExists = true;
      if (source === "pin-key") f.state.identity.selfSigningKey = Object.values(f.candidate.body.device_keys.keys)[0];
      await rejects(f.reserve(), http(409)); equal(f.state.rows.size, 0);
    });
  }
  for (const mutation of ["bound", "revoked", "expired", "version", "role", "inactive", "reset", "owner"] as const) {
    it(`revalida sesión real tras locks: ${mutation}`, async () => {
      const f = fixture(); const session = f.state.session;
      if (mutation === "bound") session.deviceId = DEVICE;
      if (mutation === "revoked") session.revokedAt = NOW;
      if (mutation === "expired") session.expiresAt = NOW;
      if (mutation === "version") session.user.sessionVersion++;
      if (mutation === "role") session.user.role = "ADMIN";
      if (mutation === "inactive") session.user.status = "PENDING";
      if (mutation === "reset") session.user.passwordResetRequired = true;
      if (mutation === "owner") session.userId = OTHER_SESSION;
      await rejects(f.reserve(), http(401)); equal(f.state.rows.size, 0);
    });
  }
  for (const phase of ["missing-pin", "foreign-namespace", "lost-device"] as const) {
    it(`rechaza confianza propia ausente: ${phase}`, async () => {
      const f = fixture();
      if (phase === "missing-pin") f.state.identity = null;
      if (phase === "foreign-namespace") f.state.identity.matrixUserId = "other";
      if (phase === "lost-device") f.state.locked = false;
      await rejects(f.reserve(), http(phase === "lost-device" ? 401 : 409)); equal(f.state.rows.size, 0);
    });
  }
  it("vencimiento durante la inserción revierte la fila", async () => {
    const f = fixture(); f.state.clocks = [NOW, new Date(NOW.getTime() + 600_000)];
    await rejects(f.reserve(), http(409, "MATRIX_CANDIDATE_EXPIRED_DURING_OPERATION")); equal(f.state.rows.size, 0);
  });
  it("expiración de sesión durante la operación también revierte", async () => {
    const f = fixture(); f.state.session.expiresAt = new Date(NOW.getTime() + 1000);
    f.state.clocks = [NOW, f.state.session.expiresAt];
    await rejects(f.reserve(), http(401)); equal(f.state.rows.size, 0);
  });
  it("suscripción vencida tras locks falla aunque el principal esté vigente", async () => {
    const f = fixture(); f.principal.role = "CASHIER"; f.state.session.user.role = "CASHIER"; f.state.subscriptionEndsAt = NOW;
    await rejects(f.reserve(), http(401)); equal(f.state.rows.size, 0);
  });
  it("pin/version/contexto discrepantes no heredan candidato anterior", async () => {
    const f = fixture(); await f.reserve(); f.state.identity.bootstrapSha256 = "b".repeat(64);
    await rejects(f.service.status(f.principal, f.candidate.id), http(409)); await rejects(f.reserve(), http(409));
  });
  for (const code of ["P2002", "P2034", "P2010"]) {
    it(`convierte conflicto Prisma ${code} sin repetir`, async () => {
      const f = fixture(); f.state.error = new Prisma.PrismaClientKnownRequestError("synthetic", { code, clientVersion: "test", meta: { code: "40P01" } });
      await rejects(f.reserve(), http(409, "MATRIX_CANDIDATE_CONCURRENT_CHANGE")); equal(f.state.transactions, 1);
    });
  }
  it("errores ajenos no se disfrazan de conflicto de concurrencia", async () => {
    const f = fixture(); const error = { code: "P2002" }; f.state.error = error;
    await rejects(f.reserve(), (caught) => caught === error);
  });
  it("mantiene las tres rutas bajo sesión, roles y gate; no hay approve", () => {
    deepEqual(Reflect.getMetadata(GUARDS_METADATA, MatrixDeviceCandidatesController), [SessionAuthGuard, RolesGuard, E2eeReleaseGuard]);
    deepEqual(Reflect.getMetadata(ROLES_KEY, MatrixDeviceCandidatesController), ["CLIENT", "CASHIER"]);
    equal(Reflect.getMetadata(PATH_METADATA, MatrixDeviceCandidatesController), "e2ee/matrix/device-candidates");
    deepEqual(Object.getOwnPropertyNames(MatrixDeviceCandidatesController.prototype).sort(), ["cancel", "constructor", "reserve", "status"]);
  });
});

function fixture() {
  const actor = principal(); const candidate = candidateFixture(MATRIX_USER);
  const order: string[] = [];
  const state: any = { now: NOW, clocks: [], rows: new Map(), creates: 0, updates: 0, transactions: 0, operationalWrites: 0,
    locked: true, deviceExists: false, registrationExists: false, keyExists: false, subscriptionEndsAt: null, error: null,
    identity: { userId: USER, matrixUserId: MATRIX_USER, bootstrapDeviceId: DEVICE, bootstrapSha256: "a".repeat(64),
      masterKey: "master", selfSigningKey: "self", userSigningKey: "user" },
    session: { userId: USER, deviceId: null, revokedAt: null, expiresAt: actor.sessionExpiresAt, sessionVersion: 1,
      user: { role: "CLIENT", status: "ACTIVE", sessionVersion: 1, passwordResetRequired: false } } };
  function matches(row: any, where: any): boolean { return Object.entries(where).every(([key, value]: any) =>
    key === "expiresAt" ? row.expiresAt <= value.lte : row[key] === value); }
  function operationalWrite(): never { state.operationalWrites++; throw new Error("UNEXPECTED_OPERATIONAL_WRITE"); }
  const tx: any = {
    async $queryRaw(parts: TemplateStringsArray) {
      const sql = parts.join("?");
      if (sql.includes("pg_advisory")) { order.push("device-lock"); return []; }
      if (sql.includes('SELECT s."id"')) { order.push("session-device-lock"); return state.locked ? [{ id: SESSION }] : []; }
      if (sql.includes("clock_timestamp")) return [{ now: state.clocks.shift() ?? state.now }];
      throw new Error("UNEXPECTED_SQL");
    },
    matrixCrossSigningIdentity: { async findUnique() { return state.identity; } },
    authSession: { async findUnique() { return state.session; }, update: operationalWrite },
    device: { async findUnique() { return state.deviceExists ? { id: candidate.id } : null; }, create: operationalWrite },
    matrixDeviceRegistration: { async findUnique() { return state.registrationExists ? { id: candidate.id } : null; }, create: operationalWrite },
    matrixDeviceKey: { async findFirst() { return state.keyExists ? { deviceId: DEVICE } : null; }, create: operationalWrite },
    matrixDeviceCandidate: {
      async findUnique({ where }: any) { return state.rows.get(where.id) ?? null; },
      async findFirst({ where }: any) { return [...state.rows.values()].find((row) => matches(row, where)) ?? null; },
      async updateMany({ where, data }: any) { let count = 0; for (const row of state.rows.values()) if (matches(row, where)) { Object.assign(row, data); count++; } return { count }; },
      async create({ data }: any) { state.creates++; const row = { ...structuredClone(data), resolvedAt: null }; state.rows.set(data.id, row); return row; },
      async update({ where, data }: any) { state.updates++; const row = state.rows.get(where.id); Object.assign(row, data); return row; }
    }
  };
  const prisma: any = { async $transaction(operation: any) { state.transactions++; if (state.error) throw state.error;
    const originalRows = structuredClone(state.rows);
    try { return await operation(tx); } catch (error) { state.rows = originalRows; throw error; } } };
  const eligibility: any = { async lockOperationalUser() { order.push("user-lock"); },
    async lockCurrentCashier() { order.push("cashier-lock"); return { subscriptionEndsAt: state.subscriptionEndsAt }; } };
  const service = new MatrixDeviceCandidatesService(prisma, eligibility);
  return { service, principal: actor, candidate, state, order, reserve: () => service.reserve(actor, candidate.id, candidate.body) };
}
