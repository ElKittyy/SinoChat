import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildEnvironment = {
  ...process.env,
  // El .env compartido usa development para la API local. Vite debe resolver
  // las exportaciones de React para produccion al generar el artefacto web.
  NODE_ENV: "production"
};

runNodeTool(require.resolve("typescript/bin/tsc"), ["-b"]);
const viteCli = resolve(
  dirname(require.resolve("vite")),
  "..",
  "..",
  "bin",
  "vite.js"
);
runNodeTool(viteCli, [
  "build",
  "--configLoader",
  "runner"
]);

const assetsDirectory = resolve(webRoot, "dist", "assets");
const builtHtml = readFileSync(resolve(webRoot, "dist", "index.html"), "utf8");
const entryBundles = [...builtHtml.matchAll(
  /<script\b[^>]*\btype="module"[^>]*\bsrc="\/assets\/([A-Za-z0-9_-]+\.js)"[^>]*><\/script>/g,
)].map((match) => match[1]);
if (entryBundles.length !== 1 || !entryBundles[0]) {
  throw new Error("WEB_ENTRY_BUNDLE_NOT_UNIQUE");
}
const entryBundle = readFileSync(
  resolve(assetsDirectory, entryBundles[0]),
  "utf8"
);
const allJavaScript = readdirSync(assetsDirectory)
  .filter((fileName) => /^[A-Za-z0-9_-]+\.js$/.test(fileName))
  .map((fileName) => readFileSync(resolve(assetsDirectory, fileName), "utf8"))
  .join("\n");
if (
  !entryBundle ||
  allJavaScript.includes("react-dom.development.js") ||
  allJavaScript.includes("Download the React DevTools")
) {
  throw new Error("REACT_DEVELOPMENT_BUILD_PRESENT");
}
if (entryBundle.includes("matrix_sdk_crypto_wasm_bg")) {
  throw new Error("E2EE_WASM_EAGERLY_BUNDLED");
}
if (["sinochatE2eeFixture", "/__sinochat_e2ee_api/", "FIXTURE_INJECTED_NETWORK_FAILURE",
  "sasPanelFixture", "/__sinochat_sas_panel__"]
  .some((marker) => allJavaScript.includes(marker) || builtHtml.includes(marker))) {
  throw new Error("E2EE_BROWSER_FIXTURE_IN_PRODUCTION_BUNDLE");
}

console.log("[OK] Artefacto web usa React de produccion.");
console.log("[OK] Matrix/WASM permanece fuera del bundle inicial.");
console.log("[OK] El relay y los hooks del navegador de prueba no forman parte del artefacto.");

function runNodeTool(modulePath, argumentsList) {
  const result = spawnSync(process.execPath, [modulePath, ...argumentsList], {
    cwd: webRoot,
    env: buildEnvironment,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
