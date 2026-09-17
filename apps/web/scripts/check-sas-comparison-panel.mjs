import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { assertTemporaryChild, findBrowserExecutable, unusedLoopbackPort } from "./browser-test-environment.mjs";

// Actual React interactions in isolated Chrome. Synthetic views/callbacks only:
// no SDK, transport, .env, real sessions, API, database or application mounting.
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = await mkdtemp(join(tmpdir(), "sinochat-sas-panel-"));
const fixtureUrl = "/__sinochat_sas_panel__.tsx";
const fixtureId = "\0sinochat-sas-panel-fixture.tsx";
const first = { state: "compare", comparisonId: "receipt-synthetic-one", decimals: [1234, 5678, 9012] };
const second = { state: "compare", comparisonId: "receipt-synthetic-two", decimals: [2345, 6789, 8123] };
const sensitiveError = "DETAIL_NOT_FOR_UI receipt-synthetic-one 1234 PRIVATE_DATA";
const harness = `
  import React from "react";
  import { createRoot } from "react-dom/client";
  import { flushSync } from "react-dom";
  import { SasComparisonPanel } from "/src/components/SasComparisonPanel.tsx";
  const root = createRoot(document.getElementById("root"));
  const calls = [];
  const pending = [];
  let mode = "resolve";
  function action(kind, id) {
    calls.push({ kind, ...(id ? { id } : {}) });
    if (mode === "reject") return Promise.reject(new Error(${JSON.stringify(sensitiveError)}));
    if (mode === "hold") return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    return Promise.resolve();
  }
  function render(view, busy = false) {
    flushSync(() => root.render(React.createElement(React.StrictMode, null,
      React.createElement(SasComparisonPanel, {
        view, busy,
        onConfirm: (id) => action("confirm", id),
        onReject: () => action("reject"),
        onCancel: () => action("cancel"),
      }))));
  }
  window.sasPanelFixture = {
    render,
    mode(value) { mode = value; },
    calls() { return structuredClone(calls); },
    pending() { return pending.length; },
    release(success = true) {
      const current = pending.shift();
      if (!current) throw new Error("FIXTURE_HAS_NO_PENDING_ACTION");
      if (success) current.resolve();
      else current.reject(new Error(${JSON.stringify(sensitiveError)}));
    },
    unmount() { flushSync(() => root.unmount()); },
  };
  render({ state: "waiting" });
`;
let server;
let browser;
let watchdog;
const unexpected = [];
const consoleMessages = [];
let passed = 0;

try {
  const source = await readFile(resolve(webRoot, "src/components/SasComparisonPanel.tsx"), "utf8");
  assert.match(source, /import type \{ MatrixSasComparisonView \} from "\.\.\/e2ee\/matrixSasComparison"/);
  assert.doesNotMatch(source, /@matrix-org|localStorage|sessionStorage|indexedDB|console\.|fetch\(/);
  server = await createServer({
    root: webRoot, configFile: false, envDir: false, cacheDir: cache, logLevel: "error",
    esbuild: { jsx: "automatic" },
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] },
    server: { host: "127.0.0.1", port: await unusedLoopbackPort(), strictPort: true, hmr: false },
    plugins: [{
      name: "sinochat-isolated-sas-panel-check",
      resolveId(id) { if (id === fixtureUrl) return fixtureId; },
      load(id) { if (id === fixtureId) return harness; },
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url !== "/__sinochat_sas_panel__") return next();
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end('<!doctype html><html lang="es"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Prueba aislada de comparación</title><body style="margin:16px;background:#090909"><div id="root"></div><script type="module" src="' + fixtureUrl + '"></script></body></html>');
        });
      },
    }],
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: findBrowserExecutable(), headless: true, timeout: 30_000 });
  watchdog = setTimeout(() => { void browser.close(); }, 120_000);
  const context = await browser.newContext({ baseURL: origin, serviceWorkers: "block", viewport: { width: 390, height: 900 } });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || /\/api(?:\/|$)|\.wasm|matrix-sdk|matrixSasComparison/.test(url.pathname)) {
      unexpected.push("UNEXPECTED_NETWORK_OR_SDK_REQUEST");
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    const missing = error.message.match(/does not provide an export named '([A-Za-z0-9_]{1,64})'/)?.[1];
    const classification = [
      ["Failed to resolve module specifier", "BARE_MODULE_IMPORT"],
      ["does not provide an export named", "MISSING_MODULE_EXPORT"],
      ["React is not defined", "JSX_RUNTIME_NOT_AVAILABLE"],
      ["Unexpected token", "MODULE_SYNTAX"],
    ].find(([snippet]) => error.message.includes(snippet))?.[1] ?? "BROWSER_RUNTIME_ERROR";
    unexpected.push(missing ? `${classification}:${missing}` : classification);
  });
  page.on("console", (message) => consoleMessages.push(message.text()));
  await page.goto(`${origin}/__sinochat_sas_panel__`);
  try {
    await page.waitForFunction(() => Boolean(window.sasPanelFixture));
  } catch {
    // Fixture boot happens before any comparison or sensitive callback exists.
    // Print only fixed classifications; never dump page/console bodies.
    const importFailure = consoleMessages.some((message) => /resolve module|import|404|500/i.test(message));
    throw new Error(`SAS_PANEL_FIXTURE_BOOT_FAILED (${importFailure ? "MODULE_LOADING" : "RUNTIME"}; ${unexpected.join(",")})`);
  }
  const confirm = () => page.getByRole("button", { name: "Sí, coinciden", exact: true });
  const reject = () => page.getByRole("button", { name: "No coinciden", exact: true });
  const cancel = () => page.getByRole("button", { name: "Cancelar comparación", exact: true });
  const checkbox = () => page.getByRole("checkbox");
  const calls = () => page.evaluate(() => window.sasPanelFixture.calls());
  const render = (view, busy = false) => page.evaluate(({ view, busy }) => window.sasPanelFixture.render(view, busy), { view, busy });
  const setMode = (mode) => page.evaluate((value) => window.sasPanelFixture.mode(value), mode);
  const idle = () => page.waitForFunction(() => document.querySelector(".sas-panel")?.getAttribute("aria-busy") === "false");

  await check("Esperar o renderizar no confirma automaticamente", async () => {
    assert.equal(await page.locator("output").count(), 0);
    assert.equal(await cancel().count(), 1);
    await render(first);
    await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    assert.deepEqual(await page.locator("output").allTextContents(), first.decimals.map(String));
    assert.equal(await confirm().isDisabled(), true);
    assert.equal(await checkbox().isChecked(), false);
    assert.deepEqual(await calls(), []);
  });
  await check("Checkbox explicita habilita y deshabilita la confirmacion", async () => {
    await checkbox().check();
    assert.equal(await confirm().isEnabled(), true);
    await checkbox().uncheck();
    assert.equal(await confirm().isDisabled(), true);
    assert.deepEqual(await calls(), []);
  });
  await check("Nuevo recibo reinicia consentimiento aunque los numeros sean iguales", async () => {
    await checkbox().check();
    await render({ ...second, decimals: first.decimals });
    assert.equal(await checkbox().isChecked(), false);
    assert.equal(await confirm().isDisabled(), true);
  });
  await check("Cambiar numeros del mismo recibo tambien reinicia consentimiento", async () => {
    await checkbox().check();
    await render(second);
    assert.equal(await checkbox().isChecked(), false);
    assert.equal(await confirm().isDisabled(), true);
  });
  await check("Busy externo impide todas las acciones", async () => {
    await render(second, true);
    for (const control of [confirm(), reject(), cancel(), checkbox()]) assert.equal(await control.isDisabled(), true);
    assert.deepEqual(await calls(), []);
    await render(second);
  });
  await check("Doble clic envia una sola confirmacion y bloquea acciones durante la promesa", async () => {
    await setMode("hold");
    await checkbox().check();
    await confirm().dblclick({ delay: 15 });
    assert.deepEqual(await calls(), [{ kind: "confirm", id: second.comparisonId }]);
    for (const control of [confirm(), reject(), cancel(), checkbox()]) assert.equal(await control.isDisabled(), true);
    await page.evaluate(() => window.sasPanelFixture.release());
    await idle();
    assert.equal(await confirm().isDisabled(), true, "Un recibo consumido no se confirma dos veces tras resolver");
  });
  await check("No coinciden rechaza sin checkbox y nunca confirma", async () => {
    await setMode("resolve");
    await render({ ...first, comparisonId: "receipt-reject" });
    await reject().click();
    await idle();
    assert.equal((await calls()).at(-1).kind, "reject");
    assert.equal((await calls()).filter((call) => call.kind === "confirm").length, 1);
  });
  await check("Cancelar tiene una accion distinta del rechazo", async () => {
    await render({ state: "waiting-peer" });
    assert.equal(await page.locator("output").count(), 0);
    await cancel().click();
    await idle();
    assert.equal((await calls()).at(-1).kind, "cancel");
  });
  for (const state of ["comparison-complete", "cancelled", "expired", "failed", "closed"]) {
    await check(`Estado ${state} elimina numeros, checkbox y acciones`, async () => {
      await render(first);
      await checkbox().check();
      const before = await calls();
      await render({ state });
      assert.equal(await page.locator("output,input,button").count(), 0);
      assert.deepEqual(await calls(), before);
      const text = await page.locator("body").innerText();
      assert.ok(first.decimals.every((number) => !text.includes(String(number))));
      assert.ok(!text.includes(first.comparisonId));
      assert.doesNotMatch(text, /dispositivo autorizado/i);
      if (state === "comparison-complete") assert.match(text, /alta del dispositivo sigue pendiente/i);
    });
  }
  await check("Error de callback es generico, sin detalles y sin reintento automatico", async () => {
    await setMode("reject");
    await render({ ...first, comparisonId: "receipt-error" });
    await checkbox().check();
    await confirm().click();
    await page.getByRole("alert").waitFor();
    const text = await page.locator("body").innerText();
    assert.match(text, /No se pudo completar la comparación/);
    assert.ok(!text.includes(sensitiveError) && !text.includes("PRIVATE_DATA"));
    assert.equal(await page.locator("output,input,button").count(), 0);
    const count = (await calls()).length;
    await render({ ...first, comparisonId: "receipt-error" });
    assert.equal((await calls()).length, count);
  });
  await check("Error de un recibo anterior no contamina el nuevo ni reutiliza consentimiento", async () => {
    await setMode("hold");
    await render({ ...first, comparisonId: "receipt-old-pending" });
    await checkbox().check();
    await confirm().click();
    await render({ ...second, comparisonId: "receipt-new-pending" });
    assert.equal(await checkbox().isChecked(), false);
    assert.equal(await confirm().isDisabled(), true);
    await page.evaluate(() => window.sasPanelFixture.release(false));
    await idle();
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.equal(await checkbox().isChecked(), false);
    assert.equal(await confirm().isDisabled(), true);
  });
  await check("Valores invalidos fallan cerrados sin mostrar codigos o acciones", async () => {
    for (const decimals of [[999, 5678, 9012], [1234, 9192, 9012], [1234, 5678], [1234.5, 5678, 9012]]) {
      await render({ ...first, decimals });
      assert.equal(await page.getByRole("alert").count(), 1);
      assert.equal(await page.locator("output,input,button").count(), 0);
    }
  });
  await check("Panel usable a 320 px y mediante teclado", async () => {
    await setMode("resolve");
    await page.setViewportSize({ width: 320, height: 900 });
    await render({ ...first, comparisonId: "receipt-keyboard" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await checkbox().focus();
    await page.keyboard.press("Space");
    assert.equal(await checkbox().isChecked(), true);
    await page.keyboard.press("Tab");
    assert.equal(await confirm().evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press("Enter");
    await idle();
    assert.equal((await calls()).at(-1).id, "receipt-keyboard");
  });
  await check("Recibos y errores no se publican en DOM, logs ni almacenamiento", async () => {
    const html = await page.locator("body").innerHTML();
    assert.ok(!html.includes("receipt-keyboard") && !html.includes("PRIVATE_DATA"));
    assert.deepEqual(await page.evaluate(async () => ({
      local: localStorage.length, session: sessionStorage.length,
      databases: (await indexedDB.databases()).length,
    })), { local: 0, session: 0, databases: 0 });
    assert.equal(consoleMessages.some((message) => /receipt-|DETAIL_NOT_FOR_UI|PRIVATE_DATA|1234|5678|9012/.test(message)), false);
    assert.deepEqual(unexpected, []);
  });
  await check("Desmontar con accion pendiente no genera errores ni acciones adicionales", async () => {
    await setMode("hold");
    await render({ ...first, comparisonId: "receipt-unmount" });
    await checkbox().check();
    await confirm().click();
    const before = await calls();
    await page.evaluate(() => { window.sasPanelFixture.unmount(); window.sasPanelFixture.release(false); });
    await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame)));
    assert.deepEqual(await calls(), before);
    assert.deepEqual(unexpected, []);
  });
  console.log(`[OK] Panel SAS: ${passed} comprobaciones en Chrome; sin SDK, API, DB ni cambios al gate.`);
} finally {
  clearTimeout(watchdog);
  try { await browser?.close(); }
  finally {
    try { await server?.close(); }
    finally {
      assertTemporaryChild(tmpdir(), cache, "sinochat-sas-panel-");
      await rm(cache, { recursive: true, force: true });
    }
  }
}

async function check(label, action) {
  await action();
  passed++;
  console.log(`[OK] ${label}.`);
}
