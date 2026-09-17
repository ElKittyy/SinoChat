BEGIN;

-- Rows created before this release used AES-GCM without AAD. Record that fact
-- explicitly: decryption never guesses a format after an authentication error.
-- Keep the database default at 0 during the compatibility phase so an older
-- writer can never create ciphertext without AAD mislabeled as format 1. New
-- binaries always write 1 explicitly.
ALTER TABLE "cashier_invitations"
  ADD COLUMN "cipher_format_version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "cashier_onboarding_invitations"
  ADD COLUMN "cipher_format_version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "cashier_invitations"
  ADD CONSTRAINT "cashier_invitations_cipher_format_check"
    CHECK ("cipher_format_version" IN (0, 1));

ALTER TABLE "cashier_onboarding_invitations"
  ADD CONSTRAINT "cashier_onboarding_invitations_cipher_format_check"
    CHECK ("cipher_format_version" IN (0, 1));

CREATE OR REPLACE FUNCTION "sinochat_enforce_cashier_onboarding_invitation_history"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."created_by_admin_user_id" <> OLD."created_by_admin_user_id"
       OR NEW."code_lookup_hash" <> OLD."code_lookup_hash"
       OR NEW."code_ciphertext" <> OLD."code_ciphertext"
       OR NEW."code_nonce" <> OLD."code_nonce"
       OR NEW."encryption_key_version" <> OLD."encryption_key_version"
       OR NEW."cipher_format_version" <> OLD."cipher_format_version"
       OR NEW."created_at" <> OLD."created_at"
       OR NEW."expires_at" <> OLD."expires_at"
       OR (
           OLD."redeemed_at" IS NOT NULL
           AND (
               NEW."redeemed_at" IS DISTINCT FROM OLD."redeemed_at"
               OR NEW."redeemed_by_cashier_id" IS DISTINCT FROM OLD."redeemed_by_cashier_id"
           )
       )
       OR (
           OLD."revoked_at" IS NOT NULL
           AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
       ) THEN
        RAISE EXCEPTION 'cashier onboarding invitation history is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "sinochat_enforce_invitation_history"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."cashier_user_id" <> OLD."cashier_user_id"
       OR NEW."code_lookup_hash" <> OLD."code_lookup_hash"
       OR NEW."code_ciphertext" <> OLD."code_ciphertext"
       OR NEW."code_nonce" <> OLD."code_nonce"
       OR NEW."encryption_key_version" <> OLD."encryption_key_version"
       OR NEW."cipher_format_version" <> OLD."cipher_format_version"
       OR NEW."created_at" <> OLD."created_at"
       OR (
           OLD."revoked_at" IS NOT NULL
           AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
       ) THEN
        RAISE EXCEPTION 'invitation history is immutable except for first revocation'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
