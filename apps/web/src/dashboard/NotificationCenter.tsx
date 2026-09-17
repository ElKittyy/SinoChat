import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  InAppNotification,
  InAppNotificationType,
  NotificationsAdapter,
} from "../api";
import { DashboardIcon } from "./DashboardIcon";

const NOTIFICATION_LIMIT = 50;

interface NotificationState {
  error?: string;
  isRefreshing: boolean;
  items: readonly InAppNotification[];
  status: "idle" | "loading" | "ready" | "error";
  unreadCount: number;
}

export interface NotificationCenterControls {
  dialog: ReactNode;
  notificationCount: number;
  openNotifications: () => void;
}

const initialState: NotificationState = {
  isRefreshing: false,
  items: [],
  status: "idle",
  unreadCount: 0,
};

/**
 * Mantiene los avisos únicamente en memoria. `scopeKey` separa las sesiones y
 * evita que una respuesta tardía de un usuario se aplique a otro.
 */
export function useNotificationCenter(
  adapter: NotificationsAdapter | undefined,
  scopeKey: string,
): NotificationCenterControls {
  const [isOpen, setIsOpen] = useState(false);
  const [state, setState] = useState<NotificationState>(initialState);
  const [isMutating, setIsMutating] = useState(false);
  const loadAbortRef = useRef<AbortController | undefined>(undefined);
  const mutationAbortRef = useRef<AbortController | undefined>(undefined);
  const loadGenerationRef = useRef(0);
  const mutationInFlightRef = useRef(false);
  const scopeRef = useRef(scopeKey);

  const refresh = useCallback(
    async (showInitialLoading = false) => {
      const generation = ++loadGenerationRef.current;
      loadAbortRef.current?.abort();

      if (!adapter) {
        setState((current) => ({
          ...current,
          error: "El servicio de avisos no está disponible en esta sesión.",
          isRefreshing: false,
          status: "error",
        }));
        return;
      }

      const controller = new AbortController();
      loadAbortRef.current = controller;
      setState((current) => ({
        ...current,
        error: undefined,
        isRefreshing: true,
        status:
          showInitialLoading && current.items.length === 0
            ? "loading"
            : current.status === "idle"
              ? "loading"
              : current.status,
      }));

      try {
        const data = await adapter.load(NOTIFICATION_LIMIT, controller.signal);
        if (
          controller.signal.aborted ||
          generation !== loadGenerationRef.current ||
          scopeRef.current !== scopeKey
        ) {
          return;
        }
        setState({
          isRefreshing: false,
          items: data.items,
          status: "ready",
          unreadCount: data.unreadCount,
        });
      } catch (error) {
        if (
          controller.signal.aborted ||
          generation !== loadGenerationRef.current ||
          isAbortError(error)
        ) {
          return;
        }
        setState((current) => ({
          ...current,
          error: notificationErrorMessage(
            error,
            "No pudimos cargar tus avisos. Inténtalo nuevamente.",
          ),
          isRefreshing: false,
          status: current.items.length > 0 ? "ready" : "error",
        }));
      }
    },
    [adapter, scopeKey],
  );

  useEffect(() => {
    scopeRef.current = scopeKey;
    setIsOpen(false);
    setIsMutating(false);
    setState(initialState);
    mutationInFlightRef.current = false;
    mutationAbortRef.current?.abort();
    void refresh(true);

    return () => {
      scopeRef.current = "";
      loadGenerationRef.current += 1;
      loadAbortRef.current?.abort();
      mutationAbortRef.current?.abort();
      mutationInFlightRef.current = false;
    };
  }, [refresh, scopeKey]);

  const openNotifications = useCallback(() => {
    setIsOpen(true);
    void refresh(false);
  }, [refresh]);

  const runMutation = useCallback(
    async (
      operation: (signal: AbortSignal) => Promise<void>,
      applyResult: (current: NotificationState, readAt: string) => NotificationState,
    ) => {
      if (mutationInFlightRef.current) return;
      mutationInFlightRef.current = true;
      setIsMutating(true);
      setState((current) => ({ ...current, error: undefined }));

      const operationScope = scopeKey;
      const controller = new AbortController();
      mutationAbortRef.current = controller;

      try {
        await operation(controller.signal);
        if (controller.signal.aborted || scopeRef.current !== operationScope) {
          return;
        }
        const readAt = new Date().toISOString();
        setState((current) => applyResult(current, readAt));
        await refresh(false);
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        setState((current) => ({
          ...current,
          error: notificationErrorMessage(
            error,
            "No pudimos actualizar el aviso. Inténtalo nuevamente.",
          ),
          status: current.items.length > 0 ? "ready" : "error",
        }));
      } finally {
        if (scopeRef.current === operationScope) {
          mutationInFlightRef.current = false;
          setIsMutating(false);
        }
      }
    },
    [refresh, scopeKey],
  );

  const markRead = useCallback(
    async (notificationId: string) => {
      if (!adapter) return;
      await runMutation(
        (signal) => adapter.markRead(notificationId, signal),
        (current, readAt) => {
          let changed = false;
          const items = current.items.map((item) => {
            if (item.id !== notificationId || item.readAt) return item;
            changed = true;
            return { ...item, readAt };
          });
          return {
            ...current,
            items,
            unreadCount: changed
              ? Math.max(0, current.unreadCount - 1)
              : current.unreadCount,
          };
        },
      );
    },
    [adapter, runMutation],
  );

  const markAllRead = useCallback(async () => {
    if (!adapter) return;
    await runMutation(
      (signal) => adapter.markAllRead(signal),
      (current, readAt) => ({
        ...current,
        items: current.items.map((item) =>
          item.readAt ? item : { ...item, readAt },
        ),
        unreadCount: 0,
      }),
    );
  }, [adapter, runMutation]);

  return {
    dialog: isOpen ? (
      <NotificationCenterDialog
        isMutating={isMutating}
        onClose={() => setIsOpen(false)}
        onMarkAllRead={markAllRead}
        onMarkRead={markRead}
        onRefresh={() => void refresh(false)}
        state={state}
      />
    ) : null,
    notificationCount: state.unreadCount,
    openNotifications,
  };
}

function NotificationCenterDialog({
  isMutating,
  onClose,
  onMarkAllRead,
  onMarkRead,
  onRefresh,
  state,
}: {
  isMutating: boolean;
  onClose: () => void;
  onMarkAllRead: () => Promise<void>;
  onMarkRead: (notificationId: string) => Promise<void>;
  onRefresh: () => void;
  state: NotificationState;
}) {
  const descriptionId = useId();
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    closeButtonRef.current?.focus();

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  const isBusy = state.isRefreshing || isMutating;

  return (
    <div
      className="dash-dialog-backdrop dash-notifications-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        aria-busy={isBusy}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="dash-dialog dash-notifications-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <header className="dash-notifications-heading">
          <span aria-hidden="true" className="dash-dialog-icon">
            <DashboardIcon name="bell" />
          </span>
          <div>
            <h2 id={titleId}>Centro de avisos</h2>
            <p id={descriptionId}>
              Actualizaciones de tu cuenta sin contenido ni vistas previas de los chats.
            </p>
          </div>
          <button
            className="dash-button dash-button-ghost dash-notifications-close"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            Cerrar
          </button>
        </header>

        <div className="dash-notifications-toolbar">
          <p aria-live="polite">
            {state.unreadCount === 0
              ? "No tienes avisos sin leer"
              : state.unreadCount === 1
                ? "1 aviso sin leer"
                : `${state.unreadCount} avisos sin leer`}
          </p>
          <div>
            <button
              className="dash-button dash-button-ghost"
              disabled={isBusy}
              onClick={onRefresh}
              type="button"
            >
              <DashboardIcon name="refresh" />
              Actualizar
            </button>
            <button
              className="dash-button dash-button-primary"
              disabled={isBusy || state.unreadCount === 0}
              onClick={() => void onMarkAllRead()}
              type="button"
            >
              <DashboardIcon name="check" />
              Marcar todas como leídas
            </button>
          </div>
        </div>

        {state.error ? (
          <div className="dash-notifications-error" role="alert">
            <DashboardIcon name="report" />
            <span>{state.error}</span>
            <button disabled={isBusy} onClick={onRefresh} type="button">
              Reintentar
            </button>
          </div>
        ) : null}

        {state.status === "loading" && state.items.length === 0 ? (
          <div className="dash-notifications-state" role="status">
            <span aria-hidden="true" className="dash-notifications-spinner" />
            <strong>Cargando avisos</strong>
            <p>Consultando las actualizaciones más recientes de tu cuenta.</p>
          </div>
        ) : state.status === "error" && state.items.length === 0 ? (
          <div className="dash-notifications-state">
            <DashboardIcon name="report" />
            <strong>No se pudieron cargar los avisos</strong>
            <p>Usa el botón Reintentar para consultar el servicio nuevamente.</p>
          </div>
        ) : state.items.length === 0 ? (
          <div className="dash-notifications-state">
            <DashboardIcon name="inbox" />
            <strong>Todavía no hay avisos</strong>
            <p>Las novedades administrativas y de actividad aparecerán aquí.</p>
          </div>
        ) : (
          <ul className="dash-notifications-list">
            {state.items.map((item) => {
              const presentation = notificationPresentation(item.type);
              return (
                <li className={item.readAt ? "" : "is-unread"} key={item.id}>
                  <span aria-hidden="true" className="dash-notification-kind">
                    <DashboardIcon name={presentation.icon} />
                  </span>
                  <div className="dash-notification-copy">
                    <div>
                      <strong>{presentation.title}</strong>
                      {!item.readAt ? <b>Nuevo</b> : null}
                    </div>
                    <p>{presentation.description}</p>
                    <span className="dash-notification-dates">
                      <time dateTime={item.createdAt}>
                        {formatNotificationDate(item.createdAt)}
                      </time>
                      {item.readAt ? (
                        <small>
                          Leído el {formatNotificationDate(item.readAt)}
                        </small>
                      ) : null}
                      {item.expiresAt ? (
                        <small>
                          Disponible hasta {formatNotificationDate(item.expiresAt)}
                        </small>
                      ) : null}
                    </span>
                  </div>
                  {!item.readAt ? (
                    <button
                      className="dash-button dash-button-ghost"
                      disabled={isBusy}
                      onClick={() => void onMarkRead(item.id)}
                      type="button"
                    >
                      Marcar como leído
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        <p className="dash-notifications-footnote">
          Se muestran hasta {NOTIFICATION_LIMIT} avisos recientes. SinoChat no
          guarda estos datos en el almacenamiento local de este dispositivo.
        </p>
      </section>
    </div>
  );
}

type NotificationPresentation = {
  description: string;
  icon: "bell" | "chat" | "check" | "refresh" | "report" | "shield";
  title: string;
};

export function notificationPresentation(
  type: InAppNotificationType,
): NotificationPresentation {
  switch (type) {
    case "NEW_MESSAGE":
      return {
        title: "Nuevo mensaje",
        description: "Hay actividad nueva en una de tus conversaciones.",
        icon: "chat",
      };
    case "MESSAGE_DELIVERED":
      return {
        title: "Mensaje entregado",
        description: "Un mensaje enviado desde tu cuenta fue entregado.",
        icon: "check",
      };
    case "MESSAGE_READ":
      return {
        title: "Mensaje leído",
        description: "Un participante confirmó la lectura de un mensaje enviado.",
        icon: "check",
      };
    case "ASSIGNMENT_CHANGED":
      return {
        title: "Asignación actualizada",
        description: "Se actualizó una asignación vinculada con tu cuenta.",
        icon: "refresh",
      };
    case "ACCOUNT_STATUS_CHANGED":
      return {
        title: "Estado de cuenta actualizado",
        description: "Cambió el estado administrativo de tu cuenta.",
        icon: "shield",
      };
    case "REPORT_RESOLVED":
      return {
        title: "Reporte resuelto",
        description: "Finalizó una revisión administrativa relacionada con tu cuenta.",
        icon: "report",
      };
    case "REPORT_WARNING":
      return {
        title: "Advertencia administrativa",
        description:
          "Una revisión relacionada con tu cuenta finalizó con una advertencia.",
        icon: "report",
      };
  }
}

export function formatNotificationDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Fecha no disponible";
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function notificationErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
