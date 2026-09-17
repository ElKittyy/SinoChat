import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applicationApi } from "./api";
import { registerSinoChatServiceWorker } from "./registerServiceWorker";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App api={applicationApi} />
  </StrictMode>
);

registerSinoChatServiceWorker();
