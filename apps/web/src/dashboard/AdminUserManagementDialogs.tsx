import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { DashboardIcon } from "./DashboardIcon";
import type {
  AdminCashierOnboardingInput,
  AdminCashierOnboardingResult,
  AdminPasswordResetInput,
  AdminUser,
  AdminUserUpdateInput,
  MaybePromise,
} from "./types";
import { createInvitationUrl } from "../invitation-fragment";

export function AdminEditUserDialog({
  onCancel,
  onConfirm,
  user,
}: {
  onCancel: () => void;
  onConfirm: (input: AdminUserUpdateInput) => MaybePromise;
  user: AdminUser;
}) {
  const [username, setUsername] = useState(user.username);
  const [email, setEmail] = useState(user.email ?? "");
  const [phone, setPhone] = useState(user.phone ?? "");
  const [error, setError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const changed =
    username.trim() !== user.username ||
    (user.role === "cashier" &&
      (email.trim() !== (user.email ?? "") ||
        phone.trim() !== (user.phone ?? "")));
  const valid = changed && username.trim().length >= 3;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid) {
      setError(
        changed
          ? "Completa correctamente los datos antes de guardar."
          : "Modifica al menos un dato antes de guardar.",
      );
      return;
    }

    setIsSubmitting(true);
    setError(undefined);
    try {
      await onConfirm({
        username: username.trim(),
        ...(user.role === "cashier"
          ? { email: email.trim(), phone: phone.trim() }
          : {}),
      });
      onCancel();
    } catch (caughtError) {
      setError(errorMessage(caughtError));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <DialogFrame
      description={`Modifica únicamente los datos administrativos permitidos de @${user.username}.`}
      isBusy={isSubmitting}
      onCancel={onCancel}
      title="Editar usuario"
    >
      <form className="dash-dialog-form-grid" onSubmit={submit}>
        <DialogField label="Nombre de usuario">
          <input
            autoFocus
            disabled={isSubmitting}
            maxLength={32}
            minLength={3}
            onChange={(event) => {
              setUsername(event.target.value);
              setError(undefined);
            }}
            pattern="[a-zA-Z0-9_.-]+"
            required
            value={username}
          />
        </DialogField>
        {user.role === "cashier" ? (
          <>
            <DialogField label="Correo electrónico">
              <input
                disabled={isSubmitting}
                maxLength={254}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setError(undefined);
                }}
                required
                type="email"
                value={email}
              />
            </DialogField>
            <DialogField
              hint="Formato internacional, por ejemplo +5491112345678."
              label="Teléfono"
            >
              <input
                disabled={isSubmitting}
                maxLength={16}
                onChange={(event) => {
                  setPhone(event.target.value);
                  setError(undefined);
                }}
                pattern="\+[1-9][0-9]{7,14}"
                required
                type="tel"
                value={phone}
              />
            </DialogField>
          </>
        ) : null}
        {error ? <FormError message={error} /> : null}
        <DialogActions
          confirmLabel="Guardar cambios"
          disabled={!valid || isSubmitting}
          isSubmitting={isSubmitting}
          onCancel={onCancel}
        />
      </form>
    </DialogFrame>
  );
}

export function AdminPasswordResetDialog({
  onCancel,
  onConfirm,
  user,
}: {
  onCancel: () => void;
  onConfirm: (input: AdminPasswordResetInput) => MaybePromise;
  user: AdminUser;
}) {
  const [error, setError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(undefined);
    try {
      await onConfirm({});
      onCancel();
    } catch (caughtError) {
      setError(errorMessage(caughtError));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <DialogFrame
      description={`Inicia la recuperación de @${user.username}. Se cerrarán sus sesiones y tendrá 24 horas para definir una nueva contraseña con uno de sus códigos personales.`}
      isBusy={isSubmitting}
      isDangerous
      onCancel={onCancel}
      title="Restablecer contraseña"
    >
      <form className="dash-dialog-form-grid" onSubmit={submit}>
        <div className="dash-onboarding-guidance">
          <DashboardIcon name="lock" />
          <div>
            <strong>El administrador nunca conoce la credencial</strong>
            <p>
              SinoChat no te pedirá un motivo ni una contraseña. El cajero
              usará un código que recibió al registrarse; sus clientes,
              asignaciones y dispositivos no se eliminan.
            </p>
          </div>
        </div>
        {error ? <FormError message={error} /> : null}
        <DialogActions
          confirmLabel="Iniciar recuperación"
          dangerous
          disabled={isSubmitting}
          isSubmitting={isSubmitting}
          onCancel={onCancel}
        />
      </form>
    </DialogFrame>
  );
}

export function AdminOnboardingDialog({
  onCancel,
  onCreateCashierInvitation,
}: {
  onCancel: () => void;
  onCreateCashierInvitation: (
    input: AdminCashierOnboardingInput,
  ) => MaybePromise<AdminCashierOnboardingResult>;
}) {
  const [role, setRole] = useState<"client" | "cashier">("cashier");
  const [expiresInHours, setExpiresInHours] = useState(72);
  const [invitation, setInvitation] =
    useState<AdminCashierOnboardingResult>();
  const [copyStatus, setCopyStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const invitationUrl = invitation
    ? createInvitationUrl(window.location.origin, {
        code: invitation.code,
        role: "cajero",
      })
    : undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(undefined);
    try {
      setInvitation(
        await onCreateCashierInvitation({
          expiresInHours,
        }),
      );
    } catch (caughtError) {
      setError(errorMessage(caughtError));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function copyLink() {
    if (!invitationUrl || !navigator.clipboard?.writeText) {
      setCopyStatus("El navegador no permite copiar automáticamente.");
      return;
    }
    try {
      await navigator.clipboard.writeText(invitationUrl);
      setCopyStatus("Enlace copiado.");
    } catch {
      setCopyStatus("No se pudo copiar. Selecciona el enlace manualmente.");
    }
  }

  return (
    <DialogFrame
      description="Las cuentas deben ser completadas por su titular para declarar mayoría de edad y aceptar los términos."
      isBusy={isSubmitting}
      onCancel={onCancel}
      title="Iniciar alta de usuario"
    >
      {invitation && invitationUrl ? (
        <div className="dash-dialog-success">
          <strong>Invitación de cajero creada</strong>
          <p>
            Compártela ahora. El código no se volverá a mostrar desde este
            flujo.
          </p>
          <label>
            Enlace de registro
            <input readOnly value={invitationUrl} />
          </label>
          <code>{invitation.code}</code>
          <small>
            Vence el {new Date(invitation.expiresAt).toLocaleString("es-AR")}.
          </small>
          {copyStatus ? <p aria-live="polite">{copyStatus}</p> : null}
          <div className="dash-dialog-actions">
            <button
              className="dash-button dash-button-ghost"
              onClick={onCancel}
              type="button"
            >
              Cerrar
            </button>
            <button
              className="dash-button dash-button-primary"
              onClick={() => void copyLink()}
              type="button"
            >
              Copiar enlace
            </button>
          </div>
        </div>
      ) : (
        <>
          <fieldset className="dash-onboarding-role">
            <legend>Tipo de alta</legend>
            <label>
              <input
                checked={role === "cashier"}
                disabled={isSubmitting}
                name="onboarding-role"
                onChange={() => setRole("cashier")}
                type="radio"
              />
              Cajero
            </label>
            <label>
              <input
                checked={role === "client"}
                disabled={isSubmitting}
                name="onboarding-role"
                onChange={() => setRole("client")}
                type="radio"
              />
              Cliente
            </label>
          </fieldset>
          {role === "client" ? (
            <div className="dash-onboarding-guidance">
              <DashboardIcon name="lock" />
              <div>
                <strong>El alta depende de su cajero</strong>
                <p>
                  El cliente debe usar el enlace único del cajero que lo
                  atenderá. Solicita a ese cajero que copie el enlace desde su
                  panel; el cliente elegirá contraseña, declarará su fecha de
                  nacimiento y aceptará los términos personalmente.
                </p>
              </div>
              <button
                className="dash-button dash-button-primary"
                onClick={onCancel}
                type="button"
              >
                Entendido
              </button>
            </div>
          ) : (
            <form className="dash-dialog-form-grid" onSubmit={submit}>
              <DialogField label="Vigencia de la invitación">
                <select
                  disabled={isSubmitting}
                  onChange={(event) =>
                    setExpiresInHours(Number(event.target.value))
                  }
                  value={expiresInHours}
                >
                  <option value={24}>24 horas</option>
                  <option value={72}>72 horas</option>
                  <option value={168}>7 días</option>
                  <option value={720}>30 días</option>
                </select>
              </DialogField>
              {error ? <FormError message={error} /> : null}
              <DialogActions
                confirmLabel="Crear invitación"
                disabled={isSubmitting}
                isSubmitting={isSubmitting}
                onCancel={onCancel}
              />
            </form>
          )}
        </>
      )}
    </DialogFrame>
  );
}

function DialogFrame({
  children,
  description,
  isBusy,
  isDangerous = false,
  onCancel,
  title,
}: {
  children: ReactNode;
  description: string;
  isBusy: boolean;
  isDangerous?: boolean;
  onCancel: () => void;
  title: string;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    const focusFrame = window.requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
        )
        ?.focus();
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      previouslyFocused?.focus();
    };
  }, []);

  useEffect(() => {
    function dismiss(event: KeyboardEvent) {
      if (event.key === "Escape" && !isBusy) onCancelRef.current();
      if (event.key !== "Tab") return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
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
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [isBusy]);

  return (
    <div
      className="dash-dialog-backdrop"
      onMouseDown={() => {
        if (!isBusy) onCancel();
      }}
    >
      <section
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        aria-busy={isBusy}
        className="dash-dialog dash-management-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
      >
        <span
          aria-hidden="true"
          className={`dash-dialog-icon${isDangerous ? " is-dangerous" : ""}`}
        >
          <DashboardIcon name={isDangerous ? "block" : "users"} />
        </span>
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
        {children}
      </section>
    </div>
  );
}

function DialogField({
  children,
  hint,
  label,
}: {
  children: ReactNode;
  hint?: string;
  label: string;
}) {
  return (
    <label className="dash-dialog-field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function FormError({ message }: { message: string }) {
  return (
    <p className="dash-form-error" role="alert">
      {message}
    </p>
  );
}

function DialogActions({
  confirmLabel,
  dangerous = false,
  disabled,
  isSubmitting,
  onCancel,
}: {
  confirmLabel: string;
  dangerous?: boolean;
  disabled: boolean;
  isSubmitting: boolean;
  onCancel: () => void;
}) {
  return (
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
        className={
          dangerous
            ? "dash-button dash-button-danger"
            : "dash-button dash-button-primary"
        }
        disabled={disabled}
        type="submit"
      >
        {isSubmitting ? "Procesando…" : confirmLabel}
      </button>
    </div>
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "No se pudo completar la acción. Inténtalo nuevamente.";
}
