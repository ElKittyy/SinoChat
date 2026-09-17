import { createHash, randomBytes } from "node:crypto";

export const CASHIER_RECOVERY_CODE_COUNT = 8;
export const CASHIER_RECOVERY_CODE_PATTERN =
  /^SC-[2-9A-HJ-NP-Z]{5}(?:-[2-9A-HJ-NP-Z]{5}){3}$/;
export const CASHIER_PASSWORD_RESET_LIFETIME_HOURS = 24;

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_SYMBOLS = 20;

export interface CashierRecoveryCodePackage {
  codes: string[];
  expiresAt: null;
}

export function issueCashierRecoveryCodes(
  issuedAt: Date,
): CashierRecoveryCodePackage {
  if (!Number.isFinite(issuedAt.getTime())) {
    throw new Error("La fecha de emisión de los códigos no es válida.");
  }
  const codes = new Set<string>();
  while (codes.size < CASHIER_RECOVERY_CODE_COUNT) {
    codes.add(formatCode(randomCodePayload()));
  }
  return {
    codes: [...codes],
    expiresAt: null,
  };
}

export function normalizeCashierRecoveryCode(value: string): string {
  return value.trim().toUpperCase();
}

export function hashCashierRecoveryCode(
  cashierUserId: string,
  recoveryCode: string,
): string {
  return createHash("sha256")
    .update("sinochat:cashier-recovery-code:v1\0", "utf8")
    .update(cashierUserId, "utf8")
    .update("\0", "utf8")
    .update(normalizeCashierRecoveryCode(recoveryCode), "utf8")
    .digest("hex");
}

export function cashierPasswordResetExpiresAt(createdAt: Date): Date {
  return new Date(
    createdAt.getTime() +
      CASHIER_PASSWORD_RESET_LIFETIME_HOURS * 60 * 60 * 1_000,
  );
}

function randomCodePayload(): string {
  const bytes = randomBytes(13);
  let accumulator = 0;
  let availableBits = 0;
  let output = "";

  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    availableBits += 8;
    while (availableBits >= 5 && output.length < CODE_SYMBOLS) {
      availableBits -= 5;
      output += ALPHABET[(accumulator >>> availableBits) & 31];
      accumulator &= (1 << availableBits) - 1;
    }
  }

  if (output.length !== CODE_SYMBOLS) {
    throw new Error("No se pudo generar un codigo de recuperacion seguro.");
  }
  return output;
}

function formatCode(payload: string): string {
  return `SC-${payload.match(/.{5}/g)?.join("-") ?? ""}`;
}
