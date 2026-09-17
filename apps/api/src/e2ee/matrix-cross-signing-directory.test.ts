import { deepEqual, equal, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import type { SessionPrincipal } from "../auth/auth.types";
import type { PrismaService } from "../database/prisma.service";
import { MatrixKeyDirectoryService } from "./matrix-key-directory.service";

process.env.NODE_ENV = "test";
process.env.MATRIX_SERVER_NAME = "sinochat.invalid";
const OWN = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const DEVICE = "33333333-3333-4333-8333-333333333333";
const OTHER_DEVICE = "44444444-4444-4444-8444-444444444444";
const OTHER_USER = "55555555-5555-4555-8555-555555555555";
const matrixUser = (id: string) => "@u" + id.replaceAll("-", "") + ":sinochat.invalid";
const matrixDevice = (id: string) => "D" + id.replaceAll("-", "").toUpperCase();

describe("directorio cross-signing: privacidad de consultas", () => {
  it("entrega las claves públicas de la relación, pero user-signing solo al propietario", async () => {
    const fixture = directoryFixture();
    const result = await fixture.service.queryRelatedKeys(fixture.principal, { device_keys: { [matrixUser(OWN)]: [], [matrixUser(PEER)]: [] } });
    deepEqual(Object.keys(result.master_keys).sort(), [matrixUser(OWN), matrixUser(PEER)].sort());
    deepEqual(Object.keys(result.self_signing_keys).sort(), [matrixUser(OWN), matrixUser(PEER)].sort());
    deepEqual(Object.keys(result.user_signing_keys), [matrixUser(OWN)]);
    deepEqual(result.device_keys[matrixUser(OWN)][matrixDevice(DEVICE)], { certified: "owner" });
    deepEqual(result.device_keys[matrixUser(PEER)][matrixDevice(OTHER_DEVICE)], { certified: "peer" });
    deepEqual(fixture.rows[0].deviceKeys, { original: "owner" });
    deepEqual(fixture.rows[1].deviceKeys, { original: "peer" });
  });

  it("no agrega identidad propia ni user-signing cuando solo se pidió la contraparte", async () => {
    const fixture = directoryFixture();
    const result = await fixture.service.queryRelatedKeys(fixture.principal, { device_keys: { [matrixUser(PEER)]: [] } });
    deepEqual(Object.keys(result.master_keys), [matrixUser(PEER)]);
    deepEqual(result.user_signing_keys, {});
  });

  it("respeta selección de dispositivos sin extender el alcance de la relación", async () => {
    const fixture = directoryFixture();
    const result = await fixture.service.queryRelatedKeys(fixture.principal, { device_keys: { [matrixUser(PEER)]: [matrixDevice(DEVICE)] } });
    deepEqual(result.device_keys[matrixUser(PEER)], {});
    deepEqual(result.user_signing_keys, {});
  });

  it("rechaza el lote entero antes de leer certificados si contiene una persona ajena", async () => {
    const fixture = directoryFixture();
    await rejects(fixture.service.queryRelatedKeys(fixture.principal, { device_keys: { [matrixUser(PEER)]: [], [matrixUser(OTHER_USER)]: [] } }), ForbiddenException);
    equal(fixture.reads(), 0);
  });

  it("ADMIN no consulta certificados ni identidad, tampoco invocando directamente el servicio", async () => {
    const fixture = directoryFixture();
    await rejects(fixture.service.queryRelatedKeys({ ...fixture.principal, role: "ADMIN" }, { device_keys: { [matrixUser(OWN)]: [] } }), ForbiddenException);
    equal(fixture.reads(), 0);
  });

  it("recomprueba sesión al terminar la espera por los bloqueos", async () => {
    const fixture = directoryFixture(true);
    await rejects(fixture.service.queryRelatedKeys(fixture.principal, { device_keys: { [matrixUser(OWN)]: [] } }), UnauthorizedException);
    equal(fixture.reads(), 0);
  });
});

function directoryFixture(revokeAfterFirstCheck = false) {
  let reads = 0;
  let sessions = 0;
  const now = new Date("2026-09-11T12:00:00Z");
  const principal: SessionPrincipal = { id: OWN, deviceId: DEVICE, sessionId: OTHER_DEVICE, username: "fixture", role: "CLIENT", status: "ACTIVE", sessionExpiresAt: new Date(now.getTime() + 60_000) };
  const rows = [
    { deviceId: DEVICE, matrixUserId: matrixUser(OWN), matrixDeviceId: matrixDevice(DEVICE), deviceKeys: { original: "owner" } },
    { deviceId: OTHER_DEVICE, matrixUserId: matrixUser(PEER), matrixDeviceId: matrixDevice(OTHER_DEVICE), deviceKeys: { original: "peer" } }
  ];
  const tx = {
    $queryRaw: async () => [{ now }],
    authSession: { findUnique: async () => ({
      userId: OWN, deviceId: DEVICE, revokedAt: ++sessions > 1 && revokeAfterFirstCheck ? now : null,
      expiresAt: principal.sessionExpiresAt, sessionVersion: 1,
      user: { sessionVersion: 1, status: "ACTIVE", passwordResetRequired: false }
    }) },
    matrixDeviceKey: {
      findUnique: async () => ({ userId: OWN, matrixUserId: matrixUser(OWN) }),
      findMany: async ({ where }: any) => { reads++; return rows.filter((row) => where.matrixUserId.in.includes(row.matrixUserId)); }
    },
    matrixDeviceCrossSigning: { findMany: async ({ where }: any) => [
      { deviceId: DEVICE, signedDeviceKeys: { certified: "owner" } },
      { deviceId: OTHER_DEVICE, signedDeviceKeys: { certified: "peer" } }
    ].filter((row) => where.deviceId.in.includes(row.deviceId)) },
    matrixCrossSigningIdentity: { findMany: async ({ where }: any) => [OWN, PEER].map((id) => ({ matrixUserId: matrixUser(id), signingKeys: {
      master_key: { public: "master" }, self_signing_key: { public: "self" }, user_signing_key: { public: "user-signing" }
    } })).filter((row) => where.matrixUserId.in.includes(row.matrixUserId)) }
  };
  const prisma = { $transaction: async (operation: (tx: any) => Promise<unknown>) => operation(tx) } as unknown as PrismaService;
  const eligibility = { lockCurrentByParticipants: async (_tx: unknown, client: string, cashier: string) => {
    if (client !== OWN || cashier !== PEER) throw new ForbiddenException();
    return { id: OTHER_USER, clientUserId: OWN, cashierUserId: PEER };
  } } as unknown as ConversationEligibilityService;
  return { service: new MatrixKeyDirectoryService(prisma, eligibility), principal, rows, reads: () => reads };
}
