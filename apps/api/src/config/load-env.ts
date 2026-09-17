import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { config } from "dotenv";

const explicitPath = process.env.SINOCHAT_ENV_FILE?.trim();
const candidates = [
  explicitPath
    ? isAbsolute(explicitPath)
      ? explicitPath
      : resolve(process.cwd(), explicitPath)
    : undefined,
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env"),
  resolve(__dirname, "../../../../.env")
].filter((candidate): candidate is string => Boolean(candidate));

const selected = [...new Set(candidates)].find((candidate) =>
  existsSync(candidate)
);
if (selected) {
  config({ path: selected, override: false, quiet: true });
}
