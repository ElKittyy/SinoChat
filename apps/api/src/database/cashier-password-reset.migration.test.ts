import { match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const migration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260727014400_cashier_required_password_change/migration.sql"
  ),
  "utf8"
);

describe("cashier required password change migration", () => {
  it("agrega un indicador no nulo y seguro para cuentas existentes", () => {
    match(
      migration,
      /ADD COLUMN "password_reset_required" BOOLEAN NOT NULL DEFAULT FALSE/
    );
  });

  it("impide que el indicador se active para roles distintos de cajero", () => {
    match(
      migration,
      /CHECK \(NOT "password_reset_required" OR "role" = 'CASHIER'\)/
    );
  });

  it("refuerza la carrera de nuevas asignaciones en el trigger diferido", () => {
    match(
      migration,
      /CREATE OR REPLACE FUNCTION "sinochat_validate_assignment_origin"\(\)/
    );
    match(
      migration,
      /u\."password_reset_required" = FALSE/
    );
  });
});
