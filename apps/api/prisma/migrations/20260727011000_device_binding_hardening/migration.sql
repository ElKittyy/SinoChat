-- Device binding secrets cannot be backfilled safely: the plaintext credential
-- must be delivered exactly once to its owner. Fail closed if an environment
-- already contains devices so the operator must perform an explicit ceremony
-- instead of silently creating unrecoverable credentials.
DO $sinochat$
BEGIN
    IF EXISTS (SELECT 1 FROM "devices") THEN
        RAISE EXCEPTION
            'device binding hardening requires an empty devices table; migrate existing devices through an explicit user ceremony'
            USING ERRCODE = '23514';
    END IF;
END;
$sinochat$;

ALTER TABLE "devices"
    ADD COLUMN "binding_secret_hash" CHAR(64) NOT NULL,
    ADD CONSTRAINT "devices_binding_secret_hash_check"
        CHECK ("binding_secret_hash" ~ '^[0-9a-f]{64}$');

-- This is intentionally stricter than the future multi-device model. It
-- prevents every second registration, including after revocation, until the
-- E2EE ADR defines signed-device approval or a safe recovery ceremony.
CREATE UNIQUE INDEX "devices_one_historical_device_per_user_key"
    ON "devices"("user_id");

-- A session can only be newly linked to an active device of the same account.
-- A later device revocation may leave the historical reference in place while
-- the session itself is revoked.
CREATE OR REPLACE FUNCTION "sinochat_enforce_owned_device_reference"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "candidate_device_id" UUID;
BEGIN
    "candidate_device_id" := CASE
        WHEN TG_TABLE_NAME = 'auth_sessions' THEN NEW."device_id"
        ELSE NEW."source_device_id"
    END;

    IF "candidate_device_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
             FROM "devices"
            WHERE "id" = "candidate_device_id"
              AND "user_id" = NEW."user_id"
              AND (
                  TG_TABLE_NAME <> 'auth_sessions'
                  OR "status" = 'ACTIVE'
              )
       ) THEN
        RAISE EXCEPTION
            'referenced active device must belong to the same user'
            USING ERRCODE = '23514';
    END IF;

    IF TG_TABLE_NAME = 'auth_sessions' THEN
        IF "candidate_device_id" IS NOT NULL
           AND (
               NEW."revoked_at" IS NOT NULL
               OR NEW."expires_at" <= clock_timestamp()
           ) THEN
            RAISE EXCEPTION
                'only a current session may be linked to a device'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- The HMAC digest is part of the immutable device identity. Rotation or
-- replacement requires the future signed approval/recovery ceremony.
CREATE OR REPLACE FUNCTION "sinochat_enforce_device_key_history"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."user_id" <> OLD."user_id"
       OR NEW."registration_id" <> OLD."registration_id"
       OR NEW."identity_public_key" <> OLD."identity_public_key"
       OR NEW."identity_key_fingerprint" <> OLD."identity_key_fingerprint"
       OR NEW."signed_pre_key_id" <> OLD."signed_pre_key_id"
       OR NEW."signed_pre_key_public" <> OLD."signed_pre_key_public"
       OR NEW."signed_pre_key_signature" <> OLD."signed_pre_key_signature"
       OR NEW."binding_secret_hash" <> OLD."binding_secret_hash"
       OR NEW."protocol_version" <> OLD."protocol_version"
       OR NEW."created_at" <> OLD."created_at"
       OR (OLD."status" = 'REVOKED' AND NEW."status" <> 'REVOKED')
       OR (
           OLD."revoked_at" IS NOT NULL
           AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
       )
       OR (NEW."status" = 'REVOKED' AND NEW."revoked_at" IS NULL) THEN
        RAISE EXCEPTION 'device cryptographic identity is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
