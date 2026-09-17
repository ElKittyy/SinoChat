-- An attachment row is the durable deletion ledger for its external object.
-- A cascading message delete could previously erase object_key before the
-- retention worker had permanently removed every object-storage version.
ALTER TABLE "attachments"
    DROP CONSTRAINT "attachments_message_id_fkey",
    ADD CONSTRAINT "attachments_message_id_fkey"
        FOREIGN KEY ("message_id")
        REFERENCES "messages"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
