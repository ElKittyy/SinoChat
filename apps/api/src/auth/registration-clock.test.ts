import { doesNotMatch, equal, match, rejects } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import type { PrismaService } from "../database/prisma.service";
import { AuthService } from "./auth.service";
import type { PasswordService } from "./password.service";
import type { SessionTokenService } from "./session-token.service";

const TERMS_HASH = "a".repeat(64);
const authSource = readFileSync(
  resolve(__dirname, "auth.service.js"),
  "utf8"
);

describe("reloj de decisiones de registro", () => {
  it("evalua el boundary de suscripcion del cliente con clock_timestamp", async () => {
    const databaseNow = new Date("2026-08-02T12:00:00.000Z");
    let where: any;
    const service = authService({
      $queryRaw: async () => [{ now: databaseNow }],
      cashierInvitation: {
        findFirst: async (query: any) => {
          where = query.where;
          return null;
        }
      }
    });

    await rejects(
      service.registerClient(
        {
          invitationCode: "SINO-CLIENTE",
          username: "cliente",
          password: "password-segura",
          dateOfBirth: "1990-01-01",
          termsAccepted: true,
          termsVersion: "v1",
          termsContentHash: TERMS_HASH
        },
        {}
      ),
      /cajero no .* disponible/
    );

    equal(where.cashier.subscriptions.some.startsAt.lte, databaseNow);
    equal(where.cashier.subscriptions.some.OR[1].endsAt.gt, databaseNow);
  });

  it("evalua la expiracion del onboarding de cajero con el mismo reloj DB", async () => {
    const databaseNow = new Date("2026-08-02T12:00:00.000Z");
    let where: any;
    const service = authService({
      $queryRaw: async () => [{ now: databaseNow }],
      cashierOnboardingInvitation: {
        findFirst: async (query: any) => {
          where = query.where;
          return null;
        }
      },
      termsDocument: {
        findFirst: async () => null
      }
    });

    await rejects(
      service.registerCashier(
        {
          invitationCode: "SINO-CAJERO",
          email: "cajero@example.com",
          username: "cajero",
          password: "password-segura",
          phone: "+5491112345678",
          dateOfBirth: "1990-01-01",
          termsAccepted: true,
          termsVersion: "v1",
          termsContentHash: TERMS_HASH
        },
        {}
      ),
      /registro no .* disponible/
    );

    equal(where.expiresAt.gt, databaseNow);
  });

  it("calcula la mayoria de edad desde la fecha legal del reloj DB", async () => {
    let invitationLookups = 0;
    const service = authService({
      $queryRaw: async () => [
        { now: new Date("2026-08-01T00:00:00.000Z") }
      ],
      cashierInvitation: {
        findFirst: async () => {
          invitationLookups += 1;
          return null;
        }
      }
    });

    await rejects(
      service.registerClient(
        {
          invitationCode: "SINO-CLIENTE",
          username: "cliente",
          password: "password-segura",
          dateOfBirth: "2008-08-02",
          termsAccepted: true,
          termsVersion: "v1",
          termsContentHash: TERMS_HASH
        },
        {}
      ),
      /mayor de 18/
    );

    equal(invitationLookups, 0);
    match(authSource, /formatToParts\(decisionTime\)/);
    doesNotMatch(authSource, /formatToParts\(new Date\(\)\)/);
  });
});

function authService(prisma: object): AuthService {
  return new AuthService(
    prisma as PrismaService,
    { hash: async () => "hash" } as unknown as PasswordService,
    {} as SessionTokenService
  );
}
