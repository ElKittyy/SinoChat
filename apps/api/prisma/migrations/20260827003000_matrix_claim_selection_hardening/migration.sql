-- keys/claim must consume the oldest available one-time-key batch before it
-- may fall back to the current fallback key. Enforce the ordering in the
-- database as a final concurrency boundary, after the chosen key transition
-- and while holding the per-recipient pre-key advisory lock.
CREATE OR REPLACE FUNCTION "sinochat_validate_matrix_key_claim_result"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "requester_device_id" UUID;
    "requester_user_id" UUID;
    "conversation_id" UUID;
    "recipient_user_id" UUID;
    "recipient_status" "DeviceStatus";
    "key_device_id" UUID;
    "key_algorithm" VARCHAR(32);
    "key_claimed_at" TIMESTAMPTZ(6);
    "key_uploaded_at" TIMESTAMPTZ(6);
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'matrix key-claim results are immutable'
            USING ERRCODE = '23514';
    END IF;

    SELECT r."requester_device_id", d."user_id", r."conversation_id"
      INTO "requester_device_id", "requester_user_id", "conversation_id"
      FROM "matrix_key_claim_requests" r
      JOIN "devices" d ON d."id" = r."requester_device_id"
     WHERE r."id" = NEW."claim_request_id";

    SELECT d."user_id", d."status"
      INTO "recipient_user_id", "recipient_status"
      FROM "devices" d
     WHERE d."id" = NEW."recipient_device_id"
     FOR SHARE;

    IF "requester_device_id" IS NULL
       OR "requester_device_id" = NEW."recipient_device_id"
       OR "recipient_status" IS DISTINCT FROM 'ACTIVE'
       OR NOT EXISTS (
            SELECT 1 FROM "matrix_device_keys" k
             WHERE k."device_id" = NEW."recipient_device_id"
       ) THEN
        RAISE EXCEPTION 'matrix key claim requires distinct active published devices'
            USING ERRCODE = '23514';
    END IF;

    IF "requester_user_id" = "recipient_user_id" THEN
        IF "conversation_id" IS NOT NULL THEN
            RAISE EXCEPTION 'same-user Matrix key claims cannot be scoped to a conversation'
                USING ERRCODE = '23514';
        END IF;
    ELSIF "conversation_id" IS NULL OR NOT EXISTS (
        SELECT 1
          FROM "conversations" c
          JOIN "assignments" a ON a."id" = c."assignment_id"
         WHERE c."id" = "conversation_id"
           AND c."status" = 'ACTIVE'
           AND a."ended_at" IS NULL
           AND (
               (
                   a."client_user_id" = "requester_user_id"
                   AND a."cashier_user_id" = "recipient_user_id"
               )
               OR (
                   a."cashier_user_id" = "requester_user_id"
                   AND a."client_user_id" = "recipient_user_id"
               )
           )
         FOR SHARE OF c, a
    ) THEN
        RAISE EXCEPTION 'cross-user Matrix key claim requires their active conversation'
            USING ERRCODE = '23514';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            'sinochat:matrix:prekeys:' || NEW."recipient_device_id"::text,
            0
        )
    );

    IF NEW."one_time_key_id" IS NOT NULL THEN
        SELECT k."device_id", k."algorithm", k."claimed_at", k."uploaded_at"
          INTO "key_device_id", "key_algorithm", "key_claimed_at", "key_uploaded_at"
          FROM "matrix_one_time_keys" k
         WHERE k."id" = NEW."one_time_key_id"
         FOR UPDATE;
    ELSIF NEW."fallback_key_id" IS NOT NULL THEN
        SELECT k."device_id", k."algorithm", k."first_claimed_at", k."uploaded_at"
          INTO "key_device_id", "key_algorithm", "key_claimed_at", "key_uploaded_at"
          FROM "matrix_fallback_keys" k
          JOIN "matrix_fallback_key_slots" s
            ON s."current_fallback_key_id" = k."id"
           AND s."device_id" = k."device_id"
           AND s."algorithm" = k."algorithm"
         WHERE k."id" = NEW."fallback_key_id"
         FOR UPDATE OF k, s;
    ELSE
        IF EXISTS (
            SELECT 1
              FROM "matrix_one_time_keys" k
             WHERE k."device_id" = NEW."recipient_device_id"
               AND k."algorithm" = NEW."algorithm"
               AND k."claimed_at" IS NULL
        ) OR EXISTS (
            SELECT 1
              FROM "matrix_fallback_key_slots" s
             WHERE s."device_id" = NEW."recipient_device_id"
               AND s."algorithm" = NEW."algorithm"
        ) THEN
            RAISE EXCEPTION 'empty Matrix key-claim result cannot hide an available key'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW."one_time_key_id" IS NOT NULL
       OR NEW."fallback_key_id" IS NOT NULL THEN
        IF "key_device_id" IS DISTINCT FROM NEW."recipient_device_id"
           OR "key_algorithm" IS DISTINCT FROM NEW."algorithm"
           OR "key_claimed_at" IS NULL
           OR (
               NEW."one_time_key_id" IS NOT NULL
               AND "key_claimed_at" IS DISTINCT FROM NEW."claimed_at"
           )
           OR (
               NEW."fallback_key_id" IS NOT NULL
               AND "key_claimed_at" > NEW."claimed_at"
           ) THEN
            RAISE EXCEPTION 'Matrix key-claim result does not match the atomically claimed recipient key'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW."one_time_key_id" IS NOT NULL AND EXISTS (
        SELECT 1
          FROM "matrix_one_time_keys" k
         WHERE k."device_id" = NEW."recipient_device_id"
           AND k."algorithm" = NEW."algorithm"
           AND k."claimed_at" IS NULL
           AND k."uploaded_at" < "key_uploaded_at"
    ) THEN
        RAISE EXCEPTION 'Matrix key claim must consume the oldest uploaded batch first'
            USING ERRCODE = '23514';
    END IF;

    IF NEW."fallback_key_id" IS NOT NULL AND EXISTS (
        SELECT 1
          FROM "matrix_one_time_keys" k
         WHERE k."device_id" = NEW."recipient_device_id"
           AND k."algorithm" = NEW."algorithm"
           AND k."claimed_at" IS NULL
    ) THEN
        RAISE EXCEPTION 'Matrix fallback cannot be claimed while a one-time key is available'
            USING ERRCODE = '23514';
    END IF;

    IF NEW."claimed_at" > clock_timestamp() THEN
        RAISE EXCEPTION 'Matrix key-claim timestamp cannot be in the future'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;
