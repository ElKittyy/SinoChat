import type { ReactNode } from "react";
import { DashboardIcon } from "./DashboardIcon";
import type {
  DashboardIdentity,
  DashboardNotice,
  MaybePromise,
} from "./types";
import { MATRIX_CRYPTO_PACKAGE_VERSION } from "../e2ee/matrixProfile";
import "./dashboard.css";

interface DashboardShellProps {
  currentUser: DashboardIdentity;
  notificationCount?: number;
  notificationsOverlay?: ReactNode;
  onOpenNotifications?: () => MaybePromise;
  onLogout: () => MaybePromise;
  roleLabel: string;
  systemNotice?: DashboardNotice;
  children: ReactNode;
}

export function DashboardShell({
  children,
  currentUser,
  notificationCount = 0,
  notificationsOverlay,
  onLogout,
  onOpenNotifications,
  roleLabel,
  systemNotice,
}: DashboardShellProps) {
  const displayName = currentUser.displayName || currentUser.username;

  return (
    <div className="dash-root">
      <a className="dash-skip-link" href="#dashboard-main">
        Saltar al contenido principal
      </a>

      <header className="dash-topbar">
        <div className="dash-topbar-inner">
          <a className="dash-brand" href="/" aria-label="SinoChat, ir al inicio">
            <img src="/assets/sinochat-logo.png" alt="SinoChat" />
          </a>

          <div className="dash-account">
            {onOpenNotifications ? (
              <button
                aria-label={
                  notificationCount > 0
                    ? `Notificaciones, ${notificationCount} sin leer`
                    : "Notificaciones"
                }
                className="dash-icon-button dash-notification-button"
                onClick={() => void onOpenNotifications()}
                type="button"
              >
                <DashboardIcon name="bell" />
                {notificationCount > 0 ? (
                  <span aria-hidden="true" className="dash-notification-count">
                    {notificationCount > 99 ? "99+" : notificationCount}
                  </span>
                ) : null}
              </button>
            ) : null}

            <div className="dash-user-summary">
              <Avatar identity={currentUser} />
              <span>
                <strong>{displayName}</strong>
                <small>{roleLabel}</small>
              </span>
            </div>

            <button
              className="dash-icon-button dash-logout-button"
              onClick={() => void onLogout()}
              title="Cerrar sesión"
              type="button"
            >
              <DashboardIcon name="logout" />
              <span>Cerrar sesión</span>
            </button>
          </div>
        </div>
      </header>

      {systemNotice ? (
        <aside
          className={`dash-system-notice is-${systemNotice.tone || "info"}`}
          role={systemNotice.tone === "error" ? "alert" : "status"}
        >
          <DashboardIcon
            name={systemNotice.tone === "error" ? "report" : "shield"}
          />
          <span>
            <strong>{systemNotice.title}</strong>
            <small>{systemNotice.message}</small>
          </span>
          {systemNotice.actionLabel && systemNotice.onAction ? (
            <button
              onClick={() => void systemNotice.onAction?.()}
              type="button"
            >
              {systemNotice.actionLabel}
            </button>
          ) : null}
        </aside>
      ) : null}

      <main className="dash-main" id="dashboard-main">
        {children}
      </main>

      {notificationsOverlay}
    </div>
  );
}

interface AvatarProps {
  identity: Pick<DashboardIdentity, "avatarUrl" | "displayName" | "username">;
  size?: "small" | "medium" | "large";
}

export function Avatar({ identity, size = "medium" }: AvatarProps) {
  const label = identity.displayName || identity.username;
  const initials = label
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("")
    .toUpperCase();

  return (
    <span
      aria-hidden="true"
      className={`dash-avatar dash-avatar-${size}`}
      title={label}
    >
      {identity.avatarUrl ? <img src={identity.avatarUrl} alt="" /> : initials || "S"}
    </span>
  );
}

export function PrivacyBar() {
  return (
    <p className="dash-privacy-bar">
      <DashboardIcon name="lock" />
      <span>
        Matrix E2EE en integración
        <small>
          Motor Rust/WASM {MATRIX_CRYPTO_PACKAGE_VERSION}; el chat seguirá
          bloqueado hasta completar transporte y auditoría. Retención: 48 horas.
        </small>
      </span>
    </p>
  );
}
