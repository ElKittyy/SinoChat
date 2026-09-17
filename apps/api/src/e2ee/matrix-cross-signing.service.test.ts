import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { before, describe, it } from "node:test";
import { ForbiddenException, HttpException } from "@nestjs/common";
import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { DeviceId, OlmMachine, RequestType, UserId, initAsync } from "@matrix-org/matrix-sdk-crypto-wasm";
import type { SessionPrincipal } from "../auth/auth.types";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { ROLES_KEY } from "../auth/roles.decorator";
import type { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import type { MatrixDeviceListPublisher } from "../database/matrix-device-list.publisher";
import type { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import { E2eeReleaseGuard } from "./e2ee-release.guard";
import { MatrixCrossSigningService } from "./matrix-cross-signing.service";
import { MatrixTransportController } from "./matrix-transport.controller";
import { parseMatrixCrossSigningBootstrap } from "./matrix-cross-signing";
import { hashMatrixCanonicalJson } from "./matrix-key-upload";

process.env.NODE_ENV = "test";
process.env.MATRIX_SERVER_NAME = "sinochat.invalid";
const USER = "11111111-1111-4111-8111-111111111111";
const DEVICE = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const MATRIX_USER = "@u11111111111141118111111111111111:sinochat.invalid";
const MATRIX_DEVICE = "D22222222222242228222222222222222";
const NOW = new Date("2026-09-11T12:00:00Z");
let deviceKeys: any;
let body: any;
let otherBody: any;

describe("MatrixCrossSigningService publicación inicial", () => {
  before(async () => { ({ deviceKeys, body, otherBody } = await sdkFixture()); });

  it("informa ausencia de identidad sin crear nada ni exponer el directorio", async () => {
    const fixture = serviceFixture();
    deepEqual(await fixture.service.status(principal()), {
      state: "UNINITIALIZED", matrixUserId: MATRIX_USER, matrixDeviceId: MATRIX_DEVICE, identity: null
    });
    equal(fixture.state.identity, null);
    equal(fixture.state.published, 0);
  });

  it("persiste raíz y certificado juntos, conserva original y publica un único cambio", async () => {
    const fixture = serviceFixture();
    const original = structuredClone(fixture.state.original);
    const parsed = parseMatrixCrossSigningBootstrap(body.signing_keys, body.device_signatures, {
      userId: MATRIX_USER, deviceId: MATRIX_DEVICE, registeredDeviceKeys: deviceKeys, pinnedIdentity: null
    });
    const response = await fixture.service.bootstrap(principal(), body);
    equal(response.state, "PINNED");
    deepEqual(response.identity, { masterKey: parsed.identity.masterKey, selfSigningKey: parsed.identity.selfSigningKey, userSigningKey: parsed.identity.userSigningKey });
    equal(fixture.state.identity.bootstrapSha256, hashMatrixCanonicalJson({ signingKeys: parsed.signingKeys, signedDeviceKeys: parsed.signedDeviceKeys }));
    deepEqual(fixture.state.certificate.signedDeviceKeys, parsed.signedDeviceKeys);
    deepEqual(fixture.state.original, original);
    equal(fixture.state.published, 1);
    deepEqual(fixture.order, ["device-lock", "user-lock", "session-device-lock", "identity", "certificate", "changed"]);
    equal(fixture.clockReads(), 2);
    deepEqual(await fixture.service.status(principal()), response);
    deepEqual(Object.keys(response).sort(), ["identity", "matrixDeviceId", "matrixUserId", "state"]);
  });

  it("reproduce exactamente un reintento sin publicar ni escribir dos veces", async () => {
    const fixture = serviceFixture();
    const first = await fixture.service.bootstrap(principal(), body);
    const stored = structuredClone(fixture.state);
    deepEqual(await fixture.service.bootstrap(principal(), structuredClone(body)), first);
    deepEqual(fixture.state, stored);
  });

  it("rechaza otro triplete válido avalado por el mismo dispositivo", async () => {
    const fixture = serviceFixture();
    await fixture.service.bootstrap(principal(), body);
    const stored = structuredClone(fixture.state);
    await rejects(fixture.service.bootstrap(principal(), otherBody), httpError(409, "MATRIX_CROSS_SIGNING_IDENTITY_CHANGE_FORBIDDEN"));
    deepEqual(fixture.state, stored);
  });

  it("no repara silenciosamente una identidad sin certificado", async () => {
    const fixture = serviceFixture();
    await fixture.service.bootstrap(principal(), body);
    fixture.state.certificate = null;
    await rejects(fixture.service.status(principal()), httpError(409, "MATRIX_CROSS_SIGNING_IDENTITY_INCOMPLETE"));
    await rejects(fixture.service.bootstrap(principal(), body), httpError(409, "MATRIX_CROSS_SIGNING_IDENTITY_INCOMPLETE"));
  });

  it("detecta un hash de reintento o certificado discrepante", async () => {
    for (const field of ["bootstrapSha256", "canonicalSha256"]) {
      const fixture = serviceFixture();
      await fixture.service.bootstrap(principal(), body);
      (field === "bootstrapSha256" ? fixture.state.identity : fixture.state.certificate)[field] = "f".repeat(64);
      await rejects(fixture.service.bootstrap(principal(), body), httpError(409, "MATRIX_CROSS_SIGNING_REPLAY_MISMATCH"));
    }
  });

  it("revierte raíz y certificado si falla la publicación transaccional", async () => {
    const fixture = serviceFixture({ publicationFailure: true });
    await rejects(fixture.service.bootstrap(principal(), body), /TEST_PUBLICATION_FAILURE/);
    equal(fixture.state.identity, null);
    equal(fixture.state.certificate, null);
    equal(fixture.state.published, 0);
  });

  it("revierte si la sesión vence durante la operación", async () => {
    const fixture = serviceFixture({ endNow: new Date(NOW.getTime() + 60_000) });
    await rejects(fixture.service.bootstrap(principal(), body), httpError(401));
    equal(fixture.state.identity, null);
    equal(fixture.state.certificate, null);
  });

  it("comprueba nuevamente la suscripción después de firmar y antes del commit", async () => {
    const fixture = serviceFixture({ endNow: new Date(NOW.getTime() + 5_000), subscriptionEndsAt: new Date(NOW.getTime() + 5_000) });
    fixture.state.session.user.role = "CASHIER";
    await rejects(fixture.service.bootstrap({ ...principal(), role: "CASHIER" }, body), httpError(401));
    equal(fixture.state.identity, null);
  });

  for (const [name, mutate] of [
    ["sesión revocada", (s: any) => { s.session.revokedAt = NOW; }],
    ["sesión vencida", (s: any) => { s.session.expiresAt = NOW; }],
    ["versión de sesión obsoleta", (s: any) => { s.session.user.sessionVersion = 2; }],
    ["usuario suspendido", (s: any) => { s.session.user.status = "SUSPENDED"; }],
    ["recuperación de contraseña pendiente", (s: any) => { s.session.user.passwordResetRequired = true; }],
    ["otro propietario de sesión", (s: any) => { s.session.userId = SESSION; }],
    ["otro dispositivo vinculado", (s: any) => { s.session.deviceId = SESSION; }],
    ["rol persistido diferente", (s: any) => { s.session.user.role = "ADMIN"; }]
  ] as const) {
    it("rechaza " + name + " aunque el principal haya pasado el guard", async () => {
      const fixture = serviceFixture();
      mutate(fixture.state);
      await rejects(fixture.service.bootstrap(principal(), body), httpError(401));
      equal(fixture.state.identity, null);
    });
  }

  it("excluye ADMIN y sesiones sin vínculo antes de abrir transacción", async () => {
    const fixture = serviceFixture();
    await rejects(fixture.service.status({ ...principal(), role: "ADMIN" }), httpError(403));
    await rejects(fixture.service.bootstrap({ ...principal(), role: "ADMIN" }, body), httpError(403));
    await rejects(fixture.service.bootstrap({ ...principal(), deviceId: null }, body), httpError(403));
    equal(fixture.transactions(), 0);
  });

  it("no acepta un dispositivo revocado o ajeno que el lock no encuentra", async () => {
    const fixture = serviceFixture({ deviceAvailable: false });
    await rejects(fixture.service.bootstrap(principal(), body), httpError(401));
    equal(fixture.state.identity, null);
  });

  it("no permite bootstrap sobre un segundo dispositivo histórico", async () => {
    const fixture = serviceFixture();
    fixture.state.deviceCount = 2;
    await rejects(fixture.service.bootstrap(principal(), body), httpError(409, "MATRIX_CROSS_SIGNING_INITIAL_DEVICE_REQUIRED"));
  });

  it("no confía en un directorio de otro usuario, dispositivo o namespace", async () => {
    for (const key of ["userId", "matrixUserId", "matrixDeviceId"]) {
      const fixture = serviceFixture();
      fixture.state.original[key] = "different";
      await rejects(fixture.service.bootstrap(principal(), body), httpError(403));
    }
  });

  it("rechaza forma incorrecta, campos privados y getters sin invocarlos", async () => {
    const fixture = serviceFixture();
    for (const value of [null, [], {}, { ...body, private_key: "not-a-real-secret" }]) {
      await rejects(fixture.service.bootstrap(principal(), value), httpError(400));
    }
    const getter = { device_signatures: body.device_signatures };
    Object.defineProperty(getter, "signing_keys", { enumerable: true, get() { throw new Error("GETTER_MUST_NOT_RUN"); } });
    await rejects(fixture.service.bootstrap(principal(), getter), httpError(400));
    equal(fixture.transactions(), 0);
  });

  it("rechaza firma alterada sin persistir ni reflejar material en errores", async () => {
    const fixture = serviceFixture();
    const altered = structuredClone(body);
    altered.signing_keys.master_key.seed = "not-a-real-secret";
    await rejects(fixture.service.bootstrap(principal(), altered), (error: unknown) => {
      ok(error instanceof HttpException);
      equal(error.getStatus(), 400);
      ok(!JSON.stringify(error.getResponse()).includes("not-a-real-secret"));
      return true;
    });
    equal(fixture.state.identity, null);
  });

  for (const code of ["P2002", "P2034", "40001", "40P01"]) {
    it("traduce conflicto " + code + " sin repetir la operación", async () => {
      const fixture = serviceFixture({ transactionError: new Prisma.PrismaClientKnownRequestError("sql details not public", {
        code: code.startsWith("P") ? code : "P2010", clientVersion: "test", meta: { code }
      }) });
      await rejects(fixture.service.bootstrap(principal(), body), httpError(409, "MATRIX_CROSS_SIGNING_CONCURRENT_CHANGE"));
      equal(fixture.transactions(), 1);
    });
  }

  it("las dos rutas conservan sesión, roles y gate de E2EE", () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, MatrixTransportController) as unknown[];
    for (const guard of [SessionAuthGuard, RolesGuard, E2eeReleaseGuard]) ok(guards.includes(guard));
    deepEqual(Reflect.getMetadata(ROLES_KEY, MatrixTransportController), ["CLIENT", "CASHIER"]);
    equal(Reflect.getMetadata(PATH_METADATA, MatrixTransportController.prototype.crossSigningStatus), "cross-signing");
    equal(Reflect.getMetadata(PATH_METADATA, MatrixTransportController.prototype.bootstrapCrossSigning), "cross-signing/bootstrap");
  });
});

function principal(): SessionPrincipal {
  return { id: USER, deviceId: DEVICE, sessionId: SESSION, username: "fixture", role: "CLIENT", status: "ACTIVE", sessionExpiresAt: new Date(NOW.getTime() + 60_000) };
}

function serviceFixture(options: { endNow?: Date; subscriptionEndsAt?: Date; publicationFailure?: boolean; deviceAvailable?: boolean; transactionError?: Error } = {}) {
  const state: any = {
    identity: null, certificate: null, published: 0, deviceCount: 1,
    original: { deviceId: DEVICE, userId: USER, matrixUserId: MATRIX_USER, matrixDeviceId: MATRIX_DEVICE, deviceKeys: structuredClone(deviceKeys) },
    session: { userId: USER, deviceId: DEVICE, revokedAt: null, expiresAt: new Date(NOW.getTime() + 60_000), sessionVersion: 1,
      user: { role: "CLIENT", status: "ACTIVE", sessionVersion: 1, passwordResetRequired: false } }
  };
  const order: string[] = [];
  let transactionCount = 0;
  let clocks = 0;
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join(" ");
      if (sql.includes("clock_timestamp")) return [{ now: ++clocks % 2 === 0 && options.endNow ? options.endNow : NOW }];
      if (sql.includes("auth_sessions")) { order.push("session-device-lock"); return options.deviceAvailable === false ? [] : [{ id: DEVICE }]; }
      order.push("device-lock"); return [{}];
    },
    authSession: { findUnique: async () => state.session },
    device: { count: async () => state.deviceCount },
    matrixDeviceKey: { findUnique: async () => state.original },
    matrixCrossSigningIdentity: {
      findUnique: async () => state.identity,
      create: async ({ data }: any) => { order.push("identity"); state.identity = structuredClone(data); return state.identity; }
    },
    matrixDeviceCrossSigning: {
      findUnique: async () => state.certificate,
      create: async ({ data }: any) => { order.push("certificate"); state.certificate = structuredClone(data); return state.certificate; }
    }
  };
  const prisma = { $transaction: async (operation: (transaction: any) => Promise<unknown>) => {
    transactionCount++;
    if (options.transactionError) throw options.transactionError;
    const snapshot = structuredClone(state);
    try { return await operation(tx); } catch (error) { Object.assign(state, snapshot); throw error; }
  } } as unknown as PrismaService;
  const eligibility = {
    lockOperationalUser: async () => { order.push("user-lock"); },
    lockCurrentCashier: async () => ({ subscriptionEndsAt: options.subscriptionEndsAt ?? null })
  } as unknown as ConversationEligibilityService;
  const publisher = { publishDeviceSetChanged: async () => {
    order.push("changed"); state.published++;
    if (options.publicationFailure) throw new Error("TEST_PUBLICATION_FAILURE");
  } } as unknown as MatrixDeviceListPublisher;
  return { state, order, service: new MatrixCrossSigningService(prisma, eligibility, publisher), transactions: () => transactionCount, clockReads: () => clocks };
}

function httpError(status: number, code?: string) {
  return (error: unknown) => {
    ok(error instanceof HttpException);
    equal(error.getStatus(), status);
    if (code) equal((error.getResponse() as { code: string }).code, code);
    return true;
  };
}

async function sdkFixture() {
  await initAsync();
  const user = new UserId(MATRIX_USER);
  const device = new DeviceId(MATRIX_DEVICE);
  let machine: OlmMachine | undefined;
  try {
    machine = await OlmMachine.initialize(user, device);
    const outgoing = await machine.outgoingRequests();
    let deviceKeys: any;
    try {
      const upload = outgoing.find((request) => request.type === RequestType.KeysUpload)!;
      const payload = JSON.parse(upload.body);
      deviceKeys = payload.device_keys;
      await machine.markRequestAsSent(upload.id!, upload.type, JSON.stringify({ one_time_key_counts: { signed_curve25519: Object.keys(payload.one_time_keys).length } }));
    } finally { outgoing.forEach((request) => request.free()); }
    const requests: any[] = [];
    // Reset exists ONLY in this disposable fixture to construct a different
    // valid chain endorsed by the same device; never used in application code.
    for (const reset of [false, true]) {
      const bootstrap = await machine.bootstrapCrossSigning(reset);
      const keys = bootstrap.uploadKeysRequest;
      const signing = bootstrap.uploadSigningKeysRequest;
      const signatures = bootstrap.uploadSignaturesRequest;
      try { requests.push({ signing_keys: JSON.parse(signing.body), device_signatures: JSON.parse(signatures.body) }); }
      finally { keys?.free(); signing.free(); signatures.free(); bootstrap.free(); }
    }
    return { deviceKeys, body: requests[0], otherBody: requests[1] };
  } finally { machine?.close(); user.free(); device.free(); }
}
