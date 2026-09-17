-- La revocación autoservicio de una passkey es distinta de una recuperación
-- total y debe quedar identificada en el ledger administrativo append-only.
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_PASSKEY_REVOKED';
