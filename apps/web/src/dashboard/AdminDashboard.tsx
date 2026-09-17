import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ActionReasonDialog } from "./ActionReasonDialog";
import {
  AdminEditUserDialog,
  AdminOnboardingDialog,
  AdminPasswordResetDialog,
} from "./AdminUserManagementDialogs";
import {
  AdminReportCloseDialog,
  AdminReportEvidenceAccessDialog,
} from "./AdminReportDialogs";
import { DashboardIcon, type DashboardIconName } from "./DashboardIcon";
import { DashboardShell } from "./DashboardShell";
import {
  formatDateTime,
  reportStatusLabel,
  roleLabel,
  subscriptionStatusLabel,
  userStatusLabel,
} from "./formatters";
import type {
  AdminAssignment,
  AdminCashierInvitation,
  AdminCashierInvitationFilterStatus,
  AdminCashierOnboardingInput,
  AdminCashierOnboardingResult,
  AdminOverviewCounts,
  AdminPagination,
  AdminPasskeySummary,
  AdminPasswordResetInput,
  AdminReport,
  AdminReportCloseInput,
  AdminReportEvidenceAccessInput,
  AdminReportEvidencePackage,
  AdminSessionSummary,
  AdminSubscription,
  AdminSupportedUserAction,
  AdminUser,
  AdminUserUpdateInput,
  DashboardCommonProps,
  DashboardStat,
  MaybePromise,
  SubscriptionEffectiveStatus,
} from "./types";

type AdminSection =
  | "overview"
  | "users"
  | "invitations"
  | "assignments"
  | "subscriptions"
  | "reports"
  | "security";

export interface AdminDashboardProps extends DashboardCommonProps {
  assignments: readonly AdminAssignment[];
  assignmentsPagination?: AdminPagination;
  overview: AdminOverviewCounts;
  reports: readonly AdminReport[];
  reportsPendingTotal: number;
  reportsPagination?: AdminPagination;
  stats: readonly DashboardStat[];
  subscriptions: readonly AdminSubscription[];
  subscriptionsPagination?: AdminPagination;
  users: readonly AdminUser[];
  usersPagination?: AdminPagination;
  cashierInvitations: readonly AdminCashierInvitation[];
  cashierInvitationsFilter: AdminCashierInvitationFilterStatus;
  cashierInvitationsPagination?: AdminPagination;
  onCreateCashierInvitation?: (
    input: AdminCashierOnboardingInput,
  ) => MaybePromise<AdminCashierOnboardingResult>;
  onCashierInvitationsFilterChange?: (
    status: AdminCashierInvitationFilterStatus,
  ) => MaybePromise;
  onCashierInvitationsPageChange?: (page: number) => MaybePromise;
  onRevokeCashierInvitation?: (invitationId: string) => MaybePromise;
  onDeleteUser?: (userId: string) => MaybePromise;
  onAccessReportEvidence?: (
    reportId: string,
    input: AdminReportEvidenceAccessInput,
  ) => MaybePromise<AdminReportEvidencePackage>;
  onAddPasskey?: () => MaybePromise;
  loadAdminPasskeys?: (
    signal?: AbortSignal,
  ) => MaybePromise<readonly AdminPasskeySummary[]>;
  loadAdminSessions?: (
    signal?: AbortSignal,
  ) => MaybePromise<readonly AdminSessionSummary[]>;
  onRevokeAdminSession?: (sessionId: string) => MaybePromise;
  onRevokeOtherAdminSessions?: () => MaybePromise<number>;
  onRevokePasskey?: (credentialId: string) => MaybePromise;
  onCloseReport?: (
    reportId: string,
    input: AdminReportCloseInput,
  ) => MaybePromise;
  onOpenReport?: (reportId: string) => MaybePromise;
  onAssignmentsPageChange?: (page: number) => MaybePromise;
  onReportsPageChange?: (page: number) => MaybePromise;
  onReassignClient?: (assignmentId: string) => MaybePromise;
  onSubscriptionAction?: (
    cashierId: string,
    action: "activate" | "deactivate",
  ) => MaybePromise;
  onSubscriptionsPageChange?: (page: number) => MaybePromise;
  onUserAction?: (
    userId: string,
    action: AdminSupportedUserAction,
  ) => MaybePromise;
  onResetPassword?: (
    userId: string,
    input: AdminPasswordResetInput,
  ) => MaybePromise;
  onUpdateUser?: (
    userId: string,
    input: AdminUserUpdateInput,
  ) => MaybePromise;
  onUsersPageChange?: (page: number) => MaybePromise;
}

type PendingAdminAction =
  | {
      kind: "user";
      user: AdminUser;
      action: AdminSupportedUserAction;
    }
  | {
      kind: "subscription";
      subscription: AdminSubscription;
      action: "activate" | "deactivate";
    }
  | {
      kind: "assignment";
      assignment: AdminAssignment;
    }
  | {
      kind: "delete";
      user: AdminUser;
    }
  | {
      kind: "invitation";
      invitation: AdminCashierInvitation;
    };

const adminSections: readonly {
  id: AdminSection;
  icon: DashboardIconName;
  label: string;
}[] = [
  { id: "overview", icon: "shield", label: "Resumen" },
  { id: "users", icon: "users", label: "Usuarios" },
  { id: "invitations", icon: "clock", label: "Invitaciones" },
  { id: "assignments", icon: "refresh", label: "Asignaciones" },
  { id: "subscriptions", icon: "clock", label: "Suscripciones" },
  { id: "reports", icon: "report", label: "Reportes" },
  { id: "security", icon: "lock", label: "Seguridad" },
];

export function AdminDashboard({
  assignments,
  assignmentsPagination,
  cashierInvitations,
  cashierInvitationsFilter,
  cashierInvitationsPagination,
  currentUser,
  notificationCount,
  notificationsOverlay,
  loadAdminPasskeys,
  loadAdminSessions,
  onAccessReportEvidence,
  onAddPasskey,
  onCloseReport,
  onCreateCashierInvitation,
  onCashierInvitationsFilterChange,
  onCashierInvitationsPageChange,
  onDeleteUser,
  onLogout,
  onOpenNotifications,
  onOpenReport,
  onAssignmentsPageChange,
  overview,
  onReportsPageChange,
  onReassignClient,
  onRevokeAdminSession,
  onRevokeCashierInvitation,
  onRevokeOtherAdminSessions,
  onRevokePasskey,
  onResetPassword,
  onSubscriptionAction,
  onSubscriptionsPageChange,
  onUserAction,
  onUpdateUser,
  reports,
  reportsPendingTotal,
  reportsPagination,
  stats,
  subscriptions,
  subscriptionsPagination,
  users,
  usersPagination,
  onUsersPageChange,
  systemNotice,
}: AdminDashboardProps) {
  const [section, setSection] = useState<AdminSection>("overview");
  const [pendingAction, setPendingAction] = useState<PendingAdminAction>();
  const [editingUser, setEditingUser] = useState<AdminUser>();
  const [passwordUser, setPasswordUser] = useState<AdminUser>();
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);
  const reportCount = reportsPendingTotal;

  async function confirmAdminAction() {
    if (!pendingAction) return;

    if (pendingAction.kind === "user") {
      await onUserAction?.(pendingAction.user.id, pendingAction.action);
    } else if (pendingAction.kind === "subscription") {
      await onSubscriptionAction?.(
        pendingAction.subscription.cashierId,
        pendingAction.action,
      );
    } else if (pendingAction.kind === "assignment") {
      await onReassignClient?.(pendingAction.assignment.id);
    } else if (pendingAction.kind === "invitation") {
      await onRevokeCashierInvitation?.(pendingAction.invitation.id);
    } else {
      await onDeleteUser?.(pendingAction.user.id);
    }

    setPendingAction(undefined);
  }

  return (
    <DashboardShell
      currentUser={currentUser}
      notificationCount={notificationCount}
      notificationsOverlay={notificationsOverlay}
      onLogout={onLogout}
      onOpenNotifications={onOpenNotifications}
      roleLabel="Administrador"
      systemNotice={systemNotice}
    >
      <div className="dash-admin-layout">
        <aside className="dash-admin-sidebar">
          <div className="dash-admin-sidebar-title">
            <span aria-hidden="true">
              <DashboardIcon name="shield" />
            </span>
            <p>
              Panel de control
              <small>Administración de SinoChat</small>
            </p>
          </div>
          <nav aria-label="Secciones de administración">
            {adminSections.map((item) => (
              <button
                aria-current={section === item.id ? "page" : undefined}
                className={section === item.id ? "is-active" : ""}
                key={item.id}
                onClick={() => setSection(item.id)}
                type="button"
              >
                <DashboardIcon name={item.icon} />
                <span>{item.label}</span>
                {item.id === "reports" && reportCount > 0 ? (
                  <b aria-label={`${reportCount} reportes pendientes`}>
                    {reportCount}
                  </b>
                ) : null}
              </button>
            ))}
          </nav>
          <div className="dash-admin-privacy">
            <DashboardIcon name="lock" />
            <p>
              Privacidad protegida
              <small>
                Este panel no recibe ni muestra el contenido de chats ordinarios.
              </small>
            </p>
          </div>
        </aside>

        <div className="dash-admin-content">
          {section === "overview" ? (
            <OverviewSection
              overview={overview}
              reportsPendingTotal={reportsPendingTotal}
              stats={stats}
              onNavigate={setSection}
            />
          ) : null}
          {section === "users" ? (
            <UsersSection
              canCreateUser={Boolean(onCreateCashierInvitation)}
              onCreateUser={() => setIsOnboardingOpen(true)}
              onDeleteUser={
                onDeleteUser
                  ? (user) => setPendingAction({ kind: "delete", user })
                  : undefined
              }
              onEditUser={onUpdateUser ? setEditingUser : undefined}
              onResetPassword={
                onResetPassword ? setPasswordUser : undefined
              }
              onRequestAction={
                onUserAction
                  ? (user, action) =>
                      setPendingAction({ kind: "user", user, action })
                  : undefined
              }
              onUsersPageChange={onUsersPageChange}
              users={users}
              usersPagination={usersPagination}
            />
          ) : null}
          {section === "invitations" ? (
            <CashierInvitationsSection
              filter={cashierInvitationsFilter}
              invitations={cashierInvitations}
              onFilterChange={onCashierInvitationsFilterChange}
              onPageChange={onCashierInvitationsPageChange}
              onRequestRevocation={
                onRevokeCashierInvitation
                  ? (invitation) =>
                      setPendingAction({ kind: "invitation", invitation })
                  : undefined
              }
              pagination={cashierInvitationsPagination}
            />
          ) : null}
          {section === "assignments" ? (
            <AssignmentsSection
              assignments={assignments}
              onPageChange={onAssignmentsPageChange}
              onRequestReassignment={
                onReassignClient
                  ? (assignment) =>
                      setPendingAction({ kind: "assignment", assignment })
                  : undefined
              }
              pagination={assignmentsPagination}
            />
          ) : null}
          {section === "subscriptions" ? (
            <SubscriptionsSection
              onRequestSubscriptionAction={
                onSubscriptionAction
                  ? (subscription, action) =>
                      setPendingAction({
                        kind: "subscription",
                        subscription,
                        action,
                      })
                  : undefined
              }
              onPageChange={onSubscriptionsPageChange}
              pagination={subscriptionsPagination}
              subscriptions={subscriptions}
            />
          ) : null}
          {section === "reports" ? (
            <ReportsSection
              onAccessReportEvidence={onAccessReportEvidence}
              onCloseReport={onCloseReport}
              onOpenReport={onOpenReport}
              onReportsPageChange={onReportsPageChange}
              reports={reports}
              reportsPagination={reportsPagination}
            />
          ) : null}
          {section === "security" ? (
            <SecuritySection
              loadAdminPasskeys={loadAdminPasskeys}
              loadAdminSessions={loadAdminSessions}
              onAddPasskey={onAddPasskey}
              onRevokeAdminSession={onRevokeAdminSession}
              onRevokeOtherAdminSessions={onRevokeOtherAdminSessions}
              onRevokePasskey={onRevokePasskey}
            />
          ) : null}
        </div>
      </div>
      {pendingAction ? (
        <ActionReasonDialog
          actionLabel={adminActionLabel(pendingAction)}
          collectReason={false}
          description={adminActionDescription(pendingAction)}
          isDangerous={isDangerousAdminAction(pendingAction)}
          onCancel={() => setPendingAction(undefined)}
          onConfirm={confirmAdminAction}
          title={adminActionTitle(pendingAction)}
        />
      ) : null}
      {editingUser && onUpdateUser ? (
        <AdminEditUserDialog
          onCancel={() => setEditingUser(undefined)}
          onConfirm={(input) => onUpdateUser(editingUser.id, input)}
          user={editingUser}
        />
      ) : null}
      {passwordUser && onResetPassword ? (
        <AdminPasswordResetDialog
          onCancel={() => setPasswordUser(undefined)}
          onConfirm={(input) => onResetPassword(passwordUser.id, input)}
          user={passwordUser}
        />
      ) : null}
      {isOnboardingOpen && onCreateCashierInvitation ? (
        <AdminOnboardingDialog
          onCancel={() => setIsOnboardingOpen(false)}
          onCreateCashierInvitation={onCreateCashierInvitation}
        />
      ) : null}
    </DashboardShell>
  );
}

function SecuritySection({
  loadAdminPasskeys,
  loadAdminSessions,
  onAddPasskey,
  onRevokeAdminSession,
  onRevokeOtherAdminSessions,
  onRevokePasskey,
}: {
  loadAdminPasskeys?: (
    signal?: AbortSignal,
  ) => MaybePromise<readonly AdminPasskeySummary[]>;
  loadAdminSessions?: (
    signal?: AbortSignal,
  ) => MaybePromise<readonly AdminSessionSummary[]>;
  onAddPasskey?: () => MaybePromise;
  onRevokeAdminSession?: (sessionId: string) => MaybePromise;
  onRevokeOtherAdminSessions?: () => MaybePromise<number>;
  onRevokePasskey?: (credentialId: string) => MaybePromise;
}) {
  const [passkeyStatus, setPasskeyStatus] = useState<
    | { tone: "success" | "error"; message: string }
    | undefined
  >();
  const [isAdding, setIsAdding] = useState(false);
  const [passkeys, setPasskeys] = useState<readonly AdminPasskeySummary[]>([]);
  const [isLoadingPasskeys, setIsLoadingPasskeys] = useState(false);
  const [revokingPasskeyId, setRevokingPasskeyId] = useState<string>();
  const [confirmingPasskeyId, setConfirmingPasskeyId] = useState<string>();
  const [sessions, setSessions] = useState<readonly AdminSessionSummary[]>([]);
  const [sessionsStatus, setSessionsStatus] = useState<
    | { tone: "success" | "error"; message: string }
    | undefined
  >();
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [revokingSessionId, setRevokingSessionId] = useState<string>();
  const [isRevokingOthers, setIsRevokingOthers] = useState(false);

  async function refreshPasskeys(signal?: AbortSignal) {
    if (!loadAdminPasskeys) return;
    setIsLoadingPasskeys(true);
    try {
      const nextPasskeys = await loadAdminPasskeys(signal);
      if (!signal?.aborted) setPasskeys(nextPasskeys);
    } catch (error) {
      if (signal?.aborted) return;
      setPasskeyStatus({
        tone: "error",
        message:
          error instanceof Error && error.message.trim()
            ? error.message
            : "No se pudieron consultar las passkeys administrativas.",
      });
    } finally {
      if (!signal?.aborted) setIsLoadingPasskeys(false);
    }
  }

  async function refreshSessions(signal?: AbortSignal) {
    if (!loadAdminSessions) return;
    setIsLoadingSessions(true);
    try {
      const nextSessions = await loadAdminSessions(signal);
      if (!signal?.aborted) setSessions(nextSessions);
    } catch (error) {
      if (signal?.aborted) return;
      setSessionsStatus({
        tone: "error",
        message:
          error instanceof Error && error.message.trim()
            ? error.message
            : "No se pudieron consultar las sesiones administrativas.",
      });
    } finally {
      if (!signal?.aborted) setIsLoadingSessions(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void refreshPasskeys(controller.signal);
    return () => controller.abort();
  }, [loadAdminPasskeys]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshSessions(controller.signal);
    return () => controller.abort();
  }, [loadAdminSessions]);

  async function addPasskey() {
    if (!onAddPasskey || isAdding) return;
    setIsAdding(true);
    setPasskeyStatus(undefined);
    try {
      await onAddPasskey();
      await refreshPasskeys();
      setPasskeyStatus({
        tone: "success",
        message: "Passkey adicional registrada correctamente.",
      });
    } catch (error) {
      setPasskeyStatus({
        tone: "error",
        message:
          error instanceof Error && error.message.trim()
            ? error.message
            : "No se pudo registrar la passkey adicional.",
      });
    } finally {
      setIsAdding(false);
    }
  }

  async function revokePasskey(credentialId: string) {
    if (
      !onRevokePasskey ||
      passkeys.length <= 1 ||
      revokingPasskeyId ||
      isAdding
    ) {
      return;
    }
    setRevokingPasskeyId(credentialId);
    setPasskeyStatus(undefined);
    try {
      await onRevokePasskey(credentialId);
      await refreshPasskeys();
      setConfirmingPasskeyId(undefined);
      setPasskeyStatus({
        tone: "success",
        message: "La passkey seleccionada quedó revocada.",
      });
    } catch (error) {
      setPasskeyStatus({
        tone: "error",
        message:
          error instanceof Error && error.message.trim()
            ? error.message
            : "No se pudo revocar la passkey seleccionada.",
      });
    } finally {
      setRevokingPasskeyId(undefined);
    }
  }

  async function revokeSession(sessionId: string) {
    if (!onRevokeAdminSession || revokingSessionId || isRevokingOthers) return;
    setRevokingSessionId(sessionId);
    setSessionsStatus(undefined);
    try {
      await onRevokeAdminSession(sessionId);
      await refreshSessions();
      setSessionsStatus({
        tone: "success",
        message: "La sesión seleccionada quedó cerrada.",
      });
    } catch (error) {
      setSessionsStatus({
        tone: "error",
        message:
          error instanceof Error && error.message.trim()
            ? error.message
            : "No se pudo cerrar la sesión seleccionada.",
      });
    } finally {
      setRevokingSessionId(undefined);
    }
  }

  async function revokeOtherSessions() {
    if (!onRevokeOtherAdminSessions || revokingSessionId || isRevokingOthers) {
      return;
    }
    setIsRevokingOthers(true);
    setSessionsStatus(undefined);
    try {
      const revokedCount = await onRevokeOtherAdminSessions();
      await refreshSessions();
      setSessionsStatus({
        tone: "success",
        message:
          revokedCount === 1
            ? "Se cerró la otra sesión administrativa."
            : `Se cerraron ${revokedCount} sesiones administrativas.`,
      });
    } catch (error) {
      setSessionsStatus({
        tone: "error",
        message:
          error instanceof Error && error.message.trim()
            ? error.message
            : "No se pudieron cerrar las demás sesiones.",
      });
    } finally {
      setIsRevokingOthers(false);
    }
  }

  const otherSessionsCount = sessions.filter(
    (session) => !session.isCurrent,
  ).length;

  return (
    <section aria-labelledby="admin-security-title">
      <SectionHeading
        eyebrow="Cuenta administrativa"
        title="Seguridad"
        description="Agrega una segunda passkey para recuperar el acceso si pierdes una. SinoChat no recibe las claves privadas. Para agregar o revocar una passkey, deberás confirmar una existente si tu verificación reciente venció."
        titleId="admin-security-title"
      />
      <div className="dash-security-card">
        <span aria-hidden="true">
          <DashboardIcon name="lock" />
        </span>
        <div>
          <h2>Passkey de respaldo</h2>
          <p>
            Usa otra llave física, teléfono o perfil de Windows Hello. Agregarla
            no reemplaza tus diez códigos de recuperación ni vuelve a mostrarlos.
          </p>
          <button
            className="dash-button dash-button-primary"
            disabled={
              !onAddPasskey ||
              isAdding ||
              Boolean(revokingPasskeyId) ||
              passkeys.length >= 10
            }
            onClick={() => void addPasskey()}
            type="button"
          >
            <DashboardIcon name="plus" />
            {isAdding
              ? "Esperando confirmación…"
              : passkeys.length >= 10
                ? "Límite de 10 alcanzado"
                : "Agregar otra passkey"}
          </button>
          {passkeyStatus ? (
            <p
              className={`dash-security-status is-${passkeyStatus.tone}`}
              role={passkeyStatus.tone === "error" ? "alert" : "status"}
            >
              {passkeyStatus.message}
            </p>
          ) : null}
          {isLoadingPasskeys && passkeys.length === 0 ? (
            <p role="status">Consultando passkeys…</p>
          ) : null}
          {passkeys.length > 0 ? (
            <>
              <p className="dash-security-count">
                {passkeys.length} de 10 passkeys activas
              </p>
              <ul className="dash-security-session-list dash-security-passkey-list">
                {passkeys.map((passkey) => (
                  <li key={passkey.id}>
                    <div>
                      <strong>
                        {passkey.deviceType === "multiDevice" ||
                        passkey.backedUp
                          ? "Passkey sincronizada"
                          : "Passkey de dispositivo"}
                      </strong>
                      <span>
                        Registrada: {formatDateTime(passkey.createdAt)} · Último
                        uso: {passkey.lastUsedAt
                          ? formatDateTime(passkey.lastUsedAt)
                          : "Nunca usada"}
                      </span>
                      <small>
                        {passkey.backedUp
                          ? "El autenticador informó que tiene respaldo."
                          : "El autenticador no informó respaldo."}
                      </small>
                    </div>
                    {passkeys.length === 1 ? (
                      <span className="dash-security-current">Única</span>
                    ) : confirmingPasskeyId === passkey.id ? (
                      <div className="dash-security-confirm-actions">
                        <button
                          className="dash-button dash-button-danger"
                          disabled={Boolean(revokingPasskeyId)}
                          onClick={() => void revokePasskey(passkey.id)}
                          type="button"
                        >
                          <DashboardIcon name="block" />
                          {revokingPasskeyId === passkey.id
                            ? "Revocando…"
                            : "Confirmar revocación"}
                        </button>
                        <button
                          className="dash-button dash-button-ghost"
                          disabled={Boolean(revokingPasskeyId)}
                          onClick={() => setConfirmingPasskeyId(undefined)}
                          type="button"
                        >
                          Cancelar
                        </button>
                      </div>
                    ) : (
                      <button
                        className="dash-button dash-button-danger"
                        disabled={
                          !onRevokePasskey ||
                          Boolean(revokingPasskeyId) ||
                          isAdding
                        }
                        onClick={() => setConfirmingPasskeyId(passkey.id)}
                        type="button"
                      >
                        <DashboardIcon name="block" />
                        Revocar
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </div>
      <div className="dash-security-card dash-security-sessions">
        <span aria-hidden="true">
          <DashboardIcon name="clock" />
        </span>
        <div>
          <div className="dash-security-sessions-heading">
            <div>
              <h2>Sesiones administrativas</h2>
              <p>
                Revisa dónde quedó abierta tu cuenta. Para cerrar otra sesión
                se solicitará una passkey si tu verificación reciente venció.
              </p>
            </div>
            <button
              className="dash-button dash-button-danger"
              disabled={
                !onRevokeOtherAdminSessions ||
                otherSessionsCount === 0 ||
                Boolean(revokingSessionId) ||
                isRevokingOthers
              }
              onClick={() => void revokeOtherSessions()}
              type="button"
            >
              <DashboardIcon name="logout" />
              {isRevokingOthers
                ? "Cerrando…"
                : "Cerrar las demás sesiones"}
            </button>
          </div>
          {isLoadingSessions && sessions.length === 0 ? (
            <p role="status">Consultando sesiones…</p>
          ) : null}
          {!isLoadingSessions && loadAdminSessions && sessions.length === 0 ? (
            <p>No hay sesiones administrativas activas para mostrar.</p>
          ) : null}
          {sessions.length > 0 ? (
            <ul className="dash-security-session-list">
              {sessions.map((session) => (
                <li key={session.id}>
                  <div>
                    <strong>
                      {session.isCurrent ? "Esta sesión" : "Otra sesión"}
                    </strong>
                    <span>
                      Iniciada: {formatDateTime(session.createdAt)} · Última
                      actividad: {formatDateTime(session.lastSeenAt)}
                    </span>
                    <small>
                      Vence: {formatDateTime(session.expiresAt)}
                    </small>
                  </div>
                  {session.isCurrent ? (
                    <span className="dash-security-current">Actual</span>
                  ) : (
                    <button
                      className="dash-button dash-button-danger"
                      disabled={
                        !onRevokeAdminSession ||
                        Boolean(revokingSessionId) ||
                        isRevokingOthers
                      }
                      onClick={() => void revokeSession(session.id)}
                      type="button"
                    >
                      <DashboardIcon name="logout" />
                      {revokingSessionId === session.id
                        ? "Cerrando…"
                        : "Cerrar sesión"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {sessionsStatus ? (
            <p
              className={`dash-security-status is-${sessionsStatus.tone}`}
              role={sessionsStatus.tone === "error" ? "alert" : "status"}
            >
              {sessionsStatus.message}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function OverviewSection({
  onNavigate,
  overview,
  reportsPendingTotal,
  stats,
}: {
  onNavigate: (section: AdminSection) => void;
  overview: AdminOverviewCounts;
  reportsPendingTotal: number;
  stats: readonly DashboardStat[];
}) {
  return (
    <section aria-labelledby="admin-overview-title">
      <SectionHeading
        eyebrow="Estado general"
        title="Resumen administrativo"
        description="Controla usuarios, asignaciones y actividad operativa sin acceder a conversaciones privadas."
        titleId="admin-overview-title"
      />

      {stats.length > 0 ? (
        <div className="dash-stat-grid">
          {stats.map((stat) => (
            <article
              className={`dash-stat-card is-${stat.tone || "default"}`}
              key={stat.id}
            >
              <p>{stat.label}</p>
              <strong>{stat.value}</strong>
              {stat.detail ? <small>{stat.detail}</small> : null}
            </article>
          ))}
        </div>
      ) : (
        <InlineEmpty text="Las métricas estarán disponibles cuando el servidor las proporcione." />
      )}

      <div className="dash-overview-grid">
        <OverviewAction
          count={overview.pendingUsers}
          description="Cuentas que requieren aprobación o validación."
          label="Usuarios pendientes"
          onClick={() => onNavigate("users")}
        />
        <OverviewAction
          count={overview.inactiveSubscriptions}
          description="Cajeros que no tienen una suscripción activa."
          label="Suscripciones a revisar"
          onClick={() => onNavigate("subscriptions")}
        />
        <OverviewAction
          count={reportsPendingTotal}
          description="Casos abiertos o actualmente bajo investigación."
          label="Reportes pendientes"
          onClick={() => onNavigate("reports")}
        />
      </div>

      <div className="dash-privacy-boundary">
        <span aria-hidden="true">
          <DashboardIcon name="lock" />
        </span>
        <div>
          <h2>Contenido privado fuera del panel</h2>
          <p>
            Puedes conocer las asignaciones y gestionar las cuentas. Los mensajes y
            fotos de chats ordinarios permanecen cifrados y no forman parte de estos
            datos.
          </p>
        </div>
      </div>
    </section>
  );
}

function UsersSection({
  canCreateUser,
  onCreateUser,
  onDeleteUser,
  onEditUser,
  onRequestAction,
  onResetPassword,
  onUsersPageChange,
  users,
  usersPagination,
}: {
  canCreateUser: boolean;
  onCreateUser: () => void;
  onDeleteUser?: (user: AdminUser) => void;
  onEditUser?: (user: AdminUser) => void;
  onRequestAction?: (
    user: AdminUser,
    action: AdminSupportedUserAction,
  ) => void;
  onResetPassword?: (user: AdminUser) => void;
  onUsersPageChange?: (page: number) => MaybePromise;
  users: readonly AdminUser[];
  usersPagination?: AdminPagination;
}) {
  const [query, setQuery] = useState("");
  const [isChangingPage, setIsChangingPage] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase("es");
  const filteredUsers = useMemo(() => {
    if (!normalizedQuery) return users;
    return users.filter((user) =>
      [
        user.username,
        user.displayName,
        user.email,
        user.phone,
        user.assignedCashierName,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("es")
        .includes(normalizedQuery),
    );
  }, [normalizedQuery, users]);

  async function changePage(page: number) {
    if (!onUsersPageChange || isChangingPage) return;
    setIsChangingPage(true);
    try {
      await onUsersPageChange(page);
      setQuery("");
    } finally {
      setIsChangingPage(false);
    }
  }

  return (
    <section aria-labelledby="admin-users-title">
      <SectionHeading
        action={
          <button
            aria-label={
              canCreateUser
                ? "Iniciar alta de usuario"
                : "Alta de usuario no disponible en el servidor"
            }
            className="dash-button dash-button-primary"
            disabled={!canCreateUser}
            onClick={onCreateUser}
            title={
              canCreateUser
                ? "Genera una invitación para que el titular complete su alta."
                : "El backend aún no permite iniciar altas desde este panel."
            }
            type="button"
          >
            <DashboardIcon name="plus" />
            Iniciar alta
          </button>
        }
        eyebrow="Cuentas"
        title="Usuarios"
        description="Gestiona clientes y cajeros sin aceptar términos, declarar edad ni elegir credenciales en nombre de otra persona."
        titleId="admin-users-title"
      />
      <TableToolbar
        onQueryChange={setQuery}
        placeholder="Buscar usuario, correo o teléfono…"
        query={query}
        resultCount={filteredUsers.length}
      />
      {filteredUsers.length > 0 ? (
        <div className="dash-table-shell">
          <table className="dash-data-table">
            <caption className="dash-visually-hidden">
              Usuarios registrados en SinoChat
            </caption>
            <thead>
              <tr>
                <th scope="col">Usuario</th>
                <th scope="col">Rol</th>
                <th scope="col">Estado</th>
                <th scope="col">Datos administrativos</th>
                <th scope="col">Asignación</th>
                <th scope="col">Alta</th>
                <th scope="col">
                  <span className="dash-visually-hidden">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((user) => (
                <tr key={user.id}>
                  <td data-label="Usuario">
                    <strong>{user.displayName || user.username}</strong>
                    {user.displayName ? <small>@{user.username}</small> : null}
                  </td>
                  <td data-label="Rol">{roleLabel(user.role)}</td>
                  <td data-label="Estado">
                    <StatusBadge
                      label={userStatusLabel(user.status)}
                      tone={user.status}
                    />
                  </td>
                  <td data-label="Datos">
                    {user.email || user.phone ? (
                      <>
                        {user.email ? <span>{user.email}</span> : null}
                        {user.phone ? <small>{user.phone}</small> : null}
                      </>
                    ) : (
                      <span className="dash-muted">No requeridos</span>
                    )}
                  </td>
                  <td data-label="Asignación">
                    {user.role === "client" ? (
                      user.assignedCashierName || "Sin asignar"
                    ) : user.role === "cashier" ? (
                      `${user.activeClientCount ?? 0} clientes activos`
                    ) : (
                      "—"
                    )}
                    {user.role === "client" &&
                    typeof user.distinctCashierBlocks === "number" ? (
                      <small>
                        {user.distinctCashierBlocks}/5 bloqueos distintos
                      </small>
                    ) : null}
                  </td>
                  <td data-label="Alta">{formatDateTime(user.createdAt)}</td>
                  <td data-label="Acciones">
                    <UserActions
                      onDelete={onDeleteUser}
                      onEdit={onEditUser}
                      onAction={onRequestAction}
                      onResetPassword={onResetPassword}
                      user={user}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <InlineEmpty
          text={
            users.length === 0
              ? "Todavía no hay usuarios para mostrar."
              : "No hay usuarios que coincidan con la búsqueda."
          }
        />
      )}
      {usersPagination ? (
        <PaginationControls
          ariaLabel="Paginación de usuarios"
          disabled={isChangingPage}
          entityLabel="usuarios"
          onPageChange={(page) => void changePage(page)}
          pagination={usersPagination}
        />
      ) : null}
    </section>
  );
}

function CashierInvitationsSection({
  filter,
  invitations,
  onFilterChange,
  onPageChange,
  onRequestRevocation,
  pagination,
}: {
  filter: AdminCashierInvitationFilterStatus;
  invitations: readonly AdminCashierInvitation[];
  onFilterChange?: (
    status: AdminCashierInvitationFilterStatus,
  ) => MaybePromise;
  onPageChange?: (page: number) => MaybePromise;
  onRequestRevocation?: (invitation: AdminCashierInvitation) => void;
  pagination?: AdminPagination;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>();

  async function changeFilter(status: AdminCashierInvitationFilterStatus) {
    if (!onFilterChange || isLoading) return;
    setIsLoading(true);
    setError(undefined);
    try {
      await onFilterChange(status);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "No se pudo aplicar el filtro.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function changePage(page: number) {
    if (!onPageChange || isLoading) return;
    setIsLoading(true);
    setError(undefined);
    try {
      await onPageChange(page);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "No se pudo cambiar la página.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <section aria-labelledby="admin-cashier-invitations-title">
      <SectionHeading
        eyebrow="Altas de cajeros"
        title="Invitaciones"
        description="Consulta y revoca enlaces de alta sin revelar sus códigos ni material cifrado. Un enlace canjeado nunca puede revocarse."
        titleId="admin-cashier-invitations-title"
      />
      <div className="dash-invitation-toolbar">
        <label>
          <span>Filtrar por estado</span>
          <select
            disabled={!onFilterChange || isLoading}
            onChange={(event) =>
              void changeFilter(
                event.target.value as AdminCashierInvitationFilterStatus,
              )
            }
            value={filter}
          >
            <option value="ALL">Todos los estados</option>
            <option value="ACTIVE">Activas</option>
            <option value="EXPIRED">Vencidas</option>
            <option value="REDEEMED">Canjeadas</option>
            <option value="REVOKED">Revocadas</option>
          </select>
        </label>
        <span aria-live="polite">
          {pagination?.total ?? invitations.length} invitaciones
        </span>
      </div>
      {error ? (
        <p className="dash-report-action-error" role="alert">
          {error}
        </p>
      ) : null}
      {invitations.length > 0 ? (
        <div className="dash-table-shell">
          <table className="dash-data-table">
            <caption className="dash-visually-hidden">
              Invitaciones administrativas para altas de cajeros
            </caption>
            <thead>
              <tr>
                <th scope="col">Identificador</th>
                <th scope="col">Estado</th>
                <th scope="col">Creada por</th>
                <th scope="col">Creación</th>
                <th scope="col">Vencimiento</th>
                <th scope="col">Canje</th>
                <th scope="col">
                  <span className="dash-visually-hidden">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((invitation) => (
                <tr key={invitation.id}>
                  <td data-label="Identificador">
                    <code title={invitation.id}>{invitation.id}</code>
                  </td>
                  <td data-label="Estado">
                    <StatusBadge
                      label={cashierInvitationStatusLabel(invitation.status)}
                      tone={cashierInvitationStatusTone(invitation.status)}
                    />
                    {invitation.revokedAt ? (
                      <small>{formatDateTime(invitation.revokedAt)}</small>
                    ) : null}
                  </td>
                  <td data-label="Creada por">
                    <strong>@{invitation.createdByAdmin.username}</strong>
                  </td>
                  <td data-label="Creación">
                    {formatDateTime(invitation.createdAt)}
                  </td>
                  <td data-label="Vencimiento">
                    {formatDateTime(invitation.expiresAt)}
                  </td>
                  <td data-label="Canje">
                    {invitation.redeemedByCashier ? (
                      <>
                        <strong>@{invitation.redeemedByCashier.username}</strong>
                        <small>{formatDateTime(invitation.redeemedAt)}</small>
                      </>
                    ) : (
                      <span className="dash-muted">Sin canjear</span>
                    )}
                  </td>
                  <td data-label="Acciones">
                    {invitation.canRevoke ? (
                      <button
                        className="dash-table-action is-danger"
                        disabled={!onRequestRevocation}
                        onClick={() => onRequestRevocation?.(invitation)}
                        type="button"
                      >
                        Revocar
                      </button>
                    ) : (
                      <span className="dash-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <InlineEmpty text="No hay invitaciones con este estado." />
      )}
      {pagination ? (
        <PaginationControls
          ariaLabel="Paginación de invitaciones de cajeros"
          disabled={isLoading}
          entityLabel="invitaciones"
          onPageChange={(page) => void changePage(page)}
          pagination={pagination}
        />
      ) : null}
    </section>
  );
}

function AssignmentsSection({
  assignments,
  onPageChange,
  onRequestReassignment,
  pagination,
}: {
  assignments: readonly AdminAssignment[];
  onPageChange?: (page: number) => MaybePromise;
  onRequestReassignment?: (assignment: AdminAssignment) => void;
  pagination?: AdminPagination;
}) {
  const [isChangingPage, setIsChangingPage] = useState(false);

  async function changePage(page: number) {
    if (!onPageChange || isChangingPage) return;
    setIsChangingPage(true);
    try {
      await onPageChange(page);
    } finally {
      setIsChangingPage(false);
    }
  }

  return (
    <section aria-labelledby="admin-assignments-title">
      <SectionHeading
        eyebrow="Vínculos"
        title="Asignaciones"
        description="Consulta qué cliente pertenece a cada cajero. La clientela existente no se redistribuye para equilibrar cantidades."
        titleId="admin-assignments-title"
      />
      {assignments.length > 0 ? (
        <div className="dash-table-shell">
          <table className="dash-data-table">
            <caption className="dash-visually-hidden">
              Asignaciones entre clientes y cajeros
            </caption>
            <thead>
              <tr>
                <th scope="col">Cliente</th>
                <th scope="col">Cajero</th>
                <th scope="col">Origen</th>
                <th scope="col">Asignado</th>
                <th scope="col">
                  <span className="dash-visually-hidden">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {assignments.map((assignment) => (
                <tr key={assignment.id}>
                  <td data-label="Cliente">
                    <strong>@{assignment.clientUsername}</strong>
                  </td>
                  <td data-label="Cajero">@{assignment.cashierUsername}</td>
                  <td data-label="Origen">
                    {assignmentSourceLabel(assignment.source)}
                  </td>
                  <td data-label="Asignado">
                    {formatDateTime(assignment.assignedAt)}
                  </td>
                  <td data-label="Acciones">
                    {onRequestReassignment ? (
                      <button
                        className="dash-table-action"
                        onClick={() => onRequestReassignment(assignment)}
                        type="button"
                      >
                        <DashboardIcon name="refresh" />
                        Reasignar
                      </button>
                    ) : (
                      <span className="dash-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <InlineEmpty text="Todavía no hay asignaciones para mostrar." />
      )}
      {pagination ? (
        <PaginationControls
          ariaLabel="Paginación de asignaciones"
          disabled={isChangingPage}
          entityLabel="asignaciones activas"
          onPageChange={(page) => void changePage(page)}
          pagination={pagination}
        />
      ) : null}
    </section>
  );
}

function SubscriptionsSection({
  onPageChange,
  onRequestSubscriptionAction,
  pagination,
  subscriptions,
}: {
  onPageChange?: (page: number) => MaybePromise;
  onRequestSubscriptionAction?: (
    subscription: AdminSubscription,
    action: "activate" | "deactivate",
  ) => void;
  pagination?: AdminPagination;
  subscriptions: readonly AdminSubscription[];
}) {
  const [isChangingPage, setIsChangingPage] = useState(false);

  async function changePage(page: number) {
    if (!onPageChange || isChangingPage) return;
    setIsChangingPage(true);
    try {
      await onPageChange(page);
    } finally {
      setIsChangingPage(false);
    }
  }

  return (
    <section aria-labelledby="admin-subscriptions-title">
      <SectionHeading
        eyebrow="Acceso de cajeros"
        title="Suscripciones"
        description="Gestiona manualmente qué cajeros pueden recibir clientes."
        titleId="admin-subscriptions-title"
      />
      {subscriptions.length > 0 ? (
        <div className="dash-table-shell">
          <table className="dash-data-table">
            <caption className="dash-visually-hidden">
              Suscripciones de cajeros
            </caption>
            <thead>
              <tr>
                <th scope="col">Cajero</th>
                <th scope="col">Estado</th>
                <th scope="col">Inicio</th>
                <th scope="col">Vigencia</th>
                <th scope="col">
                  <span className="dash-visually-hidden">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((subscription) => (
                <tr key={subscription.cashierId}>
                  <td data-label="Cajero">
                    <strong>@{subscription.cashierUsername}</strong>
                  </td>
                  <td data-label="Estado">
                    <StatusBadge
                      label={subscriptionStatusLabel(
                        subscription.effectiveStatus,
                      )}
                      tone={subscriptionTone(
                        subscription.effectiveStatus,
                      )}
                    />
                  </td>
                  <td data-label="Inicio">
                    {formatDateTime(subscription.startedAt)}
                  </td>
                  <td data-label="Vigencia">
                    {formatDateTime(subscription.validUntil)}
                  </td>
                  <td data-label="Acciones">
                    {onRequestSubscriptionAction ? (
                      <button
                        className={`dash-table-action${
                          subscription.status === "active" ? " is-danger" : ""
                        }`}
                        disabled={
                          subscription.effectiveStatus === "expired_pending"
                        }
                        onClick={() =>
                          onRequestSubscriptionAction(
                            subscription,
                            subscription.status === "active"
                              ? "deactivate"
                              : "activate",
                          )
                        }
                        type="button"
                      >
                        {subscription.effectiveStatus === "expired_pending"
                          ? "Conciliando"
                          : subscription.status === "active"
                            ? "Desactivar"
                            : "Activar"}
                      </button>
                    ) : (
                      <span className="dash-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <InlineEmpty text="Todavía no hay suscripciones para mostrar." />
      )}
      {pagination ? (
        <PaginationControls
          ariaLabel="Paginación de suscripciones"
          disabled={isChangingPage}
          entityLabel="cajeros"
          onPageChange={(page) => void changePage(page)}
          pagination={pagination}
        />
      ) : null}
    </section>
  );
}

function ReportsSection({
  onAccessReportEvidence,
  onCloseReport,
  onOpenReport,
  onReportsPageChange,
  reports,
  reportsPagination,
}: {
  onAccessReportEvidence?: (
    reportId: string,
    input: AdminReportEvidenceAccessInput,
  ) => MaybePromise<AdminReportEvidencePackage>;
  onCloseReport?: (
    reportId: string,
    input: AdminReportCloseInput,
  ) => MaybePromise;
  onOpenReport?: (reportId: string) => MaybePromise;
  onReportsPageChange?: (page: number) => MaybePromise;
  reports: readonly AdminReport[];
  reportsPagination?: AdminPagination;
}) {
  const [evidenceReport, setEvidenceReport] = useState<AdminReport>();
  const [closingReport, setClosingReport] = useState<AdminReport>();
  const [openingReportId, setOpeningReportId] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [isChangingPage, setIsChangingPage] = useState(false);

  async function beginReview(report: AdminReport) {
    if (!onOpenReport || openingReportId) return;
    setOpeningReportId(report.id);
    setActionError(undefined);
    try {
      await onOpenReport(report.id);
    } catch (error) {
      setActionError(
        error instanceof Error && error.message.trim()
          ? error.message
          : "No se pudo iniciar la revisión.",
      );
    } finally {
      setOpeningReportId(undefined);
    }
  }

  async function changePage(page: number) {
    if (!onReportsPageChange || isChangingPage) return;
    setIsChangingPage(true);
    setActionError(undefined);
    try {
      await onReportsPageChange(page);
    } catch (error) {
      setActionError(
        error instanceof Error && error.message.trim()
          ? error.message
          : "No se pudo cambiar la página de reportes.",
      );
    } finally {
      setIsChangingPage(false);
    }
  }

  return (
    <section aria-labelledby="admin-reports-title">
      <SectionHeading
        eyebrow="Investigaciones"
        title="Reportes"
        description="La lista contiene únicamente metadatos. La evidencia denunciada se abre mediante el flujo protegido de revisión."
        titleId="admin-reports-title"
      />
      {actionError ? (
        <p className="dash-report-action-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {reports.length > 0 ? (
        <div className="dash-report-list">
          {reports.map((report) => (
            <article className="dash-report-card" key={report.id}>
              <header>
                <div>
                  <span>Reporte #{report.id}</span>
                  <StatusBadge
                    label={reportStatusLabel(report.status)}
                    tone={
                      report.status === "closed"
                        ? "active"
                        : report.status === "under_review" ||
                            report.status === "closing"
                          ? "pending"
                          : "suspended"
                    }
                  />
                </div>
                <time dateTime={report.createdAt}>
                  {formatDateTime(report.createdAt)}
                </time>
              </header>
              <dl>
                <div>
                  <dt>Reporta</dt>
                  <dd>@{report.reporterUsername}</dd>
                </div>
                <div>
                  <dt>Reportado</dt>
                  <dd>@{report.reportedUsername}</dd>
                </div>
              </dl>
              <div className="dash-report-reason">
                <span>Motivo declarado</span>
                <p>{report.reason}</p>
              </div>
              {report.outcome || report.resolutionSummary ? (
                <div className="dash-report-resolution">
                  {report.outcome ? (
                    <p>
                      <span>Desenlace</span>
                      <strong>{reportOutcomeLabel(report.outcome)}</strong>
                    </p>
                  ) : null}
                  {report.resolutionSummary ? (
                    <p>
                      <span>Resolución</span>
                      {report.resolutionSummary}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <ReportLifecycle report={report} />
              {report.status === "open" && onOpenReport ? (
                <footer>
                  <button
                    className="dash-button dash-button-secondary"
                    disabled={Boolean(openingReportId)}
                    onClick={() => void beginReview(report)}
                    type="button"
                  >
                    {openingReportId === report.id
                      ? "Iniciando revisión…"
                      : "Iniciar revisión"}
                    <DashboardIcon name="chevron" />
                  </button>
                </footer>
              ) : null}
              {report.status === "under_review" ? (
                <footer>
                  {onAccessReportEvidence ? (
                    <button
                      className="dash-button dash-button-secondary"
                      onClick={() => setEvidenceReport(report)}
                      type="button"
                    >
                      <DashboardIcon name="lock" />
                      Acceder a evidencia cifrada
                    </button>
                  ) : null}
                  {onCloseReport ? (
                    <button
                      className="dash-button dash-button-ghost"
                      onClick={() => setClosingReport(report)}
                      type="button"
                    >
                      Cerrar investigación
                    </button>
                  ) : null}
                </footer>
              ) : null}
              {report.status === "closing" ? (
                <div className="dash-report-closing" role="status">
                  <DashboardIcon name="clock" />
                  <div>
                    <strong>Cierre en proceso</strong>
                    <span>
                      La evidencia cifrada ya no está disponible para revisión.
                    </span>
                    {report.closureJob ? (
                      <>
                        <span>
                          {report.closureJob.attempts === 0
                            ? "Ejecución programada"
                            : `${report.closureJob.attempts} ${
                                report.closureJob.attempts === 1
                                  ? "intento realizado"
                                  : "intentos realizados"
                              }`}
                          {` · Próxima ejecución o reintento: ${formatDateTime(
                            report.closureJob.nextAttemptAt,
                          )}`}
                        </span>
                        {report.closureJob.lastAttemptAt ? (
                          <span>
                            Último intento: {formatDateTime(
                              report.closureJob.lastAttemptAt,
                            )}
                          </span>
                        ) : null}
                        {report.closureJob.lastErrorCode ? (
                          <span className="dash-report-closure-error">
                            Último error: {reportClosureErrorLabel(
                              report.closureJob.lastErrorCode,
                            )}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span>Esperando confirmación del proceso de cierre.</span>
                    )}
                  </div>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <InlineEmpty text="No hay reportes para revisar." />
      )}
      {reportsPagination ? (
        <PaginationControls
          ariaLabel="Paginación de reportes"
          disabled={isChangingPage}
          entityLabel="reportes"
          onPageChange={(page) => void changePage(page)}
          pagination={reportsPagination}
        />
      ) : null}
      {evidenceReport && onAccessReportEvidence ? (
        <AdminReportEvidenceAccessDialog
          onCancel={() => setEvidenceReport(undefined)}
          onConfirm={(input) =>
            onAccessReportEvidence(evidenceReport.id, input)
          }
          report={evidenceReport}
        />
      ) : null}
      {closingReport && onCloseReport ? (
        <AdminReportCloseDialog
          onCancel={() => setClosingReport(undefined)}
          onConfirm={async (input) => {
            await onCloseReport(closingReport.id, input);
            setClosingReport(undefined);
          }}
          report={closingReport}
        />
      ) : null}
    </section>
  );
}

function ReportLifecycle({ report }: { report: AdminReport }) {
  const events = [
    { label: "Revisión iniciada", value: report.reviewStartedAt },
    { label: "Cierre solicitado", value: report.closeRequestedAt },
    { label: "Caso cerrado", value: report.closedAt },
    { label: "Evidencia eliminada", value: report.evidencePurgedAt },
    { label: "Aviso generado", value: report.subjectNotifiedAt },
  ].filter(
    (event): event is { label: string; value: string } =>
      typeof event.value === "string",
  );

  if (events.length === 0) return null;

  return (
    <dl className="dash-report-lifecycle">
      {events.map((event) => (
        <div key={event.label}>
          <dt>{event.label}</dt>
          <dd>
            <time dateTime={event.value}>{formatDateTime(event.value)}</time>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function reportOutcomeLabel(outcome: NonNullable<AdminReport["outcome"]>) {
  const labels: Record<NonNullable<AdminReport["outcome"]>, string> = {
    NO_ACTION: "Sin medidas",
    WARNING: "Advertencia",
    CASHIER_SUSPENDED: "Cajero suspendido",
    CASHIER_DELETED: "Cajero eliminado",
    OTHER: "Otra medida",
  };
  return labels[outcome];
}

function reportClosureErrorLabel(errorCode: string) {
  const labels: Record<string, string> = {
    STORAGE_FAILED: "falló la eliminación de la evidencia cifrada",
    FINALIZE_FAILED: "falló la finalización segura del caso",
  };
  return labels[errorCode] ?? "fallo operativo registrado";
}

function SectionHeading({
  action,
  description,
  eyebrow,
  title,
  titleId,
}: {
  action?: ReactNode;
  description: string;
  eyebrow: string;
  title: string;
  titleId: string;
}) {
  return (
    <header className="dash-section-heading">
      <div>
        <p>{eyebrow}</p>
        <h1 id={titleId}>{title}</h1>
        <span>{description}</span>
      </div>
      {action}
    </header>
  );
}

function OverviewAction({
  count,
  description,
  label,
  onClick,
}: {
  count: number;
  description: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className="dash-overview-action" onClick={onClick} type="button">
      <span>{count}</span>
      <strong>{label}</strong>
      <small>{description}</small>
      <DashboardIcon name="chevron" />
    </button>
  );
}

function TableToolbar({
  onQueryChange,
  placeholder,
  query,
  resultCount,
}: {
  onQueryChange: (value: string) => void;
  placeholder: string;
  query: string;
  resultCount: number;
}) {
  return (
    <div className="dash-table-toolbar">
      <label className="dash-search">
        <DashboardIcon name="search" />
        <span className="dash-visually-hidden">Buscar</span>
        <input
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={placeholder}
          type="search"
          value={query}
        />
      </label>
      <span>{resultCount} resultados</span>
    </div>
  );
}

function PaginationControls({
  ariaLabel,
  disabled,
  entityLabel,
  onPageChange,
  pagination,
}: {
  ariaLabel: string;
  disabled: boolean;
  entityLabel: string;
  onPageChange: (page: number) => void;
  pagination: AdminPagination;
}) {
  const totalPages = Math.max(1, pagination.totalPages);

  return (
    <nav
      aria-label={ariaLabel}
      className="dash-pagination"
    >
      <button
        disabled={disabled || pagination.page <= 1}
        onClick={() => onPageChange(pagination.page - 1)}
        type="button"
      >
        Anterior
      </button>
      <span aria-live="polite">
        Página {pagination.page} de {totalPages} · {pagination.total}{" "}
        {entityLabel}
      </span>
      <button
        disabled={disabled || pagination.page >= totalPages}
        onClick={() => onPageChange(pagination.page + 1)}
        type="button"
      >
        Siguiente
      </button>
    </nav>
  );
}

function UserActions({
  onAction,
  onDelete,
  onEdit,
  onResetPassword,
  user,
}: {
  onAction?: (
    user: AdminUser,
    action: AdminSupportedUserAction,
  ) => void;
  onDelete?: (user: AdminUser) => void;
  onEdit?: (user: AdminUser) => void;
  onResetPassword?: (user: AdminUser) => void;
  user: AdminUser;
}) {
  const manageable =
    user.role !== "admin" && user.status !== "deleted";
  const canVerify =
    user.role === "cashier" &&
    user.status !== "deleted" &&
    user.status !== "suspended" &&
    user.cashierApprovalStatus !== "approved";
  const canSuspend =
    user.role !== "admin" &&
    (user.status === "active" || user.status === "pending");
  const canReactivate =
    user.role !== "admin" && user.status === "suspended";
  const canResetPassword =
    user.role === "cashier" && user.status !== "deleted";

  return (
    <div className="dash-row-actions">
      {canVerify ? (
        <button
          disabled={!onAction}
          onClick={() => onAction?.(user, "verify")}
          type="button"
        >
          Verificar
        </button>
      ) : null}
      <button
        aria-label={`Editar a ${user.username}`}
        disabled={!manageable || !onEdit}
        onClick={() => onEdit?.(user)}
        title={
          manageable
            ? "Modificar los datos administrativos permitidos."
            : "Esta cuenta no admite modificaciones."
        }
        type="button"
      >
        Editar
      </button>
      {canSuspend ? (
        <button
          className="is-danger"
          disabled={!onAction}
          onClick={() => onAction?.(user, "suspend")}
          type="button"
        >
          Suspender
        </button>
      ) : null}
      {canReactivate ? (
        <button
          disabled={!onAction}
          onClick={() => onAction?.(user, "activate")}
          type="button"
        >
          Reactivar
        </button>
      ) : null}
      {user.role === "cashier" ? (
        <button
          aria-label={`Restablecer contraseña de ${user.username}`}
          disabled={!canResetPassword || !onResetPassword}
          onClick={() => onResetPassword?.(user)}
          title={
            canResetPassword
              ? "Cerrar sus sesiones e iniciar una recuperación con uno de sus códigos personales."
              : "Una cuenta eliminada no admite restablecimiento de contraseña."
          }
          type="button"
        >
          Contraseña
        </button>
      ) : null}
      <button
        aria-label={`Eliminar lógicamente a ${user.username}`}
        className="is-danger"
        disabled={!manageable || !onDelete}
        onClick={() => onDelete?.(user)}
        title={
          manageable
            ? "Eliminar lógicamente la cuenta y cerrar sus sesiones."
            : "Esta cuenta no admite eliminación."
        }
        type="button"
      >
        Eliminar
      </button>
    </div>
  );
}

function StatusBadge({ label, tone }: { label: string; tone: string }) {
  return <span className={`dash-status is-${tone}`}>{label}</span>;
}

function InlineEmpty({ text }: { text: string }) {
  return (
    <div className="dash-inline-empty">
      <DashboardIcon name="inbox" />
      <p>{text}</p>
    </div>
  );
}

function assignmentSourceLabel(source: AdminAssignment["source"]) {
  const labels: Record<AdminAssignment["source"], string> = {
    invitation: "Invitación",
    reassignment: "Reasignación automática",
    admin: "Administración",
    unknown: "No informado",
  };
  return labels[source];
}

function subscriptionTone(status: SubscriptionEffectiveStatus) {
  if (status === "active") return "active";
  if (
    status === "grace_period" ||
    status === "scheduled" ||
    status === "expired_pending"
  ) {
    return "pending";
  }
  if (status === "none") return "default";
  return "suspended";
}

function cashierInvitationStatusLabel(
  status: AdminCashierInvitation["status"],
) {
  const labels: Record<AdminCashierInvitation["status"], string> = {
    active: "Activa",
    expired: "Vencida",
    redeemed: "Canjeada",
    revoked: "Revocada",
  };
  return labels[status];
}

function cashierInvitationStatusTone(
  status: AdminCashierInvitation["status"],
) {
  if (status === "active") return "active";
  if (status === "expired") return "pending";
  if (status === "revoked") return "suspended";
  return "default";
}

function adminActionTitle(action: PendingAdminAction) {
  if (action.kind === "assignment") return "Reasignar cliente";
  if (action.kind === "delete") return "Eliminar cuenta";
  if (action.kind === "invitation") return "Revocar invitación";
  if (action.kind === "subscription") {
    return action.action === "activate"
      ? "Activar suscripción"
      : "Desactivar suscripción";
  }

  const labels: Record<AdminSupportedUserAction, string> = {
    verify: "Verificar cajero",
    suspend: "Suspender usuario",
    activate: "Reactivar usuario",
  };
  return labels[action.action];
}

function adminActionLabel(action: PendingAdminAction) {
  if (action.kind === "assignment") return "Reasignar";
  if (action.kind === "delete") return "Eliminar cuenta";
  if (action.kind === "invitation") return "Revocar invitación";
  if (action.kind === "subscription") {
    return action.action === "activate" ? "Activar" : "Desactivar";
  }

  const labels: Record<AdminSupportedUserAction, string> = {
    verify: "Verificar",
    suspend: "Suspender",
    activate: "Reactivar",
  };
  return labels[action.action];
}

function adminActionDescription(action: PendingAdminAction) {
  if (action.kind === "assignment") {
    return `El cliente @${action.assignment.clientUsername} será asignado a otro cajero disponible. Confirma que deseas continuar.`;
  }
  if (action.kind === "delete") {
    return action.user.role === "cashier"
      ? `La cuenta de @${action.user.username} quedará eliminada, sus sesiones se cerrarán y sus clientes se reasignarán. Los chats conservarán su ciclo normal de 48 horas.`
      : `La cuenta de @${action.user.username} quedará eliminada, sus sesiones y relaciones activas se cerrarán. Los chats conservarán su ciclo normal de 48 horas.`;
  }
  if (action.kind === "invitation") {
    return `La invitación ${action.invitation.id} dejará de admitir registros. Esta acción no expone ni recupera su código.`;
  }
  if (action.kind === "subscription") {
    const verb = action.action === "activate" ? "activar" : "desactivar";
    return `Vas a ${verb} la suscripción de @${action.subscription.cashierUsername}. Confirma que deseas continuar.`;
  }

  const verb: Record<AdminSupportedUserAction, string> = {
    verify: "verificar",
    suspend: "suspender",
    activate: "reactivar",
  };
  return `Vas a ${verb[action.action]} la cuenta de @${action.user.username}. Confirma que deseas continuar.`;
}

function isDangerousAdminAction(action: PendingAdminAction) {
  return (
    (action.kind === "user" && action.action === "suspend") ||
    (action.kind === "subscription" && action.action === "deactivate") ||
    action.kind === "delete" ||
    action.kind === "invitation"
  );
}
