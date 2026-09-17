import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { assertTemporaryChild } from "./browser-test-environment.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assertTemporaryChild(root, resolve(root, ".local-retention-test-123abc"), ".local-retention-test-");
for (const target of [root, resolve(root, ".."), resolve(root, "src"), resolve(root, ".local-retention-test-123abc/child")]) {
  assert.throws(() => assertTemporaryChild(root, target, ".local-retention-test-"), /UNSAFE_BROWSER_TEST_TEMP_PATH/);
}
const temporary = await mkdtemp(resolve(root, ".local-retention-test-"));
try {
  const source = await readFile(resolve(root, "src/localMessageRetention.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  assert.deepEqual(compiled.diagnostics ?? [], []);
  const path = resolve(temporary, "retention.mjs");
  await writeFile(path, compiled.outputText, "utf8");
  const { nextConversationExpiry, pruneExpiredConversation } = await import(pathToFileURL(path).href);
  const now = Date.parse("2026-09-10T12:00:00.000Z");
  const message = (id, delta) => Object.freeze({
    id, kind: "text", text: "Contenido efímero", expiresAt: new Date(now + delta).toISOString(),
  });
  const selected = Object.freeze({
    id: "selected", messages: Object.freeze([message("live", 1), message("due", 0)]), lastMessagePreview: "Vista previa vieja",
  });
  const unselected = Object.freeze({ id: "unselected", messages: Object.freeze([message("old", -1)]) });
  assert.equal(nextConversationExpiry([selected, unselected]), now - 1);
  assert.equal(nextConversationExpiry([]), undefined);
  assert.equal(nextConversationExpiry([{ messages: [] }]), undefined);
  assert.equal(pruneExpiredConversation(selected, now - 1), selected, "No recrea estado sin cambios");
  const pruned = pruneExpiredConversation(selected, now);
  assert.deepEqual(pruned.messages.map((item) => item.id), ["live"]);
  assert.equal(pruned.lastMessagePreview, undefined);
  assert.equal(pruned.messages[0], selected.messages[0]);
  assert.equal(selected.messages.length, 2, "No muta estado anterior");
  assert.deepEqual(pruneExpiredConversation(unselected, now).messages, []);
  assert.deepEqual(pruneExpiredConversation(selected, now + 1).messages, []);
  const malformed = { messages: [{ expiresAt: "invalid" }] };
  assert.equal(nextConversationExpiry([malformed]), 0);
  assert.deepEqual(pruneExpiredConversation(malformed, now).messages, []);
  const app = await readFile(resolve(root, "src/App.tsx"), "utf8");
  assert.match(app, /useLocalMessageExpiry\(nextConversationExpiry\(panelConversations\(panel\)\), expireLocalMessages\)/);
  assert.match(app, /setPanel\(\(current\) => pruneExpiredPanelMessages\(current, now\)\)/);
  assert.match(app, /payload\.data\.conversations\.map\(\(item\) => pruneExpiredConversation\(item, now\)\)/);
  assert.doesNotMatch(app, /nearestExpiry - Date\.now\(\)/);
  console.log("[OK] Retención local: límite inclusivo, fechas inválidas, todas las conversaciones, inmutabilidad y conexión al estado React.");
} finally {
  assertTemporaryChild(root, temporary, ".local-retention-test-");
  await rm(temporary, { recursive: true, force: true });
}
