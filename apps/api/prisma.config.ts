import "./src/config/load-env";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // El job de migraciones puede usar una credencial distinta y más
    // privilegiada; la API de runtime no debe conservarla.
    url: process.env.MIGRATION_DATABASE_URL?.trim() || env("DATABASE_URL"),
  },
});
