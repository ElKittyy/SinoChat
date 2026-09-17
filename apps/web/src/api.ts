import type { AccessActions, CashierRegistrationResult } from "./access";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import {
  parseConversationPage,
  type ConversationPage,
} from "./conversationPayload";
import type { MatrixHttpTransport } from "./e2ee/matrixTransport";
import {
  parseAttachmentUploadGrant,
  parseEncryptedMessagePage,
  parseMessageAcknowledgement,
  parseMessageReceiptAcknowledgement,
  validateAttachmentUploadRequest,
  validateSendEncryptedMessageRequest,
  type AttachmentUploadGrant,
  type AttachmentUploadRequest,
  type EncryptedMessagePage,
  type MessageAcknowledgement,
  type MessageReceiptAcknowledgement,
  type SendEncryptedMessageRequest,
} from "./messagePayload";
import type {
  AdminAssignment,
  AdminCashierInvitation,
  AdminCashierInvitationFilterStatus,
  AdminCashierOnboardingInput,
  AdminCashierOnboardingResult,
  AdminOverviewCounts,
  AdminPasskeySummary,
  AdminPagination,
  AdminPasswordResetInput,
  AdminReport,
  AdminReportCloseInput,
  AdminReportEvidenceAccessInput,
  AdminReportEvidencePackage,
  AdminReportFilterStatus,
  AdminSessionSummary,
  AdminSubscription,
  AdminSupportedUserAction,
  AdminUser,
  AdminUserUpdateInput,
  ChatConversation,
  DashboardStat,
} from "./dashboard";

const configuredApiOrigin = (import.meta.env.VITE_API_URL ?? "").replace(
  /\/+$/,
  "",
);
const API_BASE = configuredApiOrigin
  ? `${configuredApiOrigin}/api`
  : import.meta.env.DEV
    ? "http://localhost:3000/api"
    : "/api";
const CSRF_COOKIE_NAME =
  import.meta.env.VITE_CSRF_COOKIE_NAME ??
  (import.meta.env.PROD ? "__Host-sinochat_csrf" : "sinochat_csrf");
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const SESSION_INVALID_EVENT = "sinochat:session-invalid";

export type SessionRole = "CLIENT" | "CASHIER" | "ADMIN";
export type SessionAccountStatus =
  | "PENDING"
  | "ACTIVE"
  | "SUSPENDED"
  | "DELETED";

export interface SessionUser {
  id: string;
  username: string;
  role: SessionRole;
  status: SessionAccountStatus;
  deviceId: string | null;
  adminMfa: AdminMfaState | null;
}

export interface AdminMfaState {
  required: true;
  enrolled: boolean;
  verified: boolean;
}

export interface AdminMfaEnrollmentResult {
  recoveryCodes: readonly string[];
}

export interface AdminMfaAdapter {
  isSupported: () => boolean;
  enroll: () => Promise<AdminMfaEnrollmentResult>;
  authenticate: () => Promise<void>;
  recover: (recoveryCode: string) => Promise<void>;
  listPasskeys: (
    signal?: AbortSignal,
  ) => Promise<readonly AdminPasskeySummary[]>;
  revokePasskey: (
    credentialId: string,
    signal?: AbortSignal,
  ) => Promise<{ revoked: true }>;
}

export interface E2eeReleaseStatus {
  state: "BLOCKED" | "READY";
  reasonCode: string;
  protocol: string;
  clientLibrary: string;
  clientLibraryVersion: string;
  matrixSpecificationVersion: string;
  messageRetentionHours: 48;
  message: string;
}

export interface MatrixDeviceRegistration {
  deviceId: string;
  matrixUserId: string;
  matrixDeviceId: string;
  matrixServerName: string;
  expiresAt: string;
}

export interface MatrixDeviceCompletion {
  deviceId: string;
  matrixUserId: string;
  matrixDeviceId: string;
  bindingSecret: string;
  publishedAt: string;
  one_time_key_counts: Record<string, number>;
}

export interface MatrixCrossSigningPublicIdentity {
  masterKey: string;
  selfSigningKey: string;
  userSigningKey: string;
}

export type MatrixCrossSigningStatus = {
  matrixUserId: string;
  matrixDeviceId: string;
} & (
  | { state: "UNINITIALIZED"; identity: null }
  | { state: "PINNED"; identity: MatrixCrossSigningPublicIdentity }
);

export interface E2eeApi extends MatrixHttpTransport {
  getStatus: (signal?: AbortSignal) => Promise<E2eeReleaseStatus>;
  getCrossSigningStatus: (signal?: AbortSignal) => Promise<MatrixCrossSigningStatus>;
  bootstrapCrossSigning: (
    body: { signing_keys: Record<string, unknown>; device_signatures: Record<string, unknown> },
    signal?: AbortSignal,
  ) => Promise<MatrixCrossSigningStatus>;
  reserveDevice: (
    signal?: AbortSignal,
  ) => Promise<MatrixDeviceRegistration>;
  completeDevice: (
    registrationId: string,
    body: unknown,
    signal?: AbortSignal,
  ) => Promise<MatrixDeviceCompletion>;
  bindSession: (
    deviceId: string,
    bindingSecret: string,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export interface CashierInvitationData {
  id: string;
  code: string;
  createdAt: string;
}

export type InAppNotificationType =
  | "NEW_MESSAGE"
  | "MESSAGE_DELIVERED"
  | "MESSAGE_READ"
  | "ASSIGNMENT_CHANGED"
  | "ACCOUNT_STATUS_CHANGED"
  | "REPORT_RESOLVED"
  | "REPORT_WARNING";

/**
 * Metadatos deliberadamente mínimos. Los identificadores de mensajes y
 * entidades relacionadas que devuelve el backend no se conservan en la PWA.
 */
export interface InAppNotification {
  id: string;
  type: InAppNotificationType;
  createdAt: string;
  readAt?: string;
  expiresAt?: string;
}

export interface NotificationsData {
  items: readonly InAppNotification[];
  unreadCount: number;
}

export interface NotificationsAdapter {
  load: (limit?: number, signal?: AbortSignal) => Promise<NotificationsData>;
  markAllRead: (signal?: AbortSignal) => Promise<void>;
  markRead: (notificationId: string, signal?: AbortSignal) => Promise<void>;
}

export interface ClientPanelData {
  conversation: ChatConversation | null;
  notificationCount?: number;
}

export interface CashierPanelData {
  conversations: readonly ChatConversation[];
  conversationHasMore: boolean;
  conversationLimit: number;
  conversationPage: number;
  notificationCount?: number;
  selectedConversationId?: string;
  subscriptionLabel?: string;
}

export interface CashierPanelQuery {
  limit?: number;
  page?: number;
}

export interface AdminPanelData {
  assignments: readonly AdminAssignment[];
  assignmentsPagination: AdminPagination;
  cashierInvitations: readonly AdminCashierInvitation[];
  cashierInvitationsFilter: AdminCashierInvitationFilterStatus;
  cashierInvitationsPagination: AdminPagination;
  loadIssues?: readonly string[];
  notificationCount?: number;
  overview: AdminOverviewCounts;
  reports: readonly AdminReport[];
  reportsPendingTotal: number;
  reportsPagination: AdminPagination;
  stats: readonly DashboardStat[];
  subscriptions: readonly AdminSubscription[];
  subscriptionsPagination: AdminPagination;
  users: readonly AdminUser[];
  usersPagination: AdminPagination;
}

export interface AdminPanelQuery {
  assignmentPage?: number;
  assignmentPageSize?: number;
  cashierInvitationPage?: number;
  cashierInvitationPageSize?: number;
  cashierInvitationStatus?: AdminCashierInvitationFilterStatus;
  reportPage?: number;
  reportPageSize?: number;
  reportStatus?: AdminReportFilterStatus;
  subscriptionPage?: number;
  subscriptionPageSize?: number;
  userPage?: number;
  userPageSize?: number;
}

/**
 * Adaptadores de panel. `load` permanece opcional hasta que exista su endpoint.
 * Los adaptadores de mensajes deberán descifrar en el dispositivo antes de
 * producir un `ChatConversation`; la API nunca debe devolver texto plano.
 */
export interface ClientPanelAdapter {
  load?: (signal?: AbortSignal) => Promise<ClientPanelData>;
  sendText?: (conversationId: string, text: string) => Promise<void>;
  sendImage?: (conversationId: string, file: File) => Promise<void>;
  reportCashier?: (conversationId: string, reason: string) => Promise<void>;
}

export interface CashierPanelAdapter {
  load?: (
    query?: CashierPanelQuery,
    signal?: AbortSignal,
  ) => Promise<CashierPanelData>;
  getInvitation?: (signal?: AbortSignal) => Promise<CashierInvitationData>;
  rotateInvitation?: () => Promise<CashierInvitationData>;
  rotateRecoveryCodes?: (
    currentPassword: string,
  ) => Promise<CashierRegistrationResult>;
  sendText?: (conversationId: string, text: string) => Promise<void>;
  sendImage?: (conversationId: string, file: File) => Promise<void>;
  blockClient?: (clientId: string, reason: string) => Promise<void>;
}

export interface AdminPanelAdapter {
  load?: (
    query?: AdminPanelQuery,
    signal?: AbortSignal,
  ) => Promise<AdminPanelData>;
  accessReportEvidence?: (
    reportId: string,
    input: AdminReportEvidenceAccessInput,
  ) => Promise<AdminReportEvidencePackage>;
  closeReport?: (
    reportId: string,
    input: AdminReportCloseInput,
  ) => Promise<void>;
  createCashierInvitation?: (
    input: AdminCashierOnboardingInput,
  ) => Promise<AdminCashierOnboardingResult>;
  revokeCashierInvitation?: (invitationId: string) => Promise<void>;
  deleteUser?: (userId: string) => Promise<void>;
  openReport?: (reportId: string) => Promise<void>;
  reassignClient?: (assignmentId: string) => Promise<void>;
  subscriptionAction?: (
    cashierId: string,
    action: "activate" | "deactivate",
  ) => Promise<void>;
  userAction?: (
    userId: string,
    action: AdminSupportedUserAction,
  ) => Promise<void>;
  resetPassword?: (
    userId: string,
    input: AdminPasswordResetInput,
  ) => Promise<void>;
  updateUser?: (
    userId: string,
    input: AdminUserUpdateInput,
  ) => Promise<void>;
}

export interface ApplicationApi {
  access: AccessActions;
  e2ee: E2eeApi;
  messages: MessagesApi;
  notifications?: NotificationsAdapter;
  adminMfa: AdminMfaAdapter;
  session: {
    getCurrentUser: (signal?: AbortSignal) => Promise<SessionUser>;
    listAdminSessions: (signal?: AbortSignal) => Promise<readonly AdminSessionSummary[]>;
    logout: () => Promise<void>;
    revokeAdminSession: (
      sessionId: string,
      signal?: AbortSignal,
    ) => Promise<{ revoked: boolean; currentSession: boolean }>;
    revokeOtherAdminSessions: (
      signal?: AbortSignal,
    ) => Promise<{ revokedCount: number }>;
  };
  panels: {
    admin?: AdminPanelAdapter;
    cashier?: CashierPanelAdapter;
    client?: ClientPanelAdapter;
  };
}

export interface MessagesApi {
  list: (
    conversationId: string,
    deviceId: string,
    query?: { afterSequence?: string; limit?: number },
    signal?: AbortSignal,
  ) => Promise<EncryptedMessagePage>;
  requestAttachmentUpload: (
    conversationId: string,
    input: AttachmentUploadRequest,
    signal?: AbortSignal,
  ) => Promise<AttachmentUploadGrant>;
  uploadAttachment: (
    grant: AttachmentUploadGrant,
    ciphertext: Uint8Array,
    signal?: AbortSignal,
  ) => Promise<void>;
  send: (
    conversationId: string,
    input: SendEncryptedMessageRequest,
    signal?: AbortSignal,
  ) => Promise<MessageAcknowledgement>;
  updateReceipt: (
    messageId: string,
    status: "DELIVERED" | "READ",
    signal?: AbortSignal,
  ) => Promise<MessageReceiptAcknowledgement>;
}

interface ErrorPayload {
  code?: string;
  error?: string;
  message?: string | string[];
}

interface ApiRequestOptions {
  csrf?: "required" | "omit";
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface PublicTermsDocument {
  content: string;
  contentHash: string;
  version: string;
}

export async function loadCurrentTerms(
  signal?: AbortSignal,
): Promise<PublicTermsDocument> {
  return loadTermsDocument("current", signal);
}

export async function loadTermsByVersion(
  version: string,
  signal?: AbortSignal,
): Promise<PublicTermsDocument> {
  return loadTermsDocument(encodeURIComponent(version), signal);
}

async function loadTermsDocument(
  resource: string,
  signal?: AbortSignal,
): Promise<PublicTermsDocument> {
  const response = await fetch(`${API_BASE}/legal/terms/${resource}`, {
    cache: "no-store",
    credentials: "omit",
    headers: { accept: "text/markdown, text/plain;q=0.9" },
    method: "GET",
    signal,
  });
  if (!response.ok) {
    let message = "No se pudieron cargar los términos vigentes.";
    try {
      const error = (await response.json()) as ErrorPayload;
      if (typeof error.message === "string" && error.message.trim()) {
        message = error.message;
      }
    } catch {
      // La respuesta no contenía un error JSON utilizable.
    }
    throw new ApiError(message, response.status);
  }
  const version = response.headers.get("x-sinochat-terms-version");
  const expectedHash = response.headers.get("x-sinochat-terms-sha256");
  if (
    !version ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(version) ||
    !expectedHash ||
    !/^[0-9a-f]{64}$/.test(expectedHash)
  ) {
    throw new ApiError(
      "El documento de términos no incluye una identidad verificable.",
      503,
      "TERMS_IDENTITY_UNAVAILABLE",
    );
  }

  const bytes = await response.arrayBuffer();
  const calculatedHash = hexFromBytes(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  );
  if (calculatedHash !== expectedHash) {
    throw new ApiError(
      "La verificación de integridad de los términos falló.",
      503,
      "TERMS_INTEGRITY_FAILED",
    );
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError(
      "El documento de términos no contiene texto UTF-8 válido.",
      503,
      "TERMS_ENCODING_INVALID",
    );
  }

  return { content, contentHash: expectedHash, version };
}

function hexFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  options: ApiRequestOptions = {},
): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const isMutation = !SAFE_METHODS.has(method);

  headers.set("accept", "application/json");
  if (isMutation && !headers.has("content-type")) {
    // El backend exige JSON también para POST sin cuerpo, como cerrar sesión.
    headers.set("content-type", "application/json");
  }

  if (isMutation && options.csrf !== "omit") {
    const csrfToken = readCookie(CSRF_COOKIE_NAME);
    if (!csrfToken) {
      throw new ApiError(
        "La protección de la sesión no está disponible. Vuelve a iniciar sesión.",
        403,
        "CSRF_TOKEN_MISSING",
      );
    }
    headers.set("x-csrf-token", csrfToken);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: "include",
      headers,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new ApiError(
      "No pudimos conectar con SinoChat. Revisa tu conexión.",
      0,
      "NETWORK_ERROR",
    );
  }

  if (!response.ok) {
    const payload = await readErrorPayload(response);
    const message = Array.isArray(payload?.message)
      ? payload.message[0]
      : payload?.message;
    const code = payload?.code ?? payload?.error;
    if (
      response.status === 401 &&
      code === "SESSION_INVALID" &&
      typeof window !== "undefined"
    ) {
      window.dispatchEvent(new Event(SESSION_INVALID_EVENT));
    }
    throw new ApiError(
      message || "No pudimos completar la solicitud.",
      response.status,
      code,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(
      "El servidor devolvió una respuesta inesperada.",
      response.status,
      "INVALID_RESPONSE",
    );
  }
}

export const accessActions: AccessActions = {
  async login(input) {
    await apiRequest(
      "/auth/login",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      { csrf: "omit" },
    );
  },

  async completeAdminReset(input) {
    await apiRequest(
      "/auth/complete-admin-reset",
      {
        method: "POST",
        body: JSON.stringify({
          username: input.username,
          recoveryCode: input.recoveryCode,
          newPassword: input.newPassword,
        }),
      },
      { csrf: "omit" },
    );
  },

  async validateInvitation(input) {
    await apiRequest(
      "/invitations/validate",
      {
        method: "POST",
        body: JSON.stringify({ code: input.code, role: input.role }),
      },
      { csrf: "omit" },
    );
  },

  async registerClient(input) {
    await apiRequest(
      "/auth/clients/register",
      {
        method: "POST",
        body: JSON.stringify({
          invitationCode: input.invitationCode,
          username: input.username,
          password: input.password,
          dateOfBirth: input.birthDate,
          termsAccepted: input.acceptsTerms,
          termsVersion: input.termsVersion,
          termsContentHash: input.termsContentHash,
        }),
      },
      { csrf: "omit" },
    );
  },

  async registerCashier(input) {
    const payload = await apiRequest<unknown>(
      "/auth/cashiers/register",
      {
        method: "POST",
        body: JSON.stringify({
          invitationCode: input.invitationCode,
          email: input.email,
          username: input.username,
          password: input.password,
          phone: input.phone,
          dateOfBirth: input.birthDate,
          termsAccepted: input.acceptsTerms,
          termsVersion: input.termsVersion,
          termsContentHash: input.termsContentHash,
        }),
      },
      { csrf: "omit" },
    );
    return parseCashierRegistrationResult(payload);
  },
};

export const matrixHttpTransport: E2eeApi = {
  async getStatus(signal) {
    const payload = await apiRequest<unknown>("/e2ee/status", {
      cache: "no-store",
      signal,
    });
    return parseE2eeReleaseStatus(payload);
  },

  async getCrossSigningStatus(signal) {
    return parseMatrixCrossSigningStatus(await apiRequest<unknown>(
      "/e2ee/matrix/cross-signing", { cache: "no-store", signal },
    ));
  },

  async bootstrapCrossSigning(body, signal) {
    return parseMatrixCrossSigningStatus(await apiRequest<unknown>(
      "/e2ee/matrix/cross-signing/bootstrap",
      { method: "POST", body: JSON.stringify(body), signal },
    ));
  },

  async reserveDevice(signal) {
    const payload = await apiRequest<unknown>(
      "/e2ee/matrix/devices/registration",
      { method: "POST", signal },
    );
    return parseMatrixDeviceRegistration(payload);
  },

  async completeDevice(registrationId, body, signal) {
    const payload = await apiRequest<unknown>(
      `/e2ee/matrix/devices/registration/${encodeURIComponent(registrationId)}/complete`,
      {
        body: JSON.stringify(body),
        method: "POST",
        signal,
      },
    );
    return parseMatrixDeviceCompletion(payload);
  },

  async bindSession(deviceId, bindingSecret, signal) {
    await apiRequest<unknown>(
      `/devices/${encodeURIComponent(deviceId)}/bind-session`,
      {
        body: JSON.stringify({ bindingSecret }),
        method: "POST",
        signal,
      },
    );
  },

  async uploadKeys(body, signal) {
    return apiRequest<unknown>("/e2ee/matrix/keys/upload", {
      body: JSON.stringify(body),
      method: "POST",
      signal,
    });
  },

  async queryKeys(body, signal) {
    return apiRequest<unknown>("/e2ee/matrix/keys/query", {
      body: JSON.stringify(body),
      method: "POST",
      signal,
    });
  },

  async claimKeys(requestId, body, signal) {
    return apiRequest<unknown>(
      `/e2ee/matrix/keys/claim/${encodeURIComponent(requestId)}`,
      {
        body: JSON.stringify(body),
        method: "POST",
        signal,
      },
    );
  },

  async sendToDevice(eventType, transactionId, body, signal) {
    return apiRequest<unknown>(
      `/e2ee/matrix/sendToDevice/${encodeURIComponent(eventType)}/${encodeURIComponent(transactionId)}`,
      {
        body: JSON.stringify(body),
        method: "PUT",
        signal,
      },
    );
  },

  async sync({ signal, since, timeout }) {
    const query = new URLSearchParams();
    if (since !== undefined) query.set("since", since);
    if (timeout !== undefined) query.set("timeout", String(timeout));
    const suffix = query.size === 0 ? "" : `?${query}`;
    return apiRequest<unknown>(`/e2ee/matrix/sync${suffix}`, {
      cache: "no-store",
      signal,
    });
  },
};

export const messagesApi: MessagesApi = {
  async list(conversationId, deviceId, query = {}, signal) {
    const encodedConversationId = encodeURIComponent(
      canonicalUuid(conversationId, "CONVERSATION_ID_INVALID"),
    );
    const search = new URLSearchParams({
      deviceId: canonicalUuid(deviceId, "DEVICE_ID_INVALID"),
      limit: String(boundedInteger(query.limit ?? 50, 1, 100, "MESSAGE_LIMIT_INVALID")),
    });
    if (query.afterSequence !== undefined) {
      if (!/^(?:0|[1-9]\d{0,19})$/.test(query.afterSequence)) {
        throw new ApiError(
          "El cursor local de mensajes no es válido.",
          400,
          "MESSAGE_CURSOR_INVALID",
        );
      }
      search.set("afterSequence", query.afterSequence);
    }
    const payload = await apiRequest<unknown>(
      `/conversations/${encodedConversationId}/messages?${search}`,
      { cache: "no-store", signal },
    );
    return parseEncryptedMessagePage(payload);
  },

  async requestAttachmentUpload(conversationId, input, signal) {
    const encodedConversationId = encodeURIComponent(
      canonicalUuid(conversationId, "CONVERSATION_ID_INVALID"),
    );
    const request = validateAttachmentUploadRequest(input);
    const payload = await apiRequest<unknown>(
      `/conversations/${encodedConversationId}/attachments/upload-grant`,
      {
        body: JSON.stringify(request),
        method: "POST",
        signal,
      },
    );
    return parseAttachmentUploadGrant(payload, request);
  },

  async uploadAttachment(grant, ciphertext, signal) {
    if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength < 1) {
      throw new ApiError(
        "La foto cifrada no es válida.",
        400,
        "ATTACHMENT_CIPHERTEXT_INVALID",
      );
    }
    if (!globalThis.crypto?.subtle) {
      throw new ApiError(
        "El navegador no ofrece las funciones criptográficas necesarias.",
        0,
        "WEB_CRYPTO_UNAVAILABLE",
      );
    }
    const digest = new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(ciphertext)),
    );
    const verifiedGrant = parseAttachmentUploadGrant(grant, {
      ciphertextByteSize: ciphertext.byteLength,
      ciphertextSha256: hexFromBytes(digest),
    });
    if (Date.parse(verifiedGrant.grantExpiresAt) <= Date.now()) {
      throw new ApiError(
        "El permiso para subir la foto venció.",
        409,
        "ATTACHMENT_UPLOAD_GRANT_EXPIRED",
      );
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(verifiedGrant.uploadHeaders)) {
      // El navegador calcula Content-Length a partir del ArrayBuffer. Es un
      // encabezado prohibido para JavaScript, aunque siga firmado por S3.
      if (name !== "content-length") headers.set(name, String(value));
    }
    let response: Response;
    try {
      response = await fetch(verifiedGrant.uploadUrl, {
        body: Uint8Array.from(ciphertext).buffer,
        cache: "no-store",
        credentials: "omit",
        headers,
        method: "PUT",
        mode: "cors",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      throw new ApiError(
        "No pudimos subir la foto cifrada.",
        0,
        "ATTACHMENT_UPLOAD_NETWORK_ERROR",
      );
    }
    if (!response.ok) {
      throw new ApiError(
        "El almacenamiento rechazó la foto cifrada.",
        response.status,
        "ATTACHMENT_UPLOAD_REJECTED",
      );
    }
  },

  async send(conversationId, input, signal) {
    const encodedConversationId = encodeURIComponent(
      canonicalUuid(conversationId, "CONVERSATION_ID_INVALID"),
    );
    const request = validateSendEncryptedMessageRequest(input);
    const payload = await apiRequest<unknown>(
      `/conversations/${encodedConversationId}/messages`,
      {
        body: JSON.stringify(request),
        method: "POST",
        signal,
      },
    );
    return parseMessageAcknowledgement(payload, request);
  },

  async updateReceipt(messageId, status, signal) {
    const canonicalMessageId = canonicalUuid(messageId, "MESSAGE_ID_INVALID");
    if (status !== "DELIVERED" && status !== "READ") {
      throw new ApiError(
        "El estado de lectura no es válido.",
        400,
        "MESSAGE_RECEIPT_STATUS_INVALID",
      );
    }
    const payload = await apiRequest<unknown>(
      `/messages/${encodeURIComponent(canonicalMessageId)}/receipt`,
      {
        body: JSON.stringify({ status }),
        method: "PATCH",
        signal,
      },
    );
    return parseMessageReceiptAcknowledgement(payload, canonicalMessageId);
  },
};

export const applicationApi: ApplicationApi = {
  access: accessActions,
  e2ee: matrixHttpTransport,
  messages: messagesApi,
  notifications: {
    async load(limit = 30, signal) {
      const safeLimit = Math.min(100, positiveInteger(limit, 30));
      const query = new URLSearchParams({ limit: String(safeLimit) });
      const payload = await apiRequest<unknown>(`/notifications?${query}`, {
        cache: "no-store",
        signal,
      });
      return parseNotifications(payload);
    },

    async markAllRead(signal) {
      await apiRequest<unknown>("/notifications/read-all", {
        method: "PATCH",
        signal,
      });
    },

    async markRead(notificationId, signal) {
      await apiRequest<void>(
        `/notifications/${encodeURIComponent(notificationId)}/read`,
        { method: "PATCH", signal },
      );
    },
  },
  adminMfa: {
    isSupported: () => browserSupportsWebAuthn(),

    async enroll() {
      const envelope = parseAdminMfaOptions(
        await apiRequest<unknown>("/auth/admin/mfa/registration/options", {
          method: "POST",
        }),
        "registration",
      );
      let response;
      try {
        response = await startRegistration({
          optionsJSON:
            envelope.options as unknown as PublicKeyCredentialCreationOptionsJSON,
        });
      } catch (error) {
        throw webAuthnBrowserError(error);
      }
      const result = await apiRequest<unknown>(
        "/auth/admin/mfa/registration/verify",
        {
          body: JSON.stringify({
            challengeId: envelope.challengeId,
            response,
          }),
          method: "POST",
        },
      );
      return parseAdminMfaEnrollment(result);
    },

    async authenticate() {
      const envelope = parseAdminMfaOptions(
        await apiRequest<unknown>("/auth/admin/mfa/authentication/options", {
          method: "POST",
        }),
        "authentication",
      );
      let response;
      try {
        response = await startAuthentication({
          optionsJSON:
            envelope.options as unknown as PublicKeyCredentialRequestOptionsJSON,
        });
      } catch (error) {
        throw webAuthnBrowserError(error);
      }
      const result = await apiRequest<unknown>(
        "/auth/admin/mfa/authentication/verify",
        {
          body: JSON.stringify({
            challengeId: envelope.challengeId,
            response,
          }),
          method: "POST",
        },
      );
      if (!isRecord(result) || result.verified !== true) {
        throw invalidResponseError("verificación administrativa");
      }
    },

    async recover(recoveryCode) {
      const result = await apiRequest<unknown>("/auth/admin/mfa/recover", {
        body: JSON.stringify({
          recoveryCode: recoveryCode.trim().toUpperCase(),
        }),
        method: "POST",
      });
      if (!isRecord(result) || result.recovered !== true) {
        throw invalidResponseError("recuperación administrativa");
      }
    },

    async listPasskeys(signal) {
      const payload = await apiRequest<unknown>("/auth/admin/mfa/passkeys", {
        signal,
      });
      return parseAdminPasskeys(payload);
    },

    async revokePasskey(credentialId, signal) {
      if (!isUuid(credentialId)) {
        throw new ApiError(
          "La passkey seleccionada no es válida.",
          400,
          "ADMIN_PASSKEY_INVALID",
        );
      }
      const payload = await apiRequest<unknown>(
        `/auth/admin/mfa/passkeys/${encodeURIComponent(credentialId)}`,
        { body: "{}", method: "DELETE", signal },
      );
      if (
        !isRecord(payload) ||
        Object.keys(payload).length !== 1 ||
        payload.revoked !== true
      ) {
        throw invalidResponseError("revocación de passkey");
      }
      return { revoked: true };
    },
  },
  session: {
    async getCurrentUser(signal) {
      const payload = await apiRequest<unknown>("/auth/me", { signal });
      return parseSessionUser(payload);
    },

    async listAdminSessions(signal) {
      const payload = await apiRequest<unknown>("/auth/sessions", { signal });
      return parseAdminSessions(payload);
    },

    async logout() {
      await apiRequest<void>("/auth/logout", {
        body: "{}",
        method: "POST",
      });
    },

    async revokeAdminSession(sessionId, signal) {
      if (!isUuid(sessionId)) {
        throw new ApiError(
          "La sesión seleccionada no es válida.",
          400,
          "ADMIN_SESSION_INVALID",
        );
      }
      const payload = await apiRequest<unknown>(
        `/auth/sessions/${encodeURIComponent(sessionId)}`,
        { body: "{}", method: "DELETE", signal },
      );
      return parseAdminSessionRevocation(payload);
    },

    async revokeOtherAdminSessions(signal) {
      const payload = await apiRequest<unknown>(
        "/auth/sessions/revoke-others",
        { body: "{}", method: "POST", signal },
      );
      if (
        !isRecord(payload) ||
        !Number.isSafeInteger(payload.revokedCount) ||
        (payload.revokedCount as number) < 0
      ) {
        throw invalidResponseError("revocación de sesiones");
      }
      return { revokedCount: payload.revokedCount as number };
    },
  },
  panels: {
    client: {
      async load(signal) {
        const page = await loadConversationPage(
          { limit: 1, page: 1 },
          signal,
        );
        if (
          page.page !== 1 ||
          page.limit !== 1 ||
          page.hasMore ||
          page.items.length > 1
        ) {
          throw invalidResponseError("conversaciones");
        }
        return { conversation: page.items[0] ?? null };
      },
    },
    admin: {
      load: loadAdminPanel,

      async openReport(reportId) {
        await apiRequest(
          `/admin/reports/${encodeURIComponent(reportId)}/review`,
          { method: "PATCH" },
        );
      },

      async accessReportEvidence(reportId, input) {
        if (!input.currentPassword) {
          throw new ApiError(
            "Ingresa tu contraseña actual.",
            400,
            "CURRENT_PASSWORD_REQUIRED",
          );
        }
        const payload = await apiRequest<unknown>(
          `/admin/reports/${encodeURIComponent(reportId)}/evidence-access`,
          {
            body: JSON.stringify({
              currentPassword: input.currentPassword,
              reason: validateReportEvidenceReason(input.reason),
            }),
            method: "POST",
          },
        );
        return parseAdminReportEvidencePackage(payload, reportId);
      },

      async closeReport(reportId, input) {
        await apiRequest(
          `/admin/reports/${encodeURIComponent(reportId)}/close`,
          {
            body: JSON.stringify({
              outcome: validateReportOutcome(input.outcome),
              resolutionSummary: validateReportResolutionSummary(
                input.resolutionSummary,
              ),
            }),
            method: "PATCH",
          },
        );
      },

      async createCashierInvitation(input) {
        const payload = await apiRequest<unknown>(
          "/admin/cashier-invitations",
          {
            body: JSON.stringify({
              expiresInHours: input.expiresInHours,
            }),
            method: "POST",
          },
        );
        return parseAdminCashierOnboarding(payload);
      },

      async revokeCashierInvitation(invitationId) {
        const payload = await apiRequest<unknown>(
          `/admin/cashier-invitations/${encodeURIComponent(invitationId)}/revoke`,
          {
            body: JSON.stringify({}),
            method: "PATCH",
          },
        );
        parseAdminCashierInvitationRevocation(payload, invitationId);
      },

      async deleteUser(userId) {
        await apiRequest(
          `/admin/users/${encodeURIComponent(userId)}`,
          {
            body: JSON.stringify({}),
            method: "DELETE",
          },
        );
      },

      async reassignClient(assignmentId) {
        await apiRequest(
          `/admin/assignments/${encodeURIComponent(assignmentId)}/reassign`,
          {
            body: JSON.stringify({}),
            method: "POST",
          },
        );
      },

      async subscriptionAction(cashierId, action) {
        const encodedId = encodeURIComponent(cashierId);
        await apiRequest(
          `/admin/cashiers/${encodedId}/subscription/${action}`,
          {
            body: JSON.stringify({}),
            method: "PATCH",
          },
        );
      },

      async userAction(userId, action) {
        const encodedId = encodeURIComponent(userId);
        const path =
          action === "verify"
            ? `/admin/cashiers/${encodedId}/approve`
            : action === "suspend"
              ? `/admin/users/${encodedId}/suspend`
              : `/admin/users/${encodedId}/reactivate`;

        await apiRequest(path, {
          body: JSON.stringify({}),
          method: "PATCH",
        });
      },

      async resetPassword(userId, input) {
        void input;
        await apiRequest(
          `/admin/users/${encodeURIComponent(userId)}/password`,
          {
            body: JSON.stringify({}),
            method: "PATCH",
          },
        );
      },

      async updateUser(userId, input) {
        await apiRequest(
          `/admin/users/${encodeURIComponent(userId)}`,
          {
            body: JSON.stringify({
              ...(input.username !== undefined
                ? { username: input.username.trim() }
                : {}),
              ...(input.email !== undefined
                ? { email: input.email.trim() }
                : {}),
              ...(input.phone !== undefined
                ? { phone: input.phone.trim() }
                : {}),
            }),
            method: "PATCH",
          },
        );
      },
    },
    cashier: {
      async load(query, signal) {
        const page = await loadConversationPage(query, signal);
        return {
          conversations: page.items,
          conversationHasMore: page.hasMore,
          conversationLimit: page.limit,
          conversationPage: page.page,
        };
      },

      async blockClient(clientId, reason) {
        await apiRequest<void>(
          `/moderation/cashier/clients/${encodeURIComponent(clientId)}/block`,
          {
            body: JSON.stringify({
              reason: validateModerationReason(reason),
            }),
            method: "POST",
          },
        );
      },

      async getInvitation(signal) {
        const payload = await apiRequest<unknown>("/cashier/invitation/reveal", {
          method: "POST",
          signal,
        });
        return parseCashierInvitation(payload);
      },

      async rotateInvitation() {
        const payload = await apiRequest<unknown>("/cashier/invitation/rotate", {
          method: "POST",
        });
        return parseCashierInvitation(payload);
      },

      async rotateRecoveryCodes(currentPassword) {
        if (currentPassword.length < 10 || currentPassword.length > 128) {
          throw new ApiError(
            "Ingresa tu contraseña actual completa.",
            400,
            "INVALID_CURRENT_PASSWORD",
          );
        }
        const payload = await apiRequest<unknown>(
          "/auth/cashiers/recovery-codes/rotate",
          {
            body: JSON.stringify({ currentPassword }),
            method: "POST",
          },
        );
        return parseCashierRegistrationResult(payload);
      },
    },
  },
};

async function loadConversationPage(
  query: CashierPanelQuery = {},
  signal?: AbortSignal,
): Promise<ConversationPage> {
  const page = positiveInteger(query.page, 1);
  const limit = Math.min(100, positiveInteger(query.limit, 50));
  const search = new URLSearchParams({
    limit: String(limit),
    page: String(page),
  });
  const payload = await apiRequest<unknown>(`/conversations?${search}`, {
    cache: "no-store",
    signal,
  });
  return parseConversationPage(payload);
}

async function loadAdminPanel(
  query: AdminPanelQuery = {},
  signal?: AbortSignal,
): Promise<AdminPanelData> {
  const assignmentPage = positiveInteger(query.assignmentPage, 1);
  const assignmentPageSize = Math.min(
    100,
    positiveInteger(query.assignmentPageSize, 20),
  );
  const cashierInvitationPage = positiveInteger(
    query.cashierInvitationPage,
    1,
  );
  const cashierInvitationPageSize = Math.min(
    100,
    positiveInteger(query.cashierInvitationPageSize, 20),
  );
  const cashierInvitationsFilter =
    query.cashierInvitationStatus ?? "ALL";
  const userPage = positiveInteger(query.userPage, 1);
  const userPageSize = Math.min(
    100,
    positiveInteger(query.userPageSize, 20),
  );
  const reportPage = positiveInteger(query.reportPage, 1);
  const reportPageSize = Math.min(
    100,
    positiveInteger(query.reportPageSize, 20),
  );
  const subscriptionPage = positiveInteger(query.subscriptionPage, 1);
  const subscriptionPageSize = Math.min(
    100,
    positiveInteger(query.subscriptionPageSize, 20),
  );
  const assignmentQuery = new URLSearchParams({
    page: String(assignmentPage),
    pageSize: String(assignmentPageSize),
  });
  const userQuery = new URLSearchParams({
    page: String(userPage),
    pageSize: String(userPageSize),
  });
  const reportQuery = new URLSearchParams({
    page: String(reportPage),
    pageSize: String(reportPageSize),
  });
  const cashierInvitationQuery = new URLSearchParams({
    page: String(cashierInvitationPage),
    pageSize: String(cashierInvitationPageSize),
  });
  const subscriptionQuery = new URLSearchParams({
    page: String(subscriptionPage),
    pageSize: String(subscriptionPageSize),
  });
  if (cashierInvitationsFilter !== "ALL") {
    cashierInvitationQuery.set("status", cashierInvitationsFilter);
  }
  if (query.reportStatus) {
    reportQuery.set("status", query.reportStatus);
  }

  const [
    usersResult,
    assignmentsResult,
    subscriptionsResult,
    reportsResult,
    cashierInvitationsResult,
  ] = await Promise.allSettled([
    apiRequest<unknown>(`/admin/users?${userQuery}`, { signal }),
    apiRequest<unknown>(`/admin/assignments?${assignmentQuery}`, { signal }),
    apiRequest<unknown>(`/admin/subscriptions?${subscriptionQuery}`, {
      signal,
    }),
    apiRequest<unknown>(`/admin/reports?${reportQuery}`, { signal }),
    apiRequest<unknown>(
      `/admin/cashier-invitations?${cashierInvitationQuery}`,
      { signal },
    ),
  ]);
  const loadIssues: string[] = [];
  const parsedUsers = parseSettledAdminSection(
    usersResult,
    parseAdminUsers,
    {
      assignments: [],
      overview: { inactiveSubscriptions: 0, pendingUsers: 0 },
      pagination: emptyPagination(userPage, userPageSize),
      subscriptions: [],
      users: [],
    },
    "usuarios",
    loadIssues,
  );
  const parsedAssignments = parseSettledAdminSection(
    assignmentsResult,
    parseAdminAssignments,
    {
      items: [],
      pagination: emptyPagination(assignmentPage, assignmentPageSize),
    },
    "asignaciones",
    loadIssues,
  );
  const parsedSubscriptions = parseSettledAdminSection(
    subscriptionsResult,
    parseAdminSubscriptions,
    {
      activeTotal: 0,
      items: [],
      pagination: emptyPagination(subscriptionPage, subscriptionPageSize),
    },
    "suscripciones",
    loadIssues,
  );
  const parsedReports = parseSettledAdminSection(
    reportsResult,
    parseAdminReports,
    {
      pagination: emptyPagination(reportPage, reportPageSize),
      pendingTotal: 0,
      reports: [],
    },
    "reportes",
    loadIssues,
  );
  const parsedCashierInvitations = parseSettledAdminSection(
    cashierInvitationsResult,
    parseAdminCashierInvitations,
    {
      items: [],
      pagination: emptyPagination(
        cashierInvitationPage,
        cashierInvitationPageSize,
      ),
    },
    "invitaciones",
    loadIssues,
  );

  return {
    assignments: parsedAssignments.items,
    assignmentsPagination: parsedAssignments.pagination,
    cashierInvitations: parsedCashierInvitations.items,
    cashierInvitationsFilter,
    cashierInvitationsPagination: parsedCashierInvitations.pagination,
    loadIssues,
    overview: parsedUsers.overview,
    reports: parsedReports.reports,
    reportsPendingTotal: parsedReports.pendingTotal,
    reportsPagination: parsedReports.pagination,
    stats: [
      {
        id: "registered-users",
        label: "Usuarios registrados",
        value: parsedUsers.pagination.total,
        detail: `${parsedUsers.users.length} en esta página`,
      },
      {
        id: "active-assignments",
        label: "Asignaciones activas",
        value: parsedAssignments.pagination.total,
        detail: "Total global",
      },
      {
        id: "active-subscriptions",
        label: "Suscripciones activas",
        value: parsedSubscriptions.activeTotal,
        detail: "Total global",
        tone: "gold",
      },
      {
        id: "pending-reports",
        label: "Reportes pendientes",
        value: parsedReports.pendingTotal,
        detail: `${parsedReports.pagination.total} registrados`,
        tone: parsedReports.pendingTotal > 0 ? "danger" : "default",
      },
    ],
    subscriptions: parsedSubscriptions.items,
    subscriptionsPagination: parsedSubscriptions.pagination,
    users: parsedUsers.users,
    usersPagination: parsedUsers.pagination,
  };
}

function emptyPagination(page: number, pageSize: number): AdminPagination {
  return { page, pageSize, total: 0, totalPages: 0 };
}

function parseSettledAdminSection<T>(
  result: PromiseSettledResult<unknown>,
  parser: (value: unknown) => T,
  fallback: T,
  label: string,
  issues: string[],
): T {
  if (result.status === "rejected") {
    if (isAbortFailure(result.reason)) throw result.reason;
    issues.push(label);
    return fallback;
  }

  try {
    return parser(result.value);
  } catch (error) {
    if (isAbortFailure(error)) throw error;
    issues.push(label);
    return fallback;
  }
}

function isAbortFailure(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

interface ParsedAdminCashierInvitations {
  items: AdminCashierInvitation[];
  pagination: AdminPagination;
}

interface ParsedAdminAssignments {
  items: AdminAssignment[];
  pagination: AdminPagination;
}

interface ParsedAdminSubscriptions {
  activeTotal: number;
  items: AdminSubscription[];
  pagination: AdminPagination;
}

interface ParsedAdminUsers {
  assignments: AdminAssignment[];
  overview: AdminOverviewCounts;
  pagination: AdminPagination;
  subscriptions: AdminSubscription[];
  users: AdminUser[];
}

interface ParsedAdminReports {
  pagination: AdminPagination;
  pendingTotal: number;
  reports: AdminReport[];
}

function parseAdminCashierInvitations(
  payload: unknown,
): ParsedAdminCashierInvitations {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw invalidResponseError("invitaciones de cajeros");
  }

  return {
    items: payload.items.map(parseAdminCashierInvitation),
    pagination: parsePagination(payload.pagination),
  };
}

function parseAdminCashierInvitation(item: unknown): AdminCashierInvitation {
  if (!isRecord(item)) {
    throw invalidResponseError("invitaciones de cajeros");
  }
  const status = parseAdminCashierInvitationStatus(item.status);
  const createdByAdmin = requiredRecord(
    item,
    "createdByAdmin",
    "invitaciones de cajeros",
  );
  const redeemedByCashier = optionalRecord(
    item.redeemedByCashier,
    "invitaciones de cajeros",
  );
  const canRevoke = requiredBoolean(
    item,
    "canRevoke",
    "invitaciones de cajeros",
  );
  if (canRevoke !== (status === "active" || status === "expired")) {
    throw invalidResponseError("invitaciones de cajeros");
  }

  return {
    id: requiredString(item, "id", "invitaciones de cajeros"),
    status,
    canRevoke,
    createdAt: requiredString(item, "createdAt", "invitaciones de cajeros"),
    expiresAt: requiredString(item, "expiresAt", "invitaciones de cajeros"),
    redeemedAt: optionalString(item.redeemedAt, "invitaciones de cajeros"),
    revokedAt: optionalString(item.revokedAt, "invitaciones de cajeros"),
    createdByAdmin: {
      id: requiredString(createdByAdmin, "id", "invitaciones de cajeros"),
      username: requiredString(
        createdByAdmin,
        "username",
        "invitaciones de cajeros",
      ),
    },
    redeemedByCashier: redeemedByCashier
      ? {
          id: requiredString(
            redeemedByCashier,
            "id",
            "invitaciones de cajeros",
          ),
          username: requiredString(
            redeemedByCashier,
            "username",
            "invitaciones de cajeros",
          ),
        }
      : undefined,
  };
}

function parseAdminUsers(payload: unknown): ParsedAdminUsers {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw invalidResponseError("usuarios administrativos");
  }

  const pagination = parsePagination(payload.pagination);
  const overviewRecord = requiredRecord(
    payload,
    "overview",
    "usuarios administrativos",
  );
  const overview: AdminOverviewCounts = {
    inactiveSubscriptions: requiredNonNegativeInteger(
      overviewRecord.inactiveSubscriptions,
      "usuarios administrativos",
    ),
    pendingUsers: requiredNonNegativeInteger(
      overviewRecord.pendingUsers,
      "usuarios administrativos",
    ),
  };
  const assignments: AdminAssignment[] = [];
  const subscriptions: AdminSubscription[] = [];
  const users = payload.items.map((item) => {
    if (!isRecord(item)) {
      throw invalidResponseError("usuarios administrativos");
    }

    const id = requiredString(item, "id", "usuarios administrativos");
    const username = requiredString(
      item,
      "username",
      "usuarios administrativos",
    );
    const role = parseAdminUserRole(item.role);
    const status = parseAdminUserStatus(item.status);
    const createdAt = requiredString(
      item,
      "createdAt",
      "usuarios administrativos",
    );
    const clientProfile = optionalRecord(
      item.clientProfile,
      "usuarios administrativos",
    );
    const cashierProfile = optionalRecord(
      item.cashierProfile,
      "usuarios administrativos",
    );
    let assignedCashierName: string | undefined;
    let distinctCashierBlocks: number | undefined;
    let activeClientCount: number | undefined;
    let cashierApprovalStatus: AdminUser["cashierApprovalStatus"];
    let email: string | undefined;
    let phone: string | undefined;

    if (clientProfile) {
      const profileAssignments = requiredArray(
        clientProfile,
        "assignments",
        "usuarios administrativos",
      );
      if (profileAssignments.length > 0) {
        const assignment = parseAdminAssignment(
          profileAssignments[0],
          id,
          username,
        );
        assignments.push(assignment);
        assignedCashierName = assignment.cashierUsername;
      }

      const counts = optionalRecord(
        clientProfile._count,
        "usuarios administrativos",
      );
      if (counts) {
        distinctCashierBlocks = optionalNonNegativeInteger(
          counts.blocks,
          "usuarios administrativos",
        );
      }
    }

    if (cashierProfile) {
      email = optionalString(
        cashierProfile.email,
        "usuarios administrativos",
      );
      phone = optionalString(
        cashierProfile.phoneE164,
        "usuarios administrativos",
      );
      cashierApprovalStatus = parseCashierApprovalStatus(
        cashierProfile.approvalStatus,
      );

      const counts = optionalRecord(
        cashierProfile._count,
        "usuarios administrativos",
      );
      if (counts) {
        activeClientCount = optionalNonNegativeInteger(
          counts.assignments,
          "usuarios administrativos",
        );
      }

      const profileSubscriptions = requiredArray(
        cashierProfile,
        "subscriptions",
        "usuarios administrativos",
      );
      subscriptions.push(
        parseAdminSubscription(
          profileSubscriptions[0],
          id,
          username,
        ),
      );
    } else if (role === "cashier") {
      subscriptions.push({
        cashierId: id,
        cashierUsername: username,
        status: "none",
        effectiveStatus: "none",
      });
    }

    return {
      id,
      username,
      role,
      status,
      email,
      phone,
      assignedCashierName,
      distinctCashierBlocks,
      activeClientCount,
      cashierApprovalStatus,
      createdAt,
    };
  });

  return { assignments, overview, pagination, subscriptions, users };
}

function parseAdminAssignments(payload: unknown): ParsedAdminAssignments {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw invalidResponseError("asignaciones administrativas");
  }

  return {
    items: payload.items.map((value) => {
      if (!isRecord(value)) {
        throw invalidResponseError("asignaciones administrativas");
      }
      const client = requiredRecord(
        value,
        "client",
        "asignaciones administrativas",
      );
      const clientUser = requiredRecord(
        client,
        "user",
        "asignaciones administrativas",
      );
      return parseAdminAssignment(
        value,
        requiredString(
          clientUser,
          "id",
          "asignaciones administrativas",
        ),
        requiredString(
          clientUser,
          "username",
          "asignaciones administrativas",
        ),
      );
    }),
    pagination: parsePagination(payload.pagination),
  };
}

function parseAdminSubscriptions(
  payload: unknown,
): ParsedAdminSubscriptions {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw invalidResponseError("suscripciones administrativas");
  }

  return {
    activeTotal: requiredNonNegativeInteger(
      payload.activeTotal,
      "suscripciones administrativas",
    ),
    items: payload.items.map((value) => {
      if (!isRecord(value)) {
        throw invalidResponseError("suscripciones administrativas");
      }
      const subscription = value.subscription;
      if (subscription !== null && subscription !== undefined) {
        if (!isRecord(subscription)) {
          throw invalidResponseError("suscripciones administrativas");
        }
      }
      return parseAdminSubscription(
        subscription ?? undefined,
        requiredString(
          value,
          "cashierId",
          "suscripciones administrativas",
        ),
        requiredString(
          value,
          "cashierUsername",
          "suscripciones administrativas",
        ),
      );
    }),
    pagination: parsePagination(payload.pagination),
  };
}

function parseAdminAssignment(
  value: unknown,
  clientId: string,
  clientUsername: string,
): AdminAssignment {
  if (!isRecord(value)) {
    throw invalidResponseError("asignaciones administrativas");
  }

  const cashier = requiredRecord(
    value,
    "cashier",
    "asignaciones administrativas",
  );
  const cashierUser = requiredRecord(
    cashier,
    "user",
    "asignaciones administrativas",
  );

  return {
    id: requiredString(value, "id", "asignaciones administrativas"),
    clientId,
    clientUsername,
    cashierId: requiredString(
      cashierUser,
      "id",
      "asignaciones administrativas",
    ),
    cashierUsername: requiredString(
      cashierUser,
      "username",
      "asignaciones administrativas",
    ),
    assignedAt: requiredString(
      value,
      "startedAt",
      "asignaciones administrativas",
    ),
    source: parseAssignmentSource(value.startReason),
  };
}

function parseAssignmentSource(
  value: unknown,
): AdminAssignment["source"] {
  if (value === "INVITATION") return "invitation";
  if (value === "ADMINISTRATIVE") return "admin";
  if (
    value === "CLIENT_BLOCKED_CASHIER" ||
    value === "CLIENT_REPORTED_CASHIER" ||
    value === "CASHIER_BLOCKED_CLIENT" ||
    value === "CASHIER_UNAVAILABLE"
  ) {
    return "reassignment";
  }
  throw invalidResponseError("origen de asignación");
}

function parseAdminSubscription(
  value: unknown,
  cashierId: string,
  cashierUsername: string,
): AdminSubscription {
  if (value === undefined) {
    return {
      cashierId,
      cashierUsername,
      status: "none",
      effectiveStatus: "none",
    };
  }
  if (!isRecord(value)) {
    throw invalidResponseError("suscripciones administrativas");
  }

  return {
    id: requiredString(value, "id", "suscripciones administrativas"),
    cashierId,
    cashierUsername,
    status: parseSubscriptionStatus(value.status),
    effectiveStatus: parseSubscriptionEffectiveStatus(
      value.effectiveStatus,
    ),
    startedAt: optionalString(
      value.startsAt,
      "suscripciones administrativas",
    ),
    validUntil: optionalString(
      value.endsAt,
      "suscripciones administrativas",
    ),
  };
}

function parseAdminReports(payload: unknown): ParsedAdminReports {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw invalidResponseError("reportes administrativos");
  }

  const reports = payload.items.map((item): AdminReport => {
    if (!isRecord(item)) {
      throw invalidResponseError("reportes administrativos");
    }

    const block = requiredRecord(
      item,
      "block",
      "reportes administrativos",
    );
    const client = requiredRecord(
      block,
      "client",
      "reportes administrativos",
    );
    const clientUser = requiredRecord(
      client,
      "user",
      "reportes administrativos",
    );
    const cashier = requiredRecord(
      block,
      "cashier",
      "reportes administrativos",
    );
    const cashierUser = requiredRecord(
      cashier,
      "user",
      "reportes administrativos",
    );
    const closureJob = parseAdminReportClosureDiagnostic(item.closureJob);

    return {
      id: requiredString(item, "id", "reportes administrativos"),
      reporterUsername: requiredString(
        clientUser,
        "username",
        "reportes administrativos",
      ),
      reportedUsername: requiredString(
        cashierUser,
        "username",
        "reportes administrativos",
      ),
      reason: requiredString(
        block,
        "reason",
        "reportes administrativos",
      ),
      createdAt: requiredString(
        item,
        "createdAt",
        "reportes administrativos",
      ),
      status: parseReportStatus(item.status),
      outcome: parseOptionalReportOutcome(item.outcome),
      resolutionSummary: optionalString(
        item.resolutionSummary,
        "reportes administrativos",
      ),
      reviewStartedAt: optionalString(
        item.reviewStartedAt,
        "reportes administrativos",
      ),
      closeRequestedAt: optionalString(
        item.closeRequestedAt,
        "reportes administrativos",
      ),
      closedAt: optionalString(
        item.closedAt,
        "reportes administrativos",
      ),
      evidencePurgedAt: optionalString(
        item.evidencePurgedAt,
        "reportes administrativos",
      ),
      subjectNotifiedAt: optionalString(
        item.subjectNotifiedAt,
        "reportes administrativos",
      ),
      closureJob,
    };
  });

  return {
    pagination: parsePagination(payload.pagination),
    pendingTotal: requiredNonNegativeInteger(
      payload.pendingTotal,
      "reportes administrativos",
    ),
    reports,
  };
}

function parseAdminReportClosureDiagnostic(
  value: unknown,
): AdminReport["closureJob"] {
  const job = optionalRecord(value, "cierre de reporte");
  if (!job) return undefined;

  const lastErrorCode = optionalString(
    job.lastErrorCode,
    "cierre de reporte",
  );
  if (
    lastErrorCode !== undefined &&
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(lastErrorCode)
  ) {
    throw invalidResponseError("cierre de reporte");
  }

  return {
    attempts: requiredNonNegativeInteger(job.attempts, "cierre de reporte"),
    nextAttemptAt: requiredString(
      job,
      "nextAttemptAt",
      "cierre de reporte",
    ),
    lastAttemptAt: optionalString(job.lastAttemptAt, "cierre de reporte"),
    lastErrorCode,
  };
}

function parseAdminReportEvidencePackage(
  payload: unknown,
  expectedReportId: string,
): AdminReportEvidencePackage {
  if (!isRecord(payload)) {
    throw invalidResponseError("acceso a evidencia");
  }

  const reportId = requiredString(payload, "reportId", "acceso a evidencia");
  if (reportId !== expectedReportId) {
    throw invalidResponseError("acceso a evidencia");
  }

  const rawDownloadUrl = requiredString(
    payload,
    "downloadUrl",
    "acceso a evidencia",
  );
  let downloadUrl: string;
  try {
    const parsedUrl = new URL(rawDownloadUrl, window.location.origin);
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
    downloadUrl = parsedUrl.toString();
  } catch {
    throw invalidResponseError("acceso a evidencia");
  }

  const downloadExpiresInSeconds = requiredNonNegativeInteger(
    payload.downloadExpiresInSeconds,
    "acceso a evidencia",
  );
  if (downloadExpiresInSeconds < 1) {
    throw invalidResponseError("acceso a evidencia");
  }

  const rawByteSize = payload.ciphertextByteSize;
  const ciphertextByteSize =
    typeof rawByteSize === "string"
      ? rawByteSize
      : typeof rawByteSize === "number" &&
          Number.isSafeInteger(rawByteSize) &&
          rawByteSize >= 0
        ? String(rawByteSize)
        : undefined;
  if (!ciphertextByteSize || !/^\d+$/.test(ciphertextByteSize)) {
    throw invalidResponseError("acceso a evidencia");
  }

  const investigationKey = requiredRecord(
    payload,
    "investigationKey",
    "acceso a evidencia",
  );
  const manifestVersion = requiredNonNegativeInteger(
    payload.manifestVersion,
    "acceso a evidencia",
  );
  const keyVersion = requiredNonNegativeInteger(
    investigationKey.version,
    "acceso a evidencia",
  );
  if (manifestVersion < 1 || keyVersion < 1) {
    throw invalidResponseError("acceso a evidencia");
  }

  return {
    reportId,
    downloadUrl,
    downloadExpiresInSeconds,
    ciphertextByteSize,
    ciphertextSha256: requiredNonEmptyString(
      payload,
      "ciphertextSha256",
      "acceso a evidencia",
    ),
    cipherSuite: requiredNonEmptyString(
      payload,
      "cipherSuite",
      "acceso a evidencia",
    ),
    manifestVersion,
    investigationKey: {
      version: keyVersion,
      algorithm: requiredNonEmptyString(
        investigationKey,
        "algorithm",
        "acceso a evidencia",
      ),
      fingerprint: requiredNonEmptyString(
        investigationKey,
        "fingerprint",
        "acceso a evidencia",
      ),
    },
    privateKeyLocation: optionalString(
      payload.privateKeyLocation,
      "acceso a evidencia",
    ),
  };
}

function parsePagination(value: unknown): AdminPagination {
  if (!isRecord(value)) {
    throw invalidResponseError("paginación");
  }

  const page = requiredNonNegativeInteger(value.page, "paginación");
  const pageSize = requiredNonNegativeInteger(value.pageSize, "paginación");
  const total = requiredNonNegativeInteger(value.total, "paginación");
  const totalPages = requiredNonNegativeInteger(
    value.totalPages,
    "paginación",
  );
  if (page < 1 || pageSize < 1) {
    throw invalidResponseError("paginación");
  }

  return { page, pageSize, total, totalPages };
}

function parseAdminUserRole(value: unknown): AdminUser["role"] {
  if (value === "CLIENT") return "client";
  if (value === "CASHIER") return "cashier";
  if (value === "ADMIN") return "admin";
  throw invalidResponseError("rol administrativo");
}

function parseAdminUserStatus(value: unknown): AdminUser["status"] {
  if (value === "ACTIVE") return "active";
  if (value === "PENDING") return "pending";
  if (value === "SUSPENDED") return "suspended";
  if (value === "DELETED") return "deleted";
  throw invalidResponseError("estado de usuario");
}

function parseCashierApprovalStatus(
  value: unknown,
): AdminUser["cashierApprovalStatus"] {
  if (value === "PENDING") return "pending";
  if (value === "APPROVED") return "approved";
  if (value === "REJECTED") return "rejected";
  if (value === "REVOKED") return "revoked";
  throw invalidResponseError("aprobación de cajero");
}

function parseSubscriptionStatus(
  value: unknown,
): AdminSubscription["status"] {
  if (value === "ACTIVE") return "active";
  if (value === "INACTIVE") return "inactive";
  if (value === "EXPIRED") return "expired";
  if (value === "CANCELLED") return "cancelled";
  throw invalidResponseError("estado de suscripción");
}

function parseSubscriptionEffectiveStatus(
  value: unknown,
): AdminSubscription["effectiveStatus"] {
  if (value === "ACTIVE") return "active";
  if (value === "SCHEDULED") return "scheduled";
  if (value === "EXPIRED_PENDING") return "expired_pending";
  if (value === "INACTIVE") return "inactive";
  if (value === "EXPIRED") return "expired";
  if (value === "CANCELLED") return "cancelled";
  throw invalidResponseError("estado efectivo de suscripción");
}

function parseAdminCashierInvitationStatus(
  value: unknown,
): AdminCashierInvitation["status"] {
  if (value === "ACTIVE") return "active";
  if (value === "EXPIRED") return "expired";
  if (value === "REDEEMED") return "redeemed";
  if (value === "REVOKED") return "revoked";
  throw invalidResponseError("estado de invitación de cajero");
}

function parseReportStatus(value: unknown): AdminReport["status"] {
  if (value === "OPEN") return "open";
  if (value === "IN_REVIEW") return "under_review";
  if (value === "CLOSING") return "closing";
  if (value === "CLOSED") return "closed";
  throw invalidResponseError("estado de reporte");
}

function parseOptionalReportOutcome(
  value: unknown,
): AdminReport["outcome"] {
  if (value === null || value === undefined) return undefined;
  if (
    value === "NO_ACTION" ||
    value === "WARNING" ||
    value === "CASHIER_SUSPENDED" ||
    value === "CASHIER_DELETED" ||
    value === "OTHER"
  ) {
    return value;
  }
  throw invalidResponseError("desenlace de reporte");
}

function validateReportOutcome(
  outcome: AdminReportCloseInput["outcome"],
): AdminReportCloseInput["outcome"] {
  if (
    outcome === "NO_ACTION" ||
    outcome === "WARNING" ||
    outcome === "CASHIER_SUSPENDED" ||
    outcome === "CASHIER_DELETED" ||
    outcome === "OTHER"
  ) {
    return outcome;
  }
  throw new ApiError(
    "Selecciona un resultado válido para la investigación.",
    400,
    "INVALID_REPORT_OUTCOME",
  );
}

function validateReportResolutionSummary(summary: string) {
  const normalized = summary.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 2000 ||
    !/[\p{L}\p{N}]/u.test(normalized)
  ) {
    throw new ApiError(
      "El resumen debe tener entre 1 y 2000 caracteres e incluir texto descriptivo.",
      400,
      "INVALID_REPORT_RESOLUTION",
    );
  }
  return normalized;
}

function validateReportEvidenceReason(reason: string) {
  const normalized = reason.trim();
  if (normalized.length < 20 || normalized.length > 1000) {
    throw new ApiError(
      "La justificación para acceder a la evidencia debe tener entre 20 y 1000 caracteres.",
      400,
      "INVALID_REPORT_EVIDENCE_REASON",
    );
  }
  return normalized;
}

function validateModerationReason(reason: string) {
  const normalized = reason.trim();
  if (
    normalized.length < 20 ||
    normalized.length > 1000 ||
    !/[\p{L}\p{N}]/u.test(normalized)
  ) {
    throw new ApiError(
      "El motivo debe tener entre 20 y 1000 caracteres e incluir texto descriptivo.",
      400,
      "INVALID_MODERATION_REASON",
    );
  }
  return normalized;
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

function readCookie(name: string) {
  const prefix = `${encodeURIComponent(name)}=`;
  const cookie = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));

  if (!cookie) return undefined;
  const value = cookie.slice(prefix.length);
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function readErrorPayload(response: Response) {
  try {
    return (await response.json()) as ErrorPayload;
  } catch {
    // Las respuestas no JSON no deben exponer detalles internos.
    return undefined;
  }
}

const CASHIER_RECOVERY_CODE_PATTERN =
  /^SC-[2-9A-HJ-NP-Z]{5}(?:-[2-9A-HJ-NP-Z]{5}){3}$/;

function parseCashierRegistrationResult(
  payload: unknown,
): CashierRegistrationResult {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.recoveryCodes) ||
    payload.recoveryCodes.length !== 8 ||
    (payload.recoveryCodesExpireAt !== null &&
      !isIsoDate(payload.recoveryCodesExpireAt))
  ) {
    throw invalidResponseError("códigos de recuperación");
  }

  const recoveryCodes = payload.recoveryCodes.map((value) => {
    if (typeof value !== "string" || !CASHIER_RECOVERY_CODE_PATTERN.test(value)) {
      throw invalidResponseError("códigos de recuperación");
    }
    return value;
  });
  if (new Set(recoveryCodes).size !== recoveryCodes.length) {
    throw invalidResponseError("códigos de recuperación");
  }

  return {
    recoveryCodes,
    recoveryCodesExpireAt: payload.recoveryCodesExpireAt,
  };
}

function parseSessionUser(payload: unknown): SessionUser {
  if (!isRecord(payload)) {
    throw invalidResponseError();
  }

  const { adminMfa, deviceId, id, role, status, username } = payload;
  if (
    typeof id !== "string" ||
    typeof username !== "string" ||
    !isSessionRole(role) ||
    !isSessionAccountStatus(status) ||
    (deviceId !== null && !isUuid(deviceId)) ||
    (role === "ADMIN"
      ? !isAdminMfaState(adminMfa)
      : adminMfa !== null)
  ) {
    throw invalidResponseError();
  }

  return {
    adminMfa: role === "ADMIN" ? (adminMfa as AdminMfaState) : null,
    deviceId,
    id,
    role,
    status,
    username,
  };
}

function isAdminMfaState(value: unknown): value is AdminMfaState {
  return (
    isRecord(value) &&
    value.required === true &&
    typeof value.enrolled === "boolean" &&
    typeof value.verified === "boolean" &&
    (!value.verified || value.enrolled)
  );
}

function parseAdminSessions(payload: unknown): readonly AdminSessionSummary[] {
  if (!Array.isArray(payload) || payload.length > 100) {
    throw invalidResponseError("sesiones administrativas");
  }
  const sessions = payload.map((value) => {
    if (
      !isRecord(value) ||
      !isUuid(value.id) ||
      !isIsoDate(value.createdAt) ||
      !isIsoDate(value.lastSeenAt) ||
      !isIsoDate(value.expiresAt) ||
      typeof value.isCurrent !== "boolean"
    ) {
      throw invalidResponseError("sesiones administrativas");
    }
    return {
      id: value.id,
      createdAt: value.createdAt,
      lastSeenAt: value.lastSeenAt,
      expiresAt: value.expiresAt,
      isCurrent: value.isCurrent,
    };
  });
  if (
    new Set(sessions.map((session) => session.id)).size !== sessions.length ||
    sessions.filter((session) => session.isCurrent).length !== 1
  ) {
    throw invalidResponseError("sesiones administrativas");
  }
  return sessions;
}

function parseAdminPasskeys(payload: unknown): readonly AdminPasskeySummary[] {
  if (!Array.isArray(payload) || payload.length === 0 || payload.length > 10) {
    throw invalidResponseError("passkeys administrativas");
  }
  const passkeys = payload.map((value): AdminPasskeySummary => {
    const deviceType = isRecord(value) ? value.deviceType : undefined;
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 5 ||
      !isUuid(value.id) ||
      !isIsoDate(value.createdAt) ||
      !(value.lastUsedAt === null || isIsoDate(value.lastUsedAt)) ||
      (deviceType !== "singleDevice" && deviceType !== "multiDevice") ||
      typeof value.backedUp !== "boolean"
    ) {
      throw invalidResponseError("passkeys administrativas");
    }
    return {
      id: value.id,
      createdAt: value.createdAt,
      lastUsedAt: value.lastUsedAt,
      deviceType,
      backedUp: value.backedUp,
    };
  });
  if (new Set(passkeys.map((passkey) => passkey.id)).size !== passkeys.length) {
    throw invalidResponseError("passkeys administrativas");
  }
  return passkeys;
}

function parseAdminSessionRevocation(payload: unknown): {
  revoked: boolean;
  currentSession: boolean;
} {
  if (
    !isRecord(payload) ||
    typeof payload.revoked !== "boolean" ||
    typeof payload.currentSession !== "boolean"
  ) {
    throw invalidResponseError("revocación de sesión");
  }
  return {
    revoked: payload.revoked,
    currentSession: payload.currentSession,
  };
}

function parseAdminMfaOptions(
  payload: unknown,
  kind: "registration" | "authentication",
): { challengeId: string; options: Record<string, unknown> } {
  if (!isRecord(payload) || !isUuid(payload.challengeId) || !isRecord(payload.options)) {
    throw invalidResponseError("opciones WebAuthn");
  }
  const challenge = payload.options.challenge;
  if (
    typeof challenge !== "string" ||
    challenge.length < 32 ||
    challenge.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(challenge)
  ) {
    throw invalidResponseError("opciones WebAuthn");
  }
  if (kind === "registration") {
    if (!isRecord(payload.options.rp) || !isRecord(payload.options.user)) {
      throw invalidResponseError("opciones WebAuthn");
    }
  } else if (typeof payload.options.rpId !== "string") {
    throw invalidResponseError("opciones WebAuthn");
  }
  return { challengeId: payload.challengeId, options: payload.options };
}

function parseAdminMfaEnrollment(payload: unknown): AdminMfaEnrollmentResult {
  if (
    !isRecord(payload) ||
    payload.verified !== true ||
    !Array.isArray(payload.recoveryCodes) ||
    (payload.recoveryCodes.length !== 0 && payload.recoveryCodes.length !== 10)
  ) {
    throw invalidResponseError("alta de passkey");
  }
  const recoveryCodes = payload.recoveryCodes.map((code) => {
    if (
      typeof code !== "string" ||
      !/^SA-[2-9A-HJ-NP-Z]{5}(?:-[2-9A-HJ-NP-Z]{5}){4}$/.test(code)
    ) {
      throw invalidResponseError("códigos de recuperación administrativa");
    }
    return code;
  });
  if (new Set(recoveryCodes).size !== recoveryCodes.length) {
    throw invalidResponseError("códigos de recuperación administrativa");
  }
  return { recoveryCodes };
}

function webAuthnBrowserError(error: unknown): ApiError {
  const name = error instanceof Error ? error.name : "";
  const message =
    name === "NotAllowedError" || name === "AbortError"
      ? "La confirmación con passkey fue cancelada o venció."
      : "El navegador no pudo completar la verificación con passkey.";
  return new ApiError(message, 0, "WEBAUTHN_BROWSER_ERROR");
}

function parseE2eeReleaseStatus(payload: unknown): E2eeReleaseStatus {
  if (!isRecord(payload)) throw invalidResponseError("estado E2EE");
  const {
    clientLibrary,
    clientLibraryVersion,
    matrixSpecificationVersion,
    message,
    messageRetentionHours,
    protocol,
    reasonCode,
    state,
  } = payload;
  if (
    (state !== "BLOCKED" && state !== "READY") ||
    typeof reasonCode !== "string" ||
    typeof protocol !== "string" ||
    typeof clientLibrary !== "string" ||
    typeof clientLibraryVersion !== "string" ||
    typeof matrixSpecificationVersion !== "string" ||
    messageRetentionHours !== 48 ||
    typeof message !== "string"
  ) {
    throw invalidResponseError("estado E2EE");
  }
  return {
    state,
    reasonCode,
    protocol,
    clientLibrary,
    clientLibraryVersion,
    matrixSpecificationVersion,
    messageRetentionHours,
    message,
  };
}

function parseMatrixCrossSigningStatus(payload: unknown): MatrixCrossSigningStatus {
  if (
    !isRecord(payload) ||
    Object.keys(payload).sort().join(",") !== "identity,matrixDeviceId,matrixUserId,state" ||
    typeof payload.matrixUserId !== "string" ||
    !/^@u[0-9a-f]{32}:[^\s/@]{1,255}$/.test(payload.matrixUserId) ||
    typeof payload.matrixDeviceId !== "string" ||
    !/^D[0-9A-F]{32}$/.test(payload.matrixDeviceId)
  ) throw invalidResponseError("identidad E2EE");
  const binding = { matrixUserId: payload.matrixUserId, matrixDeviceId: payload.matrixDeviceId };
  if (payload.state === "UNINITIALIZED" && payload.identity === null) {
    return { ...binding, state: "UNINITIALIZED", identity: null };
  }
  const identity = payload.identity;
  if (
    payload.state !== "PINNED" || !isRecord(identity) ||
    Object.keys(identity).sort().join(",") !== "masterKey,selfSigningKey,userSigningKey" ||
    Object.values(identity).some((key) => typeof key !== "string" || !/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$/.test(key)) ||
    new Set(Object.values(identity)).size !== 3
  ) throw invalidResponseError("identidad E2EE");
  return {
    ...binding, state: "PINNED", identity: {
      masterKey: identity.masterKey as string,
      selfSigningKey: identity.selfSigningKey as string,
      userSigningKey: identity.userSigningKey as string,
    },
  };
}

function parseMatrixDeviceRegistration(
  payload: unknown,
): MatrixDeviceRegistration {
  if (!isRecord(payload)) throw invalidResponseError("registro Matrix");
  const {
    deviceId,
    expiresAt,
    matrixDeviceId,
    matrixServerName,
    matrixUserId,
  } = payload;
  if (
    !isUuid(deviceId) ||
    typeof matrixUserId !== "string" ||
    typeof matrixDeviceId !== "string" ||
    typeof matrixServerName !== "string" ||
    !isIsoDate(expiresAt)
  ) {
    throw invalidResponseError("registro Matrix");
  }
  return {
    deviceId,
    expiresAt,
    matrixDeviceId,
    matrixServerName,
    matrixUserId,
  };
}

function parseMatrixDeviceCompletion(
  payload: unknown,
): MatrixDeviceCompletion {
  if (!isRecord(payload)) throw invalidResponseError("alta Matrix");
  const {
    bindingSecret,
    deviceId,
    matrixDeviceId,
    matrixUserId,
    one_time_key_counts: keyCounts,
    publishedAt,
  } = payload;
  if (
    !isUuid(deviceId) ||
    typeof matrixUserId !== "string" ||
    typeof matrixDeviceId !== "string" ||
    typeof bindingSecret !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(bindingSecret) ||
    !isIsoDate(publishedAt) ||
    !isRecord(keyCounts) ||
    Object.values(keyCounts).some(
      (value) => !Number.isSafeInteger(value) || (value as number) < 0,
    )
  ) {
    throw invalidResponseError("alta Matrix");
  }
  return {
    bindingSecret,
    deviceId,
    matrixDeviceId,
    matrixUserId,
    one_time_key_counts: keyCounts as Record<string, number>,
    publishedAt,
  };
}

function parseNotifications(payload: unknown): NotificationsData {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw invalidResponseError("avisos");
  }

  const items = payload.items.map((value) => {
    if (!isRecord(value)) {
      throw invalidResponseError("avisos");
    }

    return {
      id: requiredNonEmptyString(value, "id", "avisos"),
      type: parseNotificationType(value.type),
      createdAt: requiredNotificationDate(value.createdAt),
      readAt: optionalNotificationDate(value.readAt),
      expiresAt: optionalNotificationDate(value.expiresAt),
    } satisfies InAppNotification;
  });

  return {
    items,
    unreadCount: requiredNonNegativeInteger(payload.unreadCount, "avisos"),
  };
}

function parseNotificationType(value: unknown): InAppNotificationType {
  if (
    value === "NEW_MESSAGE" ||
    value === "MESSAGE_DELIVERED" ||
    value === "MESSAGE_READ" ||
    value === "ASSIGNMENT_CHANGED" ||
    value === "ACCOUNT_STATUS_CHANGED" ||
    value === "REPORT_RESOLVED" ||
    value === "REPORT_WARNING"
  ) {
    return value;
  }
  throw invalidResponseError("avisos");
}

function requiredNotificationDate(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw invalidResponseError("avisos");
  }
  return value;
}

function optionalNotificationDate(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredNotificationDate(value);
}

function parseCashierInvitation(payload: unknown): CashierInvitationData {
  if (!isRecord(payload)) {
    throw invalidResponseError();
  }

  const { code, createdAt, id } = payload;
  if (
    typeof code !== "string" ||
    typeof createdAt !== "string" ||
    typeof id !== "string"
  ) {
    throw invalidResponseError();
  }

  return { code, createdAt, id };
}

function parseAdminCashierOnboarding(
  payload: unknown,
): AdminCashierOnboardingResult {
  if (!isRecord(payload)) {
    throw invalidResponseError("invitación de cajero");
  }

  return {
    id: requiredString(payload, "id", "invitación de cajero"),
    code: requiredString(payload, "code", "invitación de cajero"),
    createdAt: requiredString(
      payload,
      "createdAt",
      "invitación de cajero",
    ),
    expiresAt: requiredString(
      payload,
      "expiresAt",
      "invitación de cajero",
    ),
  };
}

function parseAdminCashierInvitationRevocation(
  payload: unknown,
  expectedInvitationId: string,
) {
  if (!isRecord(payload)) {
    throw invalidResponseError("revocación de invitación de cajero");
  }
  const invitation = parseAdminCashierInvitation(payload.invitation);
  if (
    invitation.id !== expectedInvitationId ||
    invitation.status !== "revoked"
  ) {
    throw invalidResponseError("revocación de invitación de cajero");
  }
  requiredBoolean(
    payload,
    "revokedNow",
    "revocación de invitación de cajero",
  );
}

function requiredRecord(
  record: Record<string, unknown>,
  key: string,
  subject: string,
) {
  const value = record[key];
  if (!isRecord(value)) {
    throw invalidResponseError(subject);
  }
  return value;
}

function optionalRecord(value: unknown, subject: string) {
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value)) {
    throw invalidResponseError(subject);
  }
  return value;
}

function requiredArray(
  record: Record<string, unknown>,
  key: string,
  subject: string,
) {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw invalidResponseError(subject);
  }
  return value;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  subject: string,
) {
  const value = record[key];
  if (typeof value !== "string") {
    throw invalidResponseError(subject);
  }
  return value;
}

function requiredBoolean(
  record: Record<string, unknown>,
  key: string,
  subject: string,
) {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw invalidResponseError(subject);
  }
  return value;
}

function requiredNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  subject: string,
) {
  const value = requiredString(record, key, subject).trim();
  if (!value) {
    throw invalidResponseError(subject);
  }
  return value;
}

function optionalString(value: unknown, subject: string) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw invalidResponseError(subject);
  }
  return value;
}

function requiredNonNegativeInteger(value: unknown, subject: string) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw invalidResponseError(subject);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, subject: string) {
  if (value === null || value === undefined) return undefined;
  return requiredNonNegativeInteger(value, subject);
}

function positiveInteger(value: number | undefined, fallback: number) {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : fallback;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ApiError("El valor solicitado no es válido.", 400, code);
  }
  return value;
}

function canonicalUuid(value: unknown, code: string): string {
  if (!isUuid(value) || value !== value.toLowerCase()) {
    throw new ApiError("El identificador solicitado no es válido.", 400, code);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isSessionRole(value: unknown): value is SessionRole {
  return value === "CLIENT" || value === "CASHIER" || value === "ADMIN";
}

function isSessionAccountStatus(
  value: unknown,
): value is SessionAccountStatus {
  return (
    value === "PENDING" ||
    value === "ACTIVE" ||
    value === "SUSPENDED" ||
    value === "DELETED"
  );
}

function invalidResponseError(subject = "sesión") {
  return new ApiError(
    `El servidor devolvió datos no válidos para ${subject}.`,
    200,
    "INVALID_RESPONSE",
  );
}
