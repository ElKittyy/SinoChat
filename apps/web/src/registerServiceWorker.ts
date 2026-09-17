export function registerSinoChatServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) {
    return;
  }

  window.addEventListener(
    "load",
    () => {
      void navigator.serviceWorker
        .register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        })
        .catch(() => {
          // La web sigue operativa sin SW; no registramos datos del navegador.
          console.warn("No se pudo habilitar el modo instalable de SinoChat.");
        });
    },
    { once: true },
  );
}
