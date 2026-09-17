import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import { chromium } from "playwright-core";

export function findBrowserExecutable() {
  if (process.env.CHROME_PATH) {
    if (!existsSync(process.env.CHROME_PATH)) throw new Error("CHROME_PATH no identifica un navegador instalado.");
    return process.env.CHROME_PATH;
  }
  const candidates = [
    // En CI este ejecutable se instala desde la versión fijada de playwright-core.
    chromium.executablePath(),
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Microsoft/Edge/Application/msedge.exe"),
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("Instala Chrome/Edge o define CHROME_PATH para las pruebas de navegador.");
  return executable;
}

export async function unusedLoopbackPort() {
  const probe = createServer();
  await new Promise((resolvePort, rejectPort) => {
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", resolvePort);
  });
  const port = probe.address().port;
  await new Promise((resolveClose, rejectClose) => probe.close((error) => error ? rejectClose(error) : resolveClose()));
  // El servidor consumidor debe usar strictPort si otro proceso ocupa el puerto.
  return port;
}

export function assertTemporaryChild(parent, target, prefix) {
  const child = relative(resolve(parent), resolve(target));
  if (!prefix || !child.startsWith(prefix) || child === prefix || child.includes("/") ||
      child.includes("\\") || isAbsolute(child) || child.startsWith("..")) {
    throw new Error("UNSAFE_BROWSER_TEST_TEMP_PATH");
  }
}
