import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  // Los comandos del monorepo administran un único .env en la raíz. Vite solo
  // expone al navegador las variables con prefijo VITE_, no los secretos de la
  // API que viven en el mismo archivo.
  envDir: "../..",
  plugins: [react()],
  resolve: {
    // La API consume la salida CommonJS de contracts. El navegador necesita
    // la fuente ESM para evitar entregar un modulo CommonJS sin transformar.
    alias: {
      "@sinochat/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 5173
  }
});
