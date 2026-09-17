import { RequestMethod } from "@nestjs/common";
import {
  METHOD_METADATA,
  PATH_METADATA
} from "@nestjs/common/constants";
import { deepEqual, equal } from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicUser } from "../auth/auth.types";
import { UserRole } from "../generated/prisma/enums";
import { CashierInvitationsController } from "./cashier-invitations.controller";
import { CashierInvitationsService } from "./cashier-invitations.service";

describe("revelado privado de invitacion de cliente", () => {
  it("usa POST autenticado y nunca una ruta GET", async () => {
    const calls: string[] = [];
    const service = {
      getCurrent: async (cashierId: string) => {
        calls.push(cashierId);
        return {
          id: "22222222-2222-4222-8222-222222222222",
          code: "SINO-0123456789ABCDEF0123456789ABCDEF",
          createdAt: new Date("2026-08-02T00:00:00.000Z")
        };
      }
    } as unknown as CashierInvitationsService;
    const controller = new CashierInvitationsController(service);
    const handler = CashierInvitationsController.prototype.getCurrent;
    const cashier: PublicUser = {
      id: "11111111-1111-4111-8111-111111111111",
      role: UserRole.CASHIER,
      status: "ACTIVE",
      username: "cajero"
    };

    equal(
      Reflect.getMetadata(PATH_METADATA, CashierInvitationsController),
      "cashier/invitation"
    );
    equal(Reflect.getMetadata(PATH_METADATA, handler), "reveal");
    equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.POST);
    equal(Reflect.getMetadata("THROTTLER:LIMITdefault", handler), 10);

    const result = await controller.getCurrent(cashier);
    equal(result.code, "SINO-0123456789ABCDEF0123456789ABCDEF");
    deepEqual(calls, [cashier.id]);
  });
});
