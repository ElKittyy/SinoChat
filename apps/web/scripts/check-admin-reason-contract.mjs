import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const api = await source("../src/api.ts");
const dashboard = await source("../src/dashboard/AdminDashboard.tsx");
const managementDialogs = await source(
  "../src/dashboard/AdminUserManagementDialogs.tsx",
);
const reportDialogs = await source(
  "../src/dashboard/AdminReportDialogs.tsx",
);
const types = await source("../src/dashboard/types.ts");

const ordinaryAdminTransport = between(
  api,
  "async createCashierInvitation(input)",
  "    cashier: {",
);
assert.doesNotMatch(
  ordinaryAdminTransport,
  /\breason\s*:/,
  "Las operaciones administrativas ordinarias no deben enviar reason.",
);
assert.match(
  ordinaryAdminTransport,
  /body:\s*JSON\.stringify\(\{\}\)/,
  "Las mutaciones sin datos deben conservar un cuerpo JSON para las defensas CSRF.",
);

assert.match(
  dashboard,
  /collectReason=\{false\}/,
  "El panel ADMIN debe usar confirmación simple en acciones ordinarias.",
);
assert.doesNotMatch(
  managementDialogs,
  /\bReasonField\b|Motivo administrativo|\breason\b/,
  "Alta, edición y reset administrativo no deben mostrar un motivo.",
);

for (const typeName of [
  "AdminUserUpdateInput",
  "AdminPasswordResetInput",
  "AdminCashierOnboardingInput",
]) {
  const declaration = between(types, `export interface ${typeName}`, "}\n");
  assert.doesNotMatch(
    declaration,
    /\breason\??\s*:/,
    `${typeName} no debe recuperar el motivo administrativo eliminado.`,
  );
}

assert.match(
  reportDialogs,
  /input\.reason|reason:\s*normalizedReason/,
  "El acceso a evidencia de reportes debe conservar su justificación.",
);
assert.match(
  api,
  /reason:\s*validateReportEvidenceReason\(input\.reason\)/,
  "La justificación de evidencia debe seguir validándose y enviándose.",
);

console.log(
  "[OK] Acciones ADMIN ordinarias sin motivo; reportes conservan su justificación.",
);

async function source(relativeUrl) {
  return readFile(new URL(relativeUrl, import.meta.url), "utf8");
}

function between(value, start, end) {
  const startIndex = value.indexOf(start);
  assert.notEqual(startIndex, -1, `No se encontró el inicio: ${start}`);
  const endIndex = value.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `No se encontró el final: ${end}`);
  return value.slice(startIndex, endIndex);
}
