import type { ReactNode } from "react";

export type MaybePromise<T = void> = T | Promise<T>;

export type UserRole = "client" | "cashier" | "admin";
export type PresenceStatus = "online" | "offline" | "away";
export type DeliveryStatus = "sending" | "sent" | "delivered" | "read";

export interface DashboardIdentity {
  id: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface ChatContact extends DashboardIdentity {
  presence: PresenceStatus;
  lastSeenAt?: string;
}

interface BaseChatMessage {
  id: string;
  senderId: string;
  sentAt: string;
  expiresAt: string;
  deliveryStatus?: DeliveryStatus;
}

export interface TextChatMessage extends BaseChatMessage {
  kind: "text";
  text: string;
}

export interface ImageChatMessage extends BaseChatMessage {
  kind: "image";
  image: {
    url: string;
    alt: string;
    fileName?: string;
  };
  caption?: string;
}

export type ChatMessage = TextChatMessage | ImageChatMessage;

export interface ChatConversation {
  id: string;
  participant: ChatContact;
  messages: readonly ChatMessage[];
  unreadCount: number;
  lastActivityAt?: string;
  lastMessagePreview?: string;
  isTyping?: boolean;
}

export interface DashboardCommonProps {
  currentUser: DashboardIdentity;
  notificationCount?: number;
  notificationsOverlay?: ReactNode;
  onOpenNotifications?: () => MaybePromise;
  onLogout: () => MaybePromise;
  systemNotice?: DashboardNotice;
}

export interface DashboardNotice {
  title: string;
  message: string;
  tone?: "info" | "warning" | "error";
  actionLabel?: string;
  onAction?: () => MaybePromise;
}

export type AdminUserStatus =
  | "active"
  | "pending"
  | "suspended"
  | "deleted";

export interface AdminUser {
  id: string;
  username: string;
  displayName?: string;
  role: UserRole;
  status: AdminUserStatus;
  email?: string;
  phone?: string;
  assignedCashierName?: string;
  distinctCashierBlocks?: number;
  activeClientCount?: number;
  cashierApprovalStatus?: "pending" | "approved" | "rejected" | "revoked";
  createdAt: string;
}

export interface AdminAssignment {
  id: string;
  clientId: string;
  clientUsername: string;
  cashierId: string;
  cashierUsername: string;
  assignedAt: string;
  source: "invitation" | "reassignment" | "admin" | "unknown";
}

export type SubscriptionStatus =
  | "active"
  | "inactive"
  | "grace_period"
  | "expired"
  | "none"
  | "cancelled";

export type SubscriptionEffectiveStatus =
  | SubscriptionStatus
  | "scheduled"
  | "expired_pending";

export interface AdminSubscription {
  id?: string;
  cashierId: string;
  cashierUsername: string;
  status: SubscriptionStatus;
  effectiveStatus: SubscriptionEffectiveStatus;
  startedAt?: string;
  validUntil?: string;
}

export type ReportStatus = "open" | "under_review" | "closing" | "closed";

export type AdminReportFilterStatus =
  | "OPEN"
  | "IN_REVIEW"
  | "CLOSING"
  | "CLOSED";

export type AdminReportOutcome =
  | "NO_ACTION"
  | "WARNING"
  | "CASHIER_SUSPENDED"
  | "CASHIER_DELETED"
  | "OTHER";

export interface AdminReportEvidenceAccessInput {
  currentPassword: string;
  reason: string;
}

export interface AdminReportCloseInput {
  outcome: AdminReportOutcome;
  resolutionSummary: string;
}

export interface AdminReportEvidencePackage {
  reportId: string;
  downloadUrl: string;
  downloadExpiresInSeconds: number;
  ciphertextByteSize: string;
  ciphertextSha256: string;
  cipherSuite: string;
  manifestVersion: number;
  investigationKey: {
    version: number;
    algorithm: string;
    fingerprint: string;
  };
  privateKeyLocation?: string;
}

export interface AdminReportClosureDiagnostic {
  attempts: number;
  nextAttemptAt: string;
  lastAttemptAt?: string;
  lastErrorCode?: string;
}

/**
 * Deliberately contains report metadata only. Ordinary chat content must never
 * be passed to the administration dashboard.
 */
export interface AdminReport {
  id: string;
  reporterUsername: string;
  reportedUsername: string;
  reason: string;
  createdAt: string;
  status: ReportStatus;
  outcome?: AdminReportOutcome;
  resolutionSummary?: string;
  reviewStartedAt?: string;
  closeRequestedAt?: string;
  closedAt?: string;
  evidencePurgedAt?: string;
  subjectNotifiedAt?: string;
  closureJob?: AdminReportClosureDiagnostic;
}

export interface DashboardStat {
  id: string;
  label: string;
  value: number | string;
  detail?: string;
  tone?: "default" | "gold" | "danger";
}

export interface AdminPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AdminOverviewCounts {
  inactiveSubscriptions: number;
  pendingUsers: number;
}

export interface AdminPasskeySummary {
  id: string;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
}

export interface AdminSessionSummary {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export interface AdminUserUpdateInput {
  username?: string;
  email?: string;
  phone?: string;
}

export interface AdminPasswordResetInput extends Record<string, never> {}

export interface AdminCashierOnboardingInput {
  expiresInHours: number;
}

export interface AdminCashierOnboardingResult {
  id: string;
  code: string;
  createdAt: string;
  expiresAt: string;
}

export type AdminCashierInvitationStatus =
  | "active"
  | "expired"
  | "redeemed"
  | "revoked";

export type AdminCashierInvitationFilterStatus =
  | "ALL"
  | "ACTIVE"
  | "EXPIRED"
  | "REDEEMED"
  | "REVOKED";

export interface AdminCashierInvitation {
  id: string;
  status: AdminCashierInvitationStatus;
  canRevoke: boolean;
  createdAt: string;
  expiresAt: string;
  redeemedAt?: string;
  revokedAt?: string;
  createdByAdmin: DashboardIdentity;
  redeemedByCashier?: DashboardIdentity;
}

export type AdminUserAction =
  | "edit"
  | "verify"
  | "suspend"
  | "activate"
  | "delete";

export type AdminSupportedUserAction = Extract<
  AdminUserAction,
  "verify" | "suspend" | "activate"
>;
