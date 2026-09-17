-- Assignment eligibility is a commit-time invariant. `now()` and
-- `NEW.started_at` can both reflect the beginning of a long transaction, so a
-- deferred trigger must use the wall clock at the moment it actually runs.
CREATE OR REPLACE FUNCTION "sinochat_validate_assignment_origin"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "origin_cashier_id" UUID;
    "origin_client_id" UUID;
    "validation_now" TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF TG_OP = 'INSERT'
       AND (
           NEW."started_at" > "validation_now"
           OR NOT EXISTS (
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
                         AND cs."starts_at" <= "validation_now"
                         AND (
                             cs."ends_at" IS NULL
                             OR cs."ends_at" > "validation_now"
                         )
                  )
           )
       ) THEN
        RAISE EXCEPTION 'new assignments require an active, approved, currently subscribed cashier without a pending password reset'
            USING ERRCODE = '23514';
    END IF;

    IF NEW."start_reason" = 'INVITATION' THEN
        SELECT "cashier_user_id"
          INTO "origin_cashier_id"
          FROM "cashier_invitations"
         WHERE "id" = NEW."invitation_id"
           AND (
               "revoked_at" IS NULL
               OR "revoked_at" >= CASE
                   WHEN TG_OP = 'INSERT' THEN "validation_now"
                   ELSE NEW."started_at"
               END
           );

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
