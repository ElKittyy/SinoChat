-- Public initial-bootstrap persistence only. This does not relax the compiled
-- E2EE gate or devices_one_historical_device_per_user_key. MatrixDeviceKey's
-- original self-signed JSON and its immutability trigger remain untouched.
-- Cryptographic signature verification and canonical hashes are computed by
-- the application parser; SQL adds binding, shape and append-only defenses.

CREATE TABLE "matrix_cross_signing_identities" (
    "user_id" UUID NOT NULL,
    "matrix_user_id" VARCHAR(289) NOT NULL,
    "bootstrap_device_id" UUID NOT NULL,
    "master_key" CHAR(43) NOT NULL,
    "self_signing_key" CHAR(43) NOT NULL,
    "user_signing_key" CHAR(43) NOT NULL,
    "signing_keys" JSONB NOT NULL,
    "bootstrap_sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "matrix_cross_signing_identities_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "matrix_cross_signing_identities_encoding_check" CHECK (
        "master_key" ~ '^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$'
        AND "self_signing_key" ~ '^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$'
        AND "user_signing_key" ~ '^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$'
        AND "bootstrap_sha256" ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof("signing_keys") = 'object'
        AND octet_length("signing_keys"::text) <= 8192
    ),
    CONSTRAINT "matrix_cross_signing_identities_distinct_keys_check" CHECK (
        "master_key" <> "self_signing_key"
        AND "master_key" <> "user_signing_key"
        AND "self_signing_key" <> "user_signing_key"
    )
);

CREATE TABLE "matrix_device_cross_signings" (
    "device_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "signed_device_keys" JSONB NOT NULL,
    "canonical_sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "matrix_device_cross_signings_pkey" PRIMARY KEY ("device_id"),
    CONSTRAINT "matrix_device_cross_signings_encoding_check" CHECK (
        "canonical_sha256" ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof("signed_device_keys") = 'object'
        AND octet_length("signed_device_keys"::text) <= 4096
    )
);

CREATE UNIQUE INDEX "matrix_cross_signing_identities_matrix_user_key"
    ON "matrix_cross_signing_identities"("matrix_user_id");
CREATE UNIQUE INDEX "matrix_cross_signing_identities_bootstrap_device_key"
    ON "matrix_cross_signing_identities"("bootstrap_device_id");
CREATE UNIQUE INDEX "matrix_cross_signing_identities_bootstrap_owner_key"
    ON "matrix_cross_signing_identities"("bootstrap_device_id", "user_id");
CREATE UNIQUE INDEX "matrix_cross_signing_identities_user_matrix_key"
    ON "matrix_cross_signing_identities"("user_id", "matrix_user_id");
CREATE UNIQUE INDEX "matrix_device_cross_signings_device_owner_key"
    ON "matrix_device_cross_signings"("device_id", "user_id");
CREATE INDEX "matrix_device_cross_signings_user_created_idx"
    ON "matrix_device_cross_signings"("user_id", "created_at");

ALTER TABLE "matrix_cross_signing_identities"
    ADD CONSTRAINT "matrix_cross_signing_identities_list_state_fkey"
        FOREIGN KEY ("user_id", "matrix_user_id")
        REFERENCES "matrix_device_list_states"("user_id", "matrix_user_id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "matrix_cross_signing_identities_bootstrap_device_fkey"
        FOREIGN KEY ("bootstrap_device_id", "user_id")
        REFERENCES "matrix_device_keys"("device_id", "user_id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "matrix_device_cross_signings"
    ADD CONSTRAINT "matrix_device_cross_signings_device_owner_fkey"
        FOREIGN KEY ("device_id", "user_id")
        REFERENCES "matrix_device_keys"("device_id", "user_id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "matrix_device_cross_signings_identity_fkey"
        FOREIGN KEY ("user_id")
        REFERENCES "matrix_cross_signing_identities"("user_id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- Neither half can become visible alone. Insert identity first and certificate
-- second in one transaction. Prisma does not express deferrability, so this
-- clause must be preserved when regenerating or reviewing future migrations.
ALTER TABLE "matrix_cross_signing_identities"
    ADD CONSTRAINT "matrix_cross_signing_identities_bootstrap_certificate_fkey"
        FOREIGN KEY ("bootstrap_device_id", "user_id")
        REFERENCES "matrix_device_cross_signings"("device_id", "user_id")
        ON DELETE RESTRICT ON UPDATE RESTRICT
        DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION "sinochat_cross_signing_exact_object"(
    "value" JSONB,
    "expected_keys" TEXT[]
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    IF jsonb_typeof("value") IS DISTINCT FROM 'object'
       OR "expected_keys" IS NULL OR array_position("expected_keys", NULL) IS NOT NULL THEN
        RETURN FALSE;
    END IF;
    RETURN COALESCE("value" ?& "expected_keys"
        AND "value" - "expected_keys" = '{}'::jsonb, FALSE);
END;
$$;

CREATE FUNCTION "sinochat_cross_signing_signatures_shape"(
    "value" JSONB,
    "matrix_user_id" TEXT,
    "signer_key_ids" TEXT[]
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    "signer_key_id" TEXT;
    "signature" JSONB;
BEGIN
    IF "sinochat_cross_signing_exact_object"("value", ARRAY["matrix_user_id"]) IS NOT TRUE
       OR "sinochat_cross_signing_exact_object"("value"->"matrix_user_id", "signer_key_ids") IS NOT TRUE THEN
        RETURN FALSE;
    END IF;
    FOREACH "signer_key_id" IN ARRAY "signer_key_ids" LOOP
        "signature" := "value"->"matrix_user_id"->"signer_key_id";
        IF jsonb_typeof("signature") IS DISTINCT FROM 'string'
           OR ("signature" #>> '{}') !~ '^[A-Za-z0-9+/]{85}[AQgw]$' THEN
            RETURN FALSE;
        END IF;
    END LOOP;
    RETURN TRUE;
END;
$$;

CREATE FUNCTION "sinochat_cross_signing_key_shape"(
    "value" JSONB,
    "expected_usage" TEXT,
    "public_key" TEXT,
    "matrix_user_id" TEXT,
    "signer_key_ids" TEXT[]
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    RETURN COALESCE("sinochat_cross_signing_exact_object"(
        "value", ARRAY['keys', 'signatures', 'usage', 'user_id']
    ) AND "value"->'keys' = jsonb_build_object('ed25519:' || "public_key", "public_key")
      AND "value"->'usage' = jsonb_build_array("expected_usage")
      AND "value"->'user_id' = to_jsonb("matrix_user_id")
      AND "sinochat_cross_signing_signatures_shape"(
          "value"->'signatures', "matrix_user_id", "signer_key_ids"
      ), FALSE);
END;
$$;

CREATE FUNCTION "sinochat_validate_matrix_cross_signing_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "owner_role" "UserRole";
    "owner_status" "AccountStatus";
    "owner_reset_required" BOOLEAN;
    "device_status" "DeviceStatus";
    "device_protocol" VARCHAR(32);
    "device_matrix_user_id" VARCHAR(289);
    "device_matrix_id" VARCHAR(33);
    "device_ed25519_key" CHAR(43);
    "device_curve25519_key" CHAR(43);
    "device_uploaded_at" TIMESTAMPTZ(6);
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'matrix cross-signing identities are immutable; reset is not supported'
            USING ERRCODE = '23514';
    END IF;

    SELECT u."role", u."status", u."password_reset_required"
      INTO "owner_role", "owner_status", "owner_reset_required"
      FROM "users" u WHERE u."id" = NEW."user_id"
      FOR SHARE;
    IF "owner_role" IS NULL OR "owner_role" NOT IN ('CLIENT', 'CASHIER')
       OR "owner_status" IS DISTINCT FROM 'ACTIVE'
       OR "owner_reset_required" IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION 'cross-signing bootstrap requires an active non-administrator without password reset pending'
            USING ERRCODE = '23514';
    END IF;

    SELECT d."status", d."protocol_version", k."matrix_user_id", k."matrix_device_id",
           k."ed25519_key", k."curve25519_key", k."uploaded_at"
      INTO "device_status", "device_protocol", "device_matrix_user_id", "device_matrix_id",
           "device_ed25519_key", "device_curve25519_key", "device_uploaded_at"
      FROM "devices" d
      JOIN "matrix_device_keys" k ON k."device_id" = d."id" AND k."user_id" = d."user_id"
     WHERE d."id" = NEW."bootstrap_device_id" AND d."user_id" = NEW."user_id"
     FOR SHARE OF d, k;
    IF "device_status" IS DISTINCT FROM 'ACTIVE'
       OR "device_protocol" IS DISTINCT FROM 'matrix-olm-v1'
       OR "device_matrix_user_id" IS DISTINCT FROM NEW."matrix_user_id"
       OR NEW."created_at" < "device_uploaded_at"
       OR (SELECT count(*) FROM "devices" WHERE "user_id" = NEW."user_id") <> 1 THEN
        RAISE EXCEPTION 'cross-signing bootstrap requires the sole historical active Matrix device owned by the user'
            USING ERRCODE = '23514';
    END IF;
    IF "device_ed25519_key" IN (NEW."master_key", NEW."self_signing_key", NEW."user_signing_key")
       OR "device_curve25519_key" IN (NEW."master_key", NEW."self_signing_key", NEW."user_signing_key") THEN
        RAISE EXCEPTION 'cross-signing public keys must not reuse device keys'
            USING ERRCODE = '23514';
    END IF;

    IF NOT "sinochat_cross_signing_exact_object"(
        NEW."signing_keys", ARRAY['master_key', 'self_signing_key', 'user_signing_key']
    ) OR NOT "sinochat_cross_signing_key_shape"(
        NEW."signing_keys"->'master_key', 'master', NEW."master_key", NEW."matrix_user_id",
        ARRAY['ed25519:' || "device_matrix_id", 'ed25519:' || NEW."master_key"]
    ) OR NOT "sinochat_cross_signing_key_shape"(
        NEW."signing_keys"->'self_signing_key', 'self_signing', NEW."self_signing_key", NEW."matrix_user_id",
        ARRAY['ed25519:' || NEW."master_key"]
    ) OR NOT "sinochat_cross_signing_key_shape"(
        NEW."signing_keys"->'user_signing_key', 'user_signing', NEW."user_signing_key", NEW."matrix_user_id",
        ARRAY['ed25519:' || NEW."master_key"]
    ) THEN
        RAISE EXCEPTION 'cross-signing identity must contain only the bound public bootstrap profile'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "matrix_cross_signing_identities_validation_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "matrix_cross_signing_identities"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_matrix_cross_signing_identity"();

CREATE FUNCTION "sinochat_validate_matrix_device_cross_signing"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "bootstrap_device_id" UUID;
    "matrix_user_id" VARCHAR(289);
    "self_signing_key" CHAR(43);
    "identity_created_at" TIMESTAMPTZ(6);
    "original_device_keys" JSONB;
    "matrix_device_id" VARCHAR(33);
    "device_status" "DeviceStatus";
    "device_protocol" VARCHAR(32);
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'matrix device cross-signing certificates are immutable'
            USING ERRCODE = '23514';
    END IF;

    SELECT i."bootstrap_device_id", i."matrix_user_id", i."self_signing_key", i."created_at"
      INTO "bootstrap_device_id", "matrix_user_id", "self_signing_key", "identity_created_at"
      FROM "matrix_cross_signing_identities" i WHERE i."user_id" = NEW."user_id"
      FOR SHARE;
    IF "bootstrap_device_id" IS DISTINCT FROM NEW."device_id"
       OR NEW."created_at" < "identity_created_at" THEN
        RAISE EXCEPTION 'only the initial cross-signing bootstrap device can be certified; further authorization is not implemented'
            USING ERRCODE = '23514';
    END IF;

    SELECT k."device_keys", k."matrix_device_id", d."status", d."protocol_version"
      INTO "original_device_keys", "matrix_device_id", "device_status", "device_protocol"
      FROM "matrix_device_keys" k
      JOIN "devices" d ON d."id" = k."device_id" AND d."user_id" = k."user_id"
     WHERE k."device_id" = NEW."device_id" AND k."user_id" = NEW."user_id"
     FOR SHARE OF k, d;
    IF "device_status" IS DISTINCT FROM 'ACTIVE'
       OR "device_protocol" IS DISTINCT FROM 'matrix-olm-v1'
       OR NOT "sinochat_cross_signing_exact_object"(
           NEW."signed_device_keys", ARRAY['algorithms', 'device_id', 'keys', 'signatures', 'user_id']
       )
       OR NEW."signed_device_keys" - 'signatures' IS DISTINCT FROM "original_device_keys" - 'signatures'
       OR NOT "sinochat_cross_signing_signatures_shape"(
           NEW."signed_device_keys"->'signatures', "matrix_user_id",
           ARRAY['ed25519:' || "matrix_device_id", 'ed25519:' || "self_signing_key"]
       )
       OR NEW."signed_device_keys"->'signatures'->"matrix_user_id"->('ed25519:' || "matrix_device_id")
          IS DISTINCT FROM "original_device_keys"->'signatures'->"matrix_user_id"->('ed25519:' || "matrix_device_id") THEN
        RAISE EXCEPTION 'cross-signing certificate must preserve the registered device identity and original self-signature'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "matrix_device_cross_signings_validation_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "matrix_device_cross_signings"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_matrix_device_cross_signing"();

COMMENT ON COLUMN "matrix_cross_signing_identities"."bootstrap_sha256" IS
    'Immutable canonical SHA-256 of validated {signingKeys, signedDeviceKeys}; used for exact replay, not as a trust root.';
COMMENT ON TABLE "matrix_cross_signing_identities" IS
    'Public-only immutable first-device bootstrap. No private keys, administrative reset, or second-device authorization.';
COMMENT ON TABLE "matrix_device_cross_signings" IS
    'Certified copy preserving the original immutable matrix_device_keys registration object.';
