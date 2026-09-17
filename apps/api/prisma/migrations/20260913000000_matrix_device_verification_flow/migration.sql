-- Admission and immutable replay identity for one SAS request in quarantine.
-- No delivery queue, SAS result, certificate publication, Device promotion,
-- session binding or relaxation of the existing E2EE release restrictions.

CREATE TYPE "MatrixDeviceVerificationFlowStatus" AS ENUM ('PENDING', 'CANCELLED', 'EXPIRED');

-- The candidate's immutable owner is part of the flow's foreign key, not an
-- independently trusted user_id copied from an HTTP request.
CREATE UNIQUE INDEX "matrix_device_candidates_id_user_key"
    ON "matrix_device_candidates"("id", "user_id");

CREATE FUNCTION "sinochat_matrix_verification_request_shape"(
    "value" JSONB,
    "flow_id" TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    "timestamp_ms" NUMERIC;
BEGIN
    IF "sinochat_cross_signing_exact_object"(
        "value", ARRAY['from_device', 'methods', 'timestamp', 'transaction_id']
    ) IS NOT TRUE
       OR jsonb_typeof("value"->'from_device') IS DISTINCT FROM 'string'
       OR ("value"->>'from_device') !~ '^D[0-9A-F]{32}$'
       OR ("value"->'methods') IS DISTINCT FROM '["m.sas.v1"]'::jsonb
       OR ("value"->'transaction_id') IS DISTINCT FROM to_jsonb("flow_id")
       OR jsonb_typeof("value"->'timestamp') IS DISTINCT FROM 'number' THEN
        RETURN FALSE;
    END IF;
    -- Guard the numeric cast explicitly: CHECK expressions are not an ordered
    -- validation program. This agrees with the application's safe integer range.
    "timestamp_ms" := ("value"->>'timestamp')::numeric;
    RETURN COALESCE("timestamp_ms" BETWEEN 0 AND 9007199254740991
        AND trunc("timestamp_ms") = "timestamp_ms", FALSE);
END;
$$;

CREATE TABLE "matrix_device_verification_flows" (
    "candidate_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "flow_id" VARCHAR(255) NOT NULL,
    "reviewer_session_id" UUID NOT NULL,
    "reviewer_session_version" INTEGER NOT NULL,
    "request_transaction_id" VARCHAR(255) NOT NULL,
    "request_content" JSONB NOT NULL,
    "request_sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "resolved_at" TIMESTAMPTZ(6),
    "status" "MatrixDeviceVerificationFlowStatus" NOT NULL DEFAULT 'PENDING',
    CONSTRAINT "matrix_device_verification_flows_pkey" PRIMARY KEY ("candidate_id"),
    CONSTRAINT "matrix_device_verification_flows_encoding_check" CHECK ((
        "flow_id" ~ '^[A-Za-z0-9._~-]{1,255}$'
        AND "request_transaction_id" ~ '^[A-Za-z0-9._~-]{1,255}$'
        AND "reviewer_session_version" > 0
        AND "request_sha256" ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof("request_content") = 'object'
        AND octet_length("request_content"::text) <= 8192
        AND "sinochat_matrix_verification_request_shape"("request_content", "flow_id")
    ) IS TRUE),
    CONSTRAINT "matrix_device_verification_flows_window_check" CHECK ((
        isfinite("created_at") AND isfinite("expires_at")
        AND "expires_at" > "created_at"
        AND "expires_at" <= "created_at" + INTERVAL '10 minutes'
        AND (
            ("status" = 'PENDING' AND "resolved_at" IS NULL)
            OR (
                "status" IN ('CANCELLED', 'EXPIRED')
                AND "resolved_at" IS NOT NULL AND isfinite("resolved_at")
                AND "resolved_at" >= "created_at"
                AND ("status" <> 'EXPIRED' OR "resolved_at" >= "expires_at")
            )
        )
    ) IS TRUE)
);

-- Historical uniqueness survives cancellation/expiration. In the current
-- single-bootstrap model user_id fixes the sender device as well. A future
-- multi-device design must explicitly review this deliberately strict scope.
CREATE UNIQUE INDEX "matrix_device_verification_flows_candidate_owner_key"
    ON "matrix_device_verification_flows"("candidate_id", "user_id");
CREATE UNIQUE INDEX "matrix_device_verification_flows_user_flow_key"
    ON "matrix_device_verification_flows"("user_id", "flow_id");
CREATE UNIQUE INDEX "matrix_device_verification_flows_user_request_txn_key"
    ON "matrix_device_verification_flows"("user_id", "request_transaction_id");
CREATE INDEX "matrix_device_verification_flows_reviewer_session_idx"
    ON "matrix_device_verification_flows"("reviewer_session_id");
CREATE INDEX "matrix_device_verification_flows_user_pending_idx"
    ON "matrix_device_verification_flows"("user_id", "status", "expires_at");

ALTER TABLE "matrix_device_verification_flows"
    ADD CONSTRAINT "matrix_device_verification_flows_candidate_id_user_id_fkey"
        FOREIGN KEY ("candidate_id", "user_id")
        REFERENCES "matrix_device_candidates"("id", "user_id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "matrix_device_verification_flows_reviewer_session_id_fkey"
        FOREIGN KEY ("reviewer_session_id") REFERENCES "auth_sessions"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "sinochat_validate_matrix_verification_flow"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "candidate" "matrix_device_candidates"%ROWTYPE;
    "owner_role" "UserRole";
    "owner_status" "AccountStatus";
    "owner_reset_required" BOOLEAN;
    "owner_session_version" INTEGER;
    "cashier_user_id" UUID;
    "subscription_starts_at" TIMESTAMPTZ(6);
    "subscription_ends_at" TIMESTAMPTZ(6);
    "reviewer_user_id" UUID;
    "reviewer_device_id" UUID;
    "reviewer_session_version" INTEGER;
    "reviewer_created_at" TIMESTAMPTZ(6);
    "reviewer_expires_at" TIMESTAMPTZ(6);
    "reviewer_revoked_at" TIMESTAMPTZ(6);
    "device_status" "DeviceStatus";
    "device_protocol" VARCHAR(32);
    "device_matrix_user_id" VARCHAR(289);
    "device_matrix_id" VARCHAR(33);
    "certificate_device_id" UUID;
    "requester_user_id" UUID;
    "requester_device_id" UUID;
    "requester_session_version" INTEGER;
    "requester_expires_at" TIMESTAMPTZ(6);
    "requester_revoked_at" TIMESTAMPTZ(6);
    "identity_matrix_user_id" VARCHAR(289);
    "identity_bootstrap_device_id" UUID;
    "identity_bootstrap_sha256" CHAR(64);
    "timestamp_ms" NUMERIC;
    "checked_at" TIMESTAMPTZ(6);
    "checked_epoch_ms" NUMERIC;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'verification flow tombstones cannot be deleted or reused; retention requires a separate design'
            USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF (to_jsonb(NEW) - ARRAY['status', 'resolved_at'])
                IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'resolved_at'])
           OR OLD."status" IS DISTINCT FROM 'PENDING'
           OR OLD."resolved_at" IS NOT NULL
           OR NEW."status" NOT IN ('CANCELLED', 'EXPIRED')
           OR NEW."resolved_at" IS NULL THEN
            RAISE EXCEPTION 'verification flow snapshot and terminal states are immutable'
                USING ERRCODE = '23514';
        END IF;
        IF NEW."resolved_at" > clock_timestamp() THEN
            RAISE EXCEPTION 'verification flow resolution cannot be future-dated'
                USING ERRCODE = '23514';
        END IF;
        -- Terminal maintenance deliberately does not require live authority or
        -- acquire the candidate lock after a flow lock. Services cancel the
        -- candidate first; its AFTER trigger invalidates the flow atomically.
        RETURN NEW;
    END IF;

    IF NEW."status" IS DISTINCT FROM 'PENDING' OR NEW."resolved_at" IS NOT NULL THEN
        RAISE EXCEPTION 'verification flows must begin pending without a resolution'
            USING ERRCODE = '23514';
    END IF;
    IF "sinochat_matrix_verification_request_shape"(NEW."request_content", NEW."flow_id") IS NOT TRUE THEN
        RAISE EXCEPTION 'verification flow must contain only the original scoped SAS request content'
            USING ERRCODE = '23514';
    END IF;
    "timestamp_ms" := (NEW."request_content"->>'timestamp')::numeric;

    PERFORM pg_advisory_xact_lock(hashtextextended('sinochat:devices:' || NEW."user_id"::text, 0));
    SELECT u."role", u."status", u."password_reset_required", u."session_version"
      INTO "owner_role", "owner_status", "owner_reset_required", "owner_session_version"
      FROM "users" u WHERE u."id" = NEW."user_id" FOR SHARE;
    IF "owner_role" IS NULL OR "owner_role" NOT IN ('CLIENT', 'CASHIER')
       OR "owner_status" IS DISTINCT FROM 'ACTIVE'
       OR "owner_reset_required" IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION 'verification flow admission requires an active chat participant without a pending password reset'
            USING ERRCODE = '23514';
    END IF;

    IF "owner_role" = 'CASHIER' THEN
        SELECT cp."user_id", cs."starts_at", cs."ends_at"
          INTO "cashier_user_id", "subscription_starts_at", "subscription_ends_at"
          FROM "cashier_profiles" cp
          JOIN "cashier_subscriptions" cs ON cs."cashier_user_id" = cp."user_id"
         WHERE cp."user_id" = NEW."user_id"
           AND cp."approval_status" = 'APPROVED'
           AND cp."email_verified_at" IS NOT NULL AND cp."phone_verified_at" IS NOT NULL
           AND cs."status" = 'ACTIVE'
         FOR SHARE OF cp, cs;
        IF "cashier_user_id" IS DISTINCT FROM NEW."user_id" THEN
            RAISE EXCEPTION 'cashier verification flow admission requires approval, verified contact details and an active subscription'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    -- Peek only at the immutable candidate identity to identify the reviewer.
    -- Re-read and lock the candidate after the reviewer, matching review order.
    SELECT q.* INTO "candidate" FROM "matrix_device_candidates" q
     WHERE q."id" = NEW."candidate_id" AND q."user_id" = NEW."user_id";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'verification candidate must belong to the same user'
            USING ERRCODE = '23514';
    END IF;

    SELECT s."user_id", s."device_id", s."session_version", s."created_at", s."expires_at", s."revoked_at",
           d."status", d."protocol_version", k."matrix_user_id", k."matrix_device_id", c."device_id"
      INTO "reviewer_user_id", "reviewer_device_id", "reviewer_session_version", "reviewer_created_at", "reviewer_expires_at", "reviewer_revoked_at",
           "device_status", "device_protocol", "device_matrix_user_id", "device_matrix_id", "certificate_device_id"
      FROM "auth_sessions" s
      JOIN "devices" d ON d."id" = s."device_id" AND d."user_id" = s."user_id"
      JOIN "matrix_device_keys" k ON k."device_id" = d."id" AND k."user_id" = d."user_id"
      JOIN "matrix_device_cross_signings" c ON c."device_id" = d."id" AND c."user_id" = d."user_id"
     WHERE s."id" = NEW."reviewer_session_id" AND s."user_id" = NEW."user_id"
       AND d."id" = "candidate"."trusted_device_id"
     FOR SHARE OF s, d, k, c;
    IF "reviewer_user_id" IS DISTINCT FROM NEW."user_id"
       OR "reviewer_device_id" IS DISTINCT FROM "candidate"."trusted_device_id"
       OR "reviewer_session_version" IS DISTINCT FROM NEW."reviewer_session_version"
       OR "reviewer_session_version" IS DISTINCT FROM "owner_session_version"
       OR "reviewer_revoked_at" IS NOT NULL
       OR "device_status" IS DISTINCT FROM 'ACTIVE'
       OR "device_protocol" IS DISTINCT FROM 'matrix-olm-v1'
       OR "device_matrix_user_id" IS DISTINCT FROM "candidate"."matrix_user_id"
       OR "device_matrix_id" IS DISTINCT FROM ('D' || upper(replace("candidate"."trusted_device_id"::text, '-', '')))
       OR "certificate_device_id" IS DISTINCT FROM "candidate"."trusted_device_id" THEN
        RAISE EXCEPTION 'verification flow requires the current session of its active certified bootstrap device'
            USING ERRCODE = '23514';
    END IF;

    SELECT q.* INTO "candidate" FROM "matrix_device_candidates" q
     WHERE q."id" = NEW."candidate_id" AND q."user_id" = NEW."user_id" FOR UPDATE OF q;
    IF NOT FOUND OR "candidate"."status" IS DISTINCT FROM 'PENDING'
       OR "candidate"."session_id" = NEW."reviewer_session_id"
       OR "candidate"."session_version" IS DISTINCT FROM "owner_session_version" THEN
        RAISE EXCEPTION 'verification admission requires a pending candidate and distinct participant sessions'
            USING ERRCODE = '23514';
    END IF;

    SELECT s."user_id", s."device_id", s."session_version", s."expires_at", s."revoked_at"
      INTO "requester_user_id", "requester_device_id", "requester_session_version", "requester_expires_at", "requester_revoked_at"
      FROM "auth_sessions" s WHERE s."id" = "candidate"."session_id" FOR SHARE;
    IF "requester_user_id" IS DISTINCT FROM NEW."user_id"
       OR "requester_device_id" IS NOT NULL OR "requester_revoked_at" IS NOT NULL
       OR "requester_session_version" IS DISTINCT FROM "candidate"."session_version"
       OR "requester_session_version" IS DISTINCT FROM "owner_session_version" THEN
        RAISE EXCEPTION 'verification admission requires the unchanged current unbound candidate session'
            USING ERRCODE = '23514';
    END IF;

    SELECT i."matrix_user_id", i."bootstrap_device_id", i."bootstrap_sha256"
      INTO "identity_matrix_user_id", "identity_bootstrap_device_id", "identity_bootstrap_sha256"
      FROM "matrix_cross_signing_identities" i WHERE i."user_id" = NEW."user_id" FOR SHARE;
    IF "identity_matrix_user_id" IS DISTINCT FROM "candidate"."matrix_user_id"
       OR "identity_bootstrap_device_id" IS DISTINCT FROM "candidate"."trusted_device_id"
       OR "identity_bootstrap_sha256" IS DISTINCT FROM "candidate"."identity_bootstrap_sha256"
       OR (NEW."request_content"->'from_device') IS DISTINCT FROM to_jsonb("device_matrix_id") THEN
        RAISE EXCEPTION 'verification request sender and candidate pin must match the original trusted identity'
            USING ERRCODE = '23514';
    END IF;

    -- All possibly waiting locks precede this clock. Browser request timestamps
    -- admit bounded drift, but cannot extend any server-owned validity window.
    "checked_at" := clock_timestamp();
    "checked_epoch_ms" := extract(epoch FROM "checked_at") * 1000;
    IF NEW."created_at" > "checked_at"
       OR NEW."created_at" < "candidate"."created_at"
       OR NEW."created_at" < "reviewer_created_at"
       OR NEW."expires_at" <= "checked_at"
       OR NEW."expires_at" > "candidate"."expires_at"
       OR NEW."expires_at" > "reviewer_expires_at"
       OR NEW."expires_at" > "requester_expires_at"
       OR NEW."expires_at" > NEW."created_at" + INTERVAL '10 minutes'
       OR "candidate"."expires_at" <= "checked_at"
       OR "reviewer_expires_at" <= "checked_at"
       OR "requester_expires_at" <= "checked_at"
       OR "timestamp_ms" < "checked_epoch_ms" - 600000
       OR "timestamp_ms" > "checked_epoch_ms" + 300000
       OR extract(epoch FROM NEW."expires_at") * 1000 > "timestamp_ms" + 600000
       OR ("owner_role" = 'CASHIER' AND (
           "subscription_starts_at" > "checked_at"
           OR ("subscription_ends_at" IS NOT NULL AND (
               "subscription_ends_at" <= "checked_at" OR NEW."expires_at" > "subscription_ends_at"
           ))
       )) THEN
        RAISE EXCEPTION 'verification request and both participant sessions must fit the current candidate validity window'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "matrix_device_verification_flows_validation_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "matrix_device_verification_flows"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_matrix_verification_flow"();

CREATE FUNCTION "sinochat_invalidate_matrix_candidate_verification_flow"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "checked_at" TIMESTAMPTZ(6);
BEGIN
    -- The candidate row is already locked by the terminal transition. Take the
    -- flow lock second; no live session/role/subscription is needed to invalidate.
    PERFORM f."candidate_id" FROM "matrix_device_verification_flows" f
     WHERE f."candidate_id" = NEW."id" AND f."user_id" = NEW."user_id" AND f."status" = 'PENDING'
     FOR UPDATE OF f;
    -- A previous flow operation may have held this lock across the deadline.
    -- Classify expiration with the clock after that wait, not at trigger entry.
    "checked_at" := clock_timestamp();
    UPDATE "matrix_device_verification_flows" f
       SET "status" = CASE
               WHEN f."expires_at" <= "checked_at" THEN 'EXPIRED'::"MatrixDeviceVerificationFlowStatus"
               ELSE 'CANCELLED'::"MatrixDeviceVerificationFlowStatus"
           END,
           "resolved_at" = "checked_at"
     WHERE f."candidate_id" = NEW."id" AND f."user_id" = NEW."user_id" AND f."status" = 'PENDING';
    RETURN NEW;
END;
$$;

CREATE TRIGGER "matrix_device_candidates_invalidate_verification_trigger"
AFTER UPDATE OF "status" ON "matrix_device_candidates"
FOR EACH ROW
WHEN (OLD."status" = 'PENDING' AND NEW."status" IN ('CANCELLED', 'EXPIRED'))
EXECUTE FUNCTION "sinochat_invalidate_matrix_candidate_verification_flow"();

COMMENT ON TABLE "matrix_device_verification_flows" IS
    'Immutable admission of one own-bootstrap-to-candidate SAS request. Pending does not mean delivered, verified or authorized; no operational device privileges.';
COMMENT ON COLUMN "matrix_device_verification_flows"."request_content" IS
    'Only the original m.key.verification.request content. Receiver and owner are derived from the immutable candidate; no messages wrapper, secrets or comparison values.';
COMMENT ON COLUMN "matrix_device_verification_flows"."request_sha256" IS
    'Application-validated canonical request hash bound to event type, HTTP transaction, derived sender, pinned master key and exact recipient/content. SQL checks shape, not hash authenticity.';
