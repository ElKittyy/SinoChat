import { createHash, randomBytes } from "node:crypto";

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const SYMBOLS_PER_CODE = 25;
const GROUP_SIZE = 5;
export const ADMIN_RECOVERY_CODE_COUNT = 10;
export const ADMIN_RECOVERY_CODE_PATTERN =
  /^SA-[2-9A-HJ-NP-Z]{5}(?:-[2-9A-HJ-NP-Z]{5}){4}$/;

export function issueAdminRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < ADMIN_RECOVERY_CODE_COUNT) {
    codes.add(generateAdminRecoveryCode());
  }
  return [...codes];
}

export function normalizeAdminRecoveryCode(value: string): string {
  return value.trim().toUpperCase();
}

export function hashAdminRecoveryCode(
  adminUserId: string,
  rawCode: string
): string {
  return createHash("sha256")
    .update("sinochat:admin-recovery:v1\0", "utf8")
    .update(adminUserId, "utf8")
    .update("\0", "utf8")
    .update(normalizeAdminRecoveryCode(rawCode), "utf8")
    .digest("hex");
}

function generateAdminRecoveryCode(): string {
  const bytes = randomBytes(SYMBOLS_PER_CODE);
  const symbols = Array.from(
    bytes,
    (byte) => ALPHABET[byte! & 31]!
  ).join("");
  const groups = [] as string[];
  for (let offset = 0; offset < symbols.length; offset += GROUP_SIZE) {
    groups.push(symbols.slice(offset, offset + GROUP_SIZE));
  }
  return `SA-${groups.join("-")}`;
}
