-- An administrator-provided password is a one-time reset credential. It can
-- only be consumed by a cashier to choose a different password; it must never
-- authorize an application session.
ALTER TABLE "users"
  ADD COLUMN "password_reset_required" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "users"
  ADD CONSTRAINT "users_password_reset_required_cashier_check"
  CHECK (NOT "password_reset_required" OR "role" = 'CASHIER');

-- The service-level candidate filters protect normal paths. This deferred
-- invariant also closes the race where an administrator starts a reset after
-- a candidate was selected but before its new assignment commits.
CREATE OR REPLACE FUNCTION "sinochat_validate_assignment_origin"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "origin_cashier_id" UUID;
    "origin_client_id" UUID;
BEGIN
    IF TG_OP = 'INSERT'
       AND NOT EXISTS (
           SELECT 1
             FROM "users" u
             JOIN "cashier_profiles" cp ON cp."user_id" = u."id"
            WHERE u."id" = NEW."cashier_user_id"
              AND u."status" = 'ACTIVE'
              AND u."password_reset_required" = FALSE
              AND cp."approval_status" = 'APPROVED'
              AND EXISTS (
                  SELECT 1
                    FROM "cashier_subscriptions" cs
                   WHERE cs."cashier_user_id" = cp."user_id"
                     AND cs."status" = 'ACTIVE'
                     AND cs."starts_at" <= NEW."started_at"
                     AND (cs."ends_at" IS NULL OR cs."ends_at" > NEW."started_at")
              )
       ) THEN
        RAISE EXCEPTION 'new assignments require an active, approved, subscribed cashier without a pending password reset'
            USING ERRCODE = '23514';
    END IF;

    IF NEW."start_reason" = 'INVITATION' THEN
        SELECT "cashier_user_id"
          INTO "origin_cashier_id"
          FROM "cashier_invitations"
         WHERE "id" = NEW."invitation_id"
           AND ("revoked_at" IS NULL OR "revoked_at" >= NEW."started_at");

        IF "origin_cashier_id" IS NULL OR "origin_cashier_id" <> NEW."cashier_user_id" THEN
            RAISE EXCEPTION 'the invitation must be valid and belong to the assigned cashier'
                USING ERRCODE = '23514';
        END IF;
    ELSE
        SELECT "client_user_id"
          INTO "origin_client_id"
          FROM "assignments"
         WHERE "id" = NEW."previous_assignment_id"
           AND "ended_at" IS NOT NULL;

        IF "origin_client_id" IS NULL OR "origin_client_id" <> NEW."client_user_id" THEN
            RAISE EXCEPTION 'a reassignment must follow an ended assignment for the same client'
                USING ERRCODE = '23514';
        END IF;

        IF TG_OP = 'INSERT'
           AND NOT EXISTS (
               SELECT 1
                 FROM "reassignment_requests"
                WHERE "previous_assignment_id" = NEW."previous_assignment_id"
                  AND "resulting_assignment_id" = NEW."id"
                  AND "client_user_id" = NEW."client_user_id"
                  AND "status" = 'COMPLETED'
           ) THEN
            RAISE EXCEPTION 'a reassignment must complete its pending request atomically'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NULL;
END;
$$;
