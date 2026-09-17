-- Makes first-device completion safely replayable after an HTTP response loss.
-- Existing consumed registrations remain valid legacy rows but cannot acquire
-- replay metadata because the base immutability trigger rejects a second update.
ALTER TABLE "matrix_device_registrations"
    ADD COLUMN "initial_upload_sha256" CHAR(64),
    ADD COLUMN "initial_one_time_key_count" INTEGER,
    ADD CONSTRAINT "matrix_device_registrations_replay_snapshot_check" CHECK (
        (
            "initial_upload_sha256" IS NULL
            AND "initial_one_time_key_count" IS NULL
        )
        OR (
            "consumed_at" IS NOT NULL
            AND "initial_upload_sha256" ~ '^[0-9a-f]{64}$'
            AND "initial_one_time_key_count" BETWEEN 0 AND 100
        )
    );

COMMENT ON COLUMN "matrix_device_registrations"."initial_upload_sha256" IS
    'Canonical SHA-256 of the exact initial Rust Crypto upload; immutable after consumption.';
COMMENT ON COLUMN "matrix_device_registrations"."initial_one_time_key_count" IS
    'Frozen signed_curve25519 count returned by the first successful completion.';
