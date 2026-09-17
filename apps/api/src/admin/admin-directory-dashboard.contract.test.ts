import { doesNotMatch, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const controller = readFileSync(
  resolve(__dirname, "../../src/admin/admin-users.controller.ts"),
  "utf8"
);
const webApi = readFileSync(
  resolve(__dirname, "../../../web/src/api.ts"),
  "utf8"
);
const app = readFileSync(
  resolve(__dirname, "../../../web/src/App.tsx"),
  "utf8"
);
const dashboard = readFileSync(
  resolve(__dirname, "../../../web/src/dashboard/AdminDashboard.tsx"),
  "utf8"
);

describe("contrato de directorios administrativos", () => {
  it("mantiene las listas bajo sesión ADMIN y en rutas separadas", () => {
    match(controller, /@UseGuards\(SessionAuthGuard, RolesGuard\)/);
    match(controller, /@Roles\(UserRole\.ADMIN\)/);
    match(controller, /@Get\("assignments"\)/);
    match(controller, /@Get\("subscriptions"\)/);
  });

  it("usa paginación y totales globales independientes de usuarios", () => {
    match(webApi, /\/admin\/assignments\?\$\{assignmentQuery\}/);
    match(webApi, /\/admin\/subscriptions\?\$\{subscriptionQuery\}/);
    match(
      webApi,
      /value:\s*parsedAssignments\.pagination\.total/
    );
    match(webApi, /value:\s*parsedSubscriptions\.activeTotal/);
    doesNotMatch(webApi, /value:\s*parsedUsers\.assignments\.length/);
    doesNotMatch(webApi, /value:\s*activeSubscriptions/);
  });

  it("transporta ambas paginaciones hasta controles visibles", () => {
    match(
      app,
      /assignmentsPagination=\{adminData\.assignmentsPagination\}/
    );
    match(
      app,
      /subscriptionsPagination=\{adminData\.subscriptionsPagination\}/
    );
    match(dashboard, /ariaLabel="Paginación de asignaciones"/);
    match(dashboard, /ariaLabel="Paginación de suscripciones"/);
  });

  it("conserva secciones sanas cuando otra consulta falla", () => {
    match(webApi, /Promise\.allSettled\(\[/);
    match(webApi, /parseSettledAdminSection/);
    match(app, /Las demás secciones siguen disponibles/);
  });
});
