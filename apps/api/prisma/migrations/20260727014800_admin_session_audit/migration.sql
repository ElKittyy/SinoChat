-- Audit explicit administrator session-management operations without storing
-- bearer tokens, CSRF secrets or their hashes in the audit trail.
ALTER TYPE "AdminAuditAction"
    ADD VALUE IF NOT EXISTS 'ADMIN_SESSION_REVOKED';

ALTER TYPE "AdminAuditAction"
    ADD VALUE IF NOT EXISTS 'ADMIN_OTHER_SESSIONS_REVOKED';

ALTER TYPE "AdminAuditTargetType"
    ADD VALUE IF NOT EXISTS 'AUTH_SESSION';
