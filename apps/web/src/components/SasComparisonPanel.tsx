import { useEffect, useId, useRef, useState } from "react";
import type { MatrixSasComparisonView } from "../e2ee/matrixSasComparison";
import "./SasComparisonPanel.css";

export interface SasComparisonPanelProps {
  view: MatrixSasComparisonView;
  busy: boolean;
  onConfirm: (comparisonId: string) => Promise<void>;
  onReject: () => Promise<void>;
  onCancel: () => Promise<void>;
}

type CompareView = Extract<MatrixSasComparisonView, { state: "compare" }>;

/** Presentation only. No transport, persistence, SDK initialization or device activation. */
export function SasComparisonPanel({ view, busy, onConfirm, onReject, onCancel }: SasComparisonPanelProps) {
  const titleId = useId();
  const pending = useRef(false);
  const mounted = useRef(true);
  const current = useRef(view);
  current.current = view;
  const [inFlight, setInFlight] = useState(false);
  const [failedContext, setFailedContext] = useState<string>();
  const context = contextOf(view);
  const invalid = view.state === "compare" && !validComparison(view);
  const failed = invalid || failedContext === context;
  const disabled = busy || inFlight;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function act(kind: "confirm" | "reject" | "cancel", comparisonId?: string): Promise<void> {
    const active = current.current;
    const activeContext = contextOf(active);
    if (busy || pending.current || !mounted.current || failedContext === activeContext ||
      !["compare", "waiting", "waiting-peer"].includes(active.state)) return;
    if (active.state === "compare" && !validComparison(active)) return;
    if ((kind === "confirm" || kind === "reject") && active.state !== "compare") return;
    if (kind === "confirm" && (active.state !== "compare" || comparisonId !== active.comparisonId)) return;

    // Synchronous guard covers two clicks before React commits disabled state.
    pending.current = true;
    setInFlight(true);
    try {
      if (kind === "confirm") await onConfirm(comparisonId!);
      else if (kind === "reject") await onReject();
      else await onCancel();
    } catch {
      // Neither callback errors nor comparison identifiers belong in UI/logs.
      if (mounted.current && contextOf(current.current) === activeContext) setFailedContext(activeContext);
    } finally {
      pending.current = false;
      if (mounted.current) setInFlight(false);
    }
  }

  const state = failed ? "failed" : view.state;
  return (
    <section className="sas-panel" aria-labelledby={titleId} aria-busy={disabled}>
      <header className="sas-panel__heading">
        <span>Verificación entre tus dispositivos</span>
        <h2 id={titleId}>Compara ambas pantallas</h2>
      </header>
      {state === "compare" && view.state === "compare" ? (
        <ComparisonControls
          key={context}
          view={view}
          disabled={disabled}
          onConfirm={() => act("confirm", view.comparisonId)}
          onReject={() => act("reject")}
          onCancel={() => act("cancel")}
        />
      ) : (
        <>
          <p className="sas-panel__status" role={state === "failed" ? "alert" : "status"}>
            {messageForState(state)}
          </p>
          {state === "waiting" || state === "waiting-peer" ? (
            <button className="sas-panel__button sas-panel__button--secondary" type="button" disabled={disabled} onClick={() => void act("cancel")}>
              Cancelar comparación
            </button>
          ) : null}
        </>
      )}
      <p className="sas-panel__notice">
        Esta comparación no da de alta el dispositivo ni habilita el chat.
      </p>
    </section>
  );
}

function ComparisonControls({ view, disabled, onConfirm, onReject, onCancel }: {
  view: CompareView;
  disabled: boolean;
  onConfirm: () => Promise<void>;
  onReject: () => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const consumed = useRef(false);
  function confirm() {
    if (disabled || !acknowledged || consumed.current) return;
    consumed.current = true;
    setSubmitted(true);
    void onConfirm();
  }
  return (
    <>
      <p className="sas-panel__instructions">
        Compara los tres grupos de cuatro números con los que ves en la otra pantalla.
        Deben coincidir exactamente y en el mismo orden.
      </p>
      <ol className="sas-panel__numbers" aria-label="Grupos para comparar">
        {view.decimals.map((value, index) => (
          <li key={index}>
            <span aria-hidden="true">Grupo {index + 1}</span>
            <output aria-label={`Grupo ${index + 1}`}>{value}</output>
          </li>
        ))}
      </ol>
      <p className="sas-panel__warning">No compartas estos números por chat, correo ni con otra persona.</p>
      <label className="sas-panel__acknowledgement">
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={disabled || submitted}
          onChange={(event) => setAcknowledged(event.currentTarget.checked)}
        />
        <span>He comparado los tres grupos de números en ambas pantallas y son iguales.</span>
      </label>
      <div className="sas-panel__actions">
        <button className="sas-panel__button sas-panel__button--primary" type="button" disabled={disabled || !acknowledged || submitted} onClick={confirm}>
          Sí, coinciden
        </button>
        <button className="sas-panel__button sas-panel__button--secondary" type="button" disabled={disabled} onClick={() => void onReject()}>
          No coinciden
        </button>
        <button className="sas-panel__button sas-panel__button--quiet" type="button" disabled={disabled} onClick={() => void onCancel()}>
          Cancelar comparación
        </button>
      </div>
      {submitted ? <p role="status">Tu confirmación está en proceso. Espera la actualización de la comparación.</p> : null}
    </>
  );
}

function validComparison(view: CompareView): boolean {
  return typeof view.comparisonId === "string" && view.comparisonId.length > 0 &&
    Array.isArray(view.decimals) && view.decimals.length === 3 &&
    view.decimals.every((value) => Number.isInteger(value) && value >= 1000 && value <= 9191);
}

function contextOf(view: MatrixSasComparisonView): string {
  // In-memory React state only; never use this receipt as a DOM attribute or key in storage.
  return view.state === "compare" && validComparison(view)
    ? `compare:${view.comparisonId}:${view.decimals.join(":")}`
    : view.state;
}

function messageForState(state: MatrixSasComparisonView["state"]): string {
  switch (state) {
    case "waiting": return "Preparando la comparación. Mantén abiertas ambas pantallas.";
    case "waiting-peer": return "Esperando que confirmes la comparación también en el otro dispositivo.";
    case "comparison-complete": return "Comparación completada. El alta del dispositivo sigue pendiente.";
    case "cancelled": return "Comparación cancelada. No se ha dado de alta ningún dispositivo.";
    case "expired": return "La comparación venció. Inicia una nueva comparación cuando esté disponible.";
    case "closed": return "La comparación se cerró.";
    default: return "No se pudo completar la comparación. Inicia una nueva comparación cuando esté disponible.";
  }
}
