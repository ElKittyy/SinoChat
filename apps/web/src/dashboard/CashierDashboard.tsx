import { useMemo, useState, type FormEvent } from "react";
import type { CashierRegistrationResult } from "../access";
import { ActionReasonDialog } from "./ActionReasonDialog";
import { ChatPanel } from "./ChatPanel";
import { DashboardIcon } from "./DashboardIcon";
import { Avatar, DashboardShell } from "./DashboardShell";
import { formatDateTime } from "./formatters";
import type {
  ChatConversation,
  DashboardCommonProps,
  MaybePromise,
} from "./types";

export interface CashierDashboardProps extends DashboardCommonProps {
  conversations: readonly ChatConversation[];
  hasMoreConversations?: boolean;
  invitationCode?: string;
  invitationUrl?: string;
  selectedConversationId?: string;
  subscriptionLabel?: string;
  onBlockClient?: (clientId: string, reason: string) => MaybePromise;
  onCopyInvitation?: (invitationUrl: string) => MaybePromise;
  onLoadMoreConversations?: () => MaybePromise;
  onRegenerateInvitation?: () => MaybePromise;
  onRotateRecoveryCodes?: (
    currentPassword: string,
  ) => MaybePromise<CashierRegistrationResult>;
  onSelectConversation: (conversationId: string | null) => void;
  onSendImage?: (conversationId: string, file: File) => MaybePromise;
  onSendText?: (conversationId: string, text: string) => MaybePromise;
}

export function CashierDashboard({
  conversations,
  currentUser,
  hasMoreConversations = false,
  invitationCode,
  invitationUrl,
  notificationCount,
  notificationsOverlay,
  onBlockClient,
  onCopyInvitation,
  onLogout,
  onLoadMoreConversations,
  onOpenNotifications,
  onRegenerateInvitation,
  onRotateRecoveryCodes,
  onSelectConversation,
  onSendImage,
  onSendText,
  selectedConversationId,
  subscriptionLabel = "Estado no disponible",
  systemNotice,
}: CashierDashboardProps) {
  const [query, setQuery] = useState("");
  const [isBlocking, setIsBlocking] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string>();
  const [copyLabel, setCopyLabel] = useState("Copiar enlace");
  const [isRotatingRecoveryCodes, setIsRotatingRecoveryCodes] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase("es");
  const selectedConversation = conversations.find(
    (conversation) => conversation.id === selectedConversationId,
  );
  const filteredConversations = useMemo(() => {
    if (!normalizedQuery) return conversations;
    return conversations.filter((conversation) => {
      const name =
        conversation.participant.displayName ||
        conversation.participant.username;
      return `${name} ${conversation.participant.username}`
        .toLocaleLowerCase("es")
        .includes(normalizedQuery);
    });
  }, [conversations, normalizedQuery]);

  async function copyInvitation() {
    if (!onCopyInvitation || !invitationUrl) return;
    try {
      await onCopyInvitation(invitationUrl);
      setCopyLabel("Enlace copiado");
    } catch {
      setCopyLabel("No se pudo copiar");
    }
    window.setTimeout(() => setCopyLabel("Copiar enlace"), 1800);
  }

  async function blockSelectedClient(reason: string) {
    if (!selectedConversation || !onBlockClient) return;
    await onBlockClient(selectedConversation.participant.id, reason);
    setIsBlocking(false);
  }

  async function loadMoreConversations() {
    if (!onLoadMoreConversations || isLoadingMore) return;
    setIsLoadingMore(true);
    setLoadMoreError(undefined);
    try {
      await onLoadMoreConversations();
    } catch (error) {
      setLoadMoreError(actionErrorMessage(error));
    } finally {
      setIsLoadingMore(false);
    }
  }

  return (
    <DashboardShell
      currentUser={currentUser}
      notificationCount={notificationCount}
      notificationsOverlay={notificationsOverlay}
      onLogout={onLogout}
      onOpenNotifications={onOpenNotifications}
      roleLabel="Cajero"
      systemNotice={systemNotice}
    >
      <div
        className={`dash-cashier-layout${
          selectedConversation ? " has-selected-chat" : ""
        }`}
      >
        <aside className="dash-conversation-sidebar" aria-label="Clientes">
          <InvitationCard
            code={invitationCode}
            copyLabel={copyLabel}
            onCopy={
              onCopyInvitation && invitationUrl
                ? () => void copyInvitation()
                : undefined
            }
            onRegenerate={onRegenerateInvitation}
            onManageRecoveryCodes={
              onRotateRecoveryCodes
                ? () => setIsRotatingRecoveryCodes(true)
                : undefined
            }
            subscriptionLabel={subscriptionLabel}
          />

          <div className="dash-sidebar-heading">
            <div>
              <p>Conversaciones</p>
              <h1>Mis clientes</h1>
            </div>
            <span aria-label={`${conversations.length} clientes`}>
              {conversations.length}
            </span>
          </div>

          <label className="dash-search">
            <DashboardIcon name="search" />
            <span className="dash-visually-hidden">Buscar cliente</span>
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar por usuario…"
              type="search"
              value={query}
            />
          </label>

          <nav className="dash-conversation-list" aria-label="Chats con clientes">
            {filteredConversations.length > 0 ? (
              filteredConversations.map((conversation) => (
                <ConversationListItem
                  conversation={conversation}
                  isSelected={conversation.id === selectedConversationId}
                  key={conversation.id}
                  onSelect={() => onSelectConversation(conversation.id)}
                />
              ))
            ) : (
              <div className="dash-list-empty">
                <DashboardIcon name="search" />
                <p>
                  {conversations.length === 0
                    ? "Aún no tienes clientes asignados."
                    : "No encontramos clientes con ese nombre."}
                </p>
              </div>
            )}
            {hasMoreConversations && onLoadMoreConversations ? (
              <div className="dash-conversation-load-more">
                <button
                  className="dash-button dash-button-ghost"
                  disabled={isLoadingMore}
                  onClick={() => void loadMoreConversations()}
                  type="button"
                >
                  {isLoadingMore ? "Cargando…" : "Cargar más clientes"}
                </button>
                {loadMoreError ? <p role="alert">{loadMoreError}</p> : null}
              </div>
            ) : null}
          </nav>
        </aside>

        <div className="dash-cashier-chat">
          {selectedConversation ? (
            <ChatPanel
              conversation={selectedConversation}
              currentUserId={currentUser.id}
              headerActions={
                onBlockClient ? (
                  <button
                    className="dash-chat-action-button is-danger"
                    onClick={() => setIsBlocking(true)}
                    type="button"
                  >
                    <DashboardIcon name="block" />
                    <span>Bloquear cliente</span>
                  </button>
                ) : null
              }
              onBack={() => onSelectConversation(null)}
              onSendImage={onSendImage}
              onSendText={onSendText}
            />
          ) : (
            <section
              aria-labelledby="cashier-empty-title"
              className="dash-large-empty"
            >
              <span aria-hidden="true">
                <DashboardIcon name="chat" />
              </span>
              <h1 id="cashier-empty-title">Selecciona una conversación</h1>
              <p>
                Elige un cliente de la lista para abrir su chat privado. Aquí no se
                muestra contenido a otros cajeros ni al administrador.
              </p>
            </section>
          )}
        </div>
      </div>

      {isBlocking && selectedConversation ? (
        <ActionReasonDialog
          actionLabel="Bloquear y reasignar"
          description={`El cliente ${
            selectedConversation.participant.displayName ||
            selectedConversation.participant.username
          } será reasignado a otro cajero disponible. Este bloqueo contará para la revisión de su cuenta.`}
          isDangerous
          onCancel={() => setIsBlocking(false)}
          onConfirm={blockSelectedClient}
          title="Bloquear cliente"
        />
      ) : null}
      {isRotatingRecoveryCodes && onRotateRecoveryCodes ? (
        <RecoveryCodesRotationDialog
          onCancel={() => setIsRotatingRecoveryCodes(false)}
          onRotate={onRotateRecoveryCodes}
        />
      ) : null}
    </DashboardShell>
  );
}

function InvitationCard({
  code,
  copyLabel,
  onCopy,
  onManageRecoveryCodes,
  onRegenerate,
  subscriptionLabel,
}: {
  code?: string;
  copyLabel: string;
  onCopy?: () => void;
  onManageRecoveryCodes?: () => void;
  onRegenerate?: () => MaybePromise;
  subscriptionLabel: string;
}) {
  return (
    <section className="dash-invitation-card" aria-labelledby="invitation-title">
      <div className="dash-invitation-heading">
        <span aria-hidden="true">
          <DashboardIcon name="shield" />
        </span>
        <div>
          <p id="invitation-title">Código de invitación</p>
          <small>{subscriptionLabel}</small>
        </div>
      </div>
      <code>{code || "No disponible"}</code>
      <div className="dash-invitation-actions">
        {onCopy ? (
          <button onClick={onCopy} type="button">
            <DashboardIcon name="copy" />
            {copyLabel}
          </button>
        ) : null}
        {onRegenerate ? (
          <button onClick={() => void onRegenerate()} type="button">
            <DashboardIcon name="refresh" />
            Cambiar código
          </button>
        ) : null}
        {onManageRecoveryCodes ? (
          <button onClick={onManageRecoveryCodes} type="button">
            <DashboardIcon name="lock" />
            Códigos de respaldo
          </button>
        ) : null}
      </div>
    </section>
  );
}

function RecoveryCodesRotationDialog({
  onCancel,
  onRotate,
}: {
  onCancel: () => void;
  onRotate: (
    currentPassword: string,
  ) => MaybePromise<CashierRegistrationResult>;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [result, setResult] = useState<CashierRegistrationResult>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(undefined);
    try {
      const rotated = await onRotate(currentPassword);
      setCurrentPassword("");
      setResult(rotated);
    } catch (caughtError) {
      setError(actionErrorMessage(caughtError));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function copyCodes() {
    if (!result || !navigator.clipboard?.writeText) {
      setCopyStatus("Selecciona y copia los códigos manualmente.");
      return;
    }
    try {
      await navigator.clipboard.writeText(result.recoveryCodes.join("\n"));
      setCopyStatus("Códigos copiados.");
    } catch {
      setCopyStatus("No se pudo usar el portapapeles. Cópialos manualmente.");
    }
  }

  return (
    <div className="dash-dialog-backdrop">
      <section
        aria-labelledby="cashier-recovery-title"
        aria-modal="true"
        className="dash-dialog dash-management-dialog"
        role="dialog"
      >
        <span aria-hidden="true" className="dash-dialog-icon">
          <DashboardIcon name="lock" />
        </span>
        <h2 id="cashier-recovery-title">
          {result ? "Guarda tus códigos nuevos" : "Rotar códigos de recuperación"}
        </h2>
        {result ? (
          <div className="dash-dialog-form-grid">
            <p>
              Los códigos anteriores ya no sirven. Estos ocho se muestran una
              sola vez y no vencen hasta que se usen o vuelvas a rotarlos.
            </p>
            <ol className="recovery-code-list">
              {result.recoveryCodes.map((code) => (
                <li key={code}><code>{code}</code></li>
              ))}
            </ol>
            <button
              className="dash-button dash-button-ghost"
              onClick={() => void copyCodes()}
              type="button"
            >
              Copiar los 8 códigos
            </button>
            {copyStatus ? <p role="status">{copyStatus}</p> : null}
            <label className="dash-dialog-check">
              <input
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.currentTarget.checked)}
                type="checkbox"
              />
              Confirmo que guardé los nuevos códigos de forma segura.
            </label>
            <button
              className="dash-button dash-button-primary"
              disabled={!acknowledged}
              onClick={onCancel}
              type="button"
            >
              Finalizar
            </button>
          </div>
        ) : (
          <form className="dash-dialog-form-grid" onSubmit={submit}>
            <p>
              Esta acción invalida todos tus códigos anteriores. Confirma con
              tu contraseña actual.
            </p>
            <label className="dash-dialog-field">
              <span>Contraseña actual</span>
              <input
                autoComplete="current-password"
                autoFocus
                disabled={isSubmitting}
                maxLength={128}
                minLength={10}
                onChange={(event) => setCurrentPassword(event.currentTarget.value)}
                required
                type="password"
                value={currentPassword}
              />
            </label>
            {error ? <p className="dash-form-error" role="alert">{error}</p> : null}
            <div className="dash-dialog-actions">
              <button
                className="dash-button dash-button-ghost"
                disabled={isSubmitting}
                onClick={onCancel}
                type="button"
              >
                Cancelar
              </button>
              <button
                className="dash-button dash-button-primary"
                disabled={isSubmitting || currentPassword.length < 10}
                type="submit"
              >
                {isSubmitting ? "Rotando…" : "Rotar códigos"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}

function ConversationListItem({
  conversation,
  isSelected,
  onSelect,
}: {
  conversation: ChatConversation;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const name =
    conversation.participant.displayName || conversation.participant.username;

  return (
    <button
      aria-current={isSelected ? "page" : undefined}
      className={`dash-conversation-item${isSelected ? " is-selected" : ""}`}
      onClick={onSelect}
      type="button"
    >
      <span className="dash-list-avatar">
        <Avatar identity={conversation.participant} />
        <i
          aria-label={
            conversation.participant.presence === "online"
              ? "En línea"
              : "Desconectado"
          }
          className={`dash-presence-dot is-${conversation.participant.presence}`}
        />
      </span>
      <span className="dash-conversation-copy">
        <span>
          <strong>{name}</strong>
          <time dateTime={conversation.lastActivityAt}>
            {conversation.lastActivityAt
              ? formatDateTime(conversation.lastActivityAt)
              : ""}
          </time>
        </span>
        <span>
          <small>
            {conversation.isTyping
              ? "Escribiendo…"
              : conversation.lastMessagePreview || "Sin mensajes"}
          </small>
          {conversation.unreadCount > 0 ? (
            <b aria-label={`${conversation.unreadCount} mensajes sin leer`}>
              {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
            </b>
          ) : null}
        </span>
      </span>
    </button>
  );
}

function actionErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "No se pudieron cargar más clientes. Inténtalo nuevamente.";
}
