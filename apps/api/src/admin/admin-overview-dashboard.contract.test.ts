import { doesNotMatch, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

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

describe("admin overview dashboard contract", () => {
  it("valida y transporta los agregados globales de usuarios", () => {
    match(
      webApi,
      /inactiveSubscriptions:\s*requiredNonNegativeInteger\(\s*overviewRecord\.inactiveSubscriptions/
    );
    match(
      webApi,
      /pendingUsers:\s*requiredNonNegativeInteger\(\s*overviewRecord\.pendingUsers/
    );
    match(app, /overview=\{adminData\.overview\}/);
  });

  it("no reconstruye los contadores desde la pagina visible", () => {
    match(dashboard, /count=\{overview\.pendingUsers\}/);
    match(dashboard, /count=\{overview\.inactiveSubscriptions\}/);
    doesNotMatch(
      dashboard,
      /const pendingUsers = users\.filter\(/
    );
    doesNotMatch(
      dashboard,
      /const inactiveSubscriptions = subscriptions\.filter\(/
    );
  });
});
