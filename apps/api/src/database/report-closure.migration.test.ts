import { match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const statusMigration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260727014000_report_closing_status/migration.sql"
  ),
  "utf8"
);
const sagaMigration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260727014100_durable_report_closure/migration.sql"
  ),
  "utf8"
);
const warningMigration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20260727014700_report_warning_notification/migration.sql"
  ),
  "utf8"
);

describe("durable report closure migration", () => {
  it("separa la adicion segura del estado CLOSING", () => {
    match(
      statusMigration,
      /ALTER TYPE "ReportStatus" ADD VALUE IF NOT EXISTS 'CLOSING' BEFORE 'CLOSED'/
    );
  });

  it("persiste un job unico con lease y backoff", () => {
    match(sagaMigration, /CREATE TABLE "report_closure_jobs"/);
    match(
      sagaMigration,
      /CONSTRAINT "report_closure_jobs_pkey" PRIMARY KEY \("report_id"\)/
    );
    match(sagaMigration, /"lease_token" UUID/);
    match(sagaMigration, /"leased_until" TIMESTAMPTZ\(6\)/);
    match(sagaMigration, /"next_attempt_at" TIMESTAMPTZ\(6\)/);
    match(
      sagaMigration,
      /closing reports require exactly one durable closure job/
    );
  });

  it("impide purgar fuera de CLOSING y conserva la historia monotona", () => {
    match(
      sagaMigration,
      /"parent_status" NOT IN \('CLOSING', 'CLOSED'\)/
    );
    match(
      sagaMigration,
      /OLD\."status" = 'CLOSING' AND NEW\."status" NOT IN \('CLOSING', 'CLOSED'\)/
    );
    match(
      sagaMigration,
      /"status" = 'CLOSING'[\s\S]*"close_requested_at" IS NOT NULL[\s\S]*"evidence_purged_at" IS NULL/
    );
  });

  it("distingue la advertencia administrativa de un cierre generico", () => {
    match(
      warningMigration,
      /ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REPORT_WARNING'/
    );
  });
});
