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

describe("admin report dashboard contract", () => {
  it("valida y transporta el total pendiente global de la API", () => {
    match(
      webApi,
      /pendingTotal:\s*requiredNonNegativeInteger\(\s*payload\.pendingTotal/
    );
    match(
      webApi,
      /reportsPendingTotal:\s*parsedReports\.pendingTotal/
    );
    match(
      app,
      /reportsPendingTotal=\{adminData\.reportsPendingTotal\}/
    );
  });

  it("usa el total global para el badge y el resumen, no la pagina visible", () => {
    match(dashboard, /const reportCount = reportsPendingTotal/);
    match(dashboard, /count=\{reportsPendingTotal\}/);
    doesNotMatch(
      dashboard,
      /reports\.filter\(\(report\) => report\.status !== "closed"\)/
    );
  });
});
