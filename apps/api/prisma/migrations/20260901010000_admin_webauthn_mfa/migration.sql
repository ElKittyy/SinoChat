-- MFA resistente a phishing para la cuenta administrativa. Los desafíos se
-- conservan únicamente como SHA-256 y las claves privadas nunca llegan al
-- servidor.

CREATE TYPE "AdminWebAuthnChallengePurpose" AS ENUM (
  'REGISTRATION',
  'AUTHENTICATION'
);

ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_PASSKEY_REGISTERED';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_MFA_RECOVERED';

ALTER TABLE "users"
  ADD COLUMN "admin_webauthn_user_handle" BYTEA;

CREATE UNIQUE INDEX "users_admin_webauthn_user_handle_key"
  ON "users" ("admin_webauthn_user_handle")
  WHERE "admin_webauthn_user_handle" IS NOT NULL;

ALTER TABLE "auth_sessions"
  ADD COLUMN "admin_mfa_verified_at" TIMESTAMPTZ(6);

ALTER TABLE "auth_sessions"
  ADD CONSTRAINT "auth_sessions_admin_mfa_time_check"
  CHECK (
    "admin_mfa_verified_at" IS NULL
    OR (
      "admin_mfa_verified_at" >= "created_at"
      AND "admin_mfa_verified_at" < "expires_at"
    )
  );

CREATE TABLE "admin_webauthn_credentials" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "admin_user_id" UUID NOT NULL,
  "credential_id" VARCHAR(1024) NOT NULL,
  "public_key" BYTEA NOT NULL,
  "counter" BIGINT NOT NULL DEFAULT 0,
  "transports" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "device_type" VARCHAR(16) NOT NULL,
  "backed_up" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),

  CONSTRAINT "admin_webauthn_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_webauthn_credentials_credential_key" UNIQUE ("credential_id"),
  CONSTRAINT "admin_webauthn_credentials_admin_fkey"
    FOREIGN KEY ("admin_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "admin_webauthn_credentials_id_format_check"
    CHECK (
      char_length("credential_id") BETWEEN 16 AND 1024
      AND "credential_id" ~ '^[A-Za-z0-9_-]+$'
    ),
  CONSTRAINT "admin_webauthn_credentials_public_key_check"
    CHECK (octet_length("public_key") BETWEEN 32 AND 4096),
  CONSTRAINT "admin_webauthn_credentials_counter_check"
    CHECK ("counter" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "admin_webauthn_credentials_device_type_check"
    CHECK ("device_type" IN ('singleDevice', 'multiDevice')),
  CONSTRAINT "admin_webauthn_credentials_transports_check"
    CHECK (
      "transports" <@ ARRAY[
        'ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'
      ]::TEXT[]
      AND cardinality("transports") <= 7
    ),
  CONSTRAINT "admin_webauthn_credentials_time_check"
    CHECK (
      ("last_used_at" IS NULL OR "last_used_at" >= "created_at")
      AND ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
    )
);

CREATE INDEX "admin_webauthn_credentials_admin_active_idx"
  ON "admin_webauthn_credentials" ("admin_user_id", "revoked_at");

CREATE TABLE "admin_webauthn_challenges" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "admin_user_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "purpose" "AdminWebAuthnChallengePurpose" NOT NULL,
  "challenge_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "consumed_at" TIMESTAMPTZ(6),

  CONSTRAINT "admin_webauthn_challenges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_webauthn_challenges_hash_key" UNIQUE ("challenge_hash"),
  CONSTRAINT "admin_webauthn_challenges_admin_fkey"
    FOREIGN KEY ("admin_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "admin_webauthn_challenges_session_fkey"
    FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "admin_webauthn_challenges_hash_format_check"
    CHECK ("challenge_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "admin_webauthn_challenges_time_check"
    CHECK (
      "expires_at" > "created_at"
      AND "expires_at" <= "created_at" + INTERVAL '10 minutes'
      AND ("consumed_at" IS NULL OR "consumed_at" >= "created_at")
    )
);

CREATE UNIQUE INDEX "admin_webauthn_challenges_one_open_per_session_key"
  ON "admin_webauthn_challenges" ("session_id", "purpose")
  WHERE "consumed_at" IS NULL;

CREATE INDEX "admin_webauthn_challenges_admin_expiry_idx"
  ON "admin_webauthn_challenges" (
    "admin_user_id", "purpose", "expires_at"
  );

CREATE INDEX "admin_webauthn_challenges_expiry_idx"
  ON "admin_webauthn_challenges" ("expires_at", "consumed_at");

CREATE TABLE "admin_recovery_codes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "admin_user_id" UUID NOT NULL,
  "code_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "used_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),

  CONSTRAINT "admin_recovery_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_recovery_codes_hash_key" UNIQUE ("code_hash"),
  CONSTRAINT "admin_recovery_codes_admin_fkey"
    FOREIGN KEY ("admin_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "admin_recovery_codes_hash_format_check"
    CHECK ("code_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "admin_recovery_codes_time_check"
    CHECK (
      ("used_at" IS NULL OR "used_at" >= "created_at")
      AND ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
      AND NOT ("used_at" IS NOT NULL AND "revoked_at" IS NOT NULL)
    )
);

CREATE INDEX "admin_recovery_codes_available_idx"
  ON "admin_recovery_codes" ("admin_user_id", "used_at", "revoked_at");

CREATE OR REPLACE FUNCTION enforce_admin_webauthn_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_role "UserRole";
  session_owner UUID;
BEGIN
  SELECT "role" INTO owner_role
    FROM "users"
   WHERE "id" = NEW."admin_user_id"
   FOR KEY SHARE;

  IF owner_role IS DISTINCT FROM 'ADMIN'::"UserRole" THEN
    RAISE EXCEPTION 'ADMIN_WEBAUTHN_OWNER_REQUIRED' USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'admin_webauthn_challenges' THEN
    SELECT "user_id" INTO session_owner
      FROM "auth_sessions"
     WHERE "id" = NEW."session_id"
     FOR KEY SHARE;
    IF session_owner IS DISTINCT FROM NEW."admin_user_id" THEN
      RAISE EXCEPTION 'ADMIN_WEBAUTHN_SESSION_OWNER_MISMATCH'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "admin_webauthn_credentials_owner_guard"
BEFORE INSERT OR UPDATE OF "admin_user_id"
ON "admin_webauthn_credentials"
FOR EACH ROW EXECUTE FUNCTION enforce_admin_webauthn_owner();

CREATE TRIGGER "admin_webauthn_challenges_owner_guard"
BEFORE INSERT OR UPDATE OF "admin_user_id", "session_id"
ON "admin_webauthn_challenges"
FOR EACH ROW EXECUTE FUNCTION enforce_admin_webauthn_owner();

CREATE TRIGGER "admin_recovery_codes_owner_guard"
BEFORE INSERT OR UPDATE OF "admin_user_id"
ON "admin_recovery_codes"
FOR EACH ROW EXECUTE FUNCTION enforce_admin_webauthn_owner();

CREATE OR REPLACE FUNCTION enforce_admin_mfa_session_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_role "UserRole";
BEGIN
  IF NEW."admin_mfa_verified_at" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "role" INTO owner_role
    FROM "users"
   WHERE "id" = NEW."user_id"
   FOR KEY SHARE;
  IF owner_role IS DISTINCT FROM 'ADMIN'::"UserRole" THEN
    RAISE EXCEPTION 'ADMIN_MFA_SESSION_ROLE_REQUIRED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "auth_sessions_admin_mfa_role_guard"
BEFORE INSERT OR UPDATE OF "user_id", "admin_mfa_verified_at"
ON "auth_sessions"
FOR EACH ROW EXECUTE FUNCTION enforce_admin_mfa_session_state();

CREATE OR REPLACE FUNCTION enforce_admin_webauthn_user_handle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."admin_webauthn_user_handle" IS NOT NULL THEN
    IF NEW."role" IS DISTINCT FROM 'ADMIN'::"UserRole" THEN
      RAISE EXCEPTION 'ADMIN_WEBAUTHN_HANDLE_ROLE_REQUIRED'
        USING ERRCODE = '23514';
    END IF;
    IF octet_length(NEW."admin_webauthn_user_handle") <> 32 THEN
      RAISE EXCEPTION 'ADMIN_WEBAUTHN_HANDLE_LENGTH_INVALID'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "users_admin_webauthn_handle_guard"
BEFORE INSERT OR UPDATE OF "role", "admin_webauthn_user_handle"
ON "users"
FOR EACH ROW EXECUTE FUNCTION enforce_admin_webauthn_user_handle();
