import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { AccessActions } from "./access";
import { AdminMfaGate } from "./components/AdminMfaGate";
import {
  isApiError,
  SESSION_INVALID_EVENT,
  type AdminPanelData,
  type ApplicationApi,
  type CashierInvitationData,
  type CashierPanelData,
  type ClientPanelData,
  type SessionUser,
} from "./api";
import {
  AccessPanel,
  type AccessView,
  type InvitationDraft,
} from "./components/AccessPanel";
import {
  LegalPage,
  type PublicInformationView,
} from "./components/LegalPage";
import {
  consumeInvitationFragment,
  createInvitationUrl,
  INVITATION_PATH,
} from "./invitation-fragment";
import { useNotificationCenter } from "./dashboard/NotificationCenter";
import type { ChatConversation, DashboardNotice } from "./dashboard/types";
import type { MatrixSessionLifecycleResult } from "./e2ee/matrixSessionLifecycle";
import { MatrixLocalDeviceStoreError } from "./e2ee/matrixLocalDeviceStore";
import { sinochatDeviceIdFromMatrixDeviceId } from "@sinochat/contracts";
import type { SecureMessageController } from "./secureMessageController";
import { nextConversationExpiry, pruneExpiredConversation, useLocalMessageExpiry } from "./localMessageRetention";

const AdminDashboard = lazy(async () => {
  const dashboard = await import("./dashboard/AdminDashboard");
  return { default: dashboard.AdminDashboard };
});
const CashierDashboard = lazy(async () => {
  const dashboard = await import("./dashboard/CashierDashboard");
  return { default: dashboard.CashierDashboard };
});
const ClientDashboard = lazy(async () => {
  const dashboard = await import("./dashboard/ClientDashboard");
  return { default: dashboard.ClientDashboard };
});

interface AppProps {
  api?: ApplicationApi;
  accessActions?: AccessActions;
}

type AppView = AccessView | PublicInformationView | "app";

interface AppRoute {
  invitation?: InvitationDraft;
  view: AppView;
}

type SessionState =
  | { status: "idle" | "loading" }
  | { status: "authenticated"; user: SessionUser }
  | { status: "error"; message: string; unauthorized: boolean };

type PanelPayload =
  | { role: "CLIENT"; data: ClientPanelData }
  | {
      role: "CASHIER";
      data: CashierPanelData;
      invitation?: CashierInvitationData;
    }
  | { role: "ADMIN"; data: AdminPanelData };

type PanelState =
  | { status: "idle" | "loading" }
  | {
      status: "ready" | "unavailable" | "error";
      payload: PanelPayload;
      message?: string;
    };

type MatrixClientState =
  | { status: "idle" | "loading" }
  | { status: "ready"; controller: SecureMessageController }
  | { status: "blocked"; message: string }
  | { status: "error"; message: string };

export function App({ accessActions, api }: AppProps) {
  const [route, setRoute] = useState<AppRoute>(() => routeFromLocation());
  const [session, setSession] = useState<SessionState>({ status: "idle" });
  const [panel, setPanel] = useState<PanelState>({ status: "idle" });
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [matrixAttempt, setMatrixAttempt] = useState(0);
  const [matrixClient, setMatrixClient] = useState<MatrixClientState>({
    status: "idle",
  });
  const stopMatrixRef = useRef<(() => void) | undefined>(undefined);
  const matrixShutdownRef = useRef<Promise<void>>(Promise.resolve());
  const expireLocalMessages = useCallback((now: number) => {
    setPanel((current) => pruneExpiredPanelMessages(current, now));
  }, []);
  useLocalMessageExpiry(nextConversationExpiry(panelConversations(panel)), expireLocalMessages);

  const navigate = useCallback(
    (view: AccessView, invitation?: InvitationDraft, replace = false) => {
      const nextInvitation =
        invitation ??
        (view.startsWith("register") || view === "invitation"
          ? route.invitation
          : undefined);
      const path = pathForView(view);

      if (replace) {
        window.history.replaceState(null, "", path);
      } else {
        window.history.pushState(null, "", path);
      }

      setRoute({ view, invitation: nextInvitation });
    },
    [route.invitation],
  );

  const enterApp = useCallback(() => {
    window.history.replaceState(null, "", "/app");
    setRoute({ view: "app" });
  }, []);

  const connectedAccessActions = useMemo(() => {
    const actions = api?.access ?? accessActions;
    if (!actions) return undefined;

    return wrapAccessActions(actions, enterApp);
  }, [accessActions, api?.access, enterApp]);

  const loadPanel = useCallback(
    async (user: SessionUser, signal?: AbortSignal) => {
      setPanel({ status: "loading" });
      const nextPanel = await resolvePanel(api, user, signal);
      setPanel(nextPanel);
    },
    [api],
  );

  useEffect(() => {
    const handlePopState = () =>
      setRoute((current) => routeFromLocation(current.invitation));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const handleInvalidSession = () => {
      stopMatrixRef.current?.();
      setSession({
        status: "error",
        message: "Tu sesión terminó. Vuelve a iniciar sesión.",
        unauthorized: true,
      });
      setPanel({ status: "idle" });
    };
    window.addEventListener(SESSION_INVALID_EVENT, handleInvalidSession);
    return () =>
      window.removeEventListener(
        SESSION_INVALID_EVENT,
        handleInvalidSession,
      );
  }, []);

  useEffect(() => {
    if (route.view === "app") {
      const title =
        session.status === "authenticated"
          ? dashboardTitle(session.user.role)
          : "Acceso seguro";
      document.title = `${title} | SinoChat`;
      return;
    }

    document.title = `${titleForView(route.view)} | SinoChat`;
    if (!isPublicInformationView(route.view)) {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>("#access-title")?.focus();
      });
    }
  }, [route.view, session]);

  useEffect(() => {
    if (route.view === "app") return;

    const registrationWithoutInvitation =
      (route.view === "register-client" &&
        route.invitation?.role !== "cliente") ||
      (route.view === "register-cashier" &&
        route.invitation?.role !== "cajero");

    if (registrationWithoutInvitation) {
      navigate("invitation", undefined, true);
    }
  }, [navigate, route.invitation, route.view]);

  useEffect(() => {
    if (route.view !== "app") return;

    if (!api) {
      setSession({
        status: "error",
        message: "La conexión con la API autenticada no está configurada.",
        unauthorized: false,
      });
      return;
    }

    const controller = new AbortController();
    setSession({ status: "loading" });
    setPanel({ status: "idle" });

    void api.session
      .getCurrentUser(controller.signal)
      .then(async (user) => {
        if (controller.signal.aborted) return;
        setSession({ status: "authenticated", user });
        if (
          user.role === "ADMIN" &&
          user.adminMfa &&
          (!user.adminMfa.enrolled || !user.adminMfa.verified)
        ) {
          setPanel({ status: "idle" });
          return;
        }
        await loadPanel(user, controller.signal);
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        setSession({
          status: "error",
          message: messageFromApiError(
            error,
            "No pudimos comprobar tu sesión. Inténtalo nuevamente.",
          ),
          unauthorized: isApiError(error) && error.status === 401,
        });
        setPanel({ status: "idle" });
      });

    return () => controller.abort();
  }, [api, loadPanel, route.view, sessionAttempt]);

  useEffect(() => {
    stopMatrixRef.current?.();
    stopMatrixRef.current = undefined;
    const previousShutdown = matrixShutdownRef.current;

    if (
      route.view !== "app" ||
      session.status !== "authenticated" ||
      !api ||
      session.user.role === "ADMIN"
    ) {
      setMatrixClient({ status: "idle" });
      return;
    }

    const controller = new AbortController();
    let handle: MatrixSessionLifecycleResult | undefined;
    let messageController: SecureMessageController | undefined;
    let runPromise = Promise.resolve();
    const stop = () => {
      controller.abort();
      matrixShutdownRef.current = runPromise.catch(() => undefined);
    };
    stopMatrixRef.current = stop;
    setMatrixClient({ status: "loading" });

    runPromise = (async () => {
      await previousShutdown;
      if (controller.signal.aborted) return;
      try {
        const {
          MatrixSessionLifecycle,
          MatrixSessionLifecycleError,
          runMatrixSyncLoop,
        } = await import("./e2ee/matrixSessionLifecycle");
        if (controller.signal.aborted) return;
        const lifecycle = new MatrixSessionLifecycle(api.e2ee);
        const started = await lifecycle.start(
          session.user,
          controller.signal,
        );
        handle = started;
        if (controller.signal.aborted) {
          return;
        }
        if (started.state === "blocked") {
          setMatrixClient({ status: "blocked", message: started.message });
          return;
        }
        if (started.state !== "ready") {
          setMatrixClient({ status: "idle" });
          return;
        }
        const { SecureMessageController } = await import(
          "./secureMessageController"
        );
        if (controller.signal.aborted) return;
        messageController = new SecureMessageController(
          api.messages,
          started.messages,
          session.user.id,
          sinochatDeviceIdFromMatrixDeviceId(started.identity.deviceId),
        );
        setMatrixClient({ status: "ready", controller: messageController });
        await runMatrixSyncLoop(
          started.coordinator,
          controller.signal,
          (result) => {
            if (result.rejectedApplicationEventCount > 0) {
              throw new MatrixSessionLifecycleError(
                "MATRIX_APPLICATION_EVENT_ON_CONTROL_CHANNEL",
              );
            }
          },
        );
      } catch (error: unknown) {
        if (isAbortError(error) || controller.signal.aborted) return;
        setMatrixClient({
          status: "error",
          message: matrixErrorMessage(error),
        });
      } finally {
        messageController?.close();
        messageController = undefined;
        const current = handle;
        handle = undefined;
        if (current) {
          try {
            await current.close();
          } catch (error) {
            if (!controller.signal.aborted) {
              setMatrixClient({
                status: "error",
                message: matrixErrorMessage(error),
              });
            }
          }
        }
      }
    })();

    return () => {
      stop();
      if (stopMatrixRef.current === stop) {
        stopMatrixRef.current = undefined;
      }
    };
  }, [api, matrixAttempt, route.view, session]);

  function followInternalLink(
    event: MouseEvent<HTMLAnchorElement>,
    view: AccessView,
  ) {
    event.preventDefault();
    navigate(view);
  }

  function acceptInvitation(invitation: InvitationDraft) {
    navigate(
      invitation.role === "cliente" ? "register-client" : "register-cashier",
      invitation,
    );
  }

  function goToLogin() {
    stopMatrixRef.current?.();
    setSession({ status: "idle" });
    setPanel({ status: "idle" });
    navigate("login", undefined, true);
  }

  async function logout() {
    if (!api) {
      goToLogin();
      return;
    }

    stopMatrixRef.current?.();
    try {
      await api.session.logout();
      goToLogin();
    } catch (error) {
      setMatrixAttempt((attempt) => attempt + 1);
      setPanel((current) =>
        panelWithError(
          current,
          messageFromApiError(
            error,
            "No pudimos cerrar tu sesión. Inténtalo nuevamente.",
          ),
        ),
      );
    }
  }

  if (route.view === "app") {
    if (session.status !== "authenticated") {
      return (
        <SessionBoundary
          session={session}
          onLogin={goToLogin}
          onRetry={() => setSessionAttempt((attempt) => attempt + 1)}
        />
      );
    }

    if (
      session.user.role === "ADMIN" &&
      session.user.adminMfa &&
      (!session.user.adminMfa.enrolled || !session.user.adminMfa.verified)
    ) {
      if (!api) {
        return <SessionBoundary session={{ status: "loading" }} />;
      }
      return (
        <AdminMfaGate
          adapter={api.adminMfa}
          mfa={session.user.adminMfa}
          onComplete={() =>
            setSessionAttempt((currentAttempt) => currentAttempt + 1)
          }
          onLogout={logout}
          username={session.user.username}
        />
      );
    }

    return (
      <DashboardErrorBoundary onLogin={goToLogin}>
        <Suspense fallback={<SessionBoundary session={{ status: "loading" }} />}>
          <AuthenticatedPanel
            api={api}
            onLogout={logout}
            onPanelChange={setPanel}
            matrixClient={matrixClient}
            onMatrixRetry={() =>
              setMatrixAttempt((attempt) => attempt + 1)
            }
            onRetry={() => void loadPanel(session.user)}
            panel={panel}
            user={session.user}
          />
        </Suspense>
      </DashboardErrorBoundary>
    );
  }

  if (isPublicInformationView(route.view)) {
    return <LegalPage view={route.view} />;
  }

  return (
    <div className="site-shell">
      <a className="skip-link" href="#main-content">
        Saltar al contenido principal
      </a>

      <header className="site-header">
        <nav className="nav" aria-label="Navegación principal">
          <a
            className="brand"
            href="/"
            aria-label="SinoChat, ir al inicio"
            onClick={(event) => followInternalLink(event, "welcome")}
          >
            <img src="/assets/sinochat-logo.png" alt="SinoChat" />
          </a>
          <div className="nav-actions">
            <a
              className="nav-link"
              href="/invitacion"
              onClick={(event) => followInternalLink(event, "invitation")}
            >
              Tengo un código
            </a>
            <a
              className="button button-gold nav-login"
              href="/ingresar"
              aria-current={route.view === "login" ? "page" : undefined}
              onClick={(event) => followInternalLink(event, "login")}
            >
              Iniciar sesión
            </a>
          </div>
        </nav>
      </header>

      <main className="hero" id="main-content">
        <section className="hero-copy" aria-labelledby="hero-title">
          <p className="eyebrow">
            <span aria-hidden="true" />
            Comunicación privada
          </p>
          <h1 id="hero-title">
            Tu conversación.
            <strong>Segura y directa.</strong>
          </h1>
          <p className="hero-description">
            SinoChat está diseñado para una comunicación privada con tu cajero
            asignado. El chat se habilitará únicamente cuando el cifrado de extremo a
            extremo esté integrado y auditado; sus mensajes serán temporales por 48
            horas.
          </p>

          <div className="trust-row" aria-label="Características principales">
            <div>
              <span className="trust-icon" aria-hidden="true">
                48
              </span>
              <span>
                <b>Mensajes temporales</b>
                Texto y fotos se eliminan a las 48 horas
              </span>
            </div>
            <div>
              <span className="trust-icon" aria-hidden="true">
                E2E
              </span>
              <span>
                <b>Cifrado de extremo a extremo</b>
                Requisito de seguridad previo a habilitar el chat
              </span>
            </div>
            <div>
              <span className="trust-icon" aria-hidden="true">
                1:1
              </span>
              <span>
                <b>Atención personalizada</b>
                Un chat privado con tu cajero asignado
              </span>
            </div>
          </div>

          <p className="adult-notice">
            <span aria-hidden="true">18+</span>
            Servicio exclusivo para personas mayores de edad. No compartas información
            sensible.
          </p>
        </section>

        <div className="access-column">
          <AccessPanel
            actions={connectedAccessActions}
            invitation={route.invitation}
            onCashierRegistrationAcknowledged={enterApp}
            onInvitationAccepted={acceptInvitation}
            onNavigate={(view) => navigate(view)}
            view={route.view}
          />
          <p className="encryption-caption">
            <MiniLockIcon />
            Cifrado E2EE en integración y pendiente de auditoría
          </p>
        </div>
      </main>

      <footer className="site-footer">
        <span>© 2026 SinoChat</span>
        <p>Privacidad por diseño · Mensajes efímeros</p>
        <nav aria-label="Información legal">
          <a href="/terminos">Términos</a>
          <a href="/privacidad">Privacidad</a>
          <a href="/seguridad">Seguridad</a>
        </nav>
      </footer>

      <div className="decorative-bubble bubble-red" aria-hidden="true" />
      <div className="decorative-bubble bubble-gold" aria-hidden="true" />
    </div>
  );
}

function AuthenticatedPanel({
  api,
  matrixClient,
  onLogout,
  onMatrixRetry,
  onPanelChange,
  onRetry,
  panel,
  user,
}: {
  api?: ApplicationApi;
  matrixClient: MatrixClientState;
  onLogout: () => Promise<void>;
  onMatrixRetry: () => void;
  onPanelChange: (state: PanelState | ((current: PanelState) => PanelState)) => void;
  onRetry: () => void;
  panel: PanelState;
  user: SessionUser;
}) {
  const currentUser = { id: user.id, username: user.username };
  const notice = dashboardNotice(
    panel,
    user,
    matrixClient,
    onRetry,
    onMatrixRetry,
  );
  const notifications = useNotificationCenter(api?.notifications, user.id);
  useSecureConversationSync(matrixClient, panel, onPanelChange);

  if (!("payload" in panel)) {
    return <SessionBoundary session={{ status: "loading" }} />;
  }

  if (panel.payload.role !== user.role) {
    return <SessionBoundary session={{ status: "loading" }} />;
  }

  if (panel.payload.role === "CLIENT") {
    const adapter = api?.panels.client;
    const secureController =
      matrixClient.status === "ready" ? matrixClient.controller : undefined;
    const sendText = secureController
      ? async (conversationId: string, text: string) => {
          const conversation = requirePanelConversation(panel, conversationId);
          await secureController.sendText(conversation, text);
          const refreshed = await secureController.load(conversation);
          onPanelChange((current) =>
            mergeSecureConversation(current, refreshed),
          );
        }
      : undefined;
    const sendImage = secureController
      ? async (conversationId: string, file: File) => {
          const conversation = requirePanelConversation(panel, conversationId);
          await secureController.sendImage(conversation, file);
          const refreshed = await secureController.load(conversation);
          onPanelChange((current) =>
            mergeSecureConversation(current, refreshed),
          );
        }
      : undefined;
    return (
      <ClientDashboard
        conversation={panel.payload.data.conversation}
        currentUser={currentUser}
        notificationCount={notifications.notificationCount}
        notificationsOverlay={notifications.dialog}
        onLogout={onLogout}
        onOpenNotifications={notifications.openNotifications}
        onReportCashier={adapter?.reportCashier}
        onSendImage={sendImage}
        onSendText={sendText}
        systemNotice={notice}
      />
    );
  }

  if (panel.payload.role === "CASHIER") {
    const adapter = api?.panels.cashier;
    const cashierData = panel.payload.data;
    const invitation = panel.payload.invitation;
    const invitationUrl = invitation
      ? createInvitationUrl(window.location.origin, {
          code: invitation.code,
          role: "cliente",
        })
      : undefined;
    const secureController =
      matrixClient.status === "ready" ? matrixClient.controller : undefined;
    const sendText = secureController
      ? async (conversationId: string, text: string) => {
          const conversation = requirePanelConversation(panel, conversationId);
          await secureController.sendText(conversation, text);
          const refreshed = await secureController.load(conversation);
          onPanelChange((current) =>
            mergeSecureConversation(current, refreshed),
          );
        }
      : undefined;
    const sendImage = secureController
      ? async (conversationId: string, file: File) => {
          const conversation = requirePanelConversation(panel, conversationId);
          await secureController.sendImage(conversation, file);
          const refreshed = await secureController.load(conversation);
          onPanelChange((current) =>
            mergeSecureConversation(current, refreshed),
          );
        }
      : undefined;

    return (
      <CashierDashboard
        conversations={cashierData.conversations}
        currentUser={currentUser}
        invitationCode={invitation?.code}
        invitationUrl={invitationUrl}
        hasMoreConversations={cashierData.conversationHasMore}
        notificationCount={notifications.notificationCount}
        notificationsOverlay={notifications.dialog}
        onBlockClient={
          adapter?.blockClient
            ? async (clientId, reason) => {
                await adapter.blockClient?.(clientId, reason);
                onPanelChange((current) =>
                  removeCashierClient(current, clientId),
                );
              }
            : undefined
        }
        onCopyInvitation={
          invitationUrl
            ? async (value) => {
                await copyInvitation(value);
              }
            : undefined
        }
        onLogout={onLogout}
        onLoadMoreConversations={
          adapter?.load && cashierData.conversationHasMore
            ? async () => {
                const nextPage = await adapter.load?.({
                  limit: cashierData.conversationLimit,
                  page: cashierData.conversationPage + 1,
                });
                if (!nextPage) return;
                onPanelChange((current) =>
                  appendCashierConversationPage(current, nextPage),
                );
              }
            : undefined
        }
        onOpenNotifications={notifications.openNotifications}
        onRegenerateInvitation={
          adapter?.rotateInvitation
            ? async () => {
                try {
                  const nextInvitation = await adapter.rotateInvitation?.();
                  if (!nextInvitation) return;
                  onPanelChange((current) =>
                    updateCashierInvitation(current, nextInvitation),
                  );
                } catch (error) {
                  onPanelChange((current) =>
                    panelWithError(
                      current,
                      messageFromApiError(
                        error,
                        "No pudimos cambiar el código de invitación.",
                      ),
                    ),
                  );
                }
              }
            : undefined
        }
        onRotateRecoveryCodes={adapter?.rotateRecoveryCodes}
        onSelectConversation={(conversationId) =>
          onPanelChange((current) =>
            selectCashierConversation(current, conversationId),
          )
        }
        onSendImage={sendImage}
        onSendText={sendText}
        selectedConversationId={cashierData.selectedConversationId}
        subscriptionLabel={
          user.status === "PENDING"
            ? "Cuenta pendiente de aprobación"
            : cashierData.subscriptionLabel
        }
        systemNotice={notice}
      />
    );
  }

  const adapter = api?.panels.admin;
  const adminData = panel.payload.data;

  async function withAdminMfaStepUp<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        !isApiError(error) ||
        error.code !== "ADMIN_MFA_STEP_UP_REQUIRED" ||
        !api
      ) {
        throw error;
      }
      await api.adminMfa.authenticate();
      return operation();
    }
  }

  const refreshAdminData = async ({
    assignmentPage = adminData.assignmentsPagination.page,
    cashierInvitationPage = adminData.cashierInvitationsPagination.page,
    cashierInvitationStatus = adminData.cashierInvitationsFilter,
    reportPage = adminData.reportsPagination.page,
    subscriptionPage = adminData.subscriptionsPagination.page,
    userPage = adminData.usersPagination.page,
  }: {
    assignmentPage?: number;
    cashierInvitationPage?: number;
    cashierInvitationStatus?: typeof adminData.cashierInvitationsFilter;
    reportPage?: number;
    subscriptionPage?: number;
    userPage?: number;
  } = {}) => {
    if (!adapter?.load) return;

    try {
      const data = await adapter.load({
        assignmentPage,
        assignmentPageSize: adminData.assignmentsPagination.pageSize,
        cashierInvitationPage,
        cashierInvitationPageSize:
          adminData.cashierInvitationsPagination.pageSize,
        cashierInvitationStatus,
        reportPage,
        reportPageSize: adminData.reportsPagination.pageSize,
        subscriptionPage,
        subscriptionPageSize: adminData.subscriptionsPagination.pageSize,
        userPage,
        userPageSize: adminData.usersPagination.pageSize,
      });
      onPanelChange({
        status: data.loadIssues?.length ? "error" : "ready",
        payload: { role: "ADMIN", data },
        ...(data.loadIssues?.length
          ? {
              message: `No pudimos actualizar: ${data.loadIssues.join(", ")}. Las demás secciones siguen disponibles.`,
            }
          : {}),
      });
    } catch (error) {
      onPanelChange((current) =>
        panelWithError(
          current,
          messageFromApiError(
            error,
            "No pudimos actualizar los datos administrativos.",
          ),
        ),
      );
    }
  };

  return (
    <AdminDashboard
      assignments={adminData.assignments}
      assignmentsPagination={adminData.assignmentsPagination}
      cashierInvitations={adminData.cashierInvitations}
      cashierInvitationsFilter={adminData.cashierInvitationsFilter}
      cashierInvitationsPagination={
        adminData.cashierInvitationsPagination
      }
      currentUser={currentUser}
      loadAdminPasskeys={
        api ? (signal) => api.adminMfa.listPasskeys(signal) : undefined
      }
      loadAdminSessions={
        api ? (signal) => api.session.listAdminSessions(signal) : undefined
      }
      notificationCount={notifications.notificationCount}
      notificationsOverlay={notifications.dialog}
      overview={adminData.overview}
      onAddPasskey={
        api
          ? () =>
              withAdminMfaStepUp(async () => {
                const result = await api.adminMfa.enroll();
                if (result.recoveryCodes.length !== 0) {
                  throw new Error(
                    "El alta adicional devolvió material de recuperación inesperado.",
                  );
                }
              })
          : undefined
      }
      onAccessReportEvidence={
        adapter?.accessReportEvidence
          ? (reportId, input) =>
              withAdminMfaStepUp(
                async () =>
                  (await adapter.accessReportEvidence?.(
                    reportId,
                    input,
                  )) as Awaited<
                  ReturnType<NonNullable<typeof adapter.accessReportEvidence>>
                  >,
              )
          : undefined
      }
      onCloseReport={
        adapter?.closeReport
          ? async (reportId, input) => {
              await adapter.closeReport?.(reportId, input);
              await refreshAdminData();
            }
          : undefined
      }
      onCreateCashierInvitation={
        adapter?.createCashierInvitation
          ? async (input) => {
              const invitation =
                await adapter.createCashierInvitation?.(input);
              if (!invitation) {
                throw new Error("No se pudo crear la invitación.");
              }
              await refreshAdminData({ cashierInvitationPage: 1 });
              return invitation;
            }
          : undefined
      }
      onCashierInvitationsFilterChange={
        adapter?.load
          ? async (cashierInvitationStatus) => {
              await refreshAdminData({
                cashierInvitationPage: 1,
                cashierInvitationStatus,
              });
            }
          : undefined
      }
      onCashierInvitationsPageChange={
        adapter?.load
          ? async (cashierInvitationPage) => {
              await refreshAdminData({ cashierInvitationPage });
            }
          : undefined
      }
      onDeleteUser={
        adapter?.deleteUser
          ? async (userId) => {
              await adapter.deleteUser?.(userId);
              await refreshAdminData();
            }
          : undefined
      }
      onLogout={onLogout}
      onOpenNotifications={notifications.openNotifications}
      onOpenReport={
        adapter?.openReport
          ? async (reportId) => {
              await adapter.openReport?.(reportId);
              await refreshAdminData();
            }
          : undefined
      }
      onAssignmentsPageChange={
        adapter?.load
          ? async (assignmentPage) => {
              await refreshAdminData({ assignmentPage });
            }
          : undefined
      }
      onReportsPageChange={
        adapter?.load
          ? async (reportPage) => {
              await refreshAdminData({ reportPage });
            }
          : undefined
      }
      onReassignClient={
        adapter?.reassignClient
          ? async (assignmentId) => {
              await adapter.reassignClient?.(assignmentId);
              await refreshAdminData();
            }
          : undefined
      }
      onRevokeAdminSession={
        api
          ? (sessionId) =>
              withAdminMfaStepUp(async () => {
                const result = await api.session.revokeAdminSession(sessionId);
                if (!result.revoked || result.currentSession) {
                  throw new Error(
                    "La API no confirmó el cierre de la sesión seleccionada.",
                  );
                }
              })
          : undefined
      }
      onRevokeCashierInvitation={
        adapter?.revokeCashierInvitation
          ? async (invitationId) => {
              await adapter.revokeCashierInvitation?.(invitationId);
              await refreshAdminData();
            }
          : undefined
      }
      onRevokeOtherAdminSessions={
        api
          ? () =>
              withAdminMfaStepUp(async () => {
                const result = await api.session.revokeOtherAdminSessions();
                return result.revokedCount;
              })
          : undefined
      }
      onRevokePasskey={
        api
          ? (credentialId) =>
              withAdminMfaStepUp(async () => {
                await api.adminMfa.revokePasskey(credentialId);
              })
          : undefined
      }
      onResetPassword={
        adapter?.resetPassword
          ? async (userId, input) => {
              await adapter.resetPassword?.(userId, input);
              await refreshAdminData();
            }
          : undefined
      }
      onSubscriptionAction={
        adapter?.subscriptionAction
          ? async (cashierId, action) => {
              await adapter.subscriptionAction?.(cashierId, action);
              await refreshAdminData();
            }
          : undefined
      }
      onSubscriptionsPageChange={
        adapter?.load
          ? async (subscriptionPage) => {
              await refreshAdminData({ subscriptionPage });
            }
          : undefined
      }
      onUserAction={
        adapter?.userAction
          ? async (userId, action) => {
              await adapter.userAction?.(userId, action);
              await refreshAdminData();
            }
          : undefined
      }
      onUpdateUser={
        adapter?.updateUser
          ? async (userId, input) => {
              await adapter.updateUser?.(userId, input);
              await refreshAdminData();
            }
          : undefined
      }
      onUsersPageChange={
        adapter?.load
          ? async (userPage) => {
              await refreshAdminData({ userPage });
            }
          : undefined
      }
      reports={adminData.reports}
      reportsPendingTotal={adminData.reportsPendingTotal}
      reportsPagination={adminData.reportsPagination}
      stats={adminData.stats}
      subscriptions={adminData.subscriptions}
      subscriptionsPagination={adminData.subscriptionsPagination}
      systemNotice={notice}
      users={adminData.users}
      usersPagination={adminData.usersPagination}
    />
  );
}

function useSecureConversationSync(
  matrixClient: MatrixClientState,
  panel: PanelState,
  onPanelChange: (
    state: PanelState | ((current: PanelState) => PanelState),
  ) => void,
) {
  const controller =
    matrixClient.status === "ready" ? matrixClient.controller : undefined;
  const selected = secureConversationTarget(panel);
  // Una petición lenta no debe retener en su closure una copia del historial.
  const target = selected ? {
    id: selected.id,
    participant: selected.participant,
    messages: [],
    unreadCount: 0,
  } satisfies ChatConversation : undefined;
  const targetId = target?.id;
  const participantId = target?.participant.id;

  useEffect(() => {
    if (!controller || !target || !targetId || !participantId) return;
    const abortController = new AbortController();
    let timeout: number | undefined;

    const poll = async () => {
      const nextPollDelayMs = 4_000;
      try {
        const conversation = await controller.load(
          target,
          abortController.signal,
        );
        if (abortController.signal.aborted) return;
        onPanelChange((current) =>
          mergeSecureConversation(current, conversation),
        );
        // La caducidad se retira del estado por un reloj independiente: no
        // espera esta consulta ni depende de que la red responda a tiempo.
      } catch (error) {
        if (isAbortError(error) || abortController.signal.aborted) return;
        onPanelChange((current) =>
          panelWithError(
            current,
            messageFromApiError(
              error,
              "No pudimos actualizar el chat cifrado. Reintentaremos automáticamente.",
            ),
          ),
        );
      } finally {
        if (!abortController.signal.aborted) {
          timeout = window.setTimeout(() => void poll(), nextPollDelayMs);
        }
      }
    };

    void poll();
    return () => {
      abortController.abort();
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [controller, onPanelChange, participantId, targetId]);
}

function panelConversations(panel: PanelState): readonly ChatConversation[] {
  if (!("payload" in panel)) return [];
  if (panel.payload.role === "CLIENT") {
    return panel.payload.data.conversation ? [panel.payload.data.conversation] : [];
  }
  return panel.payload.role === "CASHIER" ? panel.payload.data.conversations : [];
}

function pruneExpiredPanelMessages(panel: PanelState, now: number): PanelState {
  if (!("payload" in panel)) return panel;
  const payload = panel.payload;
  if (payload.role === "CLIENT" && payload.data.conversation) {
    const conversation = pruneExpiredConversation(payload.data.conversation, now);
    if (conversation === payload.data.conversation) return panel;
    return { ...panel, payload: { ...payload, data: { ...payload.data, conversation } } };
  }
  if (payload.role === "CASHIER") {
    const conversations = payload.data.conversations.map((item) => pruneExpiredConversation(item, now));
    if (conversations.every((item, index) => item === payload.data.conversations[index])) return panel;
    return { ...panel, payload: { ...payload, data: { ...payload.data, conversations } } };
  }
  return panel;
}

function secureConversationTarget(
  panel: PanelState,
): ChatConversation | undefined {
  if (!("payload" in panel)) return undefined;
  if (panel.payload.role === "CLIENT") {
    return panel.payload.data.conversation ?? undefined;
  }
  if (panel.payload.role === "CASHIER") {
    const selectedConversationId = panel.payload.data.selectedConversationId;
    return panel.payload.data.conversations.find(
      (conversation) => conversation.id === selectedConversationId,
    );
  }
  return undefined;
}

function requirePanelConversation(
  panel: PanelState,
  conversationId: string,
): ChatConversation {
  if (!("payload" in panel)) throw new Error("CONVERSATION_NOT_AVAILABLE");
  const conversation =
    panel.payload.role === "CLIENT"
      ? panel.payload.data.conversation
      : panel.payload.role === "CASHIER"
        ? panel.payload.data.conversations.find(
            (item) => item.id === conversationId,
          )
        : undefined;
  if (!conversation || conversation.id !== conversationId) {
    throw new Error("CONVERSATION_NOT_AVAILABLE");
  }
  return conversation;
}

function mergeSecureConversation(
  panel: PanelState,
  conversation: ChatConversation,
): PanelState {
  if (!("payload" in panel)) return panel;
  const recoveredFromMessageSync =
    panel.status === "error" &&
    panel.message?.includes("chat cifrado") === true;
  const base = {
    ...panel,
    ...(recoveredFromMessageSync
      ? { status: "ready" as const, message: undefined }
      : {}),
  };

  if (panel.payload.role === "CLIENT") {
    if (panel.payload.data.conversation?.id !== conversation.id) return panel;
    return {
      ...base,
      payload: {
        role: "CLIENT",
        data: { ...panel.payload.data, conversation },
      },
    };
  }
  if (panel.payload.role === "CASHIER") {
    if (
      !panel.payload.data.conversations.some(
        (item) => item.id === conversation.id,
      )
    ) {
      return panel;
    }
    return {
      ...base,
      payload: {
        role: "CASHIER",
        invitation: panel.payload.invitation,
        data: {
          ...panel.payload.data,
          conversations: panel.payload.data.conversations.map((item) =>
            item.id === conversation.id ? conversation : item,
          ),
        },
      },
    };
  }
  return panel;
}

class DashboardErrorBoundary extends Component<
  { children: ReactNode; onLogin: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // React conserva el diagnóstico de desarrollo. No registramos props ni
    // estado del panel porque podrían contener metadatos administrativos.
  }

  render() {
    if (this.state.failed) {
      return (
        <SessionBoundary
          onLogin={this.props.onLogin}
          onRetry={() => window.location.reload()}
          session={{
            status: "error",
            message:
              "No pudimos cargar el panel. Recarga la aplicación para volver a intentarlo.",
            unauthorized: false,
          }}
        />
      );
    }
    return this.props.children;
  }
}

function SessionBoundary({
  onLogin,
  onRetry,
  session,
}: {
  onLogin?: () => void;
  onRetry?: () => void;
  session: SessionState;
}) {
  const isLoading = session.status === "idle" || session.status === "loading";

  return (
    <div className="session-boundary">
      <a className="skip-link" href="#session-state">
        Saltar al estado de acceso
      </a>
      <header>
        <a href="/" aria-label="SinoChat, ir al inicio">
          <img src="/assets/sinochat-logo.png" alt="SinoChat" />
        </a>
      </header>
      <main
        aria-busy={isLoading}
        aria-live="polite"
        id="session-state"
        tabIndex={-1}
      >
        <span
          aria-hidden="true"
          className={isLoading ? "session-spinner" : "session-state-icon"}
        >
          {isLoading ? null : "!"}
        </span>
        <h1>
          {isLoading
            ? "Comprobando tu sesión"
            : session.status === "error" && session.unauthorized
              ? "Tu sesión terminó"
              : "No pudimos abrir tu cuenta"}
        </h1>
        <p>
          {isLoading
            ? "Estamos verificando tu acceso seguro con SinoChat."
            : session.status === "error"
              ? session.message
              : ""}
        </p>
        {!isLoading ? (
          <div>
            {onRetry ? (
              <button
                className="button button-primary"
                onClick={onRetry}
                type="button"
              >
                Reintentar
              </button>
            ) : null}
            {onLogin ? (
              <button
                className="button button-secondary"
                onClick={onLogin}
                type="button"
              >
                Ir a iniciar sesión
              </button>
            ) : null}
          </div>
        ) : null}
      </main>
    </div>
  );
}

function wrapAccessActions(
  actions: AccessActions,
  enterApp: () => void,
): AccessActions {
  return {
    validateInvitation: actions.validateInvitation,
    completeAdminReset: actions.completeAdminReset,
    login: actions.login
      ? async (input) => {
          await actions.login?.(input);
          enterApp();
        }
      : undefined,
    registerClient: actions.registerClient
      ? async (input) => {
          await actions.registerClient?.(input);
          enterApp();
        }
      : undefined,
    registerCashier: actions.registerCashier
      ? async (input) => {
          const result = await actions.registerCashier?.(input);
          if (!result) {
            throw new Error(
              "El servidor no devolvió los códigos de recuperación del cajero.",
            );
          }
          return result;
        }
      : undefined,
  };
}

async function resolvePanel(
  api: ApplicationApi | undefined,
  user: SessionUser,
  signal?: AbortSignal,
): Promise<PanelState> {
  if (user.role === "CLIENT") {
    const adapter = api?.panels.client;
    if (!adapter?.load) {
      return {
        status: "unavailable",
        payload: {
          role: "CLIENT",
          data: { conversation: null },
        },
        message:
          "La carga de la conversación todavía no está disponible en el servidor.",
      };
    }

    try {
      return {
        status: "ready",
        payload: { role: "CLIENT", data: await adapter.load(signal) },
      };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return {
        status: "error",
        payload: { role: "CLIENT", data: { conversation: null } },
        message: messageFromApiError(error, "No pudimos cargar tu conversación."),
      };
    }
  }

  if (user.role === "CASHIER") {
    const adapter = api?.panels.cashier;
    let data: CashierPanelData = {
      conversations: [],
      conversationHasMore: false,
      conversationLimit: 50,
      conversationPage: 1,
    };
    let invitation: CashierInvitationData | undefined;
    let loadError: unknown;

    const [panelResult, invitationResult] = await Promise.allSettled([
      adapter?.load
        ? adapter.load(undefined, signal)
        : Promise.resolve(undefined),
      adapter?.getInvitation
        ? adapter.getInvitation(signal)
        : Promise.resolve(undefined),
    ]);

    if (panelResult.status === "fulfilled" && panelResult.value) {
      data = panelResult.value;
    } else if (panelResult.status === "rejected") {
      if (isAbortError(panelResult.reason)) throw panelResult.reason;
      loadError = panelResult.reason;
    }

    if (invitationResult.status === "fulfilled") {
      invitation = invitationResult.value;
    } else if (
      isAbortError(invitationResult.reason)
    ) {
      throw invitationResult.reason;
    } else if (
      !isApiError(invitationResult.reason) ||
      ![403, 404].includes(invitationResult.reason.status)
    ) {
      loadError ??= invitationResult.reason;
    }

    if (loadError) {
      return {
        status: "error",
        payload: { role: "CASHIER", data, invitation },
        message: messageFromApiError(
          loadError,
          "No pudimos cargar todos los datos del panel.",
        ),
      };
    }

    if (!adapter?.load) {
      return {
        status: "unavailable",
        payload: { role: "CASHIER", data, invitation },
        message:
          "El código real está disponible, pero la lista de clientes y conversaciones aún no tiene endpoint.",
      };
    }

    return {
      status: "ready",
      payload: { role: "CASHIER", data, invitation },
    };
  }

  const adapter = api?.panels.admin;
  const emptyAdminData: AdminPanelData = {
    assignments: [],
    assignmentsPagination: {
      page: 1,
      pageSize: 20,
      total: 0,
      totalPages: 0,
    },
    cashierInvitations: [],
    cashierInvitationsFilter: "ALL",
    cashierInvitationsPagination: {
      page: 1,
      pageSize: 20,
      total: 0,
      totalPages: 0,
    },
    overview: {
      inactiveSubscriptions: 0,
      pendingUsers: 0,
    },
    reports: [],
    reportsPendingTotal: 0,
    reportsPagination: {
      page: 1,
      pageSize: 20,
      total: 0,
      totalPages: 0,
    },
    stats: [],
    subscriptions: [],
    subscriptionsPagination: {
      page: 1,
      pageSize: 20,
      total: 0,
      totalPages: 0,
    },
    users: [],
    usersPagination: {
      page: 1,
      pageSize: 20,
      total: 0,
      totalPages: 0,
    },
  };

  if (!adapter?.load) {
    return {
      status: "unavailable",
      payload: { role: "ADMIN", data: emptyAdminData },
      message:
        "Las consultas administrativas todavía no están disponibles en el servidor.",
    };
  }

  try {
    const data = await adapter.load(undefined, signal);
    return {
      status: data.loadIssues?.length ? "error" : "ready",
      payload: { role: "ADMIN", data },
      ...(data.loadIssues?.length
        ? {
            message: `No pudimos cargar: ${data.loadIssues.join(", ")}. Las demás secciones siguen disponibles.`,
          }
        : {}),
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      status: "error",
      payload: { role: "ADMIN", data: emptyAdminData },
      message: messageFromApiError(
        error,
        "No pudimos cargar los datos administrativos.",
      ),
    };
  }
}

function panelNotice(
  panel: PanelState,
  user: SessionUser,
  onRetry: () => void,
): DashboardNotice | undefined {
  if (panel.status === "error") {
    return {
      title: "No se cargaron todos los datos",
      message: panel.message || "Inténtalo nuevamente.",
      tone: "error",
      actionLabel: "Reintentar",
      onAction: onRetry,
    };
  }

  if (panel.status === "unavailable") {
    return {
      title:
        user.status === "PENDING"
          ? "Cuenta pendiente de aprobación"
          : "Funciones en preparación",
      message:
        user.status === "PENDING"
          ? "Podrás recibir clientes cuando el administrador apruebe tu cuenta y active la suscripción."
          : panel.message || "Esta sección todavía no está conectada.",
      tone: "warning",
    };
  }

  if (user.status === "PENDING") {
    return {
      title: "Cuenta pendiente de aprobación",
      message:
        "Podrás recibir clientes cuando el administrador apruebe tu cuenta y active la suscripción.",
      tone: "warning",
    };
  }

  return undefined;
}

function dashboardNotice(
  panel: PanelState,
  user: SessionUser,
  matrixClient: MatrixClientState,
  onPanelRetry: () => void,
  onMatrixRetry: () => void,
): DashboardNotice | undefined {
  const currentPanelNotice = panelNotice(panel, user, onPanelRetry);

  // Los errores de datos y los estados administrativos de la cuenta son más
  // accionables que el estado del transporte cifrado.
  if (
    panel.status === "error" ||
    user.status !== "ACTIVE"
  ) {
    return currentPanelNotice;
  }

  if (matrixClient.status === "error") {
    return {
      title: "No se pudo iniciar el cifrado",
      message: matrixClient.message,
      tone: "error",
      actionLabel: "Reintentar",
      onAction: onMatrixRetry,
    };
  }

  if (matrixClient.status === "blocked") {
    return {
      title: "Chat cifrado temporalmente bloqueado",
      message: matrixClient.message,
      tone: "warning",
    };
  }

  if (matrixClient.status === "loading") {
    return {
      title: "Preparando el cifrado de extremo a extremo",
      message:
        "El chat se habilitará únicamente después de validar este dispositivo.",
      tone: "info",
    };
  }

  return currentPanelNotice;
}

function updateCashierInvitation(
  panel: PanelState,
  invitation: CashierInvitationData,
): PanelState {
  if (
    (panel.status !== "ready" &&
      panel.status !== "unavailable" &&
      panel.status !== "error") ||
    panel.payload.role !== "CASHIER"
  ) {
    return panel;
  }

  return {
    ...panel,
    payload: { ...panel.payload, invitation },
  };
}

function selectCashierConversation(
  panel: PanelState,
  conversationId: string | null,
): PanelState {
  if (
    (panel.status !== "ready" &&
      panel.status !== "unavailable" &&
      panel.status !== "error") ||
    panel.payload.role !== "CASHIER"
  ) {
    return panel;
  }

  return {
    ...panel,
    payload: {
      ...panel.payload,
      data: {
        ...panel.payload.data,
        selectedConversationId: conversationId || undefined,
      },
    },
  };
}

function removeCashierClient(
  panel: PanelState,
  clientId: string,
): PanelState {
  if (
    (panel.status !== "ready" &&
      panel.status !== "unavailable" &&
      panel.status !== "error") ||
    panel.payload.role !== "CASHIER"
  ) {
    return panel;
  }

  const removedConversation = panel.payload.data.conversations.find(
    (conversation) => conversation.participant.id === clientId,
  );
  return {
    ...panel,
    payload: {
      ...panel.payload,
      data: {
        ...panel.payload.data,
        conversations: panel.payload.data.conversations.filter(
          (conversation) => conversation.participant.id !== clientId,
        ),
        selectedConversationId:
          removedConversation?.id ===
          panel.payload.data.selectedConversationId
            ? undefined
            : panel.payload.data.selectedConversationId,
      },
    },
  };
}

function appendCashierConversationPage(
  panel: PanelState,
  next: CashierPanelData,
): PanelState {
  if (
    (panel.status !== "ready" &&
      panel.status !== "unavailable" &&
      panel.status !== "error") ||
    panel.payload.role !== "CASHIER"
  ) {
    return panel;
  }

  const current = panel.payload.data;
  if (
    next.conversationPage !== current.conversationPage + 1 ||
    next.conversationLimit !== current.conversationLimit
  ) {
    return panelWithError(
      panel,
      "El servidor devolvió una página de conversaciones inesperada.",
    );
  }

  const knownIds = new Set(
    current.conversations.map((conversation) => conversation.id),
  );
  return {
    ...panel,
    payload: {
      ...panel.payload,
      data: {
        ...current,
        conversations: [
          ...current.conversations,
          ...next.conversations.filter(
            (conversation) => !knownIds.has(conversation.id),
          ),
        ],
        conversationHasMore: next.conversationHasMore,
        conversationLimit: next.conversationLimit,
        conversationPage: next.conversationPage,
      },
    },
  };
}

function panelWithError(panel: PanelState, message: string): PanelState {
  if (
    panel.status !== "ready" &&
    panel.status !== "unavailable" &&
    panel.status !== "error"
  ) {
    return panel;
  }
  return { ...panel, status: "error", message };
}

async function copyInvitation(value: string) {
  if (!navigator.clipboard?.writeText) {
    throw new Error("El navegador no permite copiar el enlace automáticamente.");
  }
  await navigator.clipboard.writeText(value);
}

function routeFromLocation(memoryInvitation?: InvitationDraft): AppRoute {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";

  if (path === "/app" || path.startsWith("/app/")) {
    return { view: "app" };
  }

  if (path === "/ingresar") {
    return { view: "login" };
  }

  if (path === INVITATION_PATH) {
    const fragmentInvitation = consumeInvitationFragment(
      window.location,
      window.history,
    );
    return {
      view: "invitation",
      invitation: fragmentInvitation ?? memoryInvitation,
    };
  }

  if (path.startsWith(`${INVITATION_PATH}/`)) {
    // No se aceptan enlaces heredados que expongan el secreto en el path.
    window.history.replaceState(null, "", INVITATION_PATH);
    return { view: "invitation" };
  }

  if (path === "/registro/cliente") {
    clearHistoryState();
    return { view: "register-client", invitation: memoryInvitation };
  }

  if (path === "/registro/cajero") {
    clearHistoryState();
    return { view: "register-cashier", invitation: memoryInvitation };
  }

  if (path === "/terminos") return { view: "terms" };
  if (path === "/privacidad") return { view: "privacy" };
  if (path === "/seguridad") return { view: "security" };

  return { view: "welcome" };
}

function pathForView(view: AccessView) {
  if (view === "login") return "/ingresar";
  if (view === "invitation") return INVITATION_PATH;
  if (view === "register-client") return "/registro/cliente";
  if (view === "register-cashier") return "/registro/cajero";
  return "/";
}

function clearHistoryState() {
  if (window.history.state === null) return;
  const url = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.history.replaceState(null, "", url);
}

function titleForView(view: Exclude<AppView, "app">) {
  const titles: Record<Exclude<AppView, "app">, string> = {
    welcome: "Comunicación privada",
    login: "Iniciar sesión",
    invitation: "Validar invitación",
    "register-client": "Registro de cliente",
    "register-cashier": "Registro de cajero",
    terms: "Términos de uso",
    privacy: "Política de privacidad",
    security: "Seguridad",
  };
  return titles[view];
}

function isPublicInformationView(
  view: AppView,
): view is PublicInformationView {
  return view === "terms" || view === "privacy" || view === "security";
}

function dashboardTitle(role: SessionUser["role"]) {
  const titles: Record<SessionUser["role"], string> = {
    CLIENT: "Mi conversación",
    CASHIER: "Mis clientes",
    ADMIN: "Administración",
  };
  return titles[role];
}

function messageFromApiError(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function matrixErrorMessage(error: unknown) {
  if (isApiError(error)) {
    return messageFromApiError(
      error,
      "No pudimos validar el servicio de cifrado. Inténtalo nuevamente.",
    );
  }

  if (error instanceof MatrixLocalDeviceStoreError) {
    if (
      error.code === "MATRIX_LOCAL_SECURE_STORAGE_UNAVAILABLE" ||
      error.code.startsWith("MATRIX_LOCAL_DATABASE_")
    ) {
      return "Este navegador no permite abrir el almacenamiento seguro necesario para el chat cifrado.";
    }
    return "Las credenciales cifradas de este dispositivo no son válidas. No se creó otro dispositivo automáticamente.";
  }

  // Do not import Rust Crypto here: the engine must remain lazy while BLOCKED.
  if (
    error instanceof Error && error.name === "MatrixCrossSigningError" &&
    "code" in error && typeof error.code === "string"
  ) {
    if (error.code === "MATRIX_CROSS_SIGNING_LOCAL_KEYS_REQUIRED") {
      return "Este navegador no conserva todas las claves de tu identidad cifrada. No se creó una identidad nueva ni se habilitó el chat.";
    }
    if (error.code === "MATRIX_CROSS_SIGNING_IDENTITY_CHANGED") {
      return "La identidad cifrada no coincide con la registrada. El chat se detuvo para proteger tus conversaciones; no se reemplazaron tus claves.";
    }
    if (
      error.code === "MATRIX_CROSS_SIGNING_IDENTITY_NOT_VERIFIED" ||
      error.code === "MATRIX_CROSS_SIGNING_DEVICE_NOT_VERIFIED"
    ) {
      return "No pudimos verificar las firmas de tu identidad y de este dispositivo. El chat permanece bloqueado por seguridad.";
    }
    if (error.code === "MATRIX_CROSS_SIGNING_SESSION_MISMATCH") {
      return "No pudimos confirmar que esta identidad cifrada corresponda a tu sesión. El chat permanece bloqueado.";
    }
    return "No pudimos confirmar de forma segura tu identidad cifrada. El chat permanece bloqueado; no se restablecieron tus claves.";
  }

  if (isMatrixSessionLifecycleError(error)) {
    if (error.code === "MATRIX_SESSION_ALREADY_OPEN") {
      return "El chat cifrado ya está abierto en otra pestaña. Ciérrala y vuelve a intentarlo aquí.";
    }
    if (error.code === "MATRIX_BROWSER_LOCKS_UNAVAILABLE") {
      return "Este navegador no ofrece el bloqueo seguro entre pestañas que necesita el chat cifrado.";
    }
    if (error.code === "MATRIX_SESSION_LOCK_FAILED") {
      return "No pudimos reservar de forma segura el motor de cifrado para esta pestaña.";
    }
    if (error.code === "MATRIX_SESSION_USER_NOT_ACTIVE") {
      return "La cuenta debe estar activa antes de iniciar el chat cifrado.";
    }
    if (
      error.code === "MATRIX_SESSION_DEVICE_MISMATCH" ||
      error.code === "MATRIX_LOCAL_DEVICE_CREDENTIALS_MISSING" ||
      error.code === "MATRIX_LOCAL_BINDING_SECRET_MISSING"
    ) {
      return "Este navegador no conserva las credenciales del dispositivo asociado. No se creó otro dispositivo automáticamente.";
    }
    if (error.code === "MATRIX_RELEASE_PROFILE_MISMATCH") {
      return "La versión criptográfica de la aplicación no coincide con la habilitada por el servidor. Actualiza la página.";
    }
    if (error.code === "MATRIX_APPLICATION_EVENT_ON_CONTROL_CHANNEL") {
      return "Se bloqueó un evento de chat recibido por un canal criptográfico incorrecto.";
    }
  }

  return "No pudimos iniciar el cifrado de extremo a extremo en este dispositivo.";
}

function isMatrixSessionLifecycleError(
  error: unknown,
): error is Error & { code: string } {
  return (
    error instanceof Error &&
    error.name === "MatrixSessionLifecycleError" &&
    "code" in error &&
    typeof error.code === "string"
  );
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function MiniLockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <rect x="4.5" y="8.5" width="11" height="8" rx="2" />
      <path d="M7 8.5V6a3 3 0 0 1 6 0v2.5" />
    </svg>
  );
}
