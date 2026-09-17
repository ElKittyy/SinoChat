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
  AdminReport,
  AdminReportCloseInput,
  AdminReportEvidenceAccessInput,
  AdminReportEvidencePackage,
  AdminReportOutcome,
  MaybePromise,
} from "./types";

interface EvidenceAccessDialogProps {
  report: AdminReport;
  onCancel: () => void;
  onConfirm: (
    input: AdminReportEvidenceAccessInput,
  ) => MaybePromise<AdminReportEvidencePackage>;
}

export function AdminReportEvidenceAccessDialog({
  report,
  onCancel,
  onConfirm,
}: EvidenceAccessDialogProps) {
  const descriptionId = useId();
  const passwordId = useId();
  const reasonId = useId();
  const [currentPassword, setCurrentPassword] = useState("");
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [evidence, setEvidence] = useState<AdminReportEvidencePackage>();
  const normalizedReason = reason.trim();
  const remainingReasonCharacters = Math.max(0, 20 - normalizedReason.length);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentPassword) {
      setError("Ingresa tu contraseña actual.");
      return;
    }
    if (remainingReasonCharacters > 0) {
      setError("La justificación debe tener al menos 20 caracteres.");
      return;
    }

    setIsSubmitting(true);
    setError(undefined);
    const passwordForRequest = currentPassword;
    setCurrentPassword("");
    try {
      setEvidence(
        await onConfirm({
          currentPassword: passwordForRequest,
          reason: normalizedReason,
        }),
      );
    } catch (caughtError) {
      setError(reportActionErrorMessage(caughtError));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ReportDialogFrame
      descriptionId={descriptionId}
      isBusy={isSubmitting}
      onCancel={onCancel}
      title="Acceso protegido a evidencia"
    >
      <span aria-hidden="true" className="dash-dialog-icon">
        <DashboardIcon name="lock" />
      </span>
      <h2>Acceso protegido a evidencia</h2>
      <p id={descriptionId}>
        Reporte #{report.id}. Esta acción queda auditada y solo entrega un
        paquete cifrado para su traslado a la estación externa autorizada.
      </p>

      {evidence ? (
        <EvidenceDownloadResult evidence={evidence} onClose={onCancel} />
      ) : (
        <form className="dash-dialog-form-grid" onSubmit={handleSubmit}>
          <label className="dash-dialog-field" htmlFor={passwordId}>
            <span>Contraseña actual</span>
            <input
              autoComplete="current-password"
              autoFocus
              disabled={isSubmitting}
              id={passwordId}
              maxLength={128}
              onChange={(event) => {
                setCurrentPassword(event.target.value);
                setError(undefined);
              }}
              required
              type="password"
              value={currentPassword}
            />
          </label>
          <label className="dash-dialog-field" htmlFor={reasonId}>
            <span>Justificación de acceso</span>
            <textarea
              disabled={isSubmitting}
              id={reasonId}
              maxLength={1000}
              onChange={(event) => {
                setReason(event.target.value);
                setError(undefined);
              }}
              placeholder="Explica por qué necesitas descargar esta evidencia…"
              required
              rows={5}
              value={reason}
            />
            <small>
              {remainingReasonCharacters > 0
                ? `Faltan ${remainingReasonCharacters} caracteres.`
                : "La justificación se guardará en el registro de auditoría."}
            </small>
          </label>
          <div className="dash-report-security-note">
            <DashboardIcon name="lock" />
            <p>
              SinoChat no descifra ni muestra el chat. Conserva el archivo
              descargado en un entorno autorizado y separado.
            </p>
          </div>
          {error ? (
            <p className="dash-form-error" role="alert">
              {error}
            </p>
          ) : null}
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
              disabled={
                isSubmitting || !currentPassword || remainingReasonCharacters > 0
              }
              type="submit"
            >
              {isSubmitting ? "Autorizando…" : "Autorizar acceso"}
            </button>
          </div>
        </form>
      )}
    </ReportDialogFrame>
  );
}

function EvidenceDownloadResult({
  evidence,
  onClose,
}: {
  evidence: AdminReportEvidencePackage;
  onClose: () => void;
}) {
  return (
    <div className="dash-evidence-result">
      <div aria-live="polite" className="dash-report-security-note is-success">
        <DashboardIcon name="shield" />
        <p>
          Acceso autorizado. El enlace es temporal y el archivo permanece
          cifrado de extremo a extremo.
        </p>
      </div>
      <dl className="dash-evidence-metadata">
        <div>
          <dt>Tamaño cifrado</dt>
          <dd>{formatByteSize(evidence.ciphertextByteSize)}</dd>
        </div>
        <div>
          <dt>Formato</dt>
          <dd>
            Manifiesto v{evidence.manifestVersion} · {evidence.cipherSuite}
          </dd>
        </div>
        <div>
          <dt>Clave de investigación</dt>
          <dd>
            v{evidence.investigationKey.version} · {evidence.investigationKey.algorithm}
          </dd>
        </div>
        <div>
          <dt>Enlace disponible</dt>
          <dd>{evidence.downloadExpiresInSeconds} segundos</dd>
        </div>
        <div className="is-full-width">
          <dt>SHA-256 del paquete</dt>
          <dd>
            <code>{evidence.ciphertextSha256}</code>
          </dd>
        </div>
        <div className="is-full-width">
          <dt>Huella de la clave</dt>
          <dd>
            <code>{evidence.investigationKey.fingerprint}</code>
          </dd>
        </div>
      </dl>
      <p className="dash-evidence-guidance">
        Descarga el paquete ahora y verifica su SHA-256 antes de trasladarlo. La
        clave privada no forma parte de esta descarga ni de este navegador.
      </p>
      <div className="dash-dialog-actions">
        <button
          className="dash-button dash-button-ghost"
          onClick={onClose}
          type="button"
        >
          Cerrar
        </button>
        <a
          className="dash-button dash-button-primary"
          download={`sinochat-evidencia-${evidence.reportId}.enc`}
          href={evidence.downloadUrl}
          referrerPolicy="no-referrer"
          rel="noopener noreferrer"
          target="_blank"
        >
          Descargar paquete cifrado
        </a>
      </div>
    </div>
  );
}

interface CloseReportDialogProps {
  report: AdminReport;
  onCancel: () => void;
  onConfirm: (input: AdminReportCloseInput) => MaybePromise;
}

const reportOutcomes: readonly {
  value: AdminReportOutcome;
  label: string;
}[] = [
  { value: "NO_ACTION", label: "Sin medidas" },
  { value: "WARNING", label: "Advertencia" },
  { value: "CASHIER_SUSPENDED", label: "Cajero suspendido" },
  { value: "CASHIER_DELETED", label: "Cajero eliminado" },
  { value: "OTHER", label: "Otra medida" },
];

export function AdminReportCloseDialog({
  report,
  onCancel,
  onConfirm,
}: CloseReportDialogProps) {
  const descriptionId = useId();
  const outcomeId = useId();
  const summaryId = useId();
  const [outcome, setOutcome] = useState<AdminReportOutcome>("NO_ACTION");
  const [resolutionSummary, setResolutionSummary] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const normalizedSummary = resolutionSummary.trim();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!normalizedSummary) {
      setError("Escribe un resumen de la resolución.");
      return;
    }
    setIsSubmitting(true);
    setError(undefined);
    try {
      await onConfirm({ outcome, resolutionSummary: normalizedSummary });
    } catch (caughtError) {
      setError(reportActionErrorMessage(caughtError));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ReportDialogFrame
      descriptionId={descriptionId}
      isBusy={isSubmitting}
      onCancel={onCancel}
      title="Cerrar investigación"
    >
      <span aria-hidden="true" className="dash-dialog-icon is-dangerous">
        <DashboardIcon name="report" />
      </span>
      <h2>Cerrar investigación</h2>
      <p id={descriptionId}>
        Reporte #{report.id}. El cierre inicia la eliminación permanente de la
        evidencia y no permitirá volver a acceder a su contenido.
      </p>
      <form className="dash-dialog-form-grid" onSubmit={handleSubmit}>
        <label className="dash-dialog-field" htmlFor={outcomeId}>
          <span>Resultado</span>
          <select
            autoFocus
            disabled={isSubmitting}
            id={outcomeId}
            onChange={(event) => {
              setOutcome(event.target.value as AdminReportOutcome);
              setError(undefined);
            }}
            value={outcome}
          >
            {reportOutcomes.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          {outcome === "CASHIER_SUSPENDED" ||
          outcome === "CASHIER_DELETED" ? (
            <small>
              Primero aplica esa medida desde Usuarios. El cierre solo registra
              un estado que la API ya verificó y no ejecuta la sanción.
            </small>
          ) : null}
        </label>
        <label className="dash-dialog-field" htmlFor={summaryId}>
          <span>Resumen de resolución</span>
          <textarea
            disabled={isSubmitting}
            id={summaryId}
            maxLength={2000}
            onChange={(event) => {
              setResolutionSummary(event.target.value);
              setError(undefined);
            }}
            placeholder="Documenta la conclusión y las medidas adoptadas…"
            required
            rows={6}
            value={resolutionSummary}
          />
          <small>{resolutionSummary.length}/2000 caracteres</small>
        </label>
        {error ? (
          <p className="dash-form-error" role="alert">
            {error}
          </p>
        ) : null}
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
            className="dash-button dash-button-danger"
            disabled={isSubmitting || !normalizedSummary}
            type="submit"
          >
            {isSubmitting ? "Iniciando cierre…" : "Confirmar cierre"}
          </button>
        </div>
      </form>
    </ReportDialogFrame>
  );
}

function ReportDialogFrame({
  children,
  descriptionId,
  isBusy,
  onCancel,
  title,
}: {
  children: ReactNode;
  descriptionId: string;
  isBusy: boolean;
  onCancel: () => void;
  title: string;
}) {
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
    return () => previouslyFocused?.focus();
  }, []);

  useEffect(() => {
    function handleKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape" && !isBusy) {
        onCancelRef.current();
        return;
      }
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
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [isBusy]);

  return (
    <div
      className="dash-dialog-backdrop"
      onMouseDown={() => {
        if (!isBusy) onCancel();
      }}
    >
      <section
        aria-busy={isBusy}
        aria-describedby={descriptionId}
        aria-label={title}
        aria-modal="true"
        className="dash-dialog dash-management-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
      >
        {children}
      </section>
    </div>
  );
}

function formatByteSize(value: string) {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) return `${value} bytes`;
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = -1;
  do {
    size /= 1024;
    unit += 1;
  } while (size >= 1024 && unit < units.length - 1);
  return `${size.toLocaleString("es-AR", { maximumFractionDigits: 2 })} ${units[unit]}`;
}

function reportActionErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "No se pudo completar la acción. Inténtalo nuevamente.";
}
