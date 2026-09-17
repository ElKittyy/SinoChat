-- `/sync` reports OTK availability and unused fallback types. Persist that
-- snapshot with the batch so a retransmission of the same range returns the
-- same cryptographic metadata even if another request consumes/uploads keys.
ALTER TABLE "matrix_to_device_sync_batches"
    ADD COLUMN "one_time_key_count" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "unused_fallback_key" BOOLEAN NOT NULL DEFAULT FALSE,
    ADD CONSTRAINT "matrix_to_device_sync_batches_key_count_check" CHECK (
        "one_time_key_count" BETWEEN 0 AND 100
    );

CREATE FUNCTION "sinochat_enforce_matrix_sync_crypto_snapshot"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."one_time_key_count" <> OLD."one_time_key_count"
       OR NEW."unused_fallback_key" <> OLD."unused_fallback_key" THEN
        RAISE EXCEPTION 'Matrix sync cryptographic snapshot is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "matrix_to_device_sync_batches_crypto_snapshot_trigger"
BEFORE UPDATE ON "matrix_to_device_sync_batches"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_matrix_sync_crypto_snapshot"();
