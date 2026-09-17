import type { UserRole } from "../generated/prisma/enums";

export interface RequestMetadata {
  ip?: string;
  userAgent?: string;
}

export interface PublicUser {
  id: string;
  username: string;
  role: UserRole;
  status: string;
}

export interface SessionPrincipal extends PublicUser {
  sessionId: string;
  deviceId: string | null;
  sessionExpiresAt: Date;
  adminMfaVerified?: boolean;
  adminMfaVerifiedAt?: Date | null;
}

export interface AuthResult {
  user: PublicUser;
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface CashierRegistrationResult extends AuthResult {
  recoveryCodes: string[];
  recoveryCodesExpireAt: Date | null;
}

export interface AdminSessionSummary {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  isCurrent: boolean;
}
