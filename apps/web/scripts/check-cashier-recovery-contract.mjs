import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const access = await source("../src/access.ts");
const api = await source("../src/api.ts");
const app = await source("../src/App.tsx");
const accessPanel = await source("../src/components/AccessPanel.tsx");
const adminDialog = await source(
  "../src/dashboard/AdminUserManagementDialogs.tsx",
);

assert.match(access, /recoveryCode:\s*string/);
assert.doesNotMatch(
  between(access, "export interface CompleteAdminResetInput", "}\n"),
  /temporaryPassword/,
);
assert.match(api, /\/auth\/cashiers\/recovery-codes\/rotate/);
assert.match(api, /payload\.recoveryCodes\.length !== 8/);
assert.match(api, /new Set\(recoveryCodes\)\.size/);
assert.match(accessPanel, /Confirmo que guardé los 8 códigos/);
assert.match(accessPanel, /disabled=\{!acknowledged\}/);
assert.match(app, /onCashierRegistrationAcknowledged=\{enterApp\}/);
assert.match(
  between(app, "registerCashier: actions.registerCashier", "  };"),
  /return result/,
);
assert.doesNotMatch(
  between(app, "registerCashier: actions.registerCashier", "  };"),
  /enterApp\(\)/,
);
const resetDialog = between(
  adminDialog,
  "export function AdminPasswordResetDialog",
  "export function AdminOnboardingDialog",
);
assert.match(resetDialog, /await onConfirm\(\{\}\)/);
assert.doesNotMatch(resetDialog, /type="password"|temporaryPassword/);

console.log(
  "[OK] Recuperación de cajeros sin credenciales ADMIN y códigos mostrados una sola vez.",
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
