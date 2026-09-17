BEGIN;

ALTER TABLE "reports"
    ADD COLUMN "close_requested_at" TIMESTAMPTZ(6);

-- Preserve already closed historical cases while making the moment at which
-- the durable close intent was accepted explicit for all future cases.
UPDATE "reports"
   SET "close_requested_at" = "closed_at"
 WHERE "status" = 'CLOSED';

CREATE TABLE "report_closure_jobs" (
    "report_id" UUID NOT NULL,
    "requested_by_admin_user_id" UUID NOT NULL,
    "evidence_object_key" VARCHAR(512) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" UUID,
    "leased_until" TIMESTAMPTZ(6),
    "last_attempt_at" TIMESTAMPTZ(6),
    "last_error_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "report_closure_jobs_pkey" PRIMARY KEY ("report_id"),
    CONSTRAINT "report_closure_jobs_attempts_check"
        CHECK ("attempts" >= 0),
    CONSTRAINT "report_closure_jobs_lease_check"
        CHECK (("lease_token" IS NULL) = ("leased_until" IS NULL)),
    CONSTRAINT "report_closure_jobs_error_code_check"
        CHECK (
            "last_error_code" IS NULL
            OR "last_error_code" ~ '^[A-Z0-9_]{3,64}$'
        )
);

CREATE UNIQUE INDEX "report_closure_jobs_evidence_object_key_key"
    ON "report_closure_jobs"("evidence_object_key");
CREATE INDEX "report_closure_jobs_due_idx"
    ON "report_closure_jobs"("next_attempt_at", "leased_until");

ALTER TABLE "report_closure_jobs"
    ADD CONSTRAINT "report_closure_jobs_report_id_fkey"
        FOREIGN KEY ("report_id") REFERENCES "reports"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "report_closure_jobs_requested_by_admin_user_id_fkey"
        FOREIGN KEY ("requested_by_admin_user_id") REFERENCES "users"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reports" DROP CONSTRAINT "reports_lifecycle_check";
ALTER TABLE "reports"
    ADD CONSTRAINT "reports_lifecycle_check"
        CHECK (
            (
                "status" = 'OPEN'
                AND "reviewed_by_admin_user_id" IS NULL
                AND "review_started_at" IS NULL
                AND "outcome" IS NULL
                AND "resolution_summary" IS NULL
                AND "close_requested_at" IS NULL
                AND "closed_at" IS NULL
                AND "evidence_purged_at" IS NULL
            )
            OR (
                "status" = 'IN_REVIEW'
                AND "reviewed_by_admin_user_id" IS NOT NULL
                AND "review_started_at" IS NOT NULL
                AND "outcome" IS NULL
                AND "resolution_summary" IS NULL
                AND "close_requested_at" IS NULL
                AND "closed_at" IS NULL
                AND "evidence_purged_at" IS NULL
            )
            OR (
                "status" = 'CLOSING'
                AND "reviewed_by_admin_user_id" IS NOT NULL
                AND "review_started_at" IS NOT NULL
                AND "outcome" IS NOT NULL
                AND "resolution_summary" IS NOT NULL
                AND char_length(btrim("resolution_summary")) > 0
                AND "close_requested_at" IS NOT NULL
                AND "close_requested_at" >= "review_started_at"
                AND "closed_at" IS NULL
                AND "evidence_purged_at" IS NULL
                AND "subject_notified_at" IS NULL
            )
            OR (
                "status" = 'CLOSED'
                AND "reviewed_by_admin_user_id" IS NOT NULL
                AND "review_started_at" IS NOT NULL
                AND "outcome" IS NOT NULL
                AND "resolution_summary" IS NOT NULL
                AND char_length(btrim("resolution_summary")) > 0
                AND "close_requested_at" IS NOT NULL
                AND "closed_at" IS NOT NULL
                AND "evidence_purged_at" IS NOT NULL
                AND "close_requested_at" >= "review_started_at"
                AND "closed_at" >= "close_requested_at"
                AND "evidence_purged_at" >= "closed_at"
            )
        );

CREATE OR REPLACE FUNCTION "sinochat_validate_report_evidence_lifecycle"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "target_report_id" UUID;
    "row_data" JSONB;
    "target_status" "ReportStatus";
    "evidence_count" INTEGER;
BEGIN
    "row_data" := CASE
        WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
        ELSE to_jsonb(NEW)
    END;

    "target_report_id" := CASE
        WHEN TG_TABLE_NAME = 'reports' THEN
            ("row_data" ->> 'id')::UUID
        ELSE
            ("row_data" ->> 'report_id')::UUID
    END;

    SELECT "status"
      INTO "target_status"
      FROM "reports"
     WHERE "id" = "target_report_id";

    IF "target_status" IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT count(*)
      INTO "evidence_count"
      FROM "report_evidence"
     WHERE "report_id" = "target_report_id";

    IF (
        "target_status" IN ('OPEN', 'IN_REVIEW', 'CLOSING')
        AND "evidence_count" <> 1
    ) OR (
        "target_status" = 'CLOSED'
        AND "evidence_count" <> 0
    ) THEN
        RAISE EXCEPTION 'active and closing reports require one encrypted evidence package; closed reports require it to be purged'
            USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "sinochat_enforce_report_history"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'reports cannot be deleted'
            USING ERRCODE = '23514';
    END IF;

    IF NEW."block_id" <> OLD."block_id"
       OR NEW."created_at" <> OLD."created_at"
       OR (OLD."status" = 'OPEN' AND NEW."status" NOT IN ('OPEN', 'IN_REVIEW'))
       OR (OLD."status" = 'IN_REVIEW' AND NEW."status" NOT IN ('IN_REVIEW', 'CLOSING'))
       OR (OLD."status" = 'CLOSING' AND NEW."status" NOT IN ('CLOSING', 'CLOSED'))
       OR (OLD."status" = 'CLOSED' AND NEW."status" <> 'CLOSED')
       OR (
           OLD."reviewed_by_admin_user_id" IS NOT NULL
           AND NEW."reviewed_by_admin_user_id" IS DISTINCT FROM OLD."reviewed_by_admin_user_id"
       )
       OR (
           OLD."review_started_at" IS NOT NULL
           AND NEW."review_started_at" IS DISTINCT FROM OLD."review_started_at"
       )
       OR (
           OLD."close_requested_at" IS NOT NULL
           AND NEW."close_requested_at" IS DISTINCT FROM OLD."close_requested_at"
       )
       OR (
           OLD."subject_notified_at" IS NOT NULL
           AND NEW."subject_notified_at" IS DISTINCT FROM OLD."subject_notified_at"
       )
       OR (
           OLD."status" IN ('CLOSING', 'CLOSED')
           AND (
               NEW."outcome" IS DISTINCT FROM OLD."outcome"
               OR NEW."resolution_summary" IS DISTINCT FROM OLD."resolution_summary"
               OR NEW."closed_at" IS DISTINCT FROM OLD."closed_at"
                   AND OLD."closed_at" IS NOT NULL
               OR NEW."evidence_purged_at" IS DISTINCT FROM OLD."evidence_purged_at"
                   AND OLD."evidence_purged_at" IS NOT NULL
           )
       ) THEN
        RAISE EXCEPTION 'report history is monotonic and cannot be deleted or reopened'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "sinochat_enforce_report_evidence_history"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "parent_status" "ReportStatus";
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'report evidence is immutable'
            USING ERRCODE = '23514';
    END IF;

    SELECT "status"
      INTO "parent_status"
      FROM "reports"
     WHERE "id" = OLD."report_id";

    IF "parent_status" NOT IN ('CLOSING', 'CLOSED') THEN
        RAISE EXCEPTION 'report evidence may only be purged by the durable closure worker'
            USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;

CREATE FUNCTION "sinochat_validate_report_closure_job"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "parent_status" "ReportStatus";
    "reviewer_id" UUID;
    "current_object_key" VARCHAR(512);
BEGIN
    PERFORM "sinochat_assert_user_role"(
        NEW."requested_by_admin_user_id",
        'ADMIN'
    );

    SELECT r."status", r."reviewed_by_admin_user_id", e."object_key"
      INTO "parent_status", "reviewer_id", "current_object_key"
      FROM "reports" r
      LEFT JOIN "report_evidence" e ON e."report_id" = r."id"
     WHERE r."id" = NEW."report_id";

    IF "parent_status" <> 'CLOSING'
       OR "reviewer_id" IS DISTINCT FROM NEW."requested_by_admin_user_id"
       OR "current_object_key" IS DISTINCT FROM NEW."evidence_object_key" THEN
        RAISE EXCEPTION 'closure job must match the assigned reviewer and encrypted evidence of a closing report'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "report_closure_jobs_validation_trigger"
BEFORE INSERT OR UPDATE ON "report_closure_jobs"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_report_closure_job"();

CREATE FUNCTION "sinochat_enforce_report_closure_job_history"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "parent_status" "ReportStatus";
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW."report_id" <> OLD."report_id"
           OR NEW."requested_by_admin_user_id" <> OLD."requested_by_admin_user_id"
           OR NEW."evidence_object_key" <> OLD."evidence_object_key"
           OR NEW."created_at" <> OLD."created_at"
           OR NEW."attempts" < OLD."attempts" THEN
            RAISE EXCEPTION 'report closure job identity and attempt history are immutable'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    SELECT "status"
      INTO "parent_status"
      FROM "reports"
     WHERE "id" = OLD."report_id";
    IF "parent_status" <> 'CLOSED' THEN
        RAISE EXCEPTION 'report closure jobs may only be removed after durable closure'
            USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER "report_closure_jobs_history_trigger"
BEFORE UPDATE OR DELETE ON "report_closure_jobs"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_report_closure_job_history"();

CREATE FUNCTION "sinochat_validate_report_closure_job_lifecycle"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "row_data" JSONB;
    "target_report_id" UUID;
    "parent_status" "ReportStatus";
    "job_count" INTEGER;
BEGIN
    "row_data" := CASE
        WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
        ELSE to_jsonb(NEW)
    END;
    "target_report_id" := CASE
        WHEN TG_TABLE_NAME = 'reports' THEN
            ("row_data" ->> 'id')::UUID
        ELSE
            ("row_data" ->> 'report_id')::UUID
    END;

    SELECT "status"
      INTO "parent_status"
      FROM "reports"
     WHERE "id" = "target_report_id";
    IF "parent_status" IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT count(*)
      INTO "job_count"
      FROM "report_closure_jobs"
     WHERE "report_id" = "target_report_id";

    IF ("parent_status" = 'CLOSING' AND "job_count" <> 1)
       OR ("parent_status" <> 'CLOSING' AND "job_count" <> 0) THEN
        RAISE EXCEPTION 'closing reports require exactly one durable closure job'
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "reports_closure_job_lifecycle_trigger"
AFTER INSERT OR UPDATE ON "reports"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_report_closure_job_lifecycle"();

CREATE CONSTRAINT TRIGGER "report_closure_jobs_lifecycle_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "report_closure_jobs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_report_closure_job_lifecycle"();

COMMIT;
