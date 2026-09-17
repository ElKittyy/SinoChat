-- Public, non-operational candidate reservations only. This migration does not
-- create Device rows, publish keys, bind sessions, authorize a SAS ceremony or
-- relax devices_one_historical_device_per_user_key / bootstrap certificates.
-- The application verifies signatures, strong points and canonical hashes;
-- these SQL defenses bind the immutable public snapshot to current authority.

CREATE TYPE "MatrixDeviceCandidateStatus" AS ENUM ('PENDING', 'CANCELLED', 'EXPIRED');

CREATE TABLE "matrix_device_candidates" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "session_version" INTEGER NOT NULL,
    "matrix_user_id" VARCHAR(289) NOT NULL,
    "matrix_device_id" VARCHAR(33) NOT NULL,
    "trusted_device_id" UUID NOT NULL,
    "identity_bootstrap_sha256" CHAR(64) NOT NULL,
    "device_keys" JSONB NOT NULL,
    "canonical_sha256" CHAR(64) NOT NULL,
    "ed25519_key" CHAR(43) NOT NULL,
    "curve25519_key" CHAR(43) NOT NULL,
    "status" "MatrixDeviceCandidateStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "resolved_at" TIMESTAMPTZ(6),
    CONSTRAINT "matrix_device_candidates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "matrix_device_candidates_namespace_check" CHECK ((
        "id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND "id" <> "trusted_device_id"
        AND "matrix_device_id" = 'D' || upper(replace("id"::text, '-', ''))
        AND "matrix_user_id" ~ '^@u[0-9a-f]{32}:[^[:space:]/@]{1,255}$'
        AND "matrix_user_id" LIKE '@u' || replace("user_id"::text, '-', '') || ':%'
        AND "session_version" > 0
    ) IS TRUE),
    CONSTRAINT "matrix_device_candidates_encoding_check" CHECK ((
        "identity_bootstrap_sha256" ~ '^[0-9a-f]{64}$'
        AND "canonical_sha256" ~ '^[0-9a-f]{64}$'
        AND "ed25519_key" ~ '^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$'
        AND "curve25519_key" ~ '^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$'
        AND "ed25519_key" <> "curve25519_key"
        AND jsonb_typeof("device_keys") = 'object'
        AND octet_length("device_keys"::text) <= 4096
    ) IS TRUE),
    CONSTRAINT "matrix_device_candidates_window_check" CHECK ((
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
    ) IS TRUE),
    CONSTRAINT "matrix_device_candidates_public_snapshot_check" CHECK ((
        "sinochat_cross_signing_exact_object"(
            "device_keys", ARRAY['algorithms', 'device_id', 'keys', 'signatures', 'user_id']
        )
        AND "device_keys"->'user_id' = to_jsonb("matrix_user_id")
        AND "device_keys"->'device_id' = to_jsonb("matrix_device_id")
        AND "device_keys"->'algorithms' = jsonb_build_array(
            'm.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'
        )
        AND "device_keys"->'keys' = jsonb_build_object(
            'ed25519:' || "matrix_device_id", "ed25519_key",
            'curve25519:' || "matrix_device_id", "curve25519_key"
        )
        AND "sinochat_cross_signing_signatures_shape"(
            "device_keys"->'signatures', "matrix_user_id", ARRAY['ed25519:' || "matrix_device_id"]
        )
    ) IS TRUE)
);

CREATE UNIQUE INDEX "matrix_device_candidates_matrix_device_key"
    ON "matrix_device_candidates"("matrix_device_id");
-- A bounded ceremony queue, not an account/device/customer commercial quota.
-- Expiration is explicit; wall-clock functions must not enter this predicate.
CREATE UNIQUE INDEX "matrix_device_candidates_one_pending_user_key"
    ON "matrix_device_candidates"("user_id") WHERE "status" = 'PENDING';
CREATE INDEX "matrix_device_candidates_user_pending_idx"
    ON "matrix_device_candidates"("user_id", "status", "expires_at");
CREATE INDEX "matrix_device_candidates_session_idx"
    ON "matrix_device_candidates"("session_id");

ALTER TABLE "matrix_device_candidates"
    ADD CONSTRAINT "matrix_device_candidates_session_id_fkey"
        FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "matrix_device_candidates_user_id_matrix_user_id_fkey"
        FOREIGN KEY ("user_id", "matrix_user_id")
        REFERENCES "matrix_cross_signing_identities"("user_id", "matrix_user_id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "matrix_device_candidates_trusted_device_id_user_id_fkey"
        FOREIGN KEY ("trusted_device_id", "user_id")
        REFERENCES "matrix_device_keys"("device_id", "user_id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "sinochat_validate_matrix_device_candidate"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "checked_at" TIMESTAMPTZ(6);
    "owner_role" "UserRole";
    "owner_status" "AccountStatus";
    "owner_reset_required" BOOLEAN;
    "owner_session_version" INTEGER;
    "session_user_id" UUID;
    "session_device_id" UUID;
    "session_version" INTEGER;
    "session_created_at" TIMESTAMPTZ(6);
    "session_expires_at" TIMESTAMPTZ(6);
    "session_revoked_at" TIMESTAMPTZ(6);
    "cashier_user_id" UUID;
    "subscription_starts_at" TIMESTAMPTZ(6);
    "subscription_ends_at" TIMESTAMPTZ(6);
    "identity_matrix_user_id" VARCHAR(289);
    "identity_bootstrap_device_id" UUID;
    "identity_bootstrap_sha256" CHAR(64);
    "identity_created_at" TIMESTAMPTZ(6);
    "identity_master_key" CHAR(43);
    "identity_self_signing_key" CHAR(43);
    "identity_user_signing_key" CHAR(43);
    "device_status" "DeviceStatus";
    "device_protocol" VARCHAR(32);
    "device_matrix_user_id" VARCHAR(289);
    "certificate_device_id" UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'candidate tombstones cannot be deleted or their identifiers reused; cleanup requires a separate retention design'
            USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF (to_jsonb(NEW) - ARRAY['status', 'resolved_at'])
                IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'resolved_at'])
           OR OLD."status" IS DISTINCT FROM 'PENDING'
           OR OLD."resolved_at" IS NOT NULL
           OR NEW."status" NOT IN ('CANCELLED', 'EXPIRED')
           OR NEW."resolved_at" IS NULL THEN
            RAISE EXCEPTION 'candidate public identity is immutable and terminal states cannot be reopened'
                USING ERRCODE = '23514';
        END IF;
        "checked_at" := clock_timestamp();
        IF NEW."resolved_at" > "checked_at" THEN
            RAISE EXCEPTION 'candidate resolution cannot be future-dated'
                USING ERRCODE = '23514';
        END IF;
        -- Maintenance must be able to invalidate a candidate after logout,
        -- subscription expiry or revocation. Never require live authority here.
        -- Date/order and exact snapshot constraints still apply to every UPDATE.
        RETURN NEW;
    END IF;

    IF NEW."status" IS DISTINCT FROM 'PENDING' OR NEW."resolved_at" IS NOT NULL THEN
        RAISE EXCEPTION 'candidate reservations must begin pending and unconsumed'
            USING ERRCODE = '23514';
    END IF;

    -- Same lock as initial registration, binding, cross-signing and revocation.
    -- The service obtains it before expiring prior pending rows as well.
    PERFORM pg_advisory_xact_lock(hashtextextended('sinochat:devices:' || NEW."user_id"::text, 0));

    SELECT u."role", u."status", u."password_reset_required", u."session_version"
      INTO "owner_role", "owner_status", "owner_reset_required", "owner_session_version"
      FROM "users" u WHERE u."id" = NEW."user_id"
      FOR SHARE;
    IF "owner_role" IS NULL OR "owner_role" NOT IN ('CLIENT', 'CASHIER')
       OR "owner_status" IS DISTINCT FROM 'ACTIVE'
       OR "owner_reset_required" IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION 'candidate reservations require an active non-administrator without password reset pending'
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
            RAISE EXCEPTION 'cashier candidate reservations require administrative approval and an active subscription'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    SELECT s."user_id", s."device_id", s."session_version", s."created_at", s."expires_at", s."revoked_at"
      INTO "session_user_id", "session_device_id", "session_version", "session_created_at", "session_expires_at", "session_revoked_at"
      FROM "auth_sessions" s WHERE s."id" = NEW."session_id"
      FOR SHARE;
    IF "session_user_id" IS DISTINCT FROM NEW."user_id"
       OR "session_device_id" IS NOT NULL OR "session_revoked_at" IS NOT NULL
       OR "session_version" IS DISTINCT FROM NEW."session_version"
       OR "session_version" IS DISTINCT FROM "owner_session_version" THEN
        RAISE EXCEPTION 'candidate reservations require the current unbound session and session version of their owner'
            USING ERRCODE = '23514';
    END IF;

    SELECT i."matrix_user_id", i."bootstrap_device_id", i."bootstrap_sha256", i."created_at",
           i."master_key", i."self_signing_key", i."user_signing_key",
           d."status", d."protocol_version", k."matrix_user_id", c."device_id"
      INTO "identity_matrix_user_id", "identity_bootstrap_device_id", "identity_bootstrap_sha256", "identity_created_at",
           "identity_master_key", "identity_self_signing_key", "identity_user_signing_key",
           "device_status", "device_protocol", "device_matrix_user_id", "certificate_device_id"
      FROM "matrix_cross_signing_identities" i
      JOIN "matrix_device_keys" k ON k."device_id" = i."bootstrap_device_id" AND k."user_id" = i."user_id"
      JOIN "devices" d ON d."id" = k."device_id" AND d."user_id" = k."user_id"
      JOIN "matrix_device_cross_signings" c ON c."device_id" = k."device_id" AND c."user_id" = k."user_id"
     WHERE i."user_id" = NEW."user_id"
     FOR SHARE OF i, k, d, c;
    IF "identity_matrix_user_id" IS DISTINCT FROM NEW."matrix_user_id"
       OR "device_matrix_user_id" IS DISTINCT FROM NEW."matrix_user_id"
       OR "identity_bootstrap_device_id" IS DISTINCT FROM NEW."trusted_device_id"
       OR "certificate_device_id" IS DISTINCT FROM NEW."trusted_device_id"
       OR "identity_bootstrap_sha256" IS DISTINCT FROM NEW."identity_bootstrap_sha256"
       OR "device_status" IS DISTINCT FROM 'ACTIVE'
       OR "device_protocol" IS DISTINCT FROM 'matrix-olm-v1' THEN
        RAISE EXCEPTION 'candidate reservations require the unchanged pinned identity and its active certified bootstrap device'
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (SELECT 1 FROM "devices" WHERE "id" = NEW."id")
       OR EXISTS (SELECT 1 FROM "matrix_device_registrations" WHERE "id" = NEW."id") THEN
        RAISE EXCEPTION 'candidate identifiers cannot reuse an operational or initial-registration identifier'
            USING ERRCODE = '23514';
    END IF;

    IF NEW."ed25519_key" IN ("identity_master_key", "identity_self_signing_key", "identity_user_signing_key")
       OR NEW."curve25519_key" IN ("identity_master_key", "identity_self_signing_key", "identity_user_signing_key")
       OR EXISTS (
           SELECT 1 FROM "matrix_device_keys" k
            WHERE k."ed25519_key" IN (NEW."ed25519_key", NEW."curve25519_key")
               OR k."curve25519_key" IN (NEW."ed25519_key", NEW."curve25519_key")
       ) THEN
        RAISE EXCEPTION 'candidate public keys must not reuse the pinned identity or operational device keys'
            USING ERRCODE = '23514';
    END IF;

    -- Acquire a fresh clock after all potentially waiting locks. These locks
    -- prevent concurrent invalidation, not the passage of time. The service
    -- must recheck the clock before transaction completion as well.
    "checked_at" := clock_timestamp();
    IF NEW."created_at" > "checked_at"
       OR NEW."created_at" < "session_created_at"
       OR NEW."created_at" < "identity_created_at"
       OR NEW."expires_at" <= "checked_at"
       OR NEW."expires_at" > "session_expires_at"
       OR "session_expires_at" <= "checked_at"
       OR ("owner_role" = 'CASHIER' AND (
           "subscription_starts_at" > "checked_at"
           OR ("subscription_ends_at" IS NOT NULL AND (
               "subscription_ends_at" <= "checked_at" OR NEW."expires_at" > "subscription_ends_at"
           ))
       )) THEN
        RAISE EXCEPTION 'candidate reservation must fit its current session and subscription validity window'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "matrix_device_candidates_validation_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "matrix_device_candidates"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_matrix_device_candidate"();

COMMENT ON TABLE "matrix_device_candidates" IS
    'Non-operational public quarantine and terminal anti-replay tombstones. No approval, promotion, SAS transport, private secrets or conversation access.';
COMMENT ON COLUMN "matrix_device_candidates"."identity_bootstrap_sha256" IS
    'Exact immutable bootstrap snapshot already pinned by the server; not a certificate or proof of human approval.';
COMMENT ON COLUMN "matrix_device_candidates"."canonical_sha256" IS
    'Canonical SHA-256 of the strictly validated original self-signed candidate device_keys; computed and checked by the application.';
