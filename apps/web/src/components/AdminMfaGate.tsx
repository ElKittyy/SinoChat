import { useState, type FormEvent } from "react";
import type { AdminMfaAdapter, AdminMfaState } from "../api";

type GateStatus =
  | { state: "idle" }
  | { state: "busy"; message: string }
  | { state: "error"; message: string }
  | { state: "success"; message: string };

export function AdminMfaGate({
  adapter,
  mfa,
  onComplete,
  onLogout,
  username,
}: {
  adapter: AdminMfaAdapter;
  mfa: AdminMfaState;
  onComplete: () => void;
  onLogout: () => Promise<void>;
  username: string;
}) {
  const [status, setStatus] = useState<GateStatus>({ state: "idle" });
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[]>([]);
  const [codesSaved, setCodesSaved] = useState(false);
  const busy = status.state === "busy";
  const supported = adapter.isSupported();

  async function enroll() {
    setStatus({
      state: "busy",
      message: "Esperando la confirmación segura del dispositivo…",
    });
    try {
      const result = await adapter.enroll();
      if (result.recoveryCodes.length > 0) {
        setRecoveryCodes(result.recoveryCodes);
        setCodesSaved(false);
        setStatus({
          state: "success",
          message:
            "Passkey registrada. Guarda ahora los códigos: no volverán a mostrarse.",
        });
        return;
      }
      onComplete();
    } catch (error) {
      setStatus({ state: "error", message: errorMessage(error) });
    }
  }

  async function authenticate() {
    setStatus({
      state: "busy",
      message: "Esperando la confirmación de tu passkey…",
    });
    try {
      await adapter.authenticate();
      onComplete();
    } catch (error) {
      setStatus({ state: "error", message: errorMessage(error) });
    }
  }

  async function recover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    setStatus({
      state: "busy",
      message: "Verificando el código y revocando las passkeys anteriores…",
    });
    try {
      await adapter.recover(String(data.get("recoveryCode") ?? ""));
      form.reset();
      setRecoveryMode(false);
      setStatus({
        state: "success",
        message: "Recuperación confirmada. Ahora registra una passkey nueva.",
      });
      onComplete();
    } catch (error) {
      setStatus({ state: "error", message: errorMessage(error) });
    }
  }

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
      setStatus({
        state: "success",
        message: "Códigos copiados. Guárdalos fuera de este dispositivo.",
      });
    } catch {
      setStatus({
        state: "error",
        message: "No se pudieron copiar. Guárdalos manualmente antes de continuar.",
      });
    }
  }

  return (
    <main className="admin-mfa-shell" id="main-content">
      <section className="admin-mfa-card" aria-labelledby="admin-mfa-title">
        <img className="admin-mfa-logo" src="/assets/sinochat-icon.png" alt="" />
        <p className="eyebrow">Protección administrativa</p>
        <h1 id="admin-mfa-title">
          {recoveryCodes.length > 0
            ? "Guarda tus códigos de recuperación"
            : mfa.enrolled
              ? "Confirma tu passkey"
              : "Protege la cuenta de administrador"}
        </h1>
        <p className="admin-mfa-description">
          Sesión de <strong>{username}</strong>. La passkey usa Windows Hello,
          biometría, PIN local o una llave física; SinoChat solo guarda la clave
          pública.
        </p>

        {recoveryCodes.length > 0 ? (
          <div className="admin-recovery-panel" role="region" aria-label="Códigos de recuperación">
            <p>
              Estos diez códigos son de un solo uso. No se guardan en texto plano
              y no podrán recuperarse desde el servidor.
            </p>
            <ol className="admin-recovery-codes">
              {recoveryCodes.map((code) => (
                <li key={code}>
                  <code>{code}</code>
                </li>
              ))}
            </ol>
            <button className="button button-secondary" type="button" onClick={copyCodes}>
              Copiar los diez códigos
            </button>
            <label className="admin-mfa-confirmation">
              <input
                type="checkbox"
                checked={codesSaved}
                onChange={(event) => setCodesSaved(event.currentTarget.checked)}
              />
              <span>Confirmo que guardé los diez códigos en un lugar seguro.</span>
            </label>
            <button
              className="button button-primary"
              type="button"
              disabled={!codesSaved}
              onClick={onComplete}
            >
              Entrar al panel administrativo
            </button>
          </div>
        ) : recoveryMode ? (
          <form className="access-form admin-mfa-recovery" onSubmit={recover}>
            <label htmlFor="admin-recovery-code">Código de recuperación</label>
            <input
              id="admin-recovery-code"
              name="recoveryCode"
              autoCapitalize="characters"
              autoComplete="one-time-code"
              pattern="SA-[2-9A-HJ-NP-Z]{5}(-[2-9A-HJ-NP-Z]{5}){4}"
              placeholder="SA-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
              minLength={32}
              maxLength={32}
              required
              disabled={busy}
            />
            <p className="field-hint">
              Recuperar revoca todas las passkeys y las demás sesiones. Después
              deberás registrar una passkey nueva.
            </p>
            <button className="button button-primary" type="submit" disabled={busy}>
              Usar código y revocar accesos
            </button>
            <button
              className="text-button"
              type="button"
              disabled={busy}
              onClick={() => {
                setRecoveryMode(false);
                setStatus({ state: "idle" });
              }}
            >
              Volver a la passkey
            </button>
          </form>
        ) : (
          <div className="admin-mfa-actions">
            {!supported ? (
              <p className="form-status error" role="alert">
                Este navegador no admite WebAuthn. Usa una versión actual de
                Chrome, Edge, Firefox o Safari en un contexto seguro.
              </p>
            ) : null}
            <button
              className="button button-primary"
              type="button"
              disabled={busy || !supported}
              onClick={() => void (mfa.enrolled ? authenticate() : enroll())}
            >
              {mfa.enrolled ? "Confirmar con passkey" : "Registrar mi passkey"}
            </button>
            {mfa.enrolled ? (
              <button
                className="text-button"
                type="button"
                disabled={busy}
                onClick={() => {
                  setRecoveryMode(true);
                  setStatus({ state: "idle" });
                }}
              >
                Perdí acceso a mis passkeys
              </button>
            ) : null}
          </div>
        )}

        {status.state !== "idle" ? (
          <p
            className={`form-status ${status.state === "error" ? "error" : status.state === "success" ? "success" : ""}`}
            role={status.state === "error" ? "alert" : "status"}
          >
            {status.message}
          </p>
        ) : null}

        <button className="text-button admin-mfa-logout" type="button" onClick={() => void onLogout()}>
          Cerrar sesión
        </button>
      </section>
    </main>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "No pudimos completar la verificación administrativa.";
}
