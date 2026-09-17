BEGIN;

-- A rolling deployment can still have old application instances that do not
-- know the advisory lock below. Hold table locks from before the consistency
-- scan until COMMIT so those writers cannot create a new invalid row in the
-- scan-to-trigger window. The fixed order is shared by this migration only and
-- also makes any lock wait/deadlock resolution deterministic.
LOCK TABLE "terms_documents" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "terms_acceptances" IN SHARE ROW EXCLUSIVE MODE;

-- Registration and legal publication serialize on this same transaction-level
-- lock in application code. Triggers acquire it too so direct SQL cannot race a
-- retirement against a new acceptance.
CREATE FUNCTION "sinochat_lock_terms_lifecycle"()
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended('sinochat:terms-lifecycle', 0)
    );
END;
$$;

-- Refuse to install the invariant over a ledger that is already inconsistent.
DO $sinochat$
BEGIN
    PERFORM "sinochat_lock_terms_lifecycle"();
    IF EXISTS (
        SELECT 1
          FROM "terms_acceptances" AS "acceptance"
          JOIN "terms_documents" AS "document"
            ON "document"."id" = "acceptance"."terms_document_id"
         WHERE "acceptance"."accepted_at" < "document"."effective_at"
            OR (
                "document"."retired_at" IS NOT NULL
                AND "acceptance"."accepted_at" >= "document"."retired_at"
            )
    ) THEN
        RAISE EXCEPTION
            'existing terms acceptance falls outside its document validity window'
            USING ERRCODE = '23514';
    END IF;
END;
$sinochat$;

CREATE FUNCTION "sinochat_enforce_terms_acceptance_window"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "document_effective_at" TIMESTAMPTZ;
    "document_retired_at" TIMESTAMPTZ;
BEGIN
    PERFORM "sinochat_lock_terms_lifecycle"();

    SELECT "effective_at", "retired_at"
      INTO "document_effective_at", "document_retired_at"
      FROM "terms_documents"
     WHERE "id" = NEW."terms_document_id";

    IF NOT FOUND THEN
        RAISE EXCEPTION 'referenced terms document does not exist'
            USING ERRCODE = '23503';
    END IF;

    IF NEW."accepted_at" < "document_effective_at"
       OR (
           "document_retired_at" IS NOT NULL
           AND NEW."accepted_at" >= "document_retired_at"
       ) THEN
        RAISE EXCEPTION
            'terms acceptance must fall inside [effective_at, retired_at)'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "terms_acceptances_validity_window_trigger"
BEFORE INSERT OR UPDATE ON "terms_acceptances"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_terms_acceptance_window"();

CREATE FUNCTION "sinochat_protect_terms_acceptances_on_document_change"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM "sinochat_lock_terms_lifecycle"();

    IF EXISTS (
        SELECT 1
          FROM "terms_acceptances" AS "acceptance"
         WHERE "acceptance"."terms_document_id" = NEW."id"
           AND (
               "acceptance"."accepted_at" < NEW."effective_at"
               OR (
                   NEW."retired_at" IS NOT NULL
                   AND "acceptance"."accepted_at" >= NEW."retired_at"
               )
           )
    ) THEN
        RAISE EXCEPTION
            'terms document change would invalidate an existing acceptance'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "terms_documents_acceptance_window_trigger"
BEFORE INSERT OR UPDATE ON "terms_documents"
FOR EACH ROW EXECUTE FUNCTION
    "sinochat_protect_terms_acceptances_on_document_change"();

COMMIT;
