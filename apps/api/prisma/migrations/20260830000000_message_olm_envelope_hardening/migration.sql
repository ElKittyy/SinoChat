-- El gate E2EE sigue cerrado. Esta migración falla de forma explícita si una
-- instalación conserva fixtures del formato genérico anterior: esos datos no
-- pueden declararse Matrix ni convertirse sin las claves de los extremos.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "message_envelopes"
     WHERE "protocol_version" <> 'matrix-olm-v1'
        OR "cipher_suite" <> 'm.olm.v1.curve25519-aes-sha2'
  ) THEN
    RAISE EXCEPTION 'MESSAGE_ENVELOPE_LEGACY_DATA_REQUIRES_EXPLICIT_PURGE';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "attachments"
     WHERE "cipher_suite" <> 'A256CTR'
  ) THEN
    RAISE EXCEPTION 'ATTACHMENT_LEGACY_DATA_REQUIRES_EXPLICIT_PURGE';
  END IF;
END
$$;

ALTER TABLE "message_envelopes"
  ADD CONSTRAINT "message_envelopes_protocol_version_check"
  CHECK ("protocol_version" = 'matrix-olm-v1'),
  ADD CONSTRAINT "message_envelopes_cipher_suite_check"
  CHECK ("cipher_suite" = 'm.olm.v1.curve25519-aes-sha2');

ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_cipher_suite_check"
  CHECK ("cipher_suite" = 'A256CTR');
