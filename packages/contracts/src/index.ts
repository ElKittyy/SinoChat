export const USER_ROLES = ["CLIENT", "CASHIER", "ADMIN"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const MESSAGE_MAX_LENGTH = 4_000;
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const MESSAGE_RETENTION_HOURS = 48;
export const BLOCK_REASON_MIN_LENGTH = 20;
export const CLIENT_DISTINCT_BLOCK_LIMIT = 5;

export const CASHIER_ONBOARDING_INVITATION_STATUSES = [
  "ACTIVE",
  "EXPIRED",
  "REDEEMED",
  "REVOKED"
] as const;

export type CashierOnboardingInvitationStatus =
  (typeof CASHIER_ONBOARDING_INVITATION_STATUSES)[number];

export interface SafeCashierOnboardingInvitation {
  id: string;
  status: CashierOnboardingInvitationStatus;
  canRevoke: boolean;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  revokedAt: string | null;
  createdByAdmin: { id: string; username: string };
  redeemedByCashier: { id: string; username: string } | null;
}

export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp"
] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V4_CANONICAL_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MATRIX_DEVICE_ID_PATTERN = /^D([0-9A-F]{32})$/;
const MATRIX_SERVER_NAME_PATTERN =
  /^(?:(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?$/;

export function normalizeMatrixServerName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    !MATRIX_SERVER_NAME_PATTERN.test(normalized) ||
    normalized.includes("@") ||
    normalized.includes("/") ||
    normalized.startsWith(".") ||
    normalized.endsWith(".") ||
    normalized.includes("..")
  ) {
    throw new Error("MATRIX_SERVER_NAME_INVALID");
  }

  try {
    const parsed = new URL(`https://${normalized}`);
    if (!parsed.hostname || parsed.username || parsed.password) {
      throw new Error("MATRIX_SERVER_NAME_INVALID");
    }
  } catch {
    throw new Error("MATRIX_SERVER_NAME_INVALID");
  }
  return normalized;
}

export function matrixUserIdFromUuid(
  sinochatUserId: string,
  serverName: string
): string {
  return `@u${uuidHex(sinochatUserId, "USER_ID_INVALID")}:${normalizeMatrixServerName(serverName)}`;
}

/**
 * Invierte exclusivamente las identidades Matrix internas de SinoChat. No
 * acepta otros namespaces ni otro servidor, aunque el identificador tenga una
 * sintaxis Matrix valida.
 */
export function sinochatUserIdFromMatrixUserId(
  matrixUserId: string,
  serverName: string
): string {
  const normalizedServerName = normalizeMatrixServerName(serverName);
  const match = /^@u([0-9a-f]{32}):(.+)$/i.exec(matrixUserId);
  if (!match || match[2]?.toLowerCase() !== normalizedServerName) {
    throw new Error("MATRIX_USER_ID_INVALID");
  }

  const hex = match[1]!.toLowerCase();
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
  if (!UUID_PATTERN.test(uuid)) {
    throw new Error("MATRIX_USER_ID_INVALID");
  }
  return uuid;
}

export function matrixDeviceIdFromUuid(sinochatDeviceId: string): string {
  return `D${uuidHex(sinochatDeviceId, "DEVICE_ID_INVALID").toUpperCase()}`;
}

/**
 * Invierte exclusivamente los identificadores de dispositivo canonicos que
 * SinoChat deriva de UUID v4. El formato Matrix aceptado es una `D` seguida
 * por exactamente 32 digitos hexadecimales en mayusculas.
 */
export function sinochatDeviceIdFromMatrixDeviceId(
  matrixDeviceId: string
): string {
  if (typeof matrixDeviceId !== "string") {
    throw new Error("MATRIX_DEVICE_ID_INVALID");
  }

  const match = MATRIX_DEVICE_ID_PATTERN.exec(matrixDeviceId);
  if (!match) {
    throw new Error("MATRIX_DEVICE_ID_INVALID");
  }

  const hex = match[1]!.toLowerCase();
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");

  if (
    !UUID_V4_CANONICAL_PATTERN.test(uuid) ||
    matrixDeviceIdFromUuid(uuid) !== matrixDeviceId
  ) {
    throw new Error("MATRIX_DEVICE_ID_INVALID");
  }

  return uuid;
}

export function matrixRoomIdFromUuid(
  conversationId: string,
  serverName: string
): string {
  return `!c${uuidHex(conversationId, "CONVERSATION_ID_INVALID")}:${normalizeMatrixServerName(serverName)}`;
}

function uuidHex(value: string, errorCode: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(errorCode);
  }
  return value.replaceAll("-", "").toLowerCase();
}
