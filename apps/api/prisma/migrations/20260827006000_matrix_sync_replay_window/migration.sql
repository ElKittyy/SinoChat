-- A sync batch is replayable only while every to-device event in its range
-- still exists. Keep the bearer window within the mandatory 48-hour event
-- retention and, for non-empty ranges, within the earliest event expiry.
CREATE FUNCTION "sinochat_validate_matrix_sync_replay_window"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "earliest_event_expiry" TIMESTAMPTZ(6);
BEGIN
    SELECT min(e."expires_at")
      INTO "earliest_event_expiry"
      FROM "matrix_to_device_events" e
     WHERE e."recipient_device_id" = NEW."device_id"
       AND e."recipient_sequence" > NEW."from_sequence"
       AND e."recipient_sequence" <= NEW."up_to_sequence"
       AND e."expires_at" > NEW."created_at";

    IF NEW."expires_at" > NEW."created_at" + INTERVAL '48 hours'
       OR (
           "earliest_event_expiry" IS NOT NULL
           AND NEW."expires_at" > "earliest_event_expiry"
       ) THEN
        RAISE EXCEPTION 'Matrix sync token cannot outlive its replayable 48-hour event range'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "matrix_to_device_sync_batches_replay_window_trigger"
BEFORE INSERT ON "matrix_to_device_sync_batches"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_matrix_sync_replay_window"();
