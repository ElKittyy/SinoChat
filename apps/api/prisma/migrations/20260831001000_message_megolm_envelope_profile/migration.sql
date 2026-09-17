-- El gate E2EE sigue cerrado. Los sobres Olm ordinarios no se pueden convertir
-- a eventos Megolm sin volver a cifrar en los extremos, por lo que cualquier
-- fila existente exige una decision operativa explicita.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "message_envelopes") THEN
    RAISE EXCEPTION 'MESSAGE_OLM_DATA_BLOCKS_MEGOLM_PROFILE';
  END IF;
END
$$;

ALTER TABLE "message_envelopes"
  DROP CONSTRAINT "message_envelopes_protocol_version_check",
  DROP CONSTRAINT "message_envelopes_cipher_suite_check",
  ADD CONSTRAINT "message_envelopes_protocol_version_check"
  CHECK ("protocol_version" = 'matrix-megolm-v1'),
  ADD CONSTRAINT "message_envelopes_cipher_suite_check"
  CHECK ("cipher_suite" = 'm.megolm.v1.aes-sha2');
