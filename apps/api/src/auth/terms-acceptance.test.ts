import { equal, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { PrismaService } from "../database/prisma.service";
import { AuthService } from "./auth.service";
import { PasswordService } from "./password.service";
import { SessionTokenService } from "./session-token.service";
import { RegisterClientDto } from "./dto/register-client.dto";

const VALID_INPUT = {
  invitationCode: "SINO-ABCDEFGH",
  username: "cliente_prueba",
  password: "contraseña-segura",
  dateOfBirth: "1990-01-01",
  termsAccepted: true,
  termsVersion: "v1",
  termsContentHash: "a".repeat(64)
} as const;

describe("aceptación versionada de términos", () => {
  it("exige una versión de términos con formato seguro", async () => {
    const missing = plainToInstance(RegisterClientDto, {
      ...VALID_INPUT,
      termsVersion: undefined
    });
    const invalid = plainToInstance(RegisterClientDto, {
      ...VALID_INPUT,
      termsVersion: "versión con espacios"
    });
    const invalidHash = plainToInstance(RegisterClientDto, {
      ...VALID_INPUT,
      termsContentHash: "A".repeat(64)
    });

    equal((await validate(missing)).some((error) => error.property === "termsVersion"), true);
    equal((await validate(invalid)).some((error) => error.property === "termsVersion"), true);
    equal(
      (await validate(invalidHash)).some(
        (error) => error.property === "termsContentHash"
      ),
      true
    );
  });

  it("rechaza antes de calcular la contraseña si versión y hash no identifican el mismo documento", async () => {
    let hashCalled = false;
    const prisma = {
      $queryRaw: async () => [
        { now: new Date("2026-08-02T12:00:00.000Z") }
      ],
      cashierInvitation: {
        findFirst: async () => ({ id: "invitation", cashierUserId: "cashier" })
      },
      termsDocument: {
        findFirst: async () => ({
          id: "terms-v2",
          version: "v2",
          contentHash: "b".repeat(64)
        })
      }
    } as unknown as PrismaService;
    const passwords = {
      hash: async () => {
        hashCalled = true;
        return "hash";
      }
    } as unknown as PasswordService;
    const service = new AuthService(
      prisma,
      passwords,
      {} as SessionTokenService
    );

    await rejects(
      service.registerClient({ ...VALID_INPUT }, {}),
      /Los términos cambiaron/
    );
    equal(hashCalled, false);
  });

  it("vuelve a comprobar la versión con el reloj de PostgreSQL dentro de la transacción", async () => {
    let userCreated = false;
    const transactionOrder: string[] = [];
    let isolationLevel: unknown;
    const transaction = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        const sql = Array.from(strings).join(" ");
        if (sql.includes("pg_advisory_xact_lock")) {
          transactionOrder.push("legal-lock");
          return [{ locked: 1 }];
        }
        transactionOrder.push("database-clock");
        return [{ now: new Date("2026-08-02T12:00:00.000Z") }];
      },
      termsDocument: {
        findFirst: async () => {
          transactionOrder.push("current-terms");
          return {
            id: "terms-v2",
            version: "v2",
            contentHash: "b".repeat(64)
          };
        }
      },
      user: {
        create: async () => {
          userCreated = true;
          return {};
        }
      }
    };
    const prisma = {
      $queryRaw: async () => [
        { now: new Date("2026-08-02T12:00:00.000Z") }
      ],
      cashierInvitation: {
        findFirst: async () => ({ id: "invitation", cashierUserId: "cashier" })
      },
      termsDocument: {
        findFirst: async () => ({
          id: "terms-v1",
          version: "v1",
          contentHash: "a".repeat(64)
        })
      },
      $transaction: async (
        operation: (tx: typeof transaction) => Promise<unknown>,
        options: { isolationLevel?: unknown }
      ) => {
        isolationLevel = options.isolationLevel;
        return operation(transaction);
      }
    } as unknown as PrismaService;
    const service = new AuthService(
      prisma,
      { hash: async () => "argon2id-hash" } as unknown as PasswordService,
      {} as SessionTokenService
    );

    await rejects(
      service.registerClient({ ...VALID_INPUT }, {}),
      /Los términos cambiaron/
    );
    equal(userCreated, false);
    equal(isolationLevel, "Serializable");
    equal(transactionOrder.join(","), "legal-lock,database-clock,current-terms");
  });

  it("reintenta un conflicto serializable antes de reevaluar el cambio v1 a v2", async () => {
    let attempts = 0;
    const transaction = {
      $queryRaw: async (strings: TemplateStringsArray) =>
        Array.from(strings).join(" ").includes("pg_advisory_xact_lock")
          ? [{ locked: 1 }]
          : [{ now: new Date("2026-08-02T12:00:00.000Z") }],
      termsDocument: {
        findFirst: async () => ({
          id: "terms-v2",
          version: "v2",
          contentHash: "b".repeat(64)
        })
      }
    };
    const prisma = {
      $queryRaw: async () => [
        { now: new Date("2026-08-02T12:00:00.000Z") }
      ],
      cashierInvitation: {
        findFirst: async () => ({ id: "invitation", cashierUserId: "cashier" })
      },
      termsDocument: {
        findFirst: async () => ({
          id: "terms-v1",
          version: "v1",
          contentHash: "a".repeat(64)
        })
      },
      $transaction: async (
        operation: (tx: typeof transaction) => Promise<unknown>
      ) => {
        attempts += 1;
        if (attempts === 1) {
          throw { code: "P2034" };
        }
        return operation(transaction);
      }
    } as unknown as PrismaService;
    const service = new AuthService(
      prisma,
      { hash: async () => "argon2id-hash" } as unknown as PasswordService,
      {} as SessionTokenService
    );

    await rejects(
      service.registerClient({ ...VALID_INPUT }, {}),
      /Los términos cambiaron/
    );
    equal(attempts, 2);
  });
});
