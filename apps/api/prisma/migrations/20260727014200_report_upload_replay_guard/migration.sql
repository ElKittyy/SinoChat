BEGIN;

-- A signed evidence PUT remains technically reusable until its authorization
-- expires. Keep that boundary with the evidence and make the durable closure
-- job wait for it before deleting the only tracked object key.
ALTER TABLE "report_evidence"
    ADD COLUMN "upload_authorized_until" TIMESTAMPTZ(6);

-- 14100 made every evidence UPDATE immutable. Drop only the trigger (not the
-- function) inside this transaction while the new column is backfilled. DDL
-- and the UPDATE remain invisible until the trigger has been restored.
DROP TRIGGER "report_evidence_history_trigger" ON "report_evidence";

UPDATE "report_evidence"
   SET "upload_authorized_until" = "created_at" + INTERVAL '10 minutes';

ALTER TABLE "report_evidence"
    ALTER COLUMN "upload_authorized_until" SET NOT NULL,
    ADD CONSTRAINT "report_evidence_upload_authorization_check"
        CHECK ("upload_authorized_until" >= "created_at");

CREATE TRIGGER "report_evidence_history_trigger"
BEFORE UPDATE OR DELETE ON "report_evidence"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_report_evidence_history"();

ALTER TABLE "report_closure_jobs"
    ADD COLUMN "purge_not_before" TIMESTAMPTZ(6);

UPDATE "report_closure_jobs" AS job
   SET "purge_not_before" = evidence."upload_authorized_until",
       "next_attempt_at" = GREATEST(
           job."next_attempt_at",
           evidence."upload_authorized_until"
       )
  FROM "report_evidence" AS evidence
 WHERE evidence."report_id" = job."report_id";

ALTER TABLE "report_closure_jobs"
    ALTER COLUMN "purge_not_before" SET NOT NULL,
    ADD CONSTRAINT "report_closure_jobs_purge_boundary_check"
        CHECK ("next_attempt_at" >= "purge_not_before");

CREATE INDEX "report_closure_jobs_purge_due_idx"
    ON "report_closure_jobs"(
        "purge_not_before",
        "next_attempt_at",
        "leased_until"
    );

CREATE OR REPLACE FUNCTION "sinochat_validate_report_closure_job"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "parent_status" "ReportStatus";
    "reviewer_id" UUID;
    "current_object_key" VARCHAR(512);
    "upload_authorized_until" TIMESTAMPTZ(6);
BEGIN
    PERFORM "sinochat_assert_user_role"(
        NEW."requested_by_admin_user_id",
        'ADMIN'
    );

    SELECT
        r."status",
        r."reviewed_by_admin_user_id",
        e."object_key",
        e."upload_authorized_until"
      INTO
        "parent_status",
        "reviewer_id",
        "current_object_key",
        "upload_authorized_until"
      FROM "reports" r
      LEFT JOIN "report_evidence" e ON e."report_id" = r."id"
     WHERE r."id" = NEW."report_id";

    IF "parent_status" <> 'CLOSING'
       OR "reviewer_id" IS DISTINCT FROM NEW."requested_by_admin_user_id"
       OR "current_object_key" IS DISTINCT FROM NEW."evidence_object_key"
       OR "upload_authorized_until" IS DISTINCT FROM NEW."purge_not_before"
       OR NEW."next_attempt_at" < NEW."purge_not_before" THEN
        RAISE EXCEPTION 'closure job must wait for the matching encrypted evidence upload authorization to expire'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "sinochat_enforce_report_closure_job_history"()
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
           OR NEW."purge_not_before" <> OLD."purge_not_before"
           OR NEW."created_at" <> OLD."created_at"
           OR NEW."attempts" < OLD."attempts" THEN
            RAISE EXCEPTION 'report closure job identity, purge boundary and attempt history are immutable'
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

COMMIT;
