import { equal, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  DeleteAdminUserDto,
  ResetAdminPasswordDto,
  UpdateAdminUserDto
} from "./admin-user-mutation.dto";
import { AdminActionDto } from "./admin-action.dto";

describe("AdminActionDto", () => {
  it("acepta una confirmación simple y rechaza el antiguo motivo libre", async () => {
    const empty = plainToInstance(AdminActionDto, {});
    const confirmed = plainToInstance(AdminActionDto, { confirm: true });
    const legacyReason = plainToInstance(AdminActionDto, {
      reason: "Suspensión preventiva solicitada"
    });

    equal((await validate(empty)).length, 0);
    equal((await validate(confirmed)).length, 0);
    ok(
      (
        await validate(legacyReason, {
          whitelist: true,
          forbidNonWhitelisted: true
        })
      ).length > 0
    );
  });
});

describe("DTO de gestión administrativa", () => {
  it("no admite motivos libres al editar ni eliminar usuarios", async () => {
    const deletion = plainToInstance(DeleteAdminUserDto, {});
    const editWithReason = plainToInstance(UpdateAdminUserDto, {
      username: "usuario-nuevo",
      reason: "Texto administrativo que ya no corresponde"
    });

    equal((await validate(deletion)).length, 0);
    ok(
      (
        await validate(editWithReason, {
          whitelist: true,
          forbidNonWhitelisted: true
        })
      ).some((error) => error.property === "reason")
    );
  });

  it("inicia la recuperación sin aceptar una credencial elegida por el administrador", async () => {
    const empty = plainToInstance(ResetAdminPasswordDto, {});
    const withCredential = plainToInstance(ResetAdminPasswordDto, {
      temporaryPassword: "Temporal#Segura2026"
    });

    equal((await validate(empty)).length, 0);
    ok(
      (
        await validate(withCredential, {
          whitelist: true,
          forbidNonWhitelisted: true
        })
      ).some((error) => error.property === "temporaryPassword")
    );
  });
});
