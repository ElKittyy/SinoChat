-- Matrix v1.18 scopes transaction identifiers to a device and endpoint, not
-- to an access-token/session. A renewed SinoChat session bound to the same
-- device must therefore observe the original sendToDevice result.
DROP INDEX "matrix_to_device_transactions_session_txn_key";
CREATE UNIQUE INDEX "matrix_to_device_transactions_device_endpoint_txn_key"
    ON "matrix_to_device_transactions"(
        "sender_device_id", "event_type", "transaction_id"
    );

-- Keep predecessor UUIDs as immutable logical lineage rather than a physical
-- FK. Deleting an expired predecessor must not rewrite a non-initial batch to
-- previous_batch_id=NULL, because NULL is reserved for an initial sync.
ALTER TABLE "matrix_to_device_sync_batches"
    DROP CONSTRAINT "matrix_to_device_sync_batches_previous_fkey";

CREATE OR REPLACE FUNCTION "sinochat_validate_matrix_sync_batch"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "latest_sequence" BIGINT;
    "latest_device_list_position" BIGINT;
    "previous_device_id" UUID;
    "previous_up_to_sequence" BIGINT;
    "previous_device_list_position" BIGINT;
    "previous_created_at" TIMESTAMPTZ(6);
    "previous_expires_at" TIMESTAMPTZ(6);
    "previous_acknowledged_at" TIMESTAMPTZ(6);
BEGIN
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW."id" <> OLD."id"
           OR NEW."device_id" <> OLD."device_id"
           OR NEW."previous_batch_id" IS DISTINCT FROM OLD."previous_batch_id"
           OR NEW."token_hash" <> OLD."token_hash"
           OR NEW."from_sequence" <> OLD."from_sequence"
           OR NEW."up_to_sequence" <> OLD."up_to_sequence"
           OR NEW."from_device_list_position" <> OLD."from_device_list_position"
           OR NEW."device_list_position" <> OLD."device_list_position"
           OR NEW."created_at" <> OLD."created_at"
           OR NEW."expires_at" <> OLD."expires_at"
           OR OLD."acknowledged_at" IS NOT NULL
           OR NEW."acknowledged_at" IS NULL
           OR NEW."acknowledged_at" > clock_timestamp() THEN
            RAISE EXCEPTION 'matrix sync batch identity, lineage and acknowledgement are immutable'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    SELECT c."latest_sequence" INTO "latest_sequence"
      FROM "matrix_to_device_cursors" c
     WHERE c."device_id" = NEW."device_id"
     FOR SHARE;
    SELECT s."position" INTO "latest_device_list_position"
      FROM "matrix_device_list_stream" s
     WHERE s."id" = 1
     FOR SHARE;

    IF NEW."previous_batch_id" IS NULL THEN
        IF NEW."from_sequence" <> 0
           OR NEW."from_device_list_position" <> 0 THEN
            RAISE EXCEPTION 'initial Matrix sync batch must start at zero'
                USING ERRCODE = '23514';
        END IF;
    ELSE
        SELECT p."device_id", p."up_to_sequence",
               p."device_list_position", p."created_at", p."expires_at",
               p."acknowledged_at"
          INTO "previous_device_id", "previous_up_to_sequence",
               "previous_device_list_position", "previous_created_at",
               "previous_expires_at", "previous_acknowledged_at"
          FROM "matrix_to_device_sync_batches" p
         WHERE p."id" = NEW."previous_batch_id"
         FOR UPDATE;

        IF "previous_device_id" IS DISTINCT FROM NEW."device_id"
           OR "previous_up_to_sequence" IS DISTINCT FROM NEW."from_sequence"
           OR "previous_device_list_position" IS DISTINCT FROM NEW."from_device_list_position"
           OR "previous_created_at" > NEW."created_at"
           OR "previous_expires_at" <= NEW."created_at"
           OR "previous_acknowledged_at" IS NOT NULL THEN
            RAISE EXCEPTION 'Matrix sync successor requires its current unacknowledged predecessor range'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF "latest_sequence" IS NULL
       OR NEW."up_to_sequence" > "latest_sequence"
       OR NEW."device_list_position" > "latest_device_list_position"
       OR NEW."up_to_sequence" < NEW."from_sequence"
       OR NEW."device_list_position" < NEW."from_device_list_position"
       OR NEW."expires_at" > NEW."created_at" + INTERVAL '30 days' THEN
        RAISE EXCEPTION 'matrix sync batch cannot acknowledge unissued positions or outlive the session window'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;
