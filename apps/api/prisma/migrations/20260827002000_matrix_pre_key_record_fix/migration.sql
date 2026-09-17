-- matrix_one_time_keys and matrix_fallback_keys share this trigger but expose
-- different claim timestamp columns. Resolve that column through JSONB so the
-- trigger never asks PostgreSQL for a field absent from the current record.
CREATE OR REPLACE FUNCTION "sinochat_validate_matrix_pre_key"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "is_fallback" BOOLEAN := TG_TABLE_NAME = 'matrix_fallback_keys';
    "claim_field" TEXT;
    "event_time" TIMESTAMPTZ(6);
    "old_event_time" TIMESTAMPTZ(6);
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'matrix pre-key tombstones cannot be deleted or reused'
            USING ERRCODE = '23514';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            'sinochat:matrix:prekeys:' || NEW."device_id"::text,
            0
        )
    );

    "claim_field" := CASE
        WHEN "is_fallback" THEN 'first_claimed_at'
        ELSE 'claimed_at'
    END;
    "event_time" := NULLIF(
        to_jsonb(NEW)->>"claim_field",
        ''
    )::TIMESTAMPTZ(6);

    IF TG_OP = 'UPDATE' THEN
        "old_event_time" := NULLIF(
            to_jsonb(OLD)->>"claim_field",
            ''
        )::TIMESTAMPTZ(6);

        IF NEW."id" <> OLD."id"
           OR NEW."device_id" <> OLD."device_id"
           OR NEW."algorithm" <> OLD."algorithm"
           OR NEW."key_id" <> OLD."key_id"
           OR NEW."curve25519_key" <> OLD."curve25519_key"
           OR NEW."signed_key" <> OLD."signed_key"
           OR NEW."canonical_sha256" <> OLD."canonical_sha256"
           OR NEW."uploaded_at" <> OLD."uploaded_at"
           OR "old_event_time" IS NOT NULL
           OR "event_time" IS NULL THEN
            RAISE EXCEPTION 'matrix pre-key content and claim transition are immutable'
                USING ERRCODE = '23514';
        END IF;

        IF "event_time" > clock_timestamp() THEN
            RAISE EXCEPTION 'matrix pre-key claim timestamp cannot be in the future'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM "devices" d
          JOIN "matrix_device_keys" k ON k."device_id" = d."id"
         WHERE d."id" = NEW."device_id"
           AND d."status" = 'ACTIVE'
    ) OR NEW."signed_key"->>'key' IS DISTINCT FROM NEW."curve25519_key" THEN
        RAISE EXCEPTION 'matrix pre-key requires an active published Matrix device and matching signed key'
            USING ERRCODE = '23514';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('sinochat:matrix:curve:' || NEW."curve25519_key", 0)
    );
    IF EXISTS (
        SELECT 1 FROM "matrix_device_keys" k
         WHERE k."curve25519_key" = NEW."curve25519_key"
    ) OR (
        "is_fallback" AND EXISTS (
            SELECT 1 FROM "matrix_one_time_keys" k
             WHERE k."curve25519_key" = NEW."curve25519_key"
                OR (
                    k."device_id" = NEW."device_id"
                    AND k."algorithm" = NEW."algorithm"
                    AND k."key_id" = NEW."key_id"
                )
        )
    ) OR (
        NOT "is_fallback" AND EXISTS (
            SELECT 1 FROM "matrix_fallback_keys" k
             WHERE k."curve25519_key" = NEW."curve25519_key"
                OR (
                    k."device_id" = NEW."device_id"
                    AND k."algorithm" = NEW."algorithm"
                    AND k."key_id" = NEW."key_id"
                )
        )
    ) THEN
        RAISE EXCEPTION 'matrix Curve25519 public material or key identifier cannot be reused'
            USING ERRCODE = '23505';
    END IF;

    IF NOT "is_fallback" AND (
        SELECT count(*)
          FROM "matrix_one_time_keys" k
         WHERE k."device_id" = NEW."device_id"
           AND k."algorithm" = NEW."algorithm"
           AND k."claimed_at" IS NULL
    ) >= 100 THEN
        RAISE EXCEPTION 'matrix one-time key pool cannot exceed 100 unclaimed keys'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;
