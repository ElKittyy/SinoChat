import { deepEqual, equal } from "node:assert/strict";
import { describe, it } from "node:test";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import type { Request, Response } from "express";
import { AccountStatus, UserRole } from "../generated/prisma/enums";
import { AuthController } from "./auth.controller";
import type { AuthService } from "./auth.service";
import type { AdminMfaService } from "./admin-mfa.service";
import { AdminMfaRecentGuard } from "./admin-mfa-recent.guard";
import { RolesGuard } from "./roles.guard";
import { SessionAuthGuard } from "./session-auth.guard";

const ADMIN_MFA_STUB = {} as AdminMfaService;

const RECOVERY_CODES = [
  "SC-ABCDE-FGHJK-MNPQR-STUVW",
  "SC-BCDEF-GHJKM-NPQRS-TUVWX",
  "SC-CDEFG-HJKMN-PQRST-UVWXY",
  "SC-DEFGH-JKMNP-QRSTU-VWXYZ",
  "SC-EFGHJ-KMNPQ-RSTUV-WXYZ2",
  "SC-FGHJK-MNPQR-STUVW-XYZ23",
  "SC-GHJKM-NPQRS-TUVWX-YZ234",
  "SC-HJKMN-PQRST-UVWXY-Z2345"
];

describe("AuthController cashier recovery contract", () => {
  it("devuelve los códigos de registro una vez sin exponer el token de sesión", async () => {
    const previousNodeEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    const expiresAt = new Date("2026-09-08T12:00:00.000Z");
    const cookies: string[] = [];
    const auth = {
      registerCashier: async () => ({
        user: {
          id: "11111111-1111-4111-8111-111111111111",
          username: "cajero",
          role: UserRole.CASHIER,
          status: AccountStatus.PENDING
        },
        sessionToken: "session-secret",
        csrfToken: "csrf-secret",
        expiresAt,
        recoveryCodes: RECOVERY_CODES,
        recoveryCodesExpireAt: null
      })
    } as unknown as AuthService;
    const response = {
      cookie: (name: string) => {
        cookies.push(name);
        return response;
      }
    } as unknown as Response;
    const request = {
      ip: "127.0.0.1",
      get: () => "test-agent"
    } as unknown as Request;
    const controller = new AuthController(auth, ADMIN_MFA_STUB);

    try {
      const result = await controller.registerCashier(
        {} as never,
        request,
        response
      );

      deepEqual(result.recoveryCodes, RECOVERY_CODES);
      equal(result.recoveryCodesExpireAt, null);
      equal("sessionToken" in result, false);
      equal(cookies.length, 2);
    } finally {
      if (previousNodeEnvironment === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnvironment;
      }
    }
  });

  it("transmite el principal y la contraseña actual al rotar", async () => {
    let received: unknown;
    const auth = {
      rotateCashierRecoveryCodes: async (...input: unknown[]) => {
        received = input;
        return {
          recoveryCodes: RECOVERY_CODES,
          recoveryCodesExpireAt: null
        };
      }
    } as unknown as AuthService;
    const controller = new AuthController(auth, ADMIN_MFA_STUB);
    const principal = {
      id: "11111111-1111-4111-8111-111111111111",
      username: "cajero",
      role: UserRole.CASHIER,
      status: AccountStatus.ACTIVE,
      sessionId: "session-id",
      deviceId: null,
      sessionExpiresAt: new Date()
    };

    const result = await controller.rotateCashierRecoveryCodes(principal, {
      currentPassword: "Actual#Segura2026"
    });

    deepEqual(received, [principal, { currentPassword: "Actual#Segura2026" }]);
    deepEqual(result.recoveryCodes, RECOVERY_CODES);
  });
});

describe("AuthController admin session management contract", () => {
  it("exige step-up reciente para revocar una o todas las otras sesiones", () => {
    for (const handler of [
      AuthController.prototype.adminMfaRevokePasskey,
      AuthController.prototype.revokeSession,
      AuthController.prototype.revokeOtherSessions
    ]) {
      deepEqual(Reflect.getMetadata(GUARDS_METADATA, handler), [
        SessionAuthGuard,
        RolesGuard,
        AdminMfaRecentGuard
      ]);
    }
  });

  it("permite listar passkeys y sesiones sin renovar artificialmente el step-up", () => {
    for (const handler of [
      AuthController.prototype.adminMfaPasskeys,
      AuthController.prototype.listSessions
    ]) {
      deepEqual(Reflect.getMetadata(GUARDS_METADATA, handler), [
        SessionAuthGuard,
        RolesGuard
      ]);
    }
  });
});
