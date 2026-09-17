import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import { ForbiddenException, HttpException } from "@nestjs/common";
import { matrixDeviceIdFromUuid, matrixUserIdFromUuid } from "@sinochat/contracts";
import type { SessionPrincipal } from "../auth/auth.types";
import { Prisma } from "../generated/prisma/client";
import { parseMatrixDeviceCandidate } from "./matrix-device-candidate";
import { MatrixDeviceVerificationService } from "./matrix-device-verification.service";
import { parseMatrixSasToDeviceRequest } from "./matrix-sas-to-device";
import { candidateFixture } from "./testing/matrix-candidate.fixture";

process.env.NODE_ENV = "test";
process.env.MATRIX_SERVER_NAME = "sinochat.invalid";
const USER = "11111111-1111-4111-8111-111111111111";
const DEVICE = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const REQUESTER = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-09-13T18:00:00Z");
const MATRIX_USER = matrixUserIdFromUuid(USER, "sinochat.invalid");
const MATRIX_DEVICE = matrixDeviceIdFromUuid(DEVICE);
const FLOW = "verification-flow-1";
const TRANSACTION = "verification-http-1";
const http = (status: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === status;
const at = (offset: number) => new Date(NOW.getTime() + offset);

describe("admision SAS: dos sesiones exactas, sin entrega ni autorizacion", () => {
  it("persiste solo el flujo ligado a candidato, revisor, solicitud canonica y plazo", async () => {
    const f = fixture();
    const result = await f.open();
    deepEqual(Object.keys(result).sort(), ["candidateId", "createdAt", "expiresAt", "flowId", "state"]);
    deepEqual(result, { candidateId: f.candidate.id, flowId: FLOW, state: "PENDING", createdAt: NOW.toISOString(), expiresAt: at(600_000).toISOString() });
    const parsed = parseMatrixSasToDeviceRequest("m.key.verification.request", TRANSACTION, f.body, {
      userId: MATRIX_USER, senderDeviceId: MATRIX_DEVICE, recipientDeviceId: f.state.row.matrixDeviceId,
      flowId: FLOW, pinnedMasterKey: f.state.identity.masterKey
    });
    deepEqual(f.state.flow.requestContent, f.content);
    equal(f.state.flow.requestSha256, parsed.canonicalSha256);
    equal(f.state.flow.reviewerSessionId, SESSION);
    equal(f.state.flow.reviewerSessionVersion, 1);
    equal(f.state.flow.userId, USER);
    equal(f.state.flow.candidateId, f.candidate.id);
    equal(f.state.flow.requestTransactionId, TRANSACTION);
    equal(f.state.creates, 1); equal(f.state.candidateUpdates, 0); equal(f.state.operationalWrites, 0);
    equal(f.state.requester.deviceId, null); equal(f.state.row.status, "PENDING");
    deepEqual(f.order, ["device-lock", "user-lock", "reviewer-lock", "clock", "candidate-lock", "requester-lock", "flow-lock", "clock", "flow-create", "clock"]);
    deepEqual(f.state.transactionOptions, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 30_000 });
  });

  for (const invalid of ["admin", "unbound", "malformed-device"] as const) {
    it(`rechaza ${invalid} antes de iniciar transaccion`, async () => {
      const f = fixture();
      if (invalid === "admin") f.principal.role = "ADMIN";
      if (invalid === "unbound") f.principal.deviceId = null;
      if (invalid === "malformed-device") f.principal.deviceId = "not-uuid";
      await rejects(f.open(), http(403)); equal(f.state.transactions, 0);
    });
  }
  for (const field of ["candidateId", "flowId", "transactionId"] as const) {
    for (const value of ["", "with spaces", "../path", null]) {
      it(`rechaza ${field} invalido antes de abrir transaccion (${String(value)})`, async () => {
        const f = fixture();
        const args: any = { candidateId: f.candidate.id, flowId: FLOW, transactionId: TRANSACTION, [field]: value };
        await rejects(f.service.open(f.principal, args.candidateId, args.flowId, args.transactionId, f.body), http(400));
        equal(f.state.transactions, 0);
      });
    }
  }
  it("rechaza UUID candidato no canonico o no v4", async () => {
    const f = fixture();
    for (const value of ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "11111111-1111-1111-8111-111111111111"]) {
      await rejects(f.service.open(f.principal, value, FLOW, TRANSACTION, f.body), http(400));
    }
    equal(f.state.transactions, 0);
  });
  it("rechaza IDs de flujo y transporte mayores de 255 caracteres", async () => {
    const f = fixture();
    await rejects(f.service.open(f.principal, f.candidate.id, "a".repeat(256), TRANSACTION, f.body), http(400));
    await rejects(f.service.open(f.principal, f.candidate.id, FLOW, "a".repeat(256), f.body), http(400));
    equal(f.state.transactions, 0);
  });

  for (const mutation of ["missing", "namespace", "bootstrap"] as const) {
    it(`exige identidad bootstrap propia: ${mutation}`, async () => {
      const f = fixture();
      if (mutation === "missing") f.state.identity = null;
      if (mutation === "namespace") f.state.identity.matrixUserId = "foreign";
      if (mutation === "bootstrap") f.state.identity.bootstrapDeviceId = OTHER;
      await rejects(f.open(), http(404)); equal(f.state.candidateReads, 0); equal(f.state.creates, 0);
    });
  }
  it("exige que join de sesion/dispositivo/directorio/certificado conserve confianza", async () => {
    const f = fixture(); f.state.reviewerLocked = false;
    await rejects(f.open(), http(401)); equal(f.state.candidateReads, 0);
  });
  for (const mutation of ["missing", "owner", "device", "revoked", "expired", "session-version", "role", "status", "reset"] as const) {
    it(`relee autoridad actual del revisor: ${mutation}`, async () => {
      const f = fixture(); const actor = f.state.actor;
      if (mutation === "missing") f.state.actor = null;
      if (mutation === "owner") actor.userId = OTHER;
      if (mutation === "device") actor.deviceId = OTHER;
      if (mutation === "revoked") actor.revokedAt = NOW;
      if (mutation === "expired") actor.expiresAt = NOW;
      if (mutation === "session-version") actor.user.sessionVersion++;
      if (mutation === "role") actor.user.role = "ADMIN";
      if (mutation === "status") actor.user.status = "SUSPENDED";
      if (mutation === "reset") actor.user.passwordResetRequired = true;
      await rejects(f.open(), http(401)); equal(f.state.candidateReads, 0); equal(f.state.creates, 0);
    });
  }
  for (const mutation of ["missing", "owner", "trusted-device"] as const) {
    it(`no lee candidato fuera del alcance bloqueado: ${mutation}`, async () => {
      const f = fixture();
      if (mutation === "missing") f.state.row = null;
      if (mutation === "owner") f.state.row.userId = OTHER;
      if (mutation === "trusted-device") f.state.row.trustedDeviceId = OTHER;
      await rejects(f.open(), http(404)); equal(f.state.candidateReads, 0); equal(f.state.creates, 0);
    });
  }
  for (const mutation of ["requester-lock", "same-session", "owner", "bound", "revoked", "expired", "requester-version", "candidate-version"] as const) {
    it(`exige segunda sesion propia no vinculada y vigente: ${mutation}`, async () => {
      const f = fixture();
      if (mutation === "requester-lock") f.state.requesterLocked = false;
      if (mutation === "same-session") f.state.row.sessionId = SESSION;
      if (mutation === "owner") f.state.requester.userId = OTHER;
      if (mutation === "bound") f.state.requester.deviceId = OTHER;
      if (mutation === "revoked") f.state.requester.revokedAt = NOW;
      if (mutation === "expired") f.state.requester.expiresAt = NOW;
      if (mutation === "requester-version") f.state.requester.sessionVersion++;
      if (mutation === "candidate-version") { f.state.requester.sessionVersion++; f.state.row.sessionVersion++; }
      await rejects(f.open(), http(404)); equal(f.state.creates, 0); equal(f.state.operationalWrites, 0);
    });
  }
  for (const mutation of ["pin", "matrix-user", "matrix-device", "hash", "ed25519", "curve25519", "signature", "private-key", "resigned"] as const) {
    it(`no admite snapshot o pin discrepante: ${mutation}`, async () => {
      const f = fixture(); const row = f.state.row;
      if (mutation === "pin") row.identityBootstrapSha256 = "b".repeat(64);
      if (mutation === "matrix-user") row.matrixUserId = "foreign";
      if (mutation === "matrix-device") row.matrixDeviceId = matrixDeviceIdFromUuid(OTHER);
      if (mutation === "hash") row.canonicalSha256 = "b".repeat(64);
      if (mutation === "ed25519") row.ed25519Key = "a".repeat(43);
      if (mutation === "curve25519") row.curve25519Key = "a".repeat(43);
      if (mutation === "signature") row.deviceKeys.signatures[MATRIX_USER][`ed25519:${row.matrixDeviceId}`] = "a".repeat(86);
      if (mutation === "private-key") row.deviceKeys.private_key = "synthetic-only";
      if (mutation === "resigned") row.deviceKeys = candidateFixture(MATRIX_USER, f.candidate.id).body.device_keys;
      await rejects(f.open(), http(409)); equal(f.state.creates, 0);
    });
  }
  const bodyMutations: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ["extra envelope", (f) => { (f.body as any).approved = true; }],
    ["foreign recipient", (f) => { (f.body.messages as any)["foreign"] = {}; }],
    ["another device", (f) => { (f.body.messages[MATRIX_USER] as any)[MATRIX_DEVICE] = f.content; }],
    ["wrong sender", (f) => { f.content.from_device = matrixDeviceIdFromUuid(OTHER); }],
    ["wrong flow", (f) => { f.content.transaction_id = "other-flow"; }],
    ["wrong method", (f) => { f.content.methods = ["m.qr_code.scan.v1"]; }],
    ["private field", (f) => { (f.content as any).seed = "synthetic-only"; }],
    ["invalid timestamp", (f) => { f.content.timestamp = -1; }]
  ];
  for (const [label, mutate] of bodyMutations) {
    it(`el parser real rechaza ${label} sin crear flujo`, async () => {
      const f = fixture(); mutate(f);
      await rejects(f.open(), http(400)); equal(f.state.creates, 0); equal(f.state.operationalWrites, 0);
    });
  }
  it("rechaza getters del body sin ejecutarlos ni exponer su texto", async () => {
    const f = fixture(); let called = false;
    Object.defineProperty(f.content, "timestamp", { enumerable: true, get() { called = true; throw new Error("synthetic-only"); } });
    await rejects(f.open(), (error) => http(400)(error) && !(error as Error).message.includes("synthetic-only"));
    equal(called, false); equal(f.state.creates, 0);
  });

  it("repetir solicitud exacta conserva flujo, contenido y vencimiento originales", async () => {
    const f = fixture(); const first = await f.open(); const stored = structuredClone(f.state.flow);
    f.state.now = at(120_000);
    deepEqual(await f.open(), first); deepEqual(f.state.flow, stored); equal(f.state.creates, 1);
    equal(f.state.candidateUpdates, 0); equal(f.state.operationalWrites, 0);
  });
  for (const mutation of ["reviewer-session", "flow", "transaction", "content", "flow-status", "flow-owner", "flow-version", "flow-hash"] as const) {
    it(`un replay no puede sustituir ${mutation}`, async () => {
      const f = fixture(); await f.open(); const first = structuredClone(f.state.flow);
      if (mutation === "reviewer-session") f.principal.sessionId = OTHER;
      if (mutation === "flow-status") f.state.flow.status = "CANCELLED";
      if (mutation === "flow-owner") f.state.flow.userId = OTHER;
      if (mutation === "flow-version") f.state.flow.reviewerSessionVersion++;
      if (mutation === "flow-hash") f.state.flow.requestSha256 = "b".repeat(64);
      if (mutation === "content") f.content.timestamp++;
      const flow = mutation === "flow" ? "other-flow" : FLOW;
      if (mutation === "flow") f.content.transaction_id = flow;
      const transaction = mutation === "transaction" ? "other-http" : TRANSACTION;
      await rejects(f.service.open(f.principal, f.candidate.id, flow, transaction, f.body), http(409));
      equal(f.state.creates, 1); deepEqual(f.state.flow.expiresAt, first.expiresAt); equal(f.state.operationalWrites, 0);
    });
  }
  it("el replay sigue exigiendo ambas sesiones vigentes", async () => {
    const f = fixture(); await f.open(); f.state.requester.revokedAt = NOW;
    await rejects(f.open(), http(404)); equal(f.state.creates, 1);
    f.state.requester.revokedAt = null; f.state.actor.revokedAt = NOW;
    await rejects(f.open(), http(401)); equal(f.state.creates, 1);
  });
  for (const status of ["EXPIRED", "CANCELLED"]) {
    it(`un candidato ${status} no se reabre`, async () => {
      const f = fixture(); f.state.row.status = status;
      await rejects(f.open(), http(409)); equal(f.state.row.status, status); equal(f.state.creates, 0); equal(f.state.candidateUpdates, 0);
    });
  }
  it("vencimiento inclusivo del candidato persiste fuera del rechazo HTTP", async () => {
    const f = fixture(); f.state.now = f.state.row.expiresAt;
    await rejects(f.open(), http(409)); equal(f.state.row.status, "EXPIRED"); equal(f.state.candidateUpdates, 1);
    equal(f.state.creates, 0); f.state.now = NOW;
    await rejects(f.open(), http(409)); equal(f.state.row.status, "EXPIRED"); equal(f.state.creates, 0);
  });
  it("relee el reloj despues de obtener locks y vence antes de insertar", async () => {
    const f = fixture(); f.state.clocks = [NOW, f.state.row.expiresAt, f.state.row.expiresAt];
    await rejects(f.open(), http(409)); equal(f.state.row.status, "EXPIRED"); equal(f.state.creates, 0);
    ok(f.order.indexOf("flow-lock") < f.order.lastIndexOf("clock"));
  });
  it("un flujo vencido cancela su candidato vigente y nunca recicla su ID", async () => {
    const f = fixture(); f.state.actor.expiresAt = at(60_000); await f.open();
    // Same session may have its validity extended administratively; the flow's
    // already pinned deadline must not inherit that extension on a replay.
    f.state.actor.expiresAt = at(3_600_000); f.state.now = at(60_000);
    await rejects(f.open(), http(409)); equal(f.state.row.status, "CANCELLED"); equal(f.state.flow.status, "EXPIRED");
    deepEqual(f.state.flow.resolvedAt, at(60_000));
    f.state.now = NOW; await rejects(f.open(), http(409)); equal(f.state.creates, 1);
  });

  for (const limiting of ["candidate", "requester", "reviewer", "subscription", "timestamp", "current-clock"] as const) {
    it(`calcula TTL por el minimo: ${limiting}`, async () => {
      const f = fixture(); let expected = at(45_000);
      if (limiting === "candidate") f.state.row.expiresAt = expected;
      if (limiting === "requester") f.state.requester.expiresAt = expected;
      if (limiting === "reviewer") f.state.actor.expiresAt = expected;
      if (limiting === "subscription") { f.cashier(); f.state.subscriptionEndsAt = expected; }
      if (limiting === "timestamp") f.content.timestamp = NOW.getTime() - 555_000;
      if (limiting === "current-clock") {
        f.state.row.expiresAt = at(3_600_000); f.content.timestamp = NOW.getTime() + 300_000; expected = at(600_000);
      }
      const result = await f.open(); equal(result.expiresAt, expected.toISOString()); equal(f.state.flow.createdAt.getTime(), NOW.getTime());
    });
  }
  for (const offset of [-600_001, 300_001]) {
    it(`rechaza timestamp fuera de ventana (${offset})`, async () => {
      const f = fixture(); f.content.timestamp = NOW.getTime() + offset;
      await rejects(f.open(), (error) => http(400)(error) && (error as Error).message === "MATRIX_VERIFICATION_TIMESTAMP_STALE");
      equal(f.state.creates, 0);
    });
  }
  it("timestamp exactamente diez minutos viejo no obtiene un plazo vacio", async () => {
    const f = fixture(); f.content.timestamp = NOW.getTime() - 600_000;
    await rejects(f.open(), http(409)); equal(f.state.creates, 0);
  });
  it("una solicitud casi vencida conserva solo el milisegundo restante", async () => {
    const f = fixture(); f.content.timestamp = NOW.getTime() - 599_999;
    equal((await f.open()).expiresAt, at(1).toISOString());
  });
  it("timestamp exactamente cinco minutos futuro no extiende el plazo de diez minutos", async () => {
    const f = fixture(); f.content.timestamp = NOW.getTime() + 300_000;
    equal((await f.open()).expiresAt, at(600_000).toISOString());
  });
  it("consulta la vigencia real de sesion sin confiar en la fecha del principal", async () => {
    const f = fixture(); f.principal.sessionExpiresAt = at(1);
    equal((await f.open()).expiresAt, at(600_000).toISOString());
    const expired = fixture(); expired.principal.sessionExpiresAt = at(86_400_000); expired.state.actor.expiresAt = NOW;
    await rejects(expired.open(), http(401)); equal(expired.state.creates, 0);
  });
  it("permite que ID de transporte y flujo coincidan sin confundir sus campos", async () => {
    const f = fixture();
    const result = await f.service.open(f.principal, f.candidate.id, FLOW, FLOW, f.body);
    equal(result.flowId, FLOW); equal(f.state.flow.flowId, FLOW); equal(f.state.flow.requestTransactionId, FLOW);
    equal(f.state.flow.requestContent.transaction_id, FLOW); equal(f.state.creates, 1);
  });
  it("expirar despues de crear revierte el flujo y no autoriza nada", async () => {
    const f = fixture(); f.state.row.expiresAt = at(1000); f.state.clocks = [NOW, NOW, at(1000)];
    await rejects(f.open(), http(409)); equal(f.state.creates, 1); equal(f.state.flow, null);
    equal(f.state.row.status, "PENDING"); equal(f.state.operationalWrites, 0);
  });
  for (const limiting of ["reviewer", "requester", "subscription"] as const) {
    it(`vence ${limiting} tras insertar: rollback`, async () => {
      const f = fixture();
      if (limiting === "reviewer") f.state.actor.expiresAt = at(1000);
      if (limiting === "requester") f.state.requester.expiresAt = at(1000);
      if (limiting === "subscription") { f.cashier(); f.state.subscriptionEndsAt = at(1000); }
      f.state.clocks = [NOW, NOW, at(1000)];
      await rejects(f.open(), http(limiting === "requester" ? 409 : 401));
      equal(f.state.creates, 1); equal(f.state.flow, null); equal(f.state.operationalWrites, 0);
    });
  }
  it("si revisor vence al terminalizar candidato se revierte la expiracion", async () => {
    const f = fixture(); f.state.row.expiresAt = at(1000); f.state.actor.expiresAt = at(2000);
    f.state.clocks = [NOW, at(1000), at(2000)];
    await rejects(f.open(), http(401)); equal(f.state.row.status, "PENDING"); equal(f.state.flow, null);
  });
  it("el cajero requiere elegibilidad vigente y conserva su limite de suscripcion", async () => {
    const f = fixture(); f.cashier(); f.state.subscriptionEndsAt = at(20_000);
    equal((await f.open()).expiresAt, at(20_000).toISOString()); ok(f.order.includes("cashier-lock"));
  });
  it("suscripcion ya vencida no permite admision aunque la sesion siga vigente", async () => {
    const f = fixture(); f.cashier(); f.state.subscriptionEndsAt = NOW;
    await rejects(f.open(), http(401)); equal(f.state.creates, 0);
  });
  for (const gate of ["user", "cashier"] as const) {
    it(`respeta rechazo del lock de elegibilidad ${gate}`, async () => {
      const f = fixture(); if (gate === "cashier") f.cashier(); f.state.eligibilityFailure = gate;
      await rejects(f.open(), http(403)); equal(f.state.candidateReads, 0); equal(f.state.creates, 0);
    });
  }
  for (const now of [null, new Date(NaN), "2026-09-13"]) {
    it("reloj ausente o invalido falla cerrado sin crear flujo", async () => {
      const f = fixture(); f.state.now = now;
      await rejects(f.open(), { message: "MATRIX_DATABASE_CLOCK_UNAVAILABLE" }); equal(f.state.creates, 0);
    });
  }
  for (const [code, metaCode] of [["P2002", ""], ["P2034", ""], ["P2010", "40001"], ["P2010", "40P01"], ["P2010", "23505"]]) {
    it(`mapea conflicto Prisma ${code}/${metaCode} sin reintentar`, async () => {
      const f = fixture(); f.state.error = new Prisma.PrismaClientKnownRequestError("synthetic-only", { code, clientVersion: "test", meta: { code: metaCode } });
      await rejects(f.open(), (error) => http(409)(error) && !(error as Error).message.includes("synthetic-only"));
      equal(f.state.transactions, 1); equal(f.state.creates, 0);
    });
  }
  it("errores desconocidos no se convierten en falsos conflictos", async () => {
    const f = fixture(); const error = new Error("synthetic-only"); f.state.error = error;
    await rejects(f.open(), (caught) => caught === error); equal(f.state.transactions, 1);
  });
});

function fixture() {
  const candidate = candidateFixture(MATRIX_USER);
  const parsed = parseMatrixDeviceCandidate(candidate.body, { userId: MATRIX_USER, deviceId: candidate.body.device_keys.device_id });
  const master = candidateFixture(MATRIX_USER, OTHER).body.device_keys.keys[`ed25519:${matrixDeviceIdFromUuid(OTHER)}`];
  const principal: SessionPrincipal = { id: USER, username: "verification-fixture", role: "CLIENT", status: "ACTIVE", sessionId: SESSION,
    deviceId: DEVICE, sessionExpiresAt: at(3_600_000) };
  const content = { from_device: MATRIX_DEVICE, methods: ["m.sas.v1"], timestamp: NOW.getTime(), transaction_id: FLOW };
  const body = { messages: { [MATRIX_USER]: { [candidate.body.device_keys.device_id]: content } } };
  const order: string[] = [];
  const state: any = { now: NOW, clocks: [], reviewerLocked: true, requesterLocked: true, transactions: 0, candidateReads: 0,
    creates: 0, candidateUpdates: 0, operationalWrites: 0, subscriptionEndsAt: null, eligibilityFailure: null, error: null,
    transactionOptions: null, flow: null,
    identity: { userId: USER, matrixUserId: MATRIX_USER, bootstrapDeviceId: DEVICE, bootstrapSha256: "a".repeat(64), masterKey: master },
    actor: { userId: USER, deviceId: DEVICE, revokedAt: null, expiresAt: at(3_600_000), sessionVersion: 1,
      user: { role: "CLIENT", status: "ACTIVE", sessionVersion: 1, passwordResetRequired: false } },
    requester: { userId: USER, deviceId: null, revokedAt: null, expiresAt: at(3_600_000), sessionVersion: 1 },
    row: { id: candidate.id, userId: USER, trustedDeviceId: DEVICE, sessionId: REQUESTER, sessionVersion: 1,
      matrixUserId: MATRIX_USER, matrixDeviceId: candidate.body.device_keys.device_id, identityBootstrapSha256: "a".repeat(64),
      ...structuredClone(parsed), status: "PENDING", createdAt: NOW, expiresAt: at(600_000), resolvedAt: null }
  };
  function operationalWrite(): never { state.operationalWrites++; throw new Error("UNEXPECTED_OPERATIONAL_WRITE"); }
  const tx: any = {
    async $queryRaw(query: any, ...parameters: unknown[]) {
      const sql: string = Array.isArray(query) ? query.join("?") : query.sql;
      const values = Array.isArray(query) ? parameters : query.values;
      if (sql.includes("pg_advisory")) { order.push("device-lock"); deepEqual(values, [principal.id]); return []; }
      if (sql.includes('SELECT s."id"')) {
        order.push("reviewer-lock"); deepEqual(values, [principal.sessionId, principal.id, principal.deviceId, MATRIX_USER, MATRIX_DEVICE]);
        ok(sql.includes("FOR SHARE OF s,d")); ok(sql.includes('"matrix_device_cross_signings"'));
        return state.reviewerLocked ? [{ id: principal.sessionId }] : [];
      }
      if (sql.includes('SELECT q."id"')) {
        order.push("candidate-lock"); ok(sql.includes("FOR UPDATE OF q"));
        const row = state.row;
        return row && row.id === values[0] && row.userId === values[1] && row.trustedDeviceId === values[2] ? [{ id: row.id }] : [];
      }
      if (sql.includes('SELECT r."id"')) {
        order.push("requester-lock"); deepEqual(values, [state.row.sessionId, principal.id]); ok(sql.includes("FOR SHARE OF r"));
        return state.requesterLocked ? [{ id: state.row.sessionId }] : [];
      }
      if (sql.includes('SELECT f."candidate_id"')) {
        order.push("flow-lock"); deepEqual(values, [candidate.id]); ok(sql.includes("FOR UPDATE OF f"));
        return state.flow ? [{ candidate_id: candidate.id }] : [];
      }
      if (sql.includes("clock_timestamp")) { order.push("clock"); return [{ now: state.clocks.length ? state.clocks.shift() : state.now }]; }
      throw new Error("UNEXPECTED_SQL");
    },
    matrixCrossSigningIdentity: { async findUnique({ where }: any) { equal(where.userId, principal.id); return structuredClone(state.identity); }, create: operationalWrite, update: operationalWrite },
    authSession: {
      async findUnique({ where }: any) { equal(where.id, principal.sessionId); return structuredClone(state.actor); },
      async findUniqueOrThrow({ where }: any) { equal(where.id, state.row.sessionId); return structuredClone(state.requester); },
      create: operationalWrite, update: operationalWrite, updateMany: operationalWrite
    },
    matrixDeviceCandidate: {
      async findUniqueOrThrow({ where }: any) { equal(where.id, candidate.id); state.candidateReads++; return structuredClone(state.row); },
      async update({ where, data }: any) {
        equal(where.id, candidate.id); state.candidateUpdates++; Object.assign(state.row, data);
        // Production SQL classifies the flow by its own deadline, not by the
        // parent's terminal label. This fixture has no lock wait between the
        // service clock and the simulated trigger; real SQL tests cover that wait.
        if (state.flow?.status === "PENDING") {
          state.flow.status = state.flow.expiresAt <= data.resolvedAt ? "EXPIRED" : "CANCELLED";
          state.flow.resolvedAt = structuredClone(data.resolvedAt);
        }
        return structuredClone(state.row);
      },
      create: operationalWrite
    },
    matrixDeviceVerificationFlow: {
      async findUnique({ where }: any) { equal(where.candidateId, candidate.id); return structuredClone(state.flow); },
      async create({ data }: any) { order.push("flow-create"); state.creates++; ok(state.flow === null); state.flow = structuredClone(data); return structuredClone(state.flow); },
      update: operationalWrite, updateMany: operationalWrite
    },
    device: { create: operationalWrite, update: operationalWrite },
    matrixDeviceKey: { create: operationalWrite, update: operationalWrite },
    matrixDeviceCrossSigning: { create: operationalWrite }, matrixDeviceRegistration: { create: operationalWrite },
    matrixOneTimeKey: { create: operationalWrite }, matrixFallbackKey: { create: operationalWrite },
    matrixToDeviceCursor: { create: operationalWrite, update: operationalWrite }, matrixToDeviceMessage: { create: operationalWrite },
    matrixDeviceListChange: { create: operationalWrite }, outboxEvent: { create: operationalWrite }
  };
  const prisma: any = { async $transaction(operation: any, options: any) {
    state.transactions++; state.transactionOptions = options; if (state.error) throw state.error;
    const saved = structuredClone({ row: state.row, flow: state.flow });
    try { return await operation(tx); } catch (error) { state.row = saved.row; state.flow = saved.flow; throw error; }
  } };
  const eligibility: any = {
    async lockOperationalUser(_tx: any, userId: string) {
      equal(_tx, tx); equal(userId, principal.id); order.push("user-lock");
      if (state.eligibilityFailure === "user") throw new ForbiddenException("unavailable");
    },
    async lockCurrentCashier(_tx: any, userId: string) {
      equal(_tx, tx); equal(userId, principal.id); order.push("cashier-lock");
      if (state.eligibilityFailure === "cashier") throw new ForbiddenException("unavailable");
      return { subscriptionEndsAt: state.subscriptionEndsAt };
    }
  };
  const service = new MatrixDeviceVerificationService(prisma, eligibility);
  return { service, principal, state, order, candidate, body, content,
    open: () => service.open(principal, candidate.id, FLOW, TRANSACTION, body),
    cashier: () => { principal.role = "CASHIER"; state.actor.user.role = "CASHIER"; }
  };
}
