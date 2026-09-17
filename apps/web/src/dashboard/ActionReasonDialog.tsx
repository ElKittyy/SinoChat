import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { DashboardIcon } from "./DashboardIcon";
import type { MaybePromise } from "./types";

interface ActionReasonDialogProps {
  actionLabel: string;
  collectReason?: boolean;
  description: string;
  isDangerous?: boolean;
  maxLength?: number;
  minimumLength?: number;
  onCancel: () => void;
  onConfirm: (reason: string) => MaybePromise;
  validationMessage?: string;
  validationPattern?: RegExp;
  title: string;
}

export function ActionReasonDialog({
  actionLabel,
  collectReason = true,
  description,
  isDangerous = false,
  maxLength = 1000,
  minimumLength = 20,
  onCancel,
  onConfirm,
  validationMessage = "El motivo contiene caracteres no permitidos.",
  validationPattern,
  title,
}: ActionReasonDialogProps) {
  const descriptionId = useId();
  const fieldId = useId();
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);
  const onCancelRef = useRef(onCancel);
  const normalizedReason = reason.trim();
  const remaining = Math.max(0, minimumLength - normalizedReason.length);
  const matchesPattern =
    !validationPattern || validationPattern.test(normalizedReason);

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
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape" && !isSubmitting) {
        onCancelRef.current();
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
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isSubmitting]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (collectReason && normalizedReason.length < minimumLength) {
      setError(`Escribe al menos ${minimumLength} caracteres.`);
      return;
    }

    if (collectReason && !matchesPattern) {
      setError(validationMessage);
      return;
    }

    setIsSubmitting(true);
    setError(undefined);

    try {
      await onConfirm(collectReason ? normalizedReason : "");
    } catch (caughtError) {
      setError(actionErrorMessage(caughtError));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      className="dash-dialog-backdrop"
      onMouseDown={() => {
        if (!isSubmitting) onCancel();
      }}
    >
      <section
        aria-busy={isSubmitting}
        aria-describedby={descriptionId}
        aria-labelledby={`${fieldId}-title`}
        aria-modal="true"
        className="dash-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
      >
        <span
          aria-hidden="true"
          className={`dash-dialog-icon${isDangerous ? " is-dangerous" : ""}`}
        >
          <DashboardIcon
            name={isDangerous ? "block" : collectReason ? "report" : "shield"}
          />
        </span>
        <h2 id={`${fieldId}-title`}>{title}</h2>
        <p id={descriptionId}>{description}</p>

        <form onSubmit={handleSubmit}>
          {collectReason ? (
            <>
              <label htmlFor={fieldId}>Motivo</label>
              <textarea
                autoFocus
                disabled={isSubmitting}
                id={fieldId}
                maxLength={maxLength}
                onChange={(event) => {
                  setReason(event.target.value);
                  setError(undefined);
                }}
                placeholder="Describe claramente lo ocurrido…"
                rows={5}
                value={reason}
              />
              <div className="dash-field-meta">
                <span>
                  {remaining > 0
                    ? `Faltan ${remaining} caracteres`
                    : matchesPattern
                      ? "Motivo válido"
                      : validationMessage}
                </span>
                <span>
                  {reason.length}/{maxLength}
                </span>
              </div>
            </>
          ) : null}
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
              autoFocus={!collectReason}
              className={
                isDangerous
                  ? "dash-button dash-button-danger"
                  : "dash-button dash-button-primary"
              }
              disabled={
                isSubmitting ||
                (collectReason && (remaining > 0 || !matchesPattern))
              }
              type="submit"
            >
              {isSubmitting ? "Procesando…" : actionLabel}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function actionErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "No se pudo completar la acción. Inténtalo nuevamente.";
}
