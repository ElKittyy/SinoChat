import { useEffect, useState, type FormEvent } from "react";
import {
  INITIAL_SUBMISSION_STATE,
  isAdult,
  isValidInvitationFormat,
  latestAdultBirthDate,
  messageFromError,
  normalizeInvitationCode,
  type AccessActions,
  type CashierRegistrationResult,
  type CashierRegistrationInput,
  type ClientRegistrationInput,
  type InvitationInput,
  type SubmissionState,
  type UserRole,
} from "../access";
import {
  loadCurrentTerms,
  type PublicTermsDocument,
} from "../api";
import { Field, FormStatus, PasswordField } from "./FormControls";

export type AccessView =
  | "welcome"
  | "login"
  | "invitation"
  | "register-client"
  | "register-cashier";

export interface InvitationDraft {
  code: string;
  role: UserRole;
}

interface AccessPanelProps {
  actions?: AccessActions;
  invitation?: InvitationDraft;
  onInvitationAccepted: (invitation: InvitationDraft) => void;
  onCashierRegistrationAcknowledged: () => void;
  onNavigate: (view: AccessView) => void;
  view: AccessView;
}

const pendingMessage = "Enviando de forma segura…";
const integrationMessage =
  "El formulario está validado y listo para conectarse con el servicio seguro.";

export function AccessPanel({
  actions,
  invitation,
  onInvitationAccepted,
  onCashierRegistrationAcknowledged,
  onNavigate,
  view,
}: AccessPanelProps) {
  return (
    <section className="access-card" aria-labelledby="access-title">
      <div className="card-glow" aria-hidden="true" />
      <header className="card-heading">
        <img src="/assets/sinochat-icon.png" alt="" aria-hidden="true" />
        <div>
          <span>Acceso seguro</span>
          <h2 id="access-title" tabIndex={-1}>
            {titleForView(view)}
          </h2>
        </div>
      </header>

      {view === "welcome" ? <WelcomePanel onNavigate={onNavigate} /> : null}
      {view === "login" ? (
        <LoginForm actions={actions} onNavigate={onNavigate} />
      ) : null}
      {view === "invitation" ? (
        <InvitationForm
          action={actions?.validateInvitation}
          initialInvitation={invitation}
          onAccepted={onInvitationAccepted}
          onNavigate={onNavigate}
        />
      ) : null}
      {view === "register-client" && invitation?.role === "cliente" ? (
        <ClientRegistrationForm
          action={actions?.registerClient}
          invitation={invitation}
          onNavigate={onNavigate}
        />
      ) : null}
      {view === "register-cashier" && invitation?.role === "cajero" ? (
        <CashierRegistrationForm
          action={actions?.registerCashier}
          invitation={invitation}
          onRegistrationAcknowledged={onCashierRegistrationAcknowledged}
          onNavigate={onNavigate}
        />
      ) : null}

      <p className="security-note">
        <LockIcon />
        SinoChat nunca te pedirá el contenido de tus conversaciones.
      </p>
    </section>
  );
}

function titleForView(view: AccessView) {
  const titles: Record<AccessView, string> = {
    welcome: "Tu espacio privado",
    login: "Bienvenido de nuevo",
    invitation: "Validar invitación",
    "register-client": "Crear cuenta de cliente",
    "register-cashier": "Crear cuenta de cajero",
  };

  return titles[view];
}

function WelcomePanel({
  onNavigate,
}: {
  onNavigate: (view: AccessView) => void;
}) {
  return (
    <div className="welcome-panel">
      <p className="card-description">
        Ingresa a tu cuenta o utiliza una invitación para comenzar de manera segura.
      </p>
      <button
        className="button button-primary"
        type="button"
        onClick={() => onNavigate("login")}
      >
        Iniciar sesión
        <ArrowIcon />
      </button>
      <button
        className="button button-secondary"
        type="button"
        onClick={() => onNavigate("invitation")}
      >
        Tengo un código de invitación
      </button>
      <div className="privacy-chip">
        <ShieldIcon />
        <span>
          <b>Conversaciones privadas</b>
          El contenido solo puede ser leído por sus participantes.
        </span>
      </div>
    </div>
  );
}

interface LoginFormProps {
  actions?: AccessActions;
  onNavigate: (view: AccessView) => void;
}

function LoginForm({ actions, onNavigate }: LoginFormProps) {
  const [state, setState] = useState<SubmissionState>(INITIAL_SUBMISSION_STATE);
  const [showAccessHelp, setShowAccessHelp] = useState(false);
  const [mode, setMode] = useState<"login" | "admin-reset">("login");
  const isSubmitting = state.status === "submitting";

  if (mode === "admin-reset") {
    return (
      <AdminResetCompletionForm
        action={actions?.completeAdminReset}
        onBack={() => {
          setMode("login");
          setState(INITIAL_SUBMISSION_STATE);
        }}
        onCompleted={() => {
          setMode("login");
          setState({
            status: "success",
            message:
              "Contraseña actualizada. Ya puedes iniciar sesión con la nueva contraseña.",
          });
        }}
      />
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;

    if (!form.reportValidity()) {
      return;
    }

    const data = new FormData(form);
    const input = {
      username: String(data.get("username") ?? "").trim(),
      password: String(data.get("password") ?? ""),
    };

    if (!actions?.login) {
      setState({ status: "ready", message: integrationMessage });
      return;
    }

    setState({ status: "submitting", message: pendingMessage });

    try {
      await actions.login(input);
      setState({ status: "success", message: "Acceso confirmado. Preparando tu cuenta…" });
    } catch (error) {
      if (isAdminPasswordChangeRequired(error)) {
        setState(INITIAL_SUBMISSION_STATE);
        setMode("admin-reset");
        return;
      }
      setState({ status: "error", message: messageFromError(error) });
    }
  }

  return (
    <>
      <form className="access-form" onSubmit={handleSubmit} aria-busy={isSubmitting}>
        <Field
          label="Usuario"
          name="username"
          autoCapitalize="none"
          autoComplete="username"
          minLength={3}
          maxLength={40}
          placeholder="Ingresa tu usuario"
          required
          disabled={isSubmitting}
        />
        <PasswordField
          label="Contraseña"
          name="password"
          autoComplete="current-password"
          minLength={10}
          maxLength={128}
          placeholder="Ingresa tu contraseña"
          required
          disabled={isSubmitting}
        />
        <FormStatus state={state} />
        <button className="button button-primary" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Ingresando…" : "Entrar a SinoChat"}
          {!isSubmitting ? <ArrowIcon /> : null}
        </button>
      </form>

      <button
        className="text-button"
        type="button"
        aria-expanded={showAccessHelp}
        aria-controls="access-help"
        onClick={() => setShowAccessHelp((current) => !current)}
      >
        ¿Tienes problemas para entrar?
      </button>
      {showAccessHelp ? (
        <div className="inline-help" id="access-help">
          <p>
            Las cuentas de cliente no tienen recuperación de contraseña. Los
            cajeros pueden pedir al administrador que inicie una recuperación,
            que cerrará sus sesiones. Para completarla necesitan uno de los
            códigos personales guardados durante el registro.
          </p>
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setState(INITIAL_SUBMISSION_STATE);
              setMode("admin-reset");
            }}
          >
            Completar recuperación de cajero
          </button>
        </div>
      ) : null}
      <div className="card-divider">
        <span>¿Aún no tienes cuenta?</span>
      </div>
      <button
        className="button button-secondary"
        type="button"
        onClick={() => onNavigate("invitation")}
      >
        Usar código de invitación
      </button>
    </>
  );
}

interface AdminResetCompletionFormProps {
  action?: AccessActions["completeAdminReset"];
  onBack: () => void;
  onCompleted: () => void;
}

const STRONG_RESET_PASSWORD =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9\s])\S{12,128}$/;

function AdminResetCompletionForm({
  action,
  onBack,
  onCompleted,
}: AdminResetCompletionFormProps) {
  const [state, setState] = useState<SubmissionState>(INITIAL_SUBMISSION_STATE);
  const isSubmitting = state.status === "submitting";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const recoveryCode = form.elements.namedItem("recoveryCode") as HTMLInputElement;
    const newPassword = form.elements.namedItem("newPassword") as HTMLInputElement;
    const confirmation = form.elements.namedItem(
      "newPasswordConfirmation",
    ) as HTMLInputElement;

    const normalizedRecoveryCode = recoveryCode.value.trim().toUpperCase();
    recoveryCode.value = normalizedRecoveryCode;
    recoveryCode.setCustomValidity(
      /^SC-[2-9A-HJ-NP-Z]{5}(?:-[2-9A-HJ-NP-Z]{5}){3}$/.test(
        normalizedRecoveryCode,
      )
        ? ""
        : "Ingresa un código de recuperación SinoChat válido.",
    );
    newPassword.setCustomValidity(
      STRONG_RESET_PASSWORD.test(newPassword.value)
        ? ""
        : "Usa 12 caracteres o más, con mayúscula, minúscula, número y símbolo, sin espacios.",
    );
    confirmation.setCustomValidity(
      newPassword.value === confirmation.value
        ? ""
        : "Las contraseñas no coinciden.",
    );
    if (!form.reportValidity()) return;

    if (!action) {
      setState({ status: "ready", message: integrationMessage });
      return;
    }

    const data = new FormData(form);
    setState({ status: "submitting", message: pendingMessage });
    try {
      await action({
        username: String(data.get("username") ?? "").trim(),
        recoveryCode: normalizedRecoveryCode,
        newPassword: newPassword.value,
      });
      form.reset();
      onCompleted();
    } catch (error) {
      setState({ status: "error", message: messageFromError(error) });
    }
  }

  return (
    <>
      <div className="inline-help">
        <p>
          Este paso es exclusivo para cajeros. El administrador inicia la
          solicitud, pero nunca ve tus códigos ni elige tu contraseña. Cada
          código funciona una sola vez.
        </p>
      </div>
      <form className="access-form" onSubmit={handleSubmit} aria-busy={isSubmitting}>
        <Field
          label="Usuario de cajero"
          name="username"
          autoCapitalize="none"
          autoComplete="username"
          minLength={3}
          maxLength={64}
          required
          disabled={isSubmitting}
        />
        <Field
          label="Código de recuperación"
          hint="Formato: SC-XXXXX-XXXXX-XXXXX-XXXXX. Se mostró una sola vez al crear tu cuenta."
          name="recoveryCode"
          autoCapitalize="characters"
          autoComplete="one-time-code"
          minLength={26}
          maxLength={26}
          pattern="SC-[2-9A-HJ-NP-Z]{5}(-[2-9A-HJ-NP-Z]{5}){3}"
          placeholder="SC-XXXXX-XXXXX-XXXXX-XXXXX"
          required
          disabled={isSubmitting}
        />
        <PasswordField
          label="Nueva contraseña"
          hint="12–128 caracteres con mayúscula, minúscula, número y símbolo; sin espacios."
          name="newPassword"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
          disabled={isSubmitting}
        />
        <PasswordField
          label="Confirmar nueva contraseña"
          name="newPasswordConfirmation"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
          disabled={isSubmitting}
        />
        <FormStatus state={state} />
        <button className="button button-primary" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Actualizando…" : "Definir nueva contraseña"}
        </button>
      </form>
      <button className="text-button" type="button" onClick={onBack} disabled={isSubmitting}>
        Volver al inicio de sesión
      </button>
    </>
  );
}

function isAdminPasswordChangeRequired(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ADMIN_PASSWORD_CHANGE_REQUIRED"
  );
}

interface InvitationFormProps {
  action?: AccessActions["validateInvitation"];
  initialInvitation?: InvitationDraft;
  onAccepted: (invitation: InvitationDraft) => void;
  onNavigate: (view: AccessView) => void;
}

function InvitationForm({
  action,
  initialInvitation,
  onAccepted,
  onNavigate,
}: InvitationFormProps) {
  const [role, setRole] = useState<UserRole>(initialInvitation?.role ?? "cliente");
  const [code, setCode] = useState(initialInvitation?.code ?? "");
  const [state, setState] = useState<SubmissionState>(INITIAL_SUBMISSION_STATE);
  const isSubmitting = state.status === "submitting";

  useEffect(() => {
    if (initialInvitation) {
      setRole(initialInvitation.role);
      setCode(initialInvitation.code);
    }
  }, [initialInvitation]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const inputElement = form.elements.namedItem("invitationCode") as HTMLInputElement;
    const normalizedCode = normalizeInvitationCode(inputElement.value);

    inputElement.value = normalizedCode;
    inputElement.setCustomValidity(
      isValidInvitationFormat(normalizedCode)
        ? ""
        : "Ingresa un código válido de 8 a 64 caracteres.",
    );

    if (!form.reportValidity()) {
      return;
    }

    const input: InvitationInput = { code: normalizedCode, role };

    if (!action) {
      onAccepted(input);
      return;
    }

    setState({ status: "submitting", message: "Validando tu invitación…" });

    try {
      await action(input);
      setState({ status: "success", message: "Invitación confirmada." });
      onAccepted(input);
    } catch (error) {
      setState({ status: "error", message: messageFromError(error) });
    }
  }

  return (
    <>
      <div className="step-row" aria-label="Paso 1 de 2">
        <span className="step-current">1</span>
        <i aria-hidden="true" />
        <span>2</span>
        <p>Primero confirma tu invitación</p>
      </div>

      <form className="access-form" onSubmit={handleSubmit} aria-busy={isSubmitting}>
        <fieldset className="role-selector">
          <legend>Quiero registrarme como</legend>
          <div>
            <label className={role === "cliente" ? "is-selected" : ""}>
              <input
                type="radio"
                name="role"
                value="cliente"
                checked={role === "cliente"}
                onChange={() => {
                  setRole("cliente");
                  setState(INITIAL_SUBMISSION_STATE);
                }}
                disabled={isSubmitting}
              />
              <UserIcon />
              <span>
                <b>Cliente</b>
                Invitado por un cajero
              </span>
            </label>
            <label className={role === "cajero" ? "is-selected" : ""}>
              <input
                type="radio"
                name="role"
                value="cajero"
                checked={role === "cajero"}
                onChange={() => {
                  setRole("cajero");
                  setState(INITIAL_SUBMISSION_STATE);
                }}
                disabled={isSubmitting}
              />
              <DeskIcon />
              <span>
                <b>Cajero</b>
                Invitado por el administrador
              </span>
            </label>
          </div>
        </fieldset>

        <Field
          label={role === "cliente" ? "Código de tu cajero" : "Código administrativo"}
          name="invitationCode"
          autoCapitalize="characters"
          autoComplete="off"
          minLength={6}
          maxLength={64}
          placeholder={role === "cliente" ? "Ejemplo: SINO-A7K9" : "Ingresa tu invitación"}
          value={code}
          onChange={(event) => {
            event.currentTarget.setCustomValidity("");
            setCode(event.currentTarget.value.toUpperCase());
            setState(INITIAL_SUBMISSION_STATE);
          }}
          hint={
            role === "cliente"
              ? "Este código te vinculará con el cajero que te invitó."
              : "Tu cuenta quedará pendiente de verificación antes de recibir clientes."
          }
          required
          disabled={isSubmitting}
        />
        <FormStatus state={state} />
        <button className="button button-primary" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Validando…" : "Validar y continuar"}
          {!isSubmitting ? <ArrowIcon /> : null}
        </button>
      </form>

      <button className="text-button" type="button" onClick={() => onNavigate("login")}>
        Ya tengo una cuenta
      </button>
    </>
  );
}

interface RegistrationProps {
  invitation: InvitationDraft;
  onNavigate: (view: AccessView) => void;
}

interface ClientRegistrationFormProps extends RegistrationProps {
  action?: AccessActions["registerClient"];
}

function ClientRegistrationForm({
  action,
  invitation,
  onNavigate,
}: ClientRegistrationFormProps) {
  const [state, setState] = useState<SubmissionState>(INITIAL_SUBMISSION_STATE);
  const [acceptsTerms, setAcceptsTerms] = useState(false);
  const terms = usePinnedRegistrationTerms();
  const isSubmitting = state.status === "submitting";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;

    if (!validateRegistrationForm(form)) {
      return;
    }

    if (terms.state.status !== "ready" || !acceptsTerms) {
      setState({
        status: "error",
        message: "Carga, lee y acepta los términos antes de crear la cuenta.",
      });
      return;
    }

    const data = new FormData(form);
    const input: ClientRegistrationInput = {
      invitationCode: invitation.code,
      username: String(data.get("username") ?? "").trim(),
      password: String(data.get("password") ?? ""),
      birthDate: String(data.get("birthDate") ?? ""),
      acceptsTerms: true,
      termsVersion: terms.state.document.version,
      termsContentHash: terms.state.document.contentHash,
    };

    if (!action) {
      setState({ status: "ready", message: integrationMessage });
      return;
    }

    setState({ status: "submitting", message: "Creando tu cuenta segura…" });

    try {
      await action(input);
      setState({
        status: "success",
        message: "Cuenta creada. Preparando tu conversación privada…",
      });
    } catch (error) {
      if (isTermsDocumentChanged(error)) {
        setAcceptsTerms(false);
        terms.markStale();
      }
      setState({ status: "error", message: messageFromError(error) });
    }
  }

  return (
    <RegistrationLayout
      role="cliente"
      invitation={invitation}
      onNavigate={onNavigate}
      intro="Solo necesitas un usuario y una contraseña. Guárdalos de forma segura: las cuentas de cliente no tienen recuperación de contraseña."
    >
      <form className="access-form" onSubmit={handleSubmit} aria-busy={isSubmitting}>
        <Field
          label="Usuario"
          name="username"
          autoCapitalize="none"
          autoComplete="username"
          minLength={3}
          maxLength={40}
          pattern="[A-Za-z0-9._-]+"
          title="Usa letras, números, puntos, guiones o guiones bajos."
          placeholder="Elige un nombre de usuario"
          required
          disabled={isSubmitting}
        />
        <PasswordField
          label="Contraseña"
          name="password"
          autoComplete="new-password"
          minLength={10}
          maxLength={128}
          placeholder="Mínimo 10 caracteres"
          hint="Guárdala en un lugar seguro. Si la pierdes, no podrás recuperar esta cuenta."
          required
          disabled={isSubmitting}
        />
        <PasswordField
          label="Repetir contraseña"
          name="passwordConfirmation"
          autoComplete="new-password"
          minLength={10}
          maxLength={128}
          placeholder="Vuelve a escribirla"
          onInput={(event) => event.currentTarget.setCustomValidity("")}
          required
          disabled={isSubmitting}
        />
        <AdultAndTermsFields
          acceptsTerms={acceptsTerms}
          disabled={isSubmitting}
          onAcceptsTermsChange={setAcceptsTerms}
          onReloadTerms={() => {
            setAcceptsTerms(false);
            terms.reload();
          }}
          terms={terms.state}
        />
        <FormStatus state={state} />
        <button className="button button-primary" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Creando cuenta…" : "Crear cuenta de cliente"}
          {!isSubmitting ? <ArrowIcon /> : null}
        </button>
      </form>
    </RegistrationLayout>
  );
}

interface CashierRegistrationFormProps extends RegistrationProps {
  action?: AccessActions["registerCashier"];
  onRegistrationAcknowledged: () => void;
}

function CashierRegistrationForm({
  action,
  invitation,
  onNavigate,
  onRegistrationAcknowledged,
}: CashierRegistrationFormProps) {
  const [state, setState] = useState<SubmissionState>(INITIAL_SUBMISSION_STATE);
  const [acceptsTerms, setAcceptsTerms] = useState(false);
  const [recoveryPackage, setRecoveryPackage] =
    useState<CashierRegistrationResult>();
  const terms = usePinnedRegistrationTerms();
  const isSubmitting = state.status === "submitting";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;

    if (!validateRegistrationForm(form)) {
      return;
    }

    if (terms.state.status !== "ready" || !acceptsTerms) {
      setState({
        status: "error",
        message: "Carga, lee y acepta los términos antes de enviar la solicitud.",
      });
      return;
    }

    const data = new FormData(form);
    const input: CashierRegistrationInput = {
      invitationCode: invitation.code,
      email: String(data.get("email") ?? "").trim(),
      username: String(data.get("username") ?? "").trim(),
      password: String(data.get("password") ?? ""),
      phone: String(data.get("phone") ?? "").trim(),
      birthDate: String(data.get("birthDate") ?? ""),
      acceptsTerms: true,
      termsVersion: terms.state.document.version,
      termsContentHash: terms.state.document.contentHash,
    };

    if (!action) {
      setState({ status: "ready", message: integrationMessage });
      return;
    }

    setState({ status: "submitting", message: "Enviando tu solicitud segura…" });

    try {
      const result = await action(input);
      setState({
        status: "success",
        message: "Cuenta creada. Guarda ahora tus códigos de recuperación.",
      });
      setRecoveryPackage(result);
    } catch (error) {
      if (isTermsDocumentChanged(error)) {
        setAcceptsTerms(false);
        terms.markStale();
      }
      setState({ status: "error", message: messageFromError(error) });
    }
  }

  if (recoveryPackage) {
    return (
      <CashierRecoveryCodesPanel
        recoveryPackage={recoveryPackage}
        onContinue={() => {
          setRecoveryPackage(undefined);
          onRegistrationAcknowledged();
        }}
      />
    );
  }

  return (
    <RegistrationLayout
      role="cajero"
      invitation={invitation}
      onNavigate={onNavigate}
      intro="Tus datos son administrativos y tu cuenta deberá aprobarse antes de recibir clientes."
    >
      <form className="access-form" onSubmit={handleSubmit} aria-busy={isSubmitting}>
        <div className="form-grid">
          <Field
            label="Correo electrónico"
            name="email"
            type="email"
            autoCapitalize="none"
            autoComplete="email"
            maxLength={254}
            placeholder="nombre@correo.com"
            required
            disabled={isSubmitting}
          />
          <Field
            label="Teléfono"
            name="phone"
            type="tel"
            autoComplete="tel"
            minLength={9}
            maxLength={16}
            pattern="\+[1-9][0-9]{7,14}"
            title="Usa formato internacional E.164: signo +, código de país y número, sin espacios."
            placeholder="+541112345678"
            required
            disabled={isSubmitting}
          />
        </div>
        <Field
          label="Usuario"
          name="username"
          autoCapitalize="none"
          autoComplete="username"
          minLength={3}
          maxLength={40}
          pattern="[A-Za-z0-9._-]+"
          title="Usa letras, números, puntos, guiones o guiones bajos."
          placeholder="Elige un nombre de usuario"
          required
          disabled={isSubmitting}
        />
        <PasswordField
          label="Contraseña"
          name="password"
          autoComplete="new-password"
          minLength={10}
          maxLength={128}
          placeholder="Mínimo 10 caracteres"
          hint="Guárdala de forma segura. Un restablecimiento administrativo no recupera por sí solo mensajes cifrados."
          required
          disabled={isSubmitting}
        />
        <PasswordField
          label="Repetir contraseña"
          name="passwordConfirmation"
          autoComplete="new-password"
          minLength={10}
          maxLength={128}
          placeholder="Vuelve a escribirla"
          onInput={(event) => event.currentTarget.setCustomValidity("")}
          required
          disabled={isSubmitting}
        />
        <AdultAndTermsFields
          acceptsTerms={acceptsTerms}
          disabled={isSubmitting}
          onAcceptsTermsChange={setAcceptsTerms}
          onReloadTerms={() => {
            setAcceptsTerms(false);
            terms.reload();
          }}
          terms={terms.state}
        />
        <FormStatus state={state} />
        <button className="button button-primary" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Enviando solicitud…" : "Solicitar cuenta de cajero"}
          {!isSubmitting ? <ArrowIcon /> : null}
        </button>
      </form>
    </RegistrationLayout>
  );
}

function CashierRecoveryCodesPanel({
  onContinue,
  recoveryPackage,
}: {
  onContinue: () => void;
  recoveryPackage: CashierRegistrationResult;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string>();

  async function copyCodes() {
    if (!navigator.clipboard?.writeText) {
      setCopyStatus("Copia los códigos manualmente; tu navegador bloqueó el portapapeles.");
      return;
    }
    try {
      await navigator.clipboard.writeText(recoveryPackage.recoveryCodes.join("\n"));
      setCopyStatus("Códigos copiados. Guárdalos fuera de SinoChat.");
    } catch {
      setCopyStatus("No se pudieron copiar automáticamente. Selecciónalos manualmente.");
    }
  }

  return (
    <div className="recovery-codes-panel" aria-labelledby="recovery-codes-title">
      <div className="recovery-codes-heading">
        <LockIcon />
        <div>
          <span>Solo se muestran esta vez</span>
          <h3 id="recovery-codes-title">Guarda tus códigos de recuperación</h3>
        </div>
      </div>
      <p>
        Los necesitarás si el administrador inicia un restablecimiento. Cada
        código sirve una sola vez y SinoChat solo almacena su hash.
      </p>
      <ol className="recovery-code-list">
        {recoveryPackage.recoveryCodes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ol>
      <p className="recovery-code-expiry">
        No vencen automáticamente: cada uno queda invalidado al usarlo y todos
        los anteriores se invalidan al rotarlos desde tu sesión.
      </p>
      <button className="button button-secondary" onClick={() => void copyCodes()} type="button">
        Copiar los 8 códigos
      </button>
      {copyStatus ? <p className="recovery-copy-status" role="status">{copyStatus}</p> : null}
      <label className="checkbox-field recovery-acknowledgement">
        <input
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.currentTarget.checked)}
          type="checkbox"
        />
        <span>Confirmo que guardé los 8 códigos en un lugar seguro.</span>
      </label>
      <button
        className="button button-primary"
        disabled={!acknowledged}
        onClick={onContinue}
        type="button"
      >
        Continuar a SinoChat
        <ArrowIcon />
      </button>
    </div>
  );
}

function RegistrationLayout({
  children,
  intro,
  invitation,
  onNavigate,
  role,
}: RegistrationProps & {
  children: React.ReactNode;
  intro: string;
  role: UserRole;
}) {
  return (
    <>
      <div className="step-row" aria-label="Paso 2 de 2">
        <span className="step-complete" aria-label="Paso 1 completado">
          ✓
        </span>
        <i className="is-complete" aria-hidden="true" />
        <span className="step-current">2</span>
        <p>Completa tus datos</p>
      </div>
      <p className="card-description registration-intro">{intro}</p>
      <div className="invitation-summary">
        <span>
          Invitación para <b>{role}</b>
        </span>
        <code>{invitation.code}</code>
        <button type="button" onClick={() => onNavigate("invitation")}>
          Cambiar
        </button>
      </div>
      {children}
    </>
  );
}

type PinnedTermsState =
  | { status: "loading" }
  | { status: "ready"; document: PublicTermsDocument }
  | { status: "stale"; document: PublicTermsDocument }
  | { status: "error"; message: string };

function usePinnedRegistrationTerms() {
  const [state, setState] = useState<PinnedTermsState>({ status: "loading" });
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void loadCurrentTerms(controller.signal)
      .then((document) => {
        if (!controller.signal.aborted) {
          setState({ status: "ready", document });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "No se pudieron cargar los términos vigentes.",
        });
      });
    return () => controller.abort();
  }, [loadAttempt]);

  return {
    state,
    markStale() {
      setState((current) =>
        current.status === "ready"
          ? { status: "stale", document: current.document }
          : current,
      );
    },
    reload() {
      setLoadAttempt((attempt) => attempt + 1);
    },
  };
}

function AdultAndTermsFields({
  acceptsTerms,
  disabled,
  onAcceptsTermsChange,
  onReloadTerms,
  terms,
}: {
  acceptsTerms: boolean;
  disabled: boolean;
  onAcceptsTermsChange: (accepted: boolean) => void;
  onReloadTerms: () => void;
  terms: PinnedTermsState;
}) {
  const document =
    terms.status === "ready" || terms.status === "stale"
      ? terms.document
      : null;

  return (
    <>
      <Field
        label="Fecha de nacimiento"
        name="birthDate"
        type="date"
        autoComplete="bday"
        min="1900-01-01"
        max={latestAdultBirthDate()}
        onInput={(event) => event.currentTarget.setCustomValidity("")}
        hint="Debes tener 18 años o más para usar SinoChat."
        required
        disabled={disabled}
      />
      <section
        className="registration-terms"
        aria-labelledby="registration-terms-title"
      >
        <div className="registration-terms-heading">
          <strong id="registration-terms-title">Términos que aceptarás</strong>
          {document ? <span>Versión {document.version}</span> : null}
        </div>
        {terms.status === "loading" ? (
          <p role="status">Cargando y verificando el documento…</p>
        ) : null}
        {terms.status === "error" ? (
          <div role="alert">
            <p>{terms.message}</p>
            <button type="button" onClick={onReloadTerms} disabled={disabled}>
              Reintentar
            </button>
          </div>
        ) : null}
        {terms.status === "stale" ? (
          <div className="registration-terms-stale" role="alert">
            <p>
              Esta versión dejó de ser vigente. Tu aceptación se desmarcó y no
              se actualizará automáticamente.
            </p>
            <button type="button" onClick={onReloadTerms} disabled={disabled}>
              Cargar y leer los términos vigentes
            </button>
          </div>
        ) : null}
        {document ? (
          <>
            <code className="registration-terms-hash">
              SHA-256 {document.contentHash}
            </code>
            <pre className="registration-terms-content">{document.content}</pre>
            <a
              href={`/terminos?version=${encodeURIComponent(document.version)}`}
              rel="noreferrer"
              target="_blank"
            >
              Abrir esta versión exacta en otra pestaña
            </a>
          </>
        ) : null}
      </section>
      <label className="checkbox-field">
        <input
          type="checkbox"
          name="acceptsTerms"
          checked={acceptsTerms}
          onChange={(event) => onAcceptsTermsChange(event.currentTarget.checked)}
          required
          disabled={disabled || terms.status !== "ready"}
        />
        <span>
          Confirmo que soy mayor de edad, que leí y acepto la versión{" "}
          <strong>
            {terms.status === "ready" ? terms.document.version : "indicada"}
          </strong>{" "}
          de los Términos de uso y la{" "}
          <a href="/privacidad" rel="noreferrer" target="_blank">
            Política de privacidad
          </a>
          .
        </span>
      </label>
    </>
  );
}

function isTermsDocumentChanged(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "TERMS_DOCUMENT_CHANGED"
  );
}

function validateRegistrationForm(form: HTMLFormElement) {
  const password = form.elements.namedItem("password") as HTMLInputElement;
  const confirmation = form.elements.namedItem(
    "passwordConfirmation",
  ) as HTMLInputElement;
  const birthDate = form.elements.namedItem("birthDate") as HTMLInputElement;

  confirmation.setCustomValidity(
    password.value === confirmation.value ? "" : "Las contraseñas no coinciden.",
  );
  birthDate.setCustomValidity(
    isAdult(birthDate.value) ? "" : "Debes tener al menos 18 años.",
  );

  return form.reportValidity();
}

function ArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M4 10h11M11 6l4 4-4 4" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <rect x="4.5" y="8.5" width="11" height="8" rx="2" />
      <path d="M7 8.5V6a3 3 0 0 1 6 0v2.5M10 12v2" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 3 5 6v5c0 4.6 2.8 8.1 7 10 4.2-1.9 7-5.4 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-5" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c.6-4 3-6 7-6s6.4 2 7 6" />
    </svg>
  );
}

function DeskIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="7" r="3" />
      <path d="M6 15c1-2.2 3-3.5 6-3.5s5 1.3 6 3.5M4 17h16v4H4z" />
    </svg>
  );
}
