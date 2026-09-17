-- Administrative edit, deletion, onboarding and password-reset events keep
-- the complete operator reason and bounded before/after metadata.
ALTER TABLE "admin_audit_events"
    ALTER COLUMN "reason_code" TYPE VARCHAR(1000),
    ALTER COLUMN "state_before" TYPE VARCHAR(1000),
    ALTER COLUMN "state_after" TYPE VARCHAR(1000);
