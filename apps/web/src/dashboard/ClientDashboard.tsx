import { useState } from "react";
import { ActionReasonDialog } from "./ActionReasonDialog";
import { ChatPanel } from "./ChatPanel";
import { DashboardIcon } from "./DashboardIcon";
import { DashboardShell } from "./DashboardShell";
import type {
  ChatConversation,
  DashboardCommonProps,
  MaybePromise,
} from "./types";

export interface ClientDashboardProps extends DashboardCommonProps {
  conversation: ChatConversation | null;
  onReportCashier?: (conversationId: string, reason: string) => MaybePromise;
  onSendImage?: (conversationId: string, file: File) => MaybePromise;
  onSendText?: (conversationId: string, text: string) => MaybePromise;
}

export function ClientDashboard({
  conversation,
  currentUser,
  notificationCount,
  notificationsOverlay,
  onLogout,
  onOpenNotifications,
  onReportCashier,
  onSendImage,
  onSendText,
  systemNotice,
}: ClientDashboardProps) {
  const [isReportPending, setIsReportPending] = useState(false);
  const cashierName =
    conversation?.participant.displayName ||
    conversation?.participant.username ||
    "tu cajero";

  async function confirmAction(reason: string) {
    if (!conversation || !isReportPending) return;
    await onReportCashier?.(conversation.id, reason);
    setIsReportPending(false);
  }

  const headerActions = conversation ? (
    onReportCashier ? (
      <button
        className="dash-chat-action-button is-danger"
        onClick={() => setIsReportPending(true)}
        type="button"
      >
        <DashboardIcon name="block" />
        <span>Bloquear y reportar</span>
      </button>
    ) : null
  ) : null;

  return (
    <DashboardShell
      currentUser={currentUser}
      notificationCount={notificationCount}
      notificationsOverlay={notificationsOverlay}
      onLogout={onLogout}
      onOpenNotifications={onOpenNotifications}
      roleLabel="Cliente"
      systemNotice={systemNotice}
    >
      <div className="dash-client-layout">
        {conversation ? (
          <ChatPanel
            conversation={conversation}
            currentUserId={currentUser.id}
            headerActions={headerActions}
            onSendImage={onSendImage}
            onSendText={onSendText}
          />
        ) : (
          <section className="dash-large-empty" aria-labelledby="client-empty-title">
            <span aria-hidden="true">
              <DashboardIcon name="inbox" />
            </span>
            <h1 id="client-empty-title">Buscando tu conversación</h1>
            <p>
              Todavía no hay un chat disponible. Tu cuenta permanece vinculada a un
              cajero y el acceso aparecerá aquí cuando esté listo.
            </p>
          </section>
        )}
      </div>

      {isReportPending ? (
        <ActionReasonDialog
          actionLabel="Bloquear y enviar reporte"
          description={`Dejarás de comunicarte con ${cashierName}, el chat vigente se conservará cifrado para revisión y se te asignará otro cajero disponible.`}
          isDangerous
          onCancel={() => setIsReportPending(false)}
          onConfirm={confirmAction}
          title={`Bloquear y reportar a ${cashierName}`}
        />
      ) : null}
    </DashboardShell>
  );
}
