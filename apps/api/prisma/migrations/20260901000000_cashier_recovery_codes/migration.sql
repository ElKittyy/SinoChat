CREATE TABLE "cashier_recovery_codes" (
  "id" UUID NOT NULL,
  "cashier_user_id" UUID NOT NULL,
  "code_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6),
  "used_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),

  CONSTRAINT "cashier_recovery_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cashier_recovery_codes_hash_format_check"
    CHECK ("code_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "cashier_recovery_codes_expiry_check"
    CHECK ("expires_at" IS NULL OR "expires_at" > "created_at"),
  CONSTRAINT "cashier_recovery_codes_used_window_check"
    CHECK (
      "used_at" IS NULL OR
      (
        "used_at" >= "created_at" AND
        ("expires_at" IS NULL OR "used_at" <= "expires_at")
      )
    ),
  CONSTRAINT "cashier_recovery_codes_revoked_window_check"
    CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
);

CREATE UNIQUE INDEX "cashier_recovery_codes_hash_key"
  ON "cashier_recovery_codes"("code_hash");
CREATE UNIQUE INDEX "cashier_recovery_codes_id_cashier_key"
  ON "cashier_recovery_codes"("id", "cashier_user_id");
CREATE INDEX "cashier_recovery_codes_available_idx"
  ON "cashier_recovery_codes"(
    "cashier_user_id",
    "used_at",
    "revoked_at",
    "expires_at"
  );

ALTER TABLE "cashier_recovery_codes"
  ADD CONSTRAINT "cashier_recovery_codes_cashier_user_id_fkey"
  FOREIGN KEY ("cashier_user_id") REFERENCES "cashier_profiles"("user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "cashier_password_resets" (
  "id" UUID NOT NULL,
  "cashier_user_id" UUID NOT NULL,
  "initiated_by_admin_user_id" UUID NOT NULL,
  "recovery_code_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "consumed_at" TIMESTAMPTZ(6),
  "superseded_at" TIMESTAMPTZ(6),

  CONSTRAINT "cashier_password_resets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cashier_password_resets_expiry_check"
    CHECK ("expires_at" > "created_at"),
  CONSTRAINT "cashier_password_resets_consumption_check"
    CHECK (
      ("consumed_at" IS NULL AND "recovery_code_id" IS NULL) OR
      (
        "consumed_at" IS NOT NULL AND
        "recovery_code_id" IS NOT NULL AND
        "consumed_at" >= "created_at" AND
        "consumed_at" <= "expires_at"
      )
    ),
  CONSTRAINT "cashier_password_resets_terminal_state_check"
    CHECK ("consumed_at" IS NULL OR "superseded_at" IS NULL),
  CONSTRAINT "cashier_password_resets_superseded_window_check"
    CHECK ("superseded_at" IS NULL OR "superseded_at" >= "created_at")
);

CREATE UNIQUE INDEX "cashier_password_resets_recovery_code_key"
  ON "cashier_password_resets"("recovery_code_id");
CREATE UNIQUE INDEX "cashier_password_resets_code_cashier_key"
  ON "cashier_password_resets"("recovery_code_id", "cashier_user_id");
CREATE UNIQUE INDEX "cashier_password_resets_one_open_key"
  ON "cashier_password_resets"("cashier_user_id")
  WHERE "consumed_at" IS NULL AND "superseded_at" IS NULL;
CREATE INDEX "cashier_password_resets_cashier_expires_idx"
  ON "cashier_password_resets"("cashier_user_id", "expires_at");
CREATE INDEX "cashier_password_resets_state_idx"
  ON "cashier_password_resets"("expires_at", "consumed_at", "superseded_at");

ALTER TABLE "cashier_password_resets"
  ADD CONSTRAINT "cashier_password_resets_cashier_user_id_fkey"
  FOREIGN KEY ("cashier_user_id") REFERENCES "cashier_profiles"("user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cashier_password_resets"
  ADD CONSTRAINT "cashier_password_resets_initiated_by_admin_user_id_fkey"
  FOREIGN KEY ("initiated_by_admin_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cashier_password_resets"
  ADD CONSTRAINT "cashier_password_resets_recovery_code_cashier_fkey"
  FOREIGN KEY ("recovery_code_id", "cashier_user_id")
  REFERENCES "cashier_recovery_codes"("id", "cashier_user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
