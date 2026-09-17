import { existsSync } from "node:fs";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import * as argon2 from "argon2";
import { config as loadEnvironment } from "dotenv";
import pg from "pg";
import { chromium } from "playwright-core";

const { Client } = pg;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const ADMIN_RECOVERY_CODE_PATTERN =
  /^SA-[2-9A-HJ-NP-Z]{5}(?:-[2-9A-HJ-NP-Z]{5}){4}$/;
const TEST_ADMIN_USERNAME = "sinochat_webauthn_check";

const environmentFile = resolve(
  process.cwd(),
  process.env.SINOCHAT_ENV_FILE?.trim() || ".env",
);
loadEnvironment({ path: environmentFile, override: false, quiet: true });

const databaseUrl = requiredEnvironment("DATABASE_URL");
const databaseTarget = new URL(databaseUrl);
const webOrigin = new URL(process.env.WEB_ORIGIN || "http://localhost:5173");
const apiOrigin = new URL(process.env.VITE_API_URL || "http://localhost:3000");

assertLocalTarget(databaseTarget, "DATABASE_URL");
assertLocalTarget(webOrigin, "WEB_ORIGIN");
assertLocalTarget(apiOrigin, "VITE_API_URL");
if (process.env.NODE_ENV === "production") {
  throw new Error("La comprobación de navegador está prohibida en producción.");
}
if (webOrigin.origin !== "http://localhost:5173") {
  throw new Error(
    "La comprobación WebAuthn exige WEB_ORIGIN=http://localhost:5173.",
  );
}

const browserExecutable = findBrowserExecutable();
let adminId;
const username = TEST_ADMIN_USERNAME;
const password = randomBytes(32).toString("base64url");
const database = new Client({
  connectionString: databaseUrl,
  application_name: "sinochat-webauthn-browser-check",
});
let browser;
let temporaryAdminPrepared = false;

try {
  await assertHealthy(`${apiOrigin.origin}/api/health`, "API");
  await assertHealthy(webOrigin.origin, "PWA");
  await database.connect();
  adminId = await prepareTemporaryAdmin(database, username, password);
  temporaryAdminPrepared = true;

  browser = await chromium.launch({
    executablePath: browserExecutable,
    headless: true,
  });
  const context = await browser.newContext({ baseURL: webOrigin.origin });
  const page = await context.newPage();
  const devtools = await context.newCDPSession(page);
  await devtools.send("WebAuthn.enable");
  const originalAuthenticatorId = await addVirtualAuthenticator(devtools);

  await login(page, username, password);
  const recoveryCodes = await enrollAndReadRecoveryCodes(page);
  const originalCredential = await database.query(
    `SELECT "id" FROM "admin_webauthn_credentials"
      WHERE "admin_user_id" = $1 AND "revoked_at" IS NULL`,
    [adminId],
  );
  const originalCredentialId = originalCredential.rows[0]?.id;
  if (!originalCredentialId) throw new Error("Falta la primera passkey registrada.");

  await ageCurrentAdminMfa(database, adminId);
  // Chrome admite un solo autenticador interno; el respaldo simula una llave USB.
  const backupAuthenticatorId = await addVirtualAuthenticator(devtools, false, "usb");
  let staleEnrollmentRejected = false;
  let originalPasskeyAsserted = false;
  const observeAssertion = (event) => {
    if (event.authenticatorId === originalAuthenticatorId) {
      originalPasskeyAsserted = true;
    }
  };
  devtools.on("WebAuthn.credentialAsserted", observeAssertion);
  const registrationOptionsUrl = "**/api/auth/admin/mfa/registration/options";
  await page.route(registrationOptionsUrl, async (route) => {
    const response = await route.fetch();
    if (response.status() === 403) {
      const payload = await response.json();
      staleEnrollmentRejected = payload.code === "ADMIN_MFA_STEP_UP_REQUIRED";
    }
    if (response.ok()) {
      await devtools.send("WebAuthn.setAutomaticPresenceSimulation", {
        authenticatorId: originalAuthenticatorId,
        enabled: false,
      });
      await devtools.send("WebAuthn.setAutomaticPresenceSimulation", {
        authenticatorId: backupAuthenticatorId,
        enabled: true,
      });
    }
    await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "Seguridad", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Agregar otra passkey", exact: true })
    .click();
  await page.locator(".dash-security-status").waitFor();
  const backupPasskeyError = page.locator(
    ".dash-security-status.is-error:visible",
  );
  if ((await backupPasskeyError.count()) > 0) {
    throw new Error(
      `La PWA rechazó la passkey de respaldo: ${await backupPasskeyError.first().innerText()}`,
    );
  }
  await page
    .getByText("Passkey adicional registrada correctamente.", { exact: true })
    .waitFor();
  await page.unroute(registrationOptionsUrl);
  devtools.off("WebAuthn.credentialAsserted", observeAssertion);
  if (!staleEnrollmentRejected || !originalPasskeyAsserted) {
    throw new Error("El alta adicional no exigió step-up con la passkey existente.");
  }
  await logout(page);

  await login(page, username, password);
  await page
    .getByRole("button", { name: "Confirmar con passkey", exact: true })
    .click();
  await assertAdministrativePanel(page);
  const sessionFixture = await prepareAdditionalAdminSession(database, adminId);
  const passkeyInventoryResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/auth/admin/mfa/passkeys" &&
      response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Seguridad", exact: true }).click();
  const passkeyInventoryResponse = await passkeyInventoryResponsePromise;
  if (!passkeyInventoryResponse.ok()) {
    throw new Error(
      `El inventario de passkeys respondió HTTP ${passkeyInventoryResponse.status()}.`,
    );
  }
  const passkeyInventory = await passkeyInventoryResponse.json();
  const originalPasskeyIndex = passkeyInventory.findIndex(
    (credential) => credential.id === originalCredentialId,
  );
  if (originalPasskeyIndex < 0) throw new Error("El inventario perdió la passkey original.");
  await page.getByText("Esta sesión", { exact: true }).waitFor();
  const passkeyCount = page.getByText("2 de 10 passkeys activas", {
    exact: true,
  });
  await Promise.race([
    passkeyCount.waitFor(),
    page.locator(".dash-security-card .dash-security-status.is-error").waitFor(),
  ]);
  if (!(await passkeyCount.isVisible())) {
    const message = await page
      .locator(".dash-security-card .dash-security-status.is-error")
      .first()
      .innerText();
    throw new Error(`La PWA rechazó el inventario de passkeys: ${message}`);
  }
  const originalPasskey = page
    .locator(".dash-security-passkey-list > li")
    .nth(originalPasskeyIndex);
  await originalPasskey.waitFor();
  await originalPasskey
    .getByRole("button", { name: "Revocar", exact: true })
    .click();
  await assertPasskeyConflictPreservesConfirmation(
    page,
    originalPasskey,
    originalCredentialId,
  );
  await originalPasskey
    .getByRole("button", { name: "Confirmar revocación", exact: true })
    .click();
  await page
    .getByText("La passkey seleccionada quedó revocada.", { exact: true })
    .waitFor();
  await page
    .getByText("1 de 10 passkeys activas", { exact: true })
    .waitFor();
  await page.getByText("Única", { exact: true }).waitFor();
  await assertPasskeyRevoked(database, adminId);
  const remainingCredentialId = passkeyInventory.find(
    (credential) => credential.id !== originalCredentialId,
  )?.id;
  if (!remainingCredentialId) throw new Error("Falta la passkey de respaldo.");
  await assertMutationRejected(
    page,
    `/auth/admin/mfa/passkeys/${remainingCredentialId}`,
    "DELETE",
    {},
    409,
    "ADMIN_PASSKEY_LAST_REQUIRED",
  );
  await assertMutationRejected(
    page,
    `/auth/admin/mfa/passkeys/${randomUUID()}`,
    "DELETE",
    {},
    404,
  );

  const otherSession = page
    .locator(".dash-security-session-list > li")
    .filter({ hasText: "Otra sesión" });
  await otherSession.waitFor();
  await otherSession
    .getByRole("button", { name: "Cerrar sesión", exact: true })
    .click();
  const revocationStatus = page.locator(
    ".dash-security-sessions .dash-security-status",
  );
  await revocationStatus.waitFor();
  const revocationMessage = await revocationStatus.innerText();
  if (
    (await revocationStatus.getAttribute("class"))?.includes("is-error") ||
    revocationMessage !== "La sesión seleccionada quedó cerrada."
  ) {
    throw new Error(
      `La PWA no completó la revocación protegida: ${revocationMessage}`,
    );
  }
  await assertAdditionalSessionRevoked(database, adminId, sessionFixture);
  await assertPersistedMfaState(database, adminId);

  await devtools.send("WebAuthn.removeVirtualAuthenticator", {
    authenticatorId: originalAuthenticatorId,
  });
  await devtools.send("WebAuthn.removeVirtualAuthenticator", {
    authenticatorId: backupAuthenticatorId,
  });
  const recoverySessionFixture = await prepareAdditionalAdminSession(database, adminId);
  const recoveryCodeSnapshot = await database.query(
    `SELECT "id" FROM "admin_recovery_codes"
      WHERE "admin_user_id" = $1 AND "used_at" IS NULL AND "revoked_at" IS NULL`,
    [adminId],
  );
  await logout(page);
  await login(page, username, password);
  await page.getByRole("button", { name: "Perdí acceso a mis passkeys", exact: true }).click();
  await page.getByLabel("Código de recuperación", { exact: true }).fill(recoveryCodes[0]);
  await page.getByRole("button", { name: "Usar código y revocar accesos", exact: true }).click();
  await page.getByRole("button", { name: "Registrar mi passkey", exact: true }).waitFor();
  await assertRecoveredState(
    database,
    adminId,
    recoverySessionFixture.extraSessionId,
    recoveryCodeSnapshot.rows.map((row) => row.id),
  );
  for (const oldCode of recoveryCodes.slice(0, 2)) {
    await assertMutationRejected(
      page,
      "/auth/admin/mfa/recover",
      "POST",
      { recoveryCode: oldCode },
      400,
      "ADMIN_MFA_RECOVERY_INVALID",
    );
  }
  const replacementAuthenticatorId = await addVirtualAuthenticator(devtools);
  const replacementCodes = await enrollAndReadRecoveryCodes(page);
  if (replacementCodes.some((code) => recoveryCodes.includes(code))) {
    throw new Error("El reenrolamiento reutilizó códigos de recuperación anteriores.");
  }
  await assertPersistedMfaState(database, adminId);
  await devtools.send("WebAuthn.removeVirtualAuthenticator", {
    authenticatorId: replacementAuthenticatorId,
  });
  console.log(
    "[OK] Chrome completó enrolamiento, recuperación, inventario/revocación de passkeys, conflicto concurrente sin reintento, step-up y sesiones ADMIN.",
  );
} finally {
  await browser?.close().catch(() => undefined);
  if (temporaryAdminPrepared && adminId) {
    await disableTemporaryAdmin(database, adminId).catch((error) => {
      console.error(
        "No se pudo deshabilitar la cuenta ADMIN de prueba; corrígelo antes de continuar.",
      );
      throw error;
    });
  }
  await database.end().catch(() => undefined);
}

async function login(page, loginUsername, loginPassword) {
  await page.goto("/ingresar", { waitUntil: "networkidle" });
  await page.getByLabel("Usuario", { exact: true }).fill(loginUsername);
  await page.getByLabel("Contraseña", { exact: true }).fill(loginPassword);
  await page
    .getByRole("button", { name: "Entrar a SinoChat", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: /^(Registrar mi passkey|Confirmar con passkey)$/,
    })
    .waitFor();
}

async function logout(page) {
  await page
    .getByRole("button", { name: "Cerrar sesión", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Entrar a SinoChat", exact: true })
    .waitFor();
}

async function assertAdministrativePanel(page) {
  await page
    .getByRole("heading", { name: "Resumen administrativo", exact: true })
    .waitFor();
}

async function enrollAndReadRecoveryCodes(page) {
  await page.getByRole("button", { name: "Registrar mi passkey", exact: true }).click();
  await page
    .locator(".admin-recovery-panel, .form-status.error")
    .filter({ visible: true })
    .first()
    .waitFor();
  const enrollmentError = page.locator(".form-status.error:visible");
  if ((await enrollmentError.count()) > 0) {
    throw new Error(
      `La PWA rechazó el enrolamiento: ${await enrollmentError.first().innerText()}`,
    );
  }
  await page
    .getByRole("heading", { name: "Guarda tus códigos de recuperación", exact: true })
    .waitFor();
  const codes = await page.locator(".admin-recovery-codes code").allTextContents();
  if (
    codes.length !== 10 ||
    new Set(codes).size !== codes.length ||
    codes.some((code) => !ADMIN_RECOVERY_CODE_PATTERN.test(code))
  ) {
    throw new Error("El enrolamiento no entregó diez códigos válidos.");
  }
  await page.locator(".admin-mfa-confirmation input[type=checkbox]").check();
  await page
    .getByRole("button", { name: "Entrar al panel administrativo", exact: true })
    .click();
  await assertAdministrativePanel(page);
  return codes;
}

async function assertPasskeyConflictPreservesConfirmation(page, passkey, credentialId) {
  const conflictMessage =
    "La seguridad de tu cuenta cambió mientras realizabas esta acción. Actualiza la página e inténtalo de nuevo.";
  const passkeyPath = `/api/auth/admin/mfa/passkeys/${credentialId}`;
  const matchesPasskey = (url) => url.pathname === passkeyPath;
  const confirmation = passkey.getByRole("button", {
    name: "Confirmar revocación",
    exact: true,
  });
  const inventory = page.locator(".dash-security-passkey-list");
  const inventoryBefore = await inventory.innerText();
  let deleteRequests = 0;
  let authenticationRequests = 0;
  const observeRequest = (request) => {
    if (request.method() !== "POST" && request.method() !== "DELETE") return;
    const { pathname } = new URL(request.url());
    if (request.method() === "DELETE" && pathname === passkeyPath) {
      deleteRequests += 1;
    }
    if (
      request.method() === "POST" &&
      pathname.startsWith("/api/auth/admin/mfa/authentication/")
    ) {
      authenticationRequests += 1;
    }
  };
  const rejectConcurrentRevocation = async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      headers: {
        "access-control-allow-origin": webOrigin.origin,
        "access-control-allow-credentials": "true",
      },
      body: JSON.stringify({
        code: "ADMIN_MFA_CONCURRENT_CHANGE",
        message: conflictMessage,
      }),
    });
  };

  await page.route(matchesPasskey, rejectConcurrentRevocation);
  page.on("request", observeRequest);
  try {
    await confirmation.click();
    const alert = page.getByRole("alert").filter({ hasText: conflictMessage });
    await alert.waitFor();
    await confirmation.waitFor();
    if (
      (await alert.innerText()) !== conflictMessage ||
      !(await confirmation.isEnabled()) ||
      !(await passkey.getByRole("button", { name: "Cancelar", exact: true }).isVisible()) ||
      (await inventory.innerText()) !== inventoryBefore
    ) {
      throw new Error("El conflicto concurrente perdió el mensaje, el inventario o la confirmación de revocación.");
    }
    if (deleteRequests !== 1 || authenticationRequests !== 0) {
      throw new Error("La PWA reintentó la revocación o solicitó un step-up automático ante un conflicto concurrente.");
    }
  } finally {
    page.off("request", observeRequest);
    await page.unroute(matchesPasskey, rejectConcurrentRevocation);
  }
}

async function assertMutationRejected(page, path, method, body, expectedStatus, expectedCode) {
  const result = await page.evaluate(
    async ({ url, requestMethod, requestBody, csrfCookieName }) => {
      const cookiePrefix = `${csrfCookieName}=`;
      const cookie = document.cookie.split(";").map((value) => value.trim())
        .find((value) => value.startsWith(cookiePrefix));
      if (!cookie) throw new Error("Falta la cookie CSRF de la sesión de prueba.");
      const response = await fetch(url, {
        method: requestMethod,
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": decodeURIComponent(cookie.slice(cookiePrefix.length)),
        },
        body: JSON.stringify(requestBody),
      });
      const payload = await response.json();
      return { status: response.status, code: payload.code };
    },
    {
      url: `${apiOrigin.origin}/api${path}`,
      requestMethod: method,
      requestBody: body,
      csrfCookieName: process.env.VITE_CSRF_COOKIE_NAME || "sinochat_csrf",
    },
  );
  if (result.status !== expectedStatus || (expectedCode && result.code !== expectedCode)) {
    throw new Error(
      `La protección de ${path} respondió HTTP ${result.status}; se esperaba ${expectedStatus}${expectedCode ? ` (${expectedCode})` : ""}.`,
    );
  }
}

async function ageCurrentAdminMfa(client, id) {
  const result = await client.query(
    `UPDATE "auth_sessions"
        SET "created_at" = LEAST("created_at", clock_timestamp() - INTERVAL '11 minutes'),
            "admin_mfa_verified_at" = clock_timestamp() - INTERVAL '10 minutes'
      WHERE "id" = (
        SELECT "id" FROM "auth_sessions"
         WHERE "user_id" = $1 AND "revoked_at" IS NULL
           AND "admin_mfa_verified_at" IS NOT NULL
         ORDER BY "created_at" DESC LIMIT 1
      )`,
    [id],
  );
  if (result.rowCount !== 1) throw new Error("No se pudo envejecer el MFA de prueba.");
}

async function assertRecoveredState(client, id, extraSessionId, recoveryCodeIds) {
  if (recoveryCodeIds.length !== 10) throw new Error("Faltan los códigos previos a la recuperación.");
  const result = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM "admin_webauthn_credentials"
         WHERE "admin_user_id" = $1 AND "revoked_at" IS NULL) AS "credentials",
       (SELECT COUNT(*)::int FROM "admin_recovery_codes"
         WHERE "admin_user_id" = $1 AND "id" = ANY($3::uuid[])
           AND "used_at" IS NOT NULL) AS "used_codes",
       (SELECT COUNT(*)::int FROM "admin_recovery_codes"
         WHERE "admin_user_id" = $1 AND "id" = ANY($3::uuid[])
           AND "used_at" IS NULL AND "revoked_at" IS NOT NULL) AS "revoked_codes",
       (SELECT COUNT(*)::int FROM "auth_sessions"
         WHERE "user_id" = $1 AND "revoked_at" IS NULL) AS "active_sessions",
       (SELECT COUNT(*)::int FROM "auth_sessions"
         WHERE "user_id" = $1 AND "revoked_at" IS NULL
           AND "admin_mfa_verified_at" IS NOT NULL) AS "verified_sessions",
       (SELECT "revocation_reason" FROM "auth_sessions"
         WHERE "id" = $2 AND "user_id" = $1) AS "extra_reason",
       (SELECT "action"::text FROM "admin_audit_events"
         WHERE "actor_admin_id" = $1 ORDER BY "created_at" DESC, "id" DESC LIMIT 1) AS "action"`,
    [id, extraSessionId, recoveryCodeIds],
  );
  const state = result.rows[0];
  if (
    state?.credentials !== 0 || state?.used_codes !== 1 || state?.revoked_codes !== 9 ||
    state?.active_sessions !== 1 || state?.verified_sessions !== 0 ||
    state?.extra_reason !== "ADMIN_MFA_RECOVERY" || state?.action !== "ADMIN_MFA_RECOVERED"
  ) {
    throw new Error("La recuperación no revocó y auditó los accesos anteriores correctamente.");
  }
}

async function prepareTemporaryAdmin(client, loginUsername, loginPassword) {
  const passwordMaterial = process.env.PASSWORD_PEPPER
    ? createHmac("sha256", process.env.PASSWORD_PEPPER)
        .update(loginPassword, "utf8")
        .digest("base64")
    : loginPassword;
  const passwordHash = await argon2.hash(passwordMaterial, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    hashLength: 32,
    raw: false,
  });
  const normalizedUsername = loginUsername.toLowerCase();
  await client.query("BEGIN");
  try {
    const existing = await client.query(
      `SELECT "id", "role"
         FROM "users"
        WHERE "normalized_username" = $1
        FOR UPDATE`,
      [normalizedUsername],
    );
    let id = existing.rows[0]?.id;
    if (id) {
      if (existing.rows[0].role !== "ADMIN") {
        throw new Error("La identidad reservada de prueba no pertenece a ADMIN.");
      }
      await disableAdminSecurityState(client, id);
      await client.query(
        `UPDATE "users"
            SET "username" = $2,
                "password_hash" = $3,
                "password_changed_at" = clock_timestamp(),
                "password_reset_required" = false,
                "session_version" = "session_version" + 1,
                "status" = 'ACTIVE',
                "failed_login_attempts" = 0,
                "locked_until" = NULL,
                "suspended_at" = NULL,
                "suspension_reason_code" = NULL,
                "deleted_at" = NULL,
                "updated_at" = clock_timestamp()
          WHERE "id" = $1`,
        [id, loginUsername, passwordHash],
      );
    } else {
      id = randomUUID();
      await client.query(
        `INSERT INTO "users" (
           "id", "role", "username", "normalized_username", "password_hash",
           "status", "updated_at"
         ) VALUES ($1, 'ADMIN', $2, $3, $4, 'ACTIVE', clock_timestamp())`,
        [id, loginUsername, normalizedUsername, passwordHash],
      );
    }
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function assertPersistedMfaState(client, id) {
  const result = await client.query(
    `SELECT
       (SELECT COUNT(*)::int
          FROM "admin_webauthn_credentials"
         WHERE "admin_user_id" = $1 AND "revoked_at" IS NULL) AS "credentials",
       (SELECT COUNT(*)::int
          FROM "admin_recovery_codes"
         WHERE "admin_user_id" = $1
           AND "used_at" IS NULL
           AND "revoked_at" IS NULL) AS "recovery_codes",
       (SELECT COUNT(*)::int
          FROM "auth_sessions"
         WHERE "user_id" = $1
           AND "revoked_at" IS NULL
           AND "admin_mfa_verified_at" IS NOT NULL) AS "verified_sessions"`,
    [id],
  );
  const state = result.rows[0];
  if (
    state?.credentials !== 1 ||
    state?.recovery_codes !== 10 ||
    state?.verified_sessions !== 1
  ) {
    throw new Error("El estado WebAuthn persistido no coincide con la ceremonia.");
  }
}

async function assertPasskeyRevoked(client, id) {
  const result = await client.query(
    `WITH "latest_audit" AS (
       SELECT "action", "reason_code", "state_after"
         FROM "admin_audit_events"
        WHERE "actor_admin_id" = $1
        ORDER BY "created_at" DESC, "id" DESC
        LIMIT 1
     )
     SELECT
       (SELECT COUNT(*)::int
          FROM "admin_webauthn_credentials"
         WHERE "admin_user_id" = $1 AND "revoked_at" IS NULL)
         AS "active_credentials",
       "action"::text AS "action",
       "reason_code",
       ("state_after"::jsonb ->> 'revoked')::boolean AS "revoked"
       FROM "latest_audit"`,
    [id],
  );
  const state = result.rows[0];
  if (
    state?.active_credentials !== 1 ||
    state?.action !== "ADMIN_PASSKEY_REVOKED" ||
    state?.reason_code !== "ADMIN_PASSKEY_SELF_SERVICE_REVOCATION" ||
    state?.revoked !== true
  ) {
    throw new Error("La revocación de passkey no quedó auditada correctamente.");
  }
}

async function prepareAdditionalAdminSession(client, id) {
  const current = await client.query(
    `SELECT "id"
       FROM "auth_sessions"
      WHERE "user_id" = $1
        AND "revoked_at" IS NULL
        AND "admin_mfa_verified_at" IS NOT NULL
      ORDER BY "created_at" DESC
      LIMIT 1`,
    [id],
  );
  const currentSessionId = current.rows[0]?.id;
  if (!currentSessionId) {
    throw new Error("No se encontró la sesión ADMIN vigente del navegador.");
  }

  const extraSessionId = randomUUID();
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO "auth_sessions" (
         "id", "user_id", "token_hash", "csrf_secret_hash",
         "session_version", "created_at", "last_seen_at", "expires_at",
         "admin_mfa_verified_at"
       )
       SELECT $2, "id", $3, $4, "session_version",
              clock_timestamp() - INTERVAL '10 minutes',
              clock_timestamp() - INTERVAL '1 minute',
              clock_timestamp() + INTERVAL '1 hour',
              clock_timestamp() - INTERVAL '1 minute'
         FROM "users"
        WHERE "id" = $1 AND "role" = 'ADMIN' AND "status" = 'ACTIVE'`,
      [
        id,
        extraSessionId,
        randomBytes(32).toString("hex"),
        randomBytes(32).toString("hex"),
      ],
    );
    await client.query(
      `UPDATE "auth_sessions"
          SET "created_at" = LEAST(
                "created_at",
                clock_timestamp() - INTERVAL '11 minutes'
              ),
              "admin_mfa_verified_at" = clock_timestamp() - INTERVAL '10 minutes'
        WHERE "id" = $1 AND "user_id" = $2 AND "revoked_at" IS NULL`,
      [currentSessionId, id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return { currentSessionId, extraSessionId };
}

async function assertAdditionalSessionRevoked(client, id, fixture) {
  const result = await client.query(
    `SELECT
       (SELECT "revocation_reason"
          FROM "auth_sessions"
         WHERE "id" = $2 AND "user_id" = $1) AS "extra_reason",
       (SELECT "revoked_at" IS NULL
               AND "admin_mfa_verified_at" >= clock_timestamp() - INTERVAL '5 minutes'
          FROM "auth_sessions"
         WHERE "id" = $3 AND "user_id" = $1) AS "current_is_recent",
       (SELECT COUNT(*)::int
          FROM "admin_audit_events"
         WHERE "actor_admin_id" = $1
           AND "action" = 'ADMIN_SESSION_REVOKED'
           AND "target_id" = $2) AS "audit_events"`,
    [id, fixture.extraSessionId, fixture.currentSessionId],
  );
  const state = result.rows[0];
  if (
    state?.extra_reason !== "ADMIN_SELF_SERVICE_REVOCATION" ||
    state?.current_is_recent !== true ||
    state?.audit_events !== 1
  ) {
    throw new Error(
      "La revocación de sesión o su step-up/auditoría no quedó persistida.",
    );
  }
}

async function disableTemporaryAdmin(client, id) {
  await client.query("BEGIN");
  try {
    await disableAdminSecurityState(client, id);
    const disabled = await client.query(
      `UPDATE "users"
          SET "status" = 'DELETED',
              "deleted_at" = clock_timestamp(),
              "session_version" = "session_version" + 1,
              "updated_at" = clock_timestamp()
        WHERE "id" = $1
          AND "normalized_username" = $2
          AND "role" = 'ADMIN'`,
      [id, TEST_ADMIN_USERNAME],
    );
    if (disabled.rowCount !== 1) {
      throw new Error("No se pudo deshabilitar la identidad ADMIN reservada.");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function disableAdminSecurityState(client, id) {
  await client.query(
    `UPDATE "admin_webauthn_credentials"
        SET "revoked_at" = clock_timestamp()
      WHERE "admin_user_id" = $1 AND "revoked_at" IS NULL`,
    [id],
  );
  await client.query(
    `UPDATE "admin_recovery_codes"
        SET "revoked_at" = clock_timestamp()
      WHERE "admin_user_id" = $1
        AND "used_at" IS NULL
        AND "revoked_at" IS NULL`,
    [id],
  );
  await client.query(
    `UPDATE "admin_webauthn_challenges"
        SET "consumed_at" = clock_timestamp()
      WHERE "admin_user_id" = $1 AND "consumed_at" IS NULL`,
    [id],
  );
  await client.query(
    `UPDATE "auth_sessions"
        SET "revoked_at" = clock_timestamp(),
            "revocation_reason" = 'LOCAL_BROWSER_CHECK_CLEANUP'
      WHERE "user_id" = $1 AND "revoked_at" IS NULL`,
    [id],
  );
}

async function assertHealthy(url, label) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${label} no está disponible en ${url}.`);
  }
}

function assertLocalTarget(url, name) {
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`${name} debe apuntar a localhost para ejecutar esta prueba.`);
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} es obligatorio.`);
  return value;
}

function findBrowserExecutable() {
  const configured = process.env.CHROME_PATH?.trim();
  const candidates = [
    configured,
    process.env.ProgramFiles
      ? resolve(process.env.ProgramFiles, "Google/Chrome/Application/chrome.exe")
      : undefined,
    process.env["ProgramFiles(x86)"]
      ? resolve(
          process.env["ProgramFiles(x86)"],
          "Microsoft/Edge/Application/msedge.exe",
        )
      : undefined,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error(
      "No se encontró Chrome/Edge. Define CHROME_PATH con el ejecutable local.",
    );
  }
  return executable;
}

async function addVirtualAuthenticator(devtools, automaticPresenceSimulation = true, transport = "internal") {
  const result = await devtools.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport,
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation,
    },
  });
  return result.authenticatorId;
}
