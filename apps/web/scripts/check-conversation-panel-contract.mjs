import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(webRoot, "src/conversationPayload.ts");
const temporaryDirectory = await mkdtemp(
  resolve(webRoot, ".conversation-contract-test-"),
);
const outputPath = resolve(temporaryDirectory, "conversationPayload.mjs");

try {
  const source = await readFile(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  assert.deepEqual(
    compiled.diagnostics ?? [],
    [],
    "El parser de conversaciones debe transpilar sin diagnósticos",
  );
  await writeFile(outputPath, compiled.outputText, "utf8");

  const { parseConversationPage } = await import(
    `${pathToFileURL(outputPath).href}?contract=${Date.now()}`
  );
  const validPage = {
    items: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        participant: {
          id: "22222222-2222-4222-8222-222222222222",
          username: "cliente_seguro",
          status: "ACTIVE",
        },
        assignedAt: "2026-08-30T12:00:00.000Z",
        unreadCount: 3,
        lastMessage: {
          kind: "TEXT",
          createdAt: "2026-08-30T12:30:00.000Z",
          serverSequence: "42",
        },
      },
    ],
    page: 1,
    limit: 1,
    hasMore: true,
  };
  const parsed = parseConversationPage(validPage);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].lastMessagePreview, "Mensaje cifrado");
  assert.equal(parsed.items[0].participant.presence, "offline");
  assert.deepEqual(parsed.items[0].messages, []);
  assert.equal(parsed.hasMore, true);

  assert.throws(
    () =>
      parseConversationPage({
        ...validPage,
        items: [
          {
            ...validPage.items[0],
            ciphertext: "no-debe-consumirse-aquí",
          },
        ],
      }),
    /formato inesperado/,
    "El panel debe rechazar contenido o cifrado agregado al listado",
  );
  assert.throws(
    () =>
      parseConversationPage({
        ...validPage,
        items: [],
        hasMore: true,
      }),
    /formato inesperado/,
    "hasMore exige una página completa para evitar estados incoherentes",
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

const [apiSource, appSource, cashierSource, chatSource] = await Promise.all([
  readFile(resolve(webRoot, "src/api.ts"), "utf8"),
  readFile(resolve(webRoot, "src/App.tsx"), "utf8"),
  readFile(resolve(webRoot, "src/dashboard/CashierDashboard.tsx"), "utf8"),
  readFile(resolve(webRoot, "src/dashboard/ChatPanel.tsx"), "utf8"),
]);
const applicationAdapter = apiSource.slice(
  apiSource.indexOf("export const applicationApi"),
  apiSource.indexOf("async function loadAdminPanel"),
);

assert.match(applicationAdapter, /\/conversations\?\$\{search\}/);
assert.match(
  applicationAdapter,
  /\/moderation\/cashier\/clients\/\$\{encodeURIComponent\(clientId\)\}\/block/,
);
assert.doesNotMatch(applicationAdapter, /async\s+(?:sendText|sendImage|reportCashier)\s*\(/);
assert.match(appSource, /appendCashierConversationPage/);
assert.match(appSource, /removeCashierClient\(current, clientId\)/);
assert.match(cashierSource, /Cargar más clientes/);
assert.match(chatSource, /El historial y el envío se habilitarán/);

console.log(
  "[OK] Paneles de cliente/cajero consumen solo metadatos, paginan y mantienen el contenido E2EE bloqueado.",
);
