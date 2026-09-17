-- Matrix transport is deliberately additive. The generic pre-key and envelope
-- tables are not backfilled because their blobs cannot be promoted to signed
-- Matrix objects. The compiled E2EE release gate remains BLOCKED.

-- Matrix devices use a signed JSON object instead of the legacy generic key
-- columns. Keep those columns for rollback/read compatibility, but permit the
-- new registration flow to leave them NULL rather than inventing key data.
ALTER TABLE "devices"
    ALTER COLUMN "registration_id" DROP NOT NULL,
    ALTER COLUMN "identity_public_key" DROP NOT NULL,
    ALTER COLUMN "identity_key_fingerprint" DROP NOT NULL,
    ALTER COLUMN "signed_pre_key_id" DROP NOT NULL,
    ALTER COLUMN "signed_pre_key_public" DROP NOT NULL,
    ALTER COLUMN "signed_pre_key_signature" DROP NOT NULL;

CREATE TABLE "matrix_device_registrations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    CONSTRAINT "matrix_device_registrations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "matrix_device_registrations_window_check" CHECK (
        "expires_at" > "created_at"
        AND "expires_at" <= "created_at" + INTERVAL '15 minutes'
        AND (
            "consumed_at" IS NULL
            OR "consumed_at" BETWEEN "created_at" AND "expires_at"
        )
    )
);

CREATE TABLE "matrix_device_list_states" (
    "user_id" UUID NOT NULL,
    "matrix_user_id" VARCHAR(289) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "matrix_device_list_states_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "matrix_device_list_states_version_check" CHECK ("version" >= 0),
    CONSTRAINT "matrix_device_list_states_user_id_check" CHECK (
        "matrix_user_id" LIKE (
            '@u' || replace("user_id"::text, '-', '') || ':%'
        )
        AND "matrix_user_id" !~ '[[:space:]/]'
    )
);

CREATE TABLE "matrix_device_keys" (
    "device_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "matrix_user_id" VARCHAR(289) NOT NULL,
    "matrix_device_id" VARCHAR(33) NOT NULL,
    "curve25519_key" CHAR(43) NOT NULL,
    "ed25519_key" CHAR(43) NOT NULL,
    "device_keys" JSONB NOT NULL,
    "canonical_sha256" CHAR(64) NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "matrix_device_keys_pkey" PRIMARY KEY ("device_id"),
    CONSTRAINT "matrix_device_keys_device_id_check" CHECK (
        "matrix_device_id" = (
            'D' || upper(replace("device_id"::text, '-', ''))
        )
    ),
    CONSTRAINT "matrix_device_keys_encoding_check" CHECK (
        "curve25519_key" ~ '^[A-Za-z0-9+/]{43}$'
        AND "ed25519_key" ~ '^[A-Za-z0-9+/]{43}$'
        AND "canonical_sha256" ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof("device_keys") = 'object'
    )
);

CREATE TABLE "matrix_one_time_keys" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "algorithm" VARCHAR(32) NOT NULL,
    "key_id" VARCHAR(64) NOT NULL,
    "curve25519_key" CHAR(43) NOT NULL,
    "signed_key" JSONB NOT NULL,
    "canonical_sha256" CHAR(64) NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(6),
    CONSTRAINT "matrix_one_time_keys_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "matrix_one_time_keys_algorithm_check" CHECK (
        "algorithm" = 'signed_curve25519'
    ),
    CONSTRAINT "matrix_one_time_keys_id_check" CHECK (
        "key_id" ~ '^[A-Za-z0-9._=-]{1,64}$'
    ),
    CONSTRAINT "matrix_one_time_keys_encoding_check" CHECK (
        "curve25519_key" ~ '^[A-Za-z0-9+/]{43}$'
        AND "canonical_sha256" ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof("signed_key") = 'object'
    ),
    CONSTRAINT "matrix_one_time_keys_claim_clock_check" CHECK (
        "claimed_at" IS NULL OR "claimed_at" >= "uploaded_at"
    )
);

CREATE TABLE "matrix_fallback_keys" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "algorithm" VARCHAR(32) NOT NULL,
    "key_id" VARCHAR(64) NOT NULL,
    "curve25519_key" CHAR(43) NOT NULL,
    "signed_key" JSONB NOT NULL,
    "canonical_sha256" CHAR(64) NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "first_claimed_at" TIMESTAMPTZ(6),
    CONSTRAINT "matrix_fallback_keys_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "matrix_fallback_keys_algorithm_check" CHECK (
        "algorithm" = 'signed_curve25519'
    ),
    CONSTRAINT "matrix_fallback_keys_id_check" CHECK (
        "key_id" ~ '^[A-Za-z0-9._=-]{1,64}$'
    ),
    CONSTRAINT "matrix_fallback_keys_encoding_check" CHECK (
        "curve25519_key" ~ '^[A-Za-z0-9+/]{43}$'
        AND "canonical_sha256" ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof("signed_key") = 'object'
        AND "signed_key" @> '{"fallback": true}'::jsonb
    ),
    CONSTRAINT "matrix_fallback_keys_claim_clock_check" CHECK (
        "first_claimed_at" IS NULL OR "first_claimed_at" >= "uploaded_at"
    )
);

CREATE TABLE "matrix_fallback_key_slots" (
    "device_id" UUID NOT NULL,
    "algorithm" VARCHAR(32) NOT NULL,
    "current_fallback_key_id" UUID NOT NULL,
    CONSTRAINT "matrix_fallback_key_slots_pkey" PRIMARY KEY (
        "device_id", "algorithm"
    ),
    CONSTRAINT "matrix_fallback_key_slots_algorithm_check" CHECK (
        "algorithm" = 'signed_curve25519'
    )
);

CREATE TABLE "matrix_key_claim_requests" (
    "id" UUID NOT NULL,
    "requester_device_id" UUID NOT NULL,
    "conversation_id" UUID,
    "request_id" VARCHAR(64) NOT NULL,
    "request_sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "matrix_key_claim_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "matrix_key_claim_requests_id_check" CHECK (
        "request_id" ~ '^[A-Za-z0-9._~-]{1,64}$'
        AND "request_sha256" ~ '^[0-9a-f]{64}$'
    )
);

CREATE TABLE "matrix_key_claim_results" (
    "id" UUID NOT NULL,
    "claim_request_id" UUID NOT NULL,
    "recipient_device_id" UUID NOT NULL,
    "algorithm" VARCHAR(32) NOT NULL,
    "one_time_key_id" UUID,
    "fallback_key_id" UUID,
    "claimed_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "matrix_key_claim_results_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "matrix_key_claim_results_algorithm_check" CHECK (
        "algorithm" = 'signed_curve25519'
    ),
    CONSTRAINT "matrix_key_claim_results_single_key_check" CHECK (
        num_nonnulls("one_time_key_id", "fallback_key_id") <= 1
    )
);

-- A locked singleton establishes commit-ordered device-list positions. A raw
-- sequence cannot do that because PostgreSQL allocates sequence values before
-- transactions commit.
CREATE TABLE "matrix_device_list_stream" (
    "id" INTEGER NOT NULL,
    "position" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "matrix_device_list_stream_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "matrix_device_list_stream_singleton_check" CHECK (
        "id" = 1 AND "position" >= 0
    )
);
INSERT INTO "matrix_device_list_stream" ("id", "position") VALUES (1, 0);

CREATE TABLE "matrix_device_list_changes" (
    "id" UUID NOT NULL,
    "change_id" UUID NOT NULL,
    "stream_position" BIGINT NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "subject_user_id" UUID NOT NULL,
    "subject_version" BIGINT NOT NULL,
    "change_type" VARCHAR(16) NOT NULL,
    "source_device_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "matrix_device_list_changes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "matrix_device_list_changes_position_check" CHECK (
        "stream_position" > 0 AND "subject_version" > 0
    ),
    CONSTRAINT "matrix_device_list_changes_type_check" CHECK (
        "change_type" IN ('CHANGED', 'LEFT')
    )
);

-- This counter is locked per recipient device before a sender allocates the
-- next value. It therefore preserves arrival/commit order independently for
-- every device without a global queue bottleneck.
CREATE TABLE "matrix_to_device_cursors" (
    "device_id" UUID NOT NULL,
    "latest_sequence" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "matrix_to_device_cursors_pkey" PRIMARY KEY ("device_id"),
    CONSTRAINT "matrix_to_device_cursors_sequence_check" CHECK (
        "latest_sequence" >= 0
    )
);

CREATE TABLE "matrix_to_device_transactions" (
    "id" UUID NOT NULL,
    "sender_session_id" UUID NOT NULL,
    "sender_device_id" UUID NOT NULL,
    "transaction_id" VARCHAR(255) NOT NULL,
    "event_type" VARCHAR(255) NOT NULL,
    "request_sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "matrix_to_device_transactions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "matrix_to_device_transactions_id_check" CHECK (
        char_length("transaction_id") BETWEEN 1 AND 255
        AND "transaction_id" !~ '[[:cntrl:]]'
        AND "request_sha256" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "matrix_to_device_transactions_event_type_check" CHECK (
        "event_type" IN (
            'm.room.encrypted',
            'm.room_key_request',
            'm.key.verification.request',
            'm.key.verification.ready',
            'm.key.verification.start',
            'm.key.verification.accept',
            'm.key.verification.key',
            'm.key.verification.mac',
            'm.key.verification.done',
            'm.key.verification.cancel',
            'm.secret.request',
            'm.secret.send'
        )
    )
);

CREATE TABLE "matrix_to_device_events" (
    "id" UUID NOT NULL,
    "transaction_row_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "recipient_device_id" UUID NOT NULL,
    "recipient_sequence" BIGINT NOT NULL,
    "conversation_id" UUID,
    "content" JSONB NOT NULL,
    "content_sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "matrix_to_device_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "matrix_to_device_events_sequence_check" CHECK (
        "recipient_sequence" > 0
    ),
    CONSTRAINT "matrix_to_device_events_content_check" CHECK (
        jsonb_typeof("content") = 'object'
        AND octet_length("content"::text) <= 65536
        AND "content_sha256" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "matrix_to_device_events_retention_check" CHECK (
        "expires_at" = "created_at" + INTERVAL '48 hours'
    )
);

CREATE TABLE "matrix_to_device_sync_batches" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "up_to_sequence" BIGINT NOT NULL,
    "device_list_position" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "acknowledged_at" TIMESTAMPTZ(6),
    CONSTRAINT "matrix_to_device_sync_batches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "matrix_to_device_sync_batches_position_check" CHECK (
        "up_to_sequence" >= 0 AND "device_list_position" >= 0
    ),
    CONSTRAINT "matrix_to_device_sync_batches_token_check" CHECK (
        "token_hash" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "matrix_to_device_sync_batches_clock_check" CHECK (
        "expires_at" > "created_at"
        AND (
            "acknowledged_at" IS NULL
            OR "acknowledged_at" >= "created_at"
        )
    )
);

CREATE INDEX "matrix_device_registrations_user_expires_idx"
    ON "matrix_device_registrations"("user_id", "expires_at");
CREATE INDEX "matrix_device_registrations_session_idx"
    ON "matrix_device_registrations"("session_id");
CREATE UNIQUE INDEX "matrix_device_registrations_open_session_key"
    ON "matrix_device_registrations"("session_id")
    WHERE "consumed_at" IS NULL;

CREATE UNIQUE INDEX "matrix_device_list_states_matrix_user_key"
    ON "matrix_device_list_states"("matrix_user_id");
CREATE UNIQUE INDEX "matrix_device_list_states_user_matrix_key"
    ON "matrix_device_list_states"("user_id", "matrix_user_id");

CREATE UNIQUE INDEX "matrix_device_keys_matrix_device_key"
    ON "matrix_device_keys"("matrix_device_id");
CREATE UNIQUE INDEX "matrix_device_keys_curve25519_key"
    ON "matrix_device_keys"("curve25519_key");
CREATE UNIQUE INDEX "matrix_device_keys_ed25519_key"
    ON "matrix_device_keys"("ed25519_key");
CREATE INDEX "matrix_device_keys_user_uploaded_idx"
    ON "matrix_device_keys"("user_id", "uploaded_at");
CREATE UNIQUE INDEX "matrix_device_keys_device_user_key"
    ON "matrix_device_keys"("device_id", "user_id");
CREATE UNIQUE INDEX "matrix_device_keys_user_device_key"
    ON "matrix_device_keys"("matrix_user_id", "matrix_device_id");

CREATE UNIQUE INDEX "matrix_one_time_keys_curve25519_key"
    ON "matrix_one_time_keys"("curve25519_key");
CREATE INDEX "matrix_one_time_keys_available_idx"
    ON "matrix_one_time_keys"(
        "device_id", "algorithm", "claimed_at", "uploaded_at", "id"
    );
CREATE UNIQUE INDEX "matrix_one_time_keys_device_algorithm_key"
    ON "matrix_one_time_keys"("device_id", "algorithm", "key_id");

CREATE UNIQUE INDEX "matrix_fallback_keys_curve25519_key"
    ON "matrix_fallback_keys"("curve25519_key");
CREATE INDEX "matrix_fallback_keys_device_uploaded_idx"
    ON "matrix_fallback_keys"("device_id", "algorithm", "uploaded_at");
CREATE UNIQUE INDEX "matrix_fallback_keys_device_algorithm_key"
    ON "matrix_fallback_keys"("device_id", "algorithm", "key_id");
CREATE UNIQUE INDEX "matrix_fallback_keys_identity_key"
    ON "matrix_fallback_keys"("id", "device_id", "algorithm");
CREATE UNIQUE INDEX "matrix_fallback_key_slots_current_key"
    ON "matrix_fallback_key_slots"("current_fallback_key_id");
CREATE UNIQUE INDEX "matrix_fallback_key_slots_identity_key"
    ON "matrix_fallback_key_slots"(
        "current_fallback_key_id", "device_id", "algorithm"
    );

CREATE INDEX "matrix_key_claim_requests_conversation_idx"
    ON "matrix_key_claim_requests"("conversation_id", "created_at");
CREATE UNIQUE INDEX "matrix_key_claim_requests_request_key"
    ON "matrix_key_claim_requests"("requester_device_id", "request_id");
CREATE UNIQUE INDEX "matrix_key_claim_results_one_time_key"
    ON "matrix_key_claim_results"("one_time_key_id");
CREATE INDEX "matrix_key_claim_results_recipient_idx"
    ON "matrix_key_claim_results"("recipient_device_id", "claimed_at");
CREATE UNIQUE INDEX "matrix_key_claim_results_target_key"
    ON "matrix_key_claim_results"(
        "claim_request_id", "recipient_device_id", "algorithm"
    );

CREATE INDEX "matrix_device_list_changes_recipient_stream_idx"
    ON "matrix_device_list_changes"("recipient_user_id", "stream_position");
CREATE INDEX "matrix_device_list_changes_subject_stream_idx"
    ON "matrix_device_list_changes"("subject_user_id", "stream_position");
CREATE UNIQUE INDEX "matrix_device_list_changes_fanout_key"
    ON "matrix_device_list_changes"("change_id", "recipient_user_id");
CREATE UNIQUE INDEX "matrix_device_list_changes_recipient_position_key"
    ON "matrix_device_list_changes"("recipient_user_id", "stream_position");

CREATE INDEX "matrix_to_device_transactions_sender_idx"
    ON "matrix_to_device_transactions"("sender_device_id", "created_at");
CREATE UNIQUE INDEX "matrix_to_device_transactions_session_txn_key"
    ON "matrix_to_device_transactions"(
        "sender_session_id", "transaction_id"
    );
CREATE INDEX "matrix_to_device_events_recipient_stream_idx"
    ON "matrix_to_device_events"(
        "recipient_device_id", "recipient_sequence"
    );
CREATE INDEX "matrix_to_device_events_expires_idx"
    ON "matrix_to_device_events"("expires_at");
CREATE UNIQUE INDEX "matrix_to_device_events_transaction_device_key"
    ON "matrix_to_device_events"(
        "transaction_row_id", "recipient_device_id"
    );
CREATE UNIQUE INDEX "matrix_to_device_events_recipient_sequence_key"
    ON "matrix_to_device_events"(
        "recipient_device_id", "recipient_sequence"
    );
CREATE UNIQUE INDEX "matrix_to_device_sync_batches_token_hash_key"
    ON "matrix_to_device_sync_batches"("token_hash");
CREATE INDEX "matrix_to_device_sync_batches_device_created_idx"
    ON "matrix_to_device_sync_batches"("device_id", "created_at");
CREATE INDEX "matrix_to_device_sync_batches_expires_idx"
    ON "matrix_to_device_sync_batches"("expires_at");

ALTER TABLE "matrix_device_registrations"
    ADD CONSTRAINT "matrix_device_registrations_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "matrix_device_registrations_session_id_fkey"
        FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "matrix_device_list_states"
    ADD CONSTRAINT "matrix_device_list_states_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "matrix_device_keys"
    ADD CONSTRAINT "matrix_device_keys_device_id_user_id_fkey"
        FOREIGN KEY ("device_id", "user_id")
        REFERENCES "devices"("id", "user_id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "matrix_device_keys_user_id_matrix_user_id_fkey"
        FOREIGN KEY ("user_id", "matrix_user_id")
        REFERENCES "matrix_device_list_states"("user_id", "matrix_user_id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "matrix_one_time_keys"
    ADD CONSTRAINT "matrix_one_time_keys_device_id_fkey"
        FOREIGN KEY ("device_id") REFERENCES "devices"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "matrix_fallback_keys"
    ADD CONSTRAINT "matrix_fallback_keys_device_id_fkey"
        FOREIGN KEY ("device_id") REFERENCES "devices"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "matrix_fallback_key_slots"
    ADD CONSTRAINT "matrix_fallback_key_slots_device_id_fkey"
        FOREIGN KEY ("device_id") REFERENCES "devices"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "matrix_fallback_key_slots_current_fallback_key_id_device_i_fkey"
        FOREIGN KEY (
            "current_fallback_key_id", "device_id", "algorithm"
        ) REFERENCES "matrix_fallback_keys"("id", "device_id", "algorithm")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "matrix_key_claim_requests"
    ADD CONSTRAINT "matrix_key_claim_requests_requester_device_id_fkey"
        FOREIGN KEY ("requester_device_id") REFERENCES "devices"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "matrix_key_claim_requests_conversation_id_fkey"
        FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "matrix_key_claim_results"
    ADD CONSTRAINT "matrix_key_claim_results_claim_request_id_fkey"
        FOREIGN KEY ("claim_request_id")
        REFERENCES "matrix_key_claim_requests"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "matrix_key_claim_results_recipient_device_id_fkey"
        FOREIGN KEY ("recipient_device_id") REFERENCES "devices"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "matrix_key_claim_results_one_time_key_id_fkey"
        FOREIGN KEY ("one_time_key_id") REFERENCES "matrix_one_time_keys"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "matrix_key_claim_results_fallback_key_id_fkey"
        FOREIGN KEY ("fallback_key_id") REFERENCES "matrix_fallback_keys"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "matrix_device_list_changes"
    ADD CONSTRAINT "matrix_device_list_changes_recipient_user_id_fkey"
        FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "matrix_device_list_changes_subject_user_id_fkey"
        FOREIGN KEY ("subject_user_id") REFERENCES "users"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "matrix_device_list_changes_source_device_id_fkey"
        FOREIGN KEY ("source_device_id") REFERENCES "devices"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "matrix_to_device_cursors"
    ADD CONSTRAINT "matrix_to_device_cursors_device_id_fkey"
        FOREIGN KEY ("device_id") REFERENCES "devices"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "matrix_to_device_transactions"
    ADD CONSTRAINT "matrix_to_device_transactions_sender_session_id_fkey"
        FOREIGN KEY ("sender_session_id") REFERENCES "auth_sessions"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "matrix_to_device_transactions_sender_device_id_fkey"
        FOREIGN KEY ("sender_device_id") REFERENCES "devices"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "matrix_to_device_events"
    ADD CONSTRAINT "matrix_to_device_events_transaction_row_id_fkey"
        FOREIGN KEY ("transaction_row_id")
        REFERENCES "matrix_to_device_transactions"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "matrix_to_device_events_recipient_device_id_recipient_user_fkey"
        FOREIGN KEY ("recipient_device_id", "recipient_user_id")
        REFERENCES "devices"("id", "user_id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "matrix_to_device_events_recipient_device_id_fkey"
        FOREIGN KEY ("recipient_device_id")
        REFERENCES "matrix_to_device_cursors"("device_id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "matrix_to_device_events_conversation_id_fkey"
        FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "matrix_to_device_sync_batches"
    ADD CONSTRAINT "matrix_to_device_sync_batches_device_id_fkey"
        FOREIGN KEY ("device_id")
        REFERENCES "matrix_to_device_cursors"("device_id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "sinochat_validate_matrix_device_registration"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "session_user_id" UUID;
    "session_device_id" UUID;
    "session_expires_at" TIMESTAMPTZ(6);
    "session_revoked_at" TIMESTAMPTZ(6);
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW."id" <> OLD."id"
           OR NEW."user_id" <> OLD."user_id"
           OR NEW."session_id" <> OLD."session_id"
           OR NEW."created_at" <> OLD."created_at"
           OR NEW."expires_at" <> OLD."expires_at"
           OR OLD."consumed_at" IS NOT NULL
           OR NEW."consumed_at" IS NULL THEN
            RAISE EXCEPTION 'matrix device registration identity and consumption are immutable'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    SELECT s."user_id", s."device_id", s."expires_at", s."revoked_at"
      INTO "session_user_id", "session_device_id", "session_expires_at", "session_revoked_at"
      FROM "auth_sessions" s
     WHERE s."id" = NEW."session_id"
     FOR SHARE;

    IF "session_user_id" IS DISTINCT FROM NEW."user_id"
       OR "session_revoked_at" IS NOT NULL
       OR "session_expires_at" <= clock_timestamp() THEN
        RAISE EXCEPTION 'matrix device registration requires a current session owned by the user'
            USING ERRCODE = '23514';
    END IF;

    IF NEW."consumed_at" IS NULL AND "session_device_id" IS NOT NULL THEN
        RAISE EXCEPTION 'matrix device registration requires an unbound session'
            USING ERRCODE = '23514';
    END IF;

    IF NEW."consumed_at" IS NOT NULL AND (
        "session_device_id" IS DISTINCT FROM NEW."id"
        OR NOT EXISTS (
            SELECT 1
              FROM "matrix_device_keys" k
             WHERE k."device_id" = NEW."id"
               AND k."user_id" = NEW."user_id"
        )
    ) THEN
        RAISE EXCEPTION 'matrix device registration can only be consumed after atomic device publication and session binding'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "matrix_device_registrations_validation_trigger"
BEFORE INSERT OR UPDATE ON "matrix_device_registrations"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_matrix_device_registration"();

CREATE FUNCTION "sinochat_enforce_matrix_device_list_state"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW."user_id" <> OLD."user_id"
           OR NEW."matrix_user_id" <> OLD."matrix_user_id"
           OR NEW."version" <> OLD."version" + 1 THEN
            RAISE EXCEPTION 'matrix device-list identity is immutable and version must advance exactly once'
                USING ERRCODE = '23514';
        END IF;
        NEW."updated_at" := clock_timestamp();
    ELSIF NEW."version" <> 0 THEN
        RAISE EXCEPTION 'matrix device-list state must start at version zero'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "matrix_device_list_states_progress_trigger"
BEFORE INSERT OR UPDATE ON "matrix_device_list_states"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_matrix_device_list_state"();

CREATE FUNCTION "sinochat_validate_matrix_device_key"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "device_status" "DeviceStatus";
    "device_protocol" VARCHAR(32);
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'matrix device keys are immutable; revoke and register a new device'
            USING ERRCODE = '23514';
    END IF;

    SELECT d."status", d."protocol_version"
      INTO "device_status", "device_protocol"
      FROM "devices" d
     WHERE d."id" = NEW."device_id"
       AND d."user_id" = NEW."user_id"
     FOR SHARE;

    IF "device_status" IS DISTINCT FROM 'ACTIVE'
       OR "device_protocol" IS DISTINCT FROM 'matrix-olm-v1'
       OR NEW."device_keys"->>'user_id' IS DISTINCT FROM NEW."matrix_user_id"
       OR NEW."device_keys"->>'device_id' IS DISTINCT FROM NEW."matrix_device_id"
       OR NEW."device_keys"->'keys'->>('curve25519:' || NEW."matrix_device_id") IS DISTINCT FROM NEW."curve25519_key"
       OR NEW."device_keys"->'keys'->>('ed25519:' || NEW."matrix_device_id") IS DISTINCT FROM NEW."ed25519_key" THEN
        RAISE EXCEPTION 'matrix device key does not match its active device identity'
            USING ERRCODE = '23514';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('sinochat:matrix:curve:' || NEW."curve25519_key", 0)
    );
    IF EXISTS (
        SELECT 1 FROM "matrix_one_time_keys" k
         WHERE k."curve25519_key" = NEW."curve25519_key"
        UNION ALL
        SELECT 1 FROM "matrix_fallback_keys" k
         WHERE k."curve25519_key" = NEW."curve25519_key"
    ) THEN
        RAISE EXCEPTION 'matrix Curve25519 public material cannot be reused'
            USING ERRCODE = '23505';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "matrix_device_keys_validation_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "matrix_device_keys"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_matrix_device_key"();

CREATE FUNCTION "sinochat_validate_matrix_pre_key"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "is_fallback" BOOLEAN := TG_TABLE_NAME = 'matrix_fallback_keys';
    "event_time" TIMESTAMPTZ(6);
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

    "event_time" := CASE
        WHEN "is_fallback" THEN NEW."first_claimed_at"
        ELSE NEW."claimed_at"
    END;

    IF TG_OP = 'UPDATE' THEN
        IF NEW."id" <> OLD."id"
           OR NEW."device_id" <> OLD."device_id"
           OR NEW."algorithm" <> OLD."algorithm"
           OR NEW."key_id" <> OLD."key_id"
           OR NEW."curve25519_key" <> OLD."curve25519_key"
           OR NEW."signed_key" <> OLD."signed_key"
           OR NEW."canonical_sha256" <> OLD."canonical_sha256"
           OR NEW."uploaded_at" <> OLD."uploaded_at"
           OR (
               "is_fallback"
               AND (
                   OLD."first_claimed_at" IS NOT NULL
                   OR NEW."first_claimed_at" IS NULL
               )
           )
           OR (
               NOT "is_fallback"
               AND (
                   OLD."claimed_at" IS NOT NULL
                   OR NEW."claimed_at" IS NULL
               )
           ) THEN
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

CREATE TRIGGER "matrix_one_time_keys_validation_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "matrix_one_time_keys"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_matrix_pre_key"();

CREATE TRIGGER "matrix_fallback_keys_validation_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "matrix_fallback_keys"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_matrix_pre_key"();

CREATE FUNCTION "sinochat_enforce_matrix_fallback_slot"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "old_uploaded_at" TIMESTAMPTZ(6);
    "new_uploaded_at" TIMESTAMPTZ(6);
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'matrix fallback slots cannot be deleted'
            USING ERRCODE = '23514';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            'sinochat:matrix:prekeys:' || NEW."device_id"::text,
            0
        )
    );

    IF TG_OP = 'UPDATE' THEN
        IF NEW."device_id" <> OLD."device_id"
           OR NEW."algorithm" <> OLD."algorithm"
           OR NEW."current_fallback_key_id" = OLD."current_fallback_key_id" THEN
            RAISE EXCEPTION 'matrix fallback slot identity is immutable and rotations require a new key'
                USING ERRCODE = '23514';
        END IF;

        SELECT "uploaded_at" INTO "old_uploaded_at"
          FROM "matrix_fallback_keys"
         WHERE "id" = OLD."current_fallback_key_id";
        SELECT "uploaded_at" INTO "new_uploaded_at"
          FROM "matrix_fallback_keys"
         WHERE "id" = NEW."current_fallback_key_id";

        IF "new_uploaded_at" IS NULL
           OR "old_uploaded_at" IS NULL
           OR "new_uploaded_at" <= "old_uploaded_at" THEN
            RAISE EXCEPTION 'matrix fallback rotation must move to a newer key'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "matrix_fallback_key_slots_progress_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "matrix_fallback_key_slots"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_matrix_fallback_slot"();

CREATE FUNCTION "sinochat_validate_matrix_key_claim_request"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'matrix key-claim requests are immutable idempotency records'
            USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM "devices" d
          JOIN "matrix_device_keys" k ON k."device_id" = d."id"
         WHERE d."id" = NEW."requester_device_id"
           AND d."status" = 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'matrix key claim requires an active published requester device'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "matrix_key_claim_requests_validation_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "matrix_key_claim_requests"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_matrix_key_claim_request"();

CREATE FUNCTION "sinochat_validate_matrix_key_claim_result"()
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
        SELECT k."device_id", k."algorithm", k."claimed_at"
          INTO "key_device_id", "key_algorithm", "key_claimed_at"
          FROM "matrix_one_time_keys" k
         WHERE k."id" = NEW."one_time_key_id"
         FOR UPDATE;
    ELSIF NEW."fallback_key_id" IS NOT NULL THEN
        SELECT k."device_id", k."algorithm", k."first_claimed_at"
          INTO "key_device_id", "key_algorithm", "key_claimed_at"
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

    IF NEW."claimed_at" > clock_timestamp() THEN
        RAISE EXCEPTION 'Matrix key-claim timestamp cannot be in the future'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "matrix_key_claim_results_validation_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "matrix_key_claim_results"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_matrix_key_claim_result"();

CREATE FUNCTION "sinochat_enforce_matrix_device_list_stream"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP <> 'UPDATE'
       OR NEW."id" <> OLD."id"
       OR NEW."position" <> OLD."position" + 1 THEN
        RAISE EXCEPTION 'matrix device-list stream advances exactly one position under row lock'
            USING ERRCODE = '23514';
    END IF;
    NEW."updated_at" := clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER "matrix_device_list_stream_progress_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "matrix_device_list_stream"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_matrix_device_list_stream"();

CREATE FUNCTION "sinochat_validate_matrix_device_list_change"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'matrix device-list changes are immutable'
            USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM "matrix_device_list_stream" s
         WHERE s."id" = 1
           AND s."position" = NEW."stream_position"
    ) OR NOT EXISTS (
        SELECT 1 FROM "matrix_device_list_states" s
         WHERE s."user_id" = NEW."subject_user_id"
           AND s."version" = NEW."subject_version"
    ) OR EXISTS (
        SELECT 1 FROM "users" u
         WHERE u."id" IN (NEW."recipient_user_id", NEW."subject_user_id")
           AND u."role" = 'ADMIN'
    ) THEN
        RAISE EXCEPTION 'matrix device-list change requires the current committed stream and non-admin identities'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "matrix_device_list_changes_validation_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "matrix_device_list_changes"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_matrix_device_list_change"();

CREATE FUNCTION "sinochat_enforce_matrix_to_device_cursor"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'matrix to-device cursors cannot be deleted'
            USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW."latest_sequence" <> 0 OR NOT EXISTS (
            SELECT 1
              FROM "devices" d
              JOIN "matrix_device_keys" k ON k."device_id" = d."id"
             WHERE d."id" = NEW."device_id"
               AND d."status" = 'ACTIVE'
        ) THEN
            RAISE EXCEPTION 'matrix to-device cursor must start at zero for an active published device'
                USING ERRCODE = '23514';
        END IF;
    ELSE
        IF NEW."device_id" <> OLD."device_id"
           OR NEW."latest_sequence" <> OLD."latest_sequence" + 1 THEN
            RAISE EXCEPTION 'matrix to-device sequence advances exactly once under recipient lock'
                USING ERRCODE = '23514';
        END IF;
        NEW."updated_at" := clock_timestamp();
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "matrix_to_device_cursors_progress_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "matrix_to_device_cursors"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_matrix_to_device_cursor"();

CREATE FUNCTION "sinochat_validate_matrix_to_device_transaction"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'matrix to-device transaction tombstones are immutable'
            USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM "auth_sessions" s
          JOIN "devices" d
            ON d."id" = s."device_id"
           AND d."id" = NEW."sender_device_id"
          JOIN "matrix_device_keys" k ON k."device_id" = d."id"
          JOIN "users" u ON u."id" = d."user_id"
         WHERE s."id" = NEW."sender_session_id"
           AND s."revoked_at" IS NULL
           AND s."expires_at" > clock_timestamp()
           AND d."status" = 'ACTIVE'
           AND u."role" IN ('CLIENT', 'CASHIER')
           AND u."status" = 'ACTIVE'
         FOR SHARE OF s, d, u
    ) THEN
        RAISE EXCEPTION 'matrix to-device transaction requires its current bound non-admin session'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "matrix_to_device_transactions_validation_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "matrix_to_device_transactions"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_matrix_to_device_transaction"();

CREATE FUNCTION "sinochat_validate_matrix_to_device_event"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "sender_user_id" UUID;
    "event_type" VARCHAR(255);
    "recipient_status" "DeviceStatus";
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'matrix to-device events are immutable until acknowledgement or expiry deletes them'
            USING ERRCODE = '23514';
    ELSIF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    SELECT d."user_id", t."event_type"
      INTO "sender_user_id", "event_type"
      FROM "matrix_to_device_transactions" t
      JOIN "devices" d ON d."id" = t."sender_device_id"
     WHERE t."id" = NEW."transaction_row_id";

    SELECT d."status"
      INTO "recipient_status"
      FROM "devices" d
      JOIN "matrix_device_keys" k ON k."device_id" = d."id"
     WHERE d."id" = NEW."recipient_device_id"
       AND d."user_id" = NEW."recipient_user_id"
     FOR SHARE OF d;

    IF "sender_user_id" IS NULL
       OR "recipient_status" IS DISTINCT FROM 'ACTIVE'
       OR NOT EXISTS (
            SELECT 1
              FROM "matrix_to_device_cursors" c
             WHERE c."device_id" = NEW."recipient_device_id"
               AND c."latest_sequence" = NEW."recipient_sequence"
       )
       OR NEW."created_at" > clock_timestamp() THEN
        RAISE EXCEPTION 'matrix to-device event requires the current sequence of an active published recipient'
            USING ERRCODE = '23514';
    END IF;

    IF "event_type" = 'm.room.encrypted' AND (
        NEW."content"->>'algorithm' IS DISTINCT FROM 'm.olm.v1.curve25519-aes-sha2'
        OR jsonb_typeof(NEW."content"->'ciphertext') IS DISTINCT FROM 'object'
    ) THEN
        RAISE EXCEPTION 'encrypted Matrix to-device controls require the exact Olm v1 envelope'
            USING ERRCODE = '23514';
    END IF;

    IF "sender_user_id" = NEW."recipient_user_id" THEN
        IF NEW."conversation_id" IS NOT NULL THEN
            RAISE EXCEPTION 'same-user Matrix to-device controls are not conversation events'
                USING ERRCODE = '23514';
        END IF;
    ELSIF NEW."conversation_id" IS NULL OR NOT EXISTS (
        SELECT 1
          FROM "conversations" c
          JOIN "assignments" a ON a."id" = c."assignment_id"
         WHERE c."id" = NEW."conversation_id"
           AND c."status" = 'ACTIVE'
           AND a."ended_at" IS NULL
           AND (
               (
                   a."client_user_id" = "sender_user_id"
                   AND a."cashier_user_id" = NEW."recipient_user_id"
               )
               OR (
                   a."cashier_user_id" = "sender_user_id"
                   AND a."client_user_id" = NEW."recipient_user_id"
               )
           )
         FOR SHARE OF c, a
    ) THEN
        RAISE EXCEPTION 'cross-user Matrix to-device controls require their active conversation'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "matrix_to_device_events_validation_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "matrix_to_device_events"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_matrix_to_device_event"();

CREATE FUNCTION "sinochat_validate_matrix_sync_batch"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "latest_sequence" BIGINT;
    "latest_device_list_position" BIGINT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW."id" <> OLD."id"
           OR NEW."device_id" <> OLD."device_id"
           OR NEW."token_hash" <> OLD."token_hash"
           OR NEW."up_to_sequence" <> OLD."up_to_sequence"
           OR NEW."device_list_position" <> OLD."device_list_position"
           OR NEW."created_at" <> OLD."created_at"
           OR NEW."expires_at" <> OLD."expires_at"
           OR OLD."acknowledged_at" IS NOT NULL
           OR NEW."acknowledged_at" IS NULL
           OR NEW."acknowledged_at" > clock_timestamp() THEN
            RAISE EXCEPTION 'matrix sync batch identity and acknowledgement are immutable'
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

    IF "latest_sequence" IS NULL
       OR NEW."up_to_sequence" > "latest_sequence"
       OR NEW."device_list_position" > "latest_device_list_position"
       OR NEW."expires_at" > NEW."created_at" + INTERVAL '30 days' THEN
        RAISE EXCEPTION 'matrix sync batch cannot acknowledge unissued positions or outlive the session window'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "matrix_to_device_sync_batches_validation_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "matrix_to_device_sync_batches"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_matrix_sync_batch"();
