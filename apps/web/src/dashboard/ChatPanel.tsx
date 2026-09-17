import {
  Fragment,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Avatar, PrivacyBar } from "./DashboardShell";
import { DashboardIcon } from "./DashboardIcon";
import {
  dayKey,
  deliveryLabel,
  expiryLabel,
  formatDay,
  formatTime,
  presenceLabel,
} from "./formatters";
import type {
  ChatConversation,
  ChatMessage,
  MaybePromise,
} from "./types";

const MAX_MESSAGE_LENGTH = 4000;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

interface ChatPanelProps {
  conversation: ChatConversation;
  currentUserId: string;
  headerActions?: ReactNode;
  onBack?: () => void;
  onSendImage?: (conversationId: string, file: File) => MaybePromise;
  onSendText?: (conversationId: string, text: string) => MaybePromise;
}

export function ChatPanel({
  conversation,
  currentUserId,
  headerActions,
  onBack,
  onSendImage,
  onSendText,
}: ChatPanelProps) {
  const composerId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [composerError, setComposerError] = useState<string>();
  const participantName =
    conversation.participant.displayName || conversation.participant.username;
  const normalizedDraft = draft.trim();
  const canSend = Boolean(onSendImage || onSendText);

  async function sendText(event?: FormEvent) {
    event?.preventDefault();
    if (!onSendText || !normalizedDraft || isSending) return;

    setIsSending(true);
    setComposerError(undefined);
    try {
      await onSendText(conversation.id, normalizedDraft);
      setDraft("");
    } catch (error) {
      setComposerError(sendErrorMessage(error));
    } finally {
      setIsSending(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void sendText();
    }
  }

  async function handleImageSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || !onSendImage) return;

    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      setComposerError("Formato no permitido. Usa JPG, JPEG, PNG o WebP.");
      return;
    }

    if (file.size > MAX_IMAGE_SIZE) {
      setComposerError("La imagen supera el límite de 5 MB.");
      return;
    }

    setIsSending(true);
    setComposerError(undefined);
    try {
      await onSendImage(conversation.id, file);
    } catch (error) {
      setComposerError(sendErrorMessage(error));
    } finally {
      setIsSending(false);
    }
  }

  return (
    <section
      aria-label={`Conversación con ${participantName}`}
      className="dash-chat-panel"
    >
      <header className="dash-chat-header">
        {onBack ? (
          <button
            aria-label="Volver a la lista de clientes"
            className="dash-icon-button dash-chat-back"
            onClick={onBack}
            type="button"
          >
            <DashboardIcon name="arrow-left" />
          </button>
        ) : null}
        <Avatar identity={conversation.participant} />
        <div className="dash-chat-person">
          <h1>{participantName}</h1>
          <p>
            <span
              aria-hidden="true"
              className={`dash-presence-dot is-${conversation.participant.presence}`}
            />
            {conversation.isTyping
              ? "Escribiendo…"
              : presenceLabel(
                  conversation.participant.presence,
                  conversation.participant.lastSeenAt,
                )}
          </p>
        </div>
        {headerActions ? (
          <div className="dash-chat-actions">{headerActions}</div>
        ) : null}
      </header>

      <PrivacyBar />

      <div
        aria-live="polite"
        aria-relevant="additions text"
        className="dash-message-list"
        role="log"
      >
        {conversation.messages.length === 0 ? (
          <ChatEmptyState canSend={canSend} participantName={participantName} />
        ) : (
          conversation.messages.map((message, index) => {
            const previousMessage = conversation.messages[index - 1];
            const startsDay =
              !previousMessage ||
              dayKey(previousMessage.sentAt) !== dayKey(message.sentAt);

            return (
              <Fragment key={message.id}>
                {startsDay ? (
                  <p className="dash-day-divider">
                    <span>{formatDay(message.sentAt)}</span>
                  </p>
                ) : null}
                <MessageBubble
                  isOwn={message.senderId === currentUserId}
                  message={message}
                  participantName={participantName}
                />
              </Fragment>
            );
          })
        )}
        {conversation.isTyping ? (
          <div
            aria-label={`${participantName} está escribiendo`}
            className="dash-typing-indicator"
          >
            <span />
            <span />
            <span />
          </div>
        ) : null}
      </div>

      <form className="dash-composer" onSubmit={(event) => void sendText(event)}>
        {composerError ? (
          <p className="dash-composer-error" role="alert">
            {composerError}
          </p>
        ) : null}
        <div className="dash-composer-row">
          <input
            accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
            aria-label="Seleccionar una foto"
            className="dash-visually-hidden"
            disabled={!onSendImage || isSending}
            onChange={(event) => void handleImageSelection(event)}
            ref={fileInputRef}
            type="file"
          />
          <button
            aria-label="Adjuntar una foto"
            className="dash-icon-button dash-attach-button"
            disabled={!onSendImage || isSending}
            onClick={() => fileInputRef.current?.click()}
            title="Adjuntar foto (máximo 5 MB)"
            type="button"
          >
            <DashboardIcon name="image" />
          </button>

          <label className="dash-visually-hidden" htmlFor={composerId}>
            Mensaje
          </label>
          <textarea
            disabled={!onSendText || isSending}
            id={composerId}
            maxLength={MAX_MESSAGE_LENGTH}
            onChange={(event) => {
              setDraft(event.target.value);
              setComposerError(undefined);
            }}
            onKeyDown={handleComposerKeyDown}
            placeholder="Escribe un mensaje…"
            rows={1}
            value={draft}
          />
          <button
            aria-label="Enviar mensaje"
            className="dash-send-button"
            disabled={!onSendText || !normalizedDraft || isSending}
            type="submit"
          >
            <DashboardIcon name="send" />
          </button>
        </div>
        <div className="dash-composer-help">
          <span>JPG, PNG o WebP · Máximo 5 MB</span>
          <span
            className={draft.length >= MAX_MESSAGE_LENGTH ? "is-limit" : ""}
          >
            {draft.length}/{MAX_MESSAGE_LENGTH}
          </span>
        </div>
      </form>
    </section>
  );
}

function MessageBubble({
  isOwn,
  message,
  participantName,
}: {
  isOwn: boolean;
  message: ChatMessage;
  participantName: string;
}) {
  const status = isOwn ? deliveryLabel(message.deliveryStatus) : undefined;

  return (
    <article
      aria-label={`Mensaje ${isOwn ? "tuyo" : `de ${participantName}`}`}
      className={`dash-message${isOwn ? " is-own" : ""}`}
    >
      <div className="dash-message-bubble">
        {message.kind === "text" ? (
          <p>{message.text}</p>
        ) : (
          <>
            <img
              className="dash-message-image"
              loading="lazy"
              src={message.image.url}
              alt={message.image.alt}
            />
            {message.caption ? <p>{message.caption}</p> : null}
          </>
        )}
        <footer>
          <time dateTime={message.sentAt}>{formatTime(message.sentAt)}</time>
          {status ? (
            <span
              aria-label={status}
              className={`dash-delivery-status is-${message.deliveryStatus}`}
              title={status}
            >
              <DashboardIcon name="check" />
              {message.deliveryStatus === "delivered" ||
              message.deliveryStatus === "read" ? (
                <DashboardIcon name="check" />
              ) : null}
            </span>
          ) : null}
        </footer>
      </div>
      <span className="dash-expiry-label" title={expiryLabel(message.expiresAt)}>
        <DashboardIcon name="clock" />
        {expiryLabel(message.expiresAt)}
      </span>
    </article>
  );
}

function ChatEmptyState({
  canSend,
  participantName,
}: {
  canSend: boolean;
  participantName: string;
}) {
  return (
    <div className="dash-chat-empty">
      <span aria-hidden="true">
        <DashboardIcon name="chat" />
      </span>
      <h2>{canSend ? "La conversación está lista" : "Conversación asignada"}</h2>
      {canSend ? (
        <p>
          Envía el primer mensaje a {participantName}. El contenido estará
          disponible durante 48 horas.
        </p>
      ) : (
        <p>
          El historial y el envío se habilitarán cuando termine la preparación
          del cifrado de extremo a extremo.
        </p>
      )}
    </div>
  );
}

function sendErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "No se pudo enviar. Revisa tu conexión e inténtalo nuevamente.";
}
