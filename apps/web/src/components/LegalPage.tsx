import { useEffect, useState } from "react";
import { loadCurrentTerms, loadTermsByVersion } from "../api";

export type PublicInformationView =
  | "terms"
  | "privacy"
  | "security";

type TermsState =
  | { status: "loading" }
  | {
      status: "ready";
      content: string;
      contentHash: string;
      version: string;
    }
  | { status: "error"; message: string };

export function LegalPage({ view }: { view: PublicInformationView }) {
  const [terms, setTerms] = useState<TermsState>({ status: "loading" });
  const requestedTermsVersion =
    view === "terms"
      ? new URLSearchParams(window.location.search).get("version")?.trim() || null
      : null;

  useEffect(() => {
    if (view !== "terms") return;
    const controller = new AbortController();
    setTerms({ status: "loading" });
    const request = requestedTermsVersion
      ? loadTermsByVersion(requestedTermsVersion, controller.signal)
      : loadCurrentTerms(controller.signal);
    void request
      .then((document) => {
        if (!controller.signal.aborted) {
          setTerms({
            status: "ready",
            content: document.content,
            contentHash: document.contentHash,
            version: document.version
          });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setTerms({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "No se pudieron cargar los términos."
        });
      });
    return () => controller.abort();
  }, [requestedTermsVersion, view]);

  return (
    <div className="public-document-shell">
      <header className="public-document-header">
        <a href="/" aria-label="SinoChat, volver al inicio">
          <img src="/assets/sinochat-logo.png" alt="SinoChat" />
        </a>
        <a className="button button-gold" href="/ingresar">
          Iniciar sesión
        </a>
      </header>
      <main className="public-document-main" id="main-content">
        {view === "terms" ? <TermsDocument state={terms} /> : null}
        {view === "privacy" ? <PrivacyInformation /> : null}
        {view === "security" ? <SecurityInformation /> : null}
      </main>
      <footer className="public-document-footer">
        <a href="/terminos">Términos</a>
        <a href="/privacidad">Privacidad</a>
        <a href="/seguridad">Seguridad</a>
      </footer>
    </div>
  );
}

function TermsDocument({ state }: { state: TermsState }) {
  return (
    <article aria-labelledby="public-document-title">
      <p className="eyebrow">Documento legal verificable</p>
      <h1 id="public-document-title">Términos de uso</h1>
      {state.status === "loading" ? (
        <p role="status">Cargando la versión vigente…</p>
      ) : null}
      {state.status === "error" ? (
        <div className="public-document-warning" role="alert">
          <strong>Términos no disponibles</strong>
          <p>{state.message}</p>
          <p>El registro permanece inhabilitado hasta su publicación.</p>
        </div>
      ) : null}
      {state.status === "ready" ? (
        <>
          <p className="public-document-version">
            Versión publicada: <strong>{state.version}</strong>
            <br />
            <code>SHA-256 {state.contentHash}</code>
          </p>
          <pre className="public-document-content">{state.content}</pre>
        </>
      ) : null}
    </article>
  );
}

function PrivacyInformation() {
  return (
    <article aria-labelledby="public-document-title">
      <p className="eyebrow">Privacidad</p>
      <h1 id="public-document-title">Política de privacidad</h1>
      <div className="public-document-warning">
        <strong>Documento pendiente de aprobación profesional</strong>
        <p>
          SinoChat no debe abrir registros ni operar con datos reales hasta
          publicar aquí la política aplicable al país de lanzamiento.
        </p>
      </div>
      <p>
        La especificación técnica minimiza los metadatos, separa la evidencia
        reportada y prohíbe al administrador consultar chats ordinarios. Esos
        controles no reemplazan el aviso legal que debe explicar responsables,
        finalidades, derechos, proveedores y plazos de conservación.
      </p>
    </article>
  );
}

function SecurityInformation() {
  return (
    <article aria-labelledby="public-document-title">
      <p className="eyebrow">Seguridad</p>
      <h1 id="public-document-title">Cómo protege SinoChat</h1>
      <ul className="public-document-list">
        <li>El chat solo une a un cliente con su cajero asignado.</li>
        <li>Texto y fotos dejan de estar disponibles al cumplir 48 horas.</li>
        <li>Las fotos cifradas admiten JPEG, PNG y WebP hasta 5 MiB.</li>
        <li>Reportar bloquea la relación y separa la evidencia para revisión.</li>
        <li>No se recomienda compartir contraseñas ni información sensible.</li>
      </ul>
      <div className="public-document-warning">
        <strong>Estado criptográfico</strong>
        <p>
          El lanzamiento del chat continúa bloqueado hasta seleccionar,
          integrar y auditar externamente el protocolo E2EE multidispositivo.
        </p>
      </div>
    </article>
  );
}
