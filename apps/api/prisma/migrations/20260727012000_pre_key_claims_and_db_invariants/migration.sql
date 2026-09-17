-- One-time pre-key claims are durable idempotency records. A retry by the
-- same requester device in the same conversation must receive the same
-- result for every recipient device, including the deliberate "no pre-key
-- available" result represented by a NULL one_time_pre_key_id.
CREATE TABLE "one_time_pre_key_claims" (
    "id" UUID NOT NULL,
    "requester_device_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "recipient_device_id" UUID NOT NULL,
    "one_time_pre_key_id" UUID,
    "claimed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "one_time_pre_key_claims_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "one_time_pre_key_claims_distinct_devices_check"
        CHECK ("requester_device_id" <> "recipient_device_id")
);

CREATE UNIQUE INDEX "one_time_pre_key_claims_pre_key_key"
    ON "one_time_pre_key_claims"("one_time_pre_key_id");
CREATE UNIQUE INDEX "one_time_pre_key_claims_request_key"
    ON "one_time_pre_key_claims"(
        "requester_device_id",
        "conversation_id",
        "recipient_device_id"
    );
CREATE INDEX "one_time_pre_key_claims_conversation_idx"
    ON "one_time_pre_key_claims"("conversation_id", "claimed_at");
CREATE INDEX "one_time_pre_key_claims_recipient_idx"
    ON "one_time_pre_key_claims"("recipient_device_id", "claimed_at");

ALTER TABLE "one_time_pre_key_claims"
    ADD CONSTRAINT "one_time_pre_key_claims_requester_device_id_fkey"
        FOREIGN KEY ("requester_device_id")
        REFERENCES "devices"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "one_time_pre_key_claims_conversation_id_fkey"
        FOREIGN KEY ("conversation_id")
        REFERENCES "conversations"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "one_time_pre_key_claims_recipient_device_id_fkey"
        FOREIGN KEY ("recipient_device_id")
        REFERENCES "devices"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "one_time_pre_key_claims_one_time_pre_key_id_fkey"
        FOREIGN KEY ("one_time_pre_key_id")
        REFERENCES "one_time_pre_keys"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "sinochat_validate_one_time_pre_key_claim"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "requester_user_id" UUID;
    "recipient_user_id" UUID;
    "requester_status" "DeviceStatus";
    "recipient_status" "DeviceStatus";
    "assignment_client_id" UUID;
    "assignment_cashier_id" UUID;
    "conversation_created_at" TIMESTAMPTZ(6);
    "claimed_pre_key_device_id" UUID;
    "pre_key_claimed_at" TIMESTAMPTZ(6);
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'one-time pre-key claims are immutable'
            USING ERRCODE = '23514';
    END IF;

    SELECT "user_id", "status"
      INTO "requester_user_id", "requester_status"
      FROM "devices"
     WHERE "id" = NEW."requester_device_id";

    SELECT "user_id", "status"
      INTO "recipient_user_id", "recipient_status"
      FROM "devices"
     WHERE "id" = NEW."recipient_device_id";

    SELECT a."client_user_id",
           a."cashier_user_id",
           c."created_at"
      INTO "assignment_client_id",
           "assignment_cashier_id",
           "conversation_created_at"
      FROM "conversations" c
      JOIN "assignments" a ON a."id" = c."assignment_id"
     WHERE c."id" = NEW."conversation_id"
       AND c."status" = 'ACTIVE'
       AND a."ended_at" IS NULL;

    IF "requester_status" IS DISTINCT FROM 'ACTIVE'
       OR "recipient_status" IS DISTINCT FROM 'ACTIVE'
       OR "assignment_client_id" IS NULL
       OR NOT (
           (
               "requester_user_id" = "assignment_client_id"
               AND "recipient_user_id" = "assignment_cashier_id"
           )
           OR (
               "requester_user_id" = "assignment_cashier_id"
               AND "recipient_user_id" = "assignment_client_id"
           )
       )
       OR NEW."claimed_at" < "conversation_created_at"
       OR NEW."claimed_at" > clock_timestamp() THEN
        RAISE EXCEPTION
            'pre-key claim requires active devices from opposite participants of an active conversation'
            USING ERRCODE = '23514';
    END IF;

    IF NEW."one_time_pre_key_id" IS NOT NULL THEN
        SELECT "device_id", "claimed_at"
          INTO "claimed_pre_key_device_id", "pre_key_claimed_at"
          FROM "one_time_pre_keys"
         WHERE "id" = NEW."one_time_pre_key_id";

        IF "claimed_pre_key_device_id" IS DISTINCT FROM NEW."recipient_device_id"
           OR "pre_key_claimed_at" IS DISTINCT FROM NEW."claimed_at" THEN
            RAISE EXCEPTION
                'claimed one-time pre-key must belong to the recipient and share the claim timestamp'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "one_time_pre_key_claims_validation_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "one_time_pre_key_claims"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_one_time_pre_key_claim"();

-- A report may reserve at most one evidence object for an assignment. Existing
-- duplicates cannot be discarded safely because their objects may differ, so
-- deployment stops with an actionable error instead of selecting one silently.
DO $sinochat$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM "pending_report_evidence_uploads"
         GROUP BY "assignment_id"
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'duplicate pending report evidence uploads must be reconciled before adding the assignment uniqueness invariant'
            USING ERRCODE = '23505';
    END IF;
END;
$sinochat$;

CREATE UNIQUE INDEX "pending_report_evidence_uploads_assignment_key"
    ON "pending_report_evidence_uploads"("assignment_id");

-- Pending object reservations are deletion ledgers. Their owners cannot be
-- physically deleted before retention has purged the external object and then
-- removed the reservation.
ALTER TABLE "pending_attachment_uploads"
    DROP CONSTRAINT "pending_attachment_uploads_user_id_fkey",
    DROP CONSTRAINT "pending_attachment_uploads_conversation_id_fkey",
    ADD CONSTRAINT "pending_attachment_uploads_user_id_fkey"
        FOREIGN KEY ("user_id")
        REFERENCES "users"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "pending_attachment_uploads_conversation_id_fkey"
        FOREIGN KEY ("conversation_id")
        REFERENCES "conversations"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pending_report_evidence_uploads"
    DROP CONSTRAINT "pending_report_evidence_uploads_client_user_id_fkey",
    DROP CONSTRAINT "pending_report_evidence_uploads_assignment_id_fkey",
    DROP CONSTRAINT "pending_report_evidence_uploads_conversation_id_fkey",
    ADD CONSTRAINT "pending_report_evidence_uploads_client_user_id_fkey"
        FOREIGN KEY ("client_user_id")
        REFERENCES "users"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "pending_report_evidence_uploads_assignment_id_fkey"
        FOREIGN KEY ("assignment_id")
        REFERENCES "assignments"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "pending_report_evidence_uploads_conversation_id_fkey"
        FOREIGN KEY ("conversation_id")
        REFERENCES "conversations"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- Raw SQL receipt updates predate this trigger and did not advance updated_at.
-- Normalize only that derived timestamp before enforcing the stronger rule.
UPDATE "message_receipts" r
   SET "updated_at" = GREATEST(
       r."updated_at",
       m."created_at",
       COALESCE(r."delivered_at", '-infinity'::timestamptz),
       COALESCE(r."read_at", '-infinity'::timestamptz)
   )
  FROM "messages" m
 WHERE m."id" = r."message_id";

CREATE FUNCTION "sinochat_enforce_message_receipt_progress"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "message_created_at" TIMESTAMPTZ(6);
    "database_now" TIMESTAMPTZ(6);
    "old_rank" INTEGER;
    "new_rank" INTEGER;
BEGIN
    "database_now" := clock_timestamp();

    SELECT "created_at"
      INTO "message_created_at"
      FROM "messages"
     WHERE "id" = NEW."message_id";

    IF "message_created_at" IS NULL THEN
        RAISE EXCEPTION 'message receipt requires an existing message'
            USING ERRCODE = '23514';
    END IF;

    "new_rank" := CASE NEW."status"
        WHEN 'SENT' THEN 0
        WHEN 'DELIVERED' THEN 1
        WHEN 'READ' THEN 2
    END;

    IF TG_OP = 'UPDATE' THEN
        IF NEW."message_id" <> OLD."message_id"
           OR NEW."recipient_user_id" <> OLD."recipient_user_id" THEN
            RAISE EXCEPTION 'message receipt identity is immutable'
                USING ERRCODE = '23514';
        END IF;

        "old_rank" := CASE OLD."status"
            WHEN 'SENT' THEN 0
            WHEN 'DELIVERED' THEN 1
            WHEN 'READ' THEN 2
        END;

        IF "new_rank" < "old_rank" THEN
            RAISE EXCEPTION 'message receipt status cannot move backwards'
                USING ERRCODE = '23514';
        END IF;

        IF (
               OLD."delivered_at" IS NOT NULL
               AND NEW."delivered_at" IS DISTINCT FROM OLD."delivered_at"
           )
           OR (
               OLD."read_at" IS NOT NULL
               AND NEW."read_at" IS DISTINCT FROM OLD."read_at"
           ) THEN
            RAISE EXCEPTION 'message receipt event timestamps are immutable'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF (
           NEW."delivered_at" IS NOT NULL
           AND (
               NEW."delivered_at" < "message_created_at"
               OR NEW."delivered_at" > "database_now"
           )
       )
       OR (
           NEW."read_at" IS NOT NULL
           AND (
               NEW."read_at" < "message_created_at"
               OR NEW."read_at" > "database_now"
               OR NEW."delivered_at" IS NULL
               OR NEW."read_at" < NEW."delivered_at"
           )
       ) THEN
        RAISE EXCEPTION 'message receipt contains incoherent event timestamps'
            USING ERRCODE = '23514';
    END IF;

    NEW."updated_at" := "database_now";
    RETURN NEW;
END;
$$;

CREATE TRIGGER "message_receipts_progress_trigger"
BEFORE INSERT OR UPDATE ON "message_receipts"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_message_receipt_progress"();
