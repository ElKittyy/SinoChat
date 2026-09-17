import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const environmentPath = resolve(projectRoot, ".env");

if (process.argv.length > 2) {
  throw new Error("Argumento no reconocido; no se modifico .env.");
}

if (!existsSync(environmentPath)) {
  throw new Error(
    "Falta .env. Copia .env.example una sola vez antes de configurar MinIO."
  );
}

const original = readFileSync(environmentPath, "utf8");
const eol = original.includes("\r\n") ? "\r\n" : "\n";
const hadFinalNewline = /\r?\n$/.test(original);
const lines = original.split(/\r?\n/);
if (hadFinalNewline) {
  lines.pop();
}

function findEntry(name) {
  const pattern = new RegExp(`^\\s*${name}\\s*=(.*)$`);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(pattern);
    if (match) {
      return { index, value: match[1].trim() };
    }
  }
  return undefined;
}

function setValue(name, value) {
  const entry = findEntry(name);
  if (entry) {
    lines[entry.index] = `${name}=${value}`;
  } else {
    lines.push(`${name}=${value}`);
  }
}

function setCompatiblePublicValue(name, value, acceptedExistingValues) {
  const current = findEntry(name)?.value ?? "";
  if (current && !acceptedExistingValues.includes(current)) {
    throw new Error(
      `${name} ya apunta a otra configuracion. No se modifico .env.`
    );
  }
  setValue(name, value);
}

function ensureSecret(name, generator, minimumLength) {
  const current = findEntry(name)?.value ?? "";
  if (current) {
    if (current.length < minimumLength) {
      throw new Error(
        `${name} existe pero es demasiado corto. No se modifico .env.`
      );
    }
    return;
  }
  setValue(name, generator());
}

setCompatiblePublicValue(
  "OBJECT_STORAGE_ENDPOINT",
  "http://127.0.0.1:9000",
  ["http://127.0.0.1:9000", "http://localhost:9000"]
);
setCompatiblePublicValue(
  "OBJECT_STORAGE_REGION",
  "us-east-1",
  ["auto", "us-east-1"]
);
setCompatiblePublicValue(
  "OBJECT_STORAGE_BUCKET",
  "sinochat-ephemeral",
  ["sinochat-ephemeral"]
);
setCompatiblePublicValue(
  "OBJECT_STORAGE_FORCE_PATH_STYLE",
  "true",
  ["true"]
);
setCompatiblePublicValue(
  "OBJECT_STORAGE_VERSIONING_MODE",
  "purge-all",
  ["disabled", "purge-all"]
);

ensureSecret(
  "MINIO_ROOT_USER",
  () => `sinochat-admin-${randomBytes(8).toString("hex")}`,
  3
);
ensureSecret(
  "MINIO_ROOT_PASSWORD",
  () => randomBytes(48).toString("base64url"),
  16
);
ensureSecret(
  "OBJECT_STORAGE_ACCESS_KEY_ID",
  () => `sinochat-app-${randomBytes(8).toString("hex")}`,
  3
);
ensureSecret(
  "OBJECT_STORAGE_SECRET_ACCESS_KEY",
  () => randomBytes(48).toString("base64url"),
  16
);

writeFileSync(
  environmentPath,
  `${lines.join(eol)}${hadFinalNewline ? eol : ""}`,
  { encoding: "utf8", mode: 0o600 }
);

console.log(
  "Configuracion local de MinIO preparada en .env; los secretos no se mostraron."
);
