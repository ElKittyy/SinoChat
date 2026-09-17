-- Older metadata-only terms cannot be reconstructed from their digest. They
-- remain as historical records, but registration and public serving ignore
-- them until a new complete version is published.
ALTER TABLE "terms_documents"
    ADD COLUMN "content_type" VARCHAR(32),
    ADD COLUMN "content" BYTEA,
    ADD COLUMN "byte_size" INTEGER;

DO $sinochat$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM "terms_documents"
         GROUP BY "content_hash"
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'duplicate terms content hashes must be reconciled before publication hardening'
            USING ERRCODE = '23505';
    END IF;
END;
$sinochat$;

CREATE UNIQUE INDEX "terms_documents_content_hash_key"
    ON "terms_documents"("content_hash");

ALTER TABLE "terms_documents"
    ADD CONSTRAINT "terms_documents_exact_content_check"
    CHECK (
        (
            "content_type" IS NULL
            AND "content" IS NULL
            AND "byte_size" IS NULL
        )
        OR
        (
            "content_type" IN ('text/markdown', 'text/plain')
            AND "content" IS NOT NULL
            AND "byte_size" = octet_length("content")
            AND "byte_size" BETWEEN 1 AND 5242880
            AND "content_hash" ~ '^[0-9a-f]{64}$'
        )
    );

-- Published legal content is immutable. Retirement remains the only mutable
-- lifecycle field and is already serialized by the publication CLI.
CREATE FUNCTION "sinochat_enforce_terms_content_immutability"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."id" <> OLD."id"
       OR NEW."version" <> OLD."version"
       OR NEW."content_hash" <> OLD."content_hash"
       OR NEW."content_type" IS DISTINCT FROM OLD."content_type"
       OR NEW."content" IS DISTINCT FROM OLD."content"
       OR NEW."byte_size" IS DISTINCT FROM OLD."byte_size"
       OR NEW."effective_at" <> OLD."effective_at"
       OR NEW."created_at" <> OLD."created_at"
       OR (
           OLD."retired_at" IS NOT NULL
           AND NEW."retired_at" IS DISTINCT FROM OLD."retired_at"
       )
       OR (
           NEW."retired_at" IS NOT NULL
           AND NEW."retired_at" <= NEW."effective_at"
       ) THEN
        RAISE EXCEPTION 'published terms content is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "terms_documents_content_immutability_trigger"
BEFORE UPDATE ON "terms_documents"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_terms_content_immutability"();
