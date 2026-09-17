-- This trigger is shared by auth_sessions and encrypted_key_bundles. Directly
-- referencing both possible fields through NEW makes PostgreSQL resolve a
-- field that does not exist on one of the two record types. Extract the
-- table-specific field from JSONB so each trigger invocation remains valid.
CREATE OR REPLACE FUNCTION "sinochat_enforce_owned_device_reference"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "candidate_device_id" UUID;
BEGIN
    IF TG_TABLE_NAME = 'auth_sessions' THEN
        "candidate_device_id" := NULLIF(
            to_jsonb(NEW)->>'device_id',
            ''
        )::UUID;
    ELSE
        "candidate_device_id" := NULLIF(
            to_jsonb(NEW)->>'source_device_id',
            ''
        )::UUID;
    END IF;

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
