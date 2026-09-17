import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const api = readFileSync(resolve(root, "src/api.ts"), "utf8");
const app = readFileSync(resolve(root, "src/App.tsx"), "utf8");
const gate = readFileSync(
  resolve(root, "src/components/AdminMfaGate.tsx"),
  "utf8",
);
const dashboard = readFileSync(
  resolve(root, "src/dashboard/AdminDashboard.tsx"),
  "utf8",
);

assertContains(api, "startRegistration", "La PWA no inicia el alta WebAuthn.");
assertContains(api, "startAuthentication", "La PWA no inicia la assertion WebAuthn.");
for (const route of [
  "/auth/admin/mfa/registration/options",
  "/auth/admin/mfa/registration/verify",
  "/auth/admin/mfa/authentication/options",
  "/auth/admin/mfa/authentication/verify",
  "/auth/admin/mfa/recover",
  "/auth/admin/mfa/passkeys",
  "/auth/sessions",
  "/auth/sessions/revoke-others",
]) {
  assertContains(api, route, `Falta el endpoint web ${route}.`);
}
assertContains(app, "<AdminMfaGate", "App no bloquea el panel ADMIN detrás de MFA.");
assertContains(
  app,
  'error.code !== "ADMIN_MFA_STEP_UP_REQUIRED"',
  "La evidencia no reintenta tras un step-up con passkey.",
);
assertContains(
  gate,
  "Confirmo que guardé los diez códigos",
  "El administrador puede salir sin confirmar el respaldo de recuperación.",
);
assertContains(
  gate,
  "revoca todas las passkeys y las demás sesiones",
  "La UX no explica el efecto destructivo de la recuperación.",
);
if (/localStorage|sessionStorage|indexedDB/i.test(gate)) {
  throw new Error("Los códigos administrativos no deben persistirse en el navegador.");
}
assertContains(
  dashboard,
  "Agregar otra passkey",
  "El panel ADMIN no permite registrar una passkey de respaldo.",
);
assertContains(
  dashboard,
  "Confirmar revocación",
  "El panel ADMIN no confirma la revocación de una passkey.",
);
assertContains(
  dashboard,
  "Única",
  "El panel ADMIN no identifica que la última passkey debe conservarse.",
);
assertContains(
  dashboard,
  "no reemplaza tus diez códigos de recuperación",
  "La UX no distingue una passkey adicional de la recuperación inicial.",
);
assertContains(
  dashboard,
  "Esta sesión",
  "El panel ADMIN no identifica de forma inequívoca la sesión actual.",
);
assertContains(
  dashboard,
  "Cerrar las demás sesiones",
  "El panel ADMIN no permite revocar el resto de las sesiones.",
);
assertContains(
  app,
  "withAdminMfaStepUp",
  "Las acciones administrativas sensibles no comparten el step-up WebAuthn.",
);
assertContains(
  app,
  "revokeAdminSession",
  "La PWA no conecta la revocación individual de sesiones ADMIN.",
);
assertContains(
  app,
  "revokePasskey",
  "La PWA no conecta la revocación protegida de passkeys.",
);

console.log(
  "[OK] Passkeys ADMIN, inventario/revocación, recuperación, step-up y sesiones conectados.",
);

function assertContains(source, fragment, message) {
  if (!source.includes(fragment)) throw new Error(message);
}
