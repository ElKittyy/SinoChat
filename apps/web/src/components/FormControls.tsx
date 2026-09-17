import { useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import type { SubmissionState } from "../access";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  trailing?: ReactNode;
}

export function Field({ label, hint, trailing, id: suppliedId, ...inputProps }: FieldProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <div className="field">
      <div className="field-label-row">
        <label htmlFor={id}>{label}</label>
        {trailing}
      </div>
      <input id={id} aria-describedby={hintId} {...inputProps} />
      {hint ? (
        <span className="field-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

interface PasswordFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  hint?: string;
}

export function PasswordField({ label, hint, id: suppliedId, ...inputProps }: PasswordFieldProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const hintId = hint ? `${id}-hint` : undefined;
  const [isVisible, setIsVisible] = useState(false);

  return (
    <div className="field">
      <div className="field-label-row">
        <label htmlFor={id}>{label}</label>
        <button
          className="field-action"
          type="button"
          aria-controls={id}
          aria-pressed={isVisible}
          onClick={() => setIsVisible((current) => !current)}
        >
          {isVisible ? "Ocultar" : "Mostrar"}
        </button>
      </div>
      <input
        {...inputProps}
        id={id}
        type={isVisible ? "text" : "password"}
        aria-describedby={hintId}
      />
      {hint ? (
        <span className="field-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function FormStatus({ state }: { state: SubmissionState }) {
  if (state.status === "idle") {
    return null;
  }

  return (
    <div
      className={`form-status form-status-${state.status}`}
      role={state.status === "error" ? "alert" : "status"}
      aria-live="polite"
    >
      <span aria-hidden="true">
        {state.status === "error" ? "!" : state.status === "success" ? "✓" : "•"}
      </span>
      <p>{state.message}</p>
    </div>
  );
}
