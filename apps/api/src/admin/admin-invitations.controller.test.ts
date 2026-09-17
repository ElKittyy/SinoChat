import { plainToInstance } from "class-transformer";
import {
  METHOD_METADATA,
  PATH_METADATA
} from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { deepEqual, equal, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { validate } from "class-validator";
import { AdminInvitationsController } from "./admin-invitations.controller";
import { AdminInvitationsService } from "./admin-invitations.service";
import { CreateCashierInvitationDto } from "./dto/create-cashier-invitation.dto";
import {
  CashierOnboardingInvitationsQueryDto,
  RevokeCashierOnboardingInvitationDto
} from "./dto/cashier-onboarding-invitations.dto";

describe("contrato administrativo de invitaciones de cajeros", () => {
  it("normaliza filtros y limita la paginación", async () => {
    const valid = plainToInstance(CashierOnboardingInvitationsQueryDto, {
      status: " revoked ",
      page: "2",
      pageSize: "100"
    });
    equal((await validate(valid)).length, 0);
    equal(valid.status, "REVOKED");
    equal(valid.page, 2);
    equal(valid.pageSize, 100);

    const invalid = plainToInstance(CashierOnboardingInvitationsQueryDto, {
      status: "WITH_CODE",
      page: 0,
      pageSize: 101
    });
    ok((await validate(invalid)).length >= 3);
  });

  it("acepta confirmación sin motivo y rechaza el antiguo texto libre", async () => {
    const valid = plainToInstance(RevokeCashierOnboardingInvitationDto, {});
    const invalid = plainToInstance(CreateCashierInvitationDto, {
      expiresInHours: 72,
      reason: "Alta solicitada por control administrativo",
      code: "NO-DEBE-ACEPTARSE"
    });

    equal((await validate(valid)).length, 0);
    ok(
      (
        await validate(invalid, {
          whitelist: true,
          forbidNonWhitelisted: true
        })
      ).length >= 2
    );
  });

  it("expone alta y revocación sin propagar texto libre al servicio", async () => {
    const calls: unknown[][] = [];
    const service = {
      listCashierInvitations: async (...args: unknown[]) => {
        calls.push(["list", ...args]);
        return { items: [] };
      },
      createCashierInvitation: async (...args: unknown[]) => {
        calls.push(["create", ...args]);
        return { code: "codigo" };
      },
      revokeCashierInvitation: async (...args: unknown[]) => {
        calls.push(["revoke", ...args]);
        return { revokedNow: true };
      }
    } as unknown as AdminInvitationsService;
    const controller = new AdminInvitationsController(service);
    const listHandler = AdminInvitationsController.prototype.list;
    const createHandler = AdminInvitationsController.prototype.create;
    const revokeHandler = AdminInvitationsController.prototype.revoke;
    const query = { page: 1, pageSize: 20 };

    equal(
      Reflect.getMetadata(PATH_METADATA, AdminInvitationsController),
      "admin/cashier-invitations"
    );
    equal(Reflect.getMetadata(PATH_METADATA, listHandler), "/");
    equal(Reflect.getMetadata(METHOD_METADATA, listHandler), RequestMethod.GET);
    equal(Reflect.getMetadata(PATH_METADATA, createHandler), "/");
    equal(
      Reflect.getMetadata(METHOD_METADATA, createHandler),
      RequestMethod.POST
    );
    equal(
      Reflect.getMetadata(PATH_METADATA, revokeHandler),
      ":invitationId/revoke"
    );
    equal(
      Reflect.getMetadata(METHOD_METADATA, revokeHandler),
      RequestMethod.PATCH
    );

    await controller.list(query);
    await controller.create(
      { id: "admin-id" } as never,
      { expiresInHours: 72 }
    );
    await controller.revoke(
      { id: "admin-id" } as never,
      "11111111-1111-4111-8111-111111111111",
      {}
    );
    deepEqual(calls, [
      ["list", query],
      ["create", "admin-id", 72],
      [
        "revoke",
        "admin-id",
        "11111111-1111-4111-8111-111111111111"
      ]
    ]);
  });
});
