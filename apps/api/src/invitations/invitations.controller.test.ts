import { plainToInstance } from "class-transformer";
import {
  METHOD_METADATA,
  PATH_METADATA
} from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { deepEqual, equal } from "node:assert/strict";
import { describe, it } from "node:test";
import { validate } from "class-validator";
import { InvitationsController } from "./invitations.controller";
import { InvitationsService } from "./invitations.service";
import { ValidateInvitationDto } from "./dto/validate-invitation.dto";

describe("validacion privada de invitaciones", () => {
  it("normaliza un cuerpo JSON valido y rechaza campos adicionales", async () => {
    const validInput = plainToInstance(ValidateInvitationDto, {
      code: "  sino-0123456789abcdef0123456789abcdef  ",
      role: "cliente"
    });

    equal(
      (
        await validate(validInput, {
          forbidNonWhitelisted: true,
          whitelist: true
        })
      ).length,
      0
    );
    equal(validInput.code, "SINO-0123456789ABCDEF0123456789ABCDEF");

    const unexpectedInput = plainToInstance(ValidateInvitationDto, {
      code: "SINO-0123456789ABCDEF0123456789ABCDEF",
      role: "cajero",
      redirectUrl: "https://atacante.example"
    });
    equal(
      (
        await validate(unexpectedInput, {
          forbidNonWhitelisted: true,
          whitelist: true
        })
      ).length,
      1
    );
  });

  it("rechaza codigos o roles fuera del contrato", async () => {
    const input = plainToInstance(ValidateInvitationDto, {
      code: "../../codigo?filtrado=true",
      role: "administrador"
    });

    equal((await validate(input)).length >= 2, true);
  });

  it("expone solo POST /invitations/validate con limite dedicado", async () => {
    const calls: unknown[][] = [];
    const service = {
      validate: async (...args: unknown[]) => {
        calls.push(args);
        return { valid: true, role: args[1] };
      }
    } as unknown as InvitationsService;
    const controller = new InvitationsController(service);
    const handler = InvitationsController.prototype.validate;

    equal(Reflect.getMetadata(PATH_METADATA, InvitationsController), "invitations");
    equal(Reflect.getMetadata(PATH_METADATA, handler), "validate");
    equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.POST);
    equal(Reflect.getMetadata("THROTTLER:LIMITdefault", handler), 10);

    deepEqual(
      await controller.validate({
        code: "SINO-0123456789ABCDEF0123456789ABCDEF",
        role: "cliente"
      }),
      { valid: true, role: "cliente" }
    );
    deepEqual(calls, [
      ["SINO-0123456789ABCDEF0123456789ABCDEF", "cliente"]
    ]);
  });
});
