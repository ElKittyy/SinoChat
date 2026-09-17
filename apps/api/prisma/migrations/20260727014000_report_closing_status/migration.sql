-- PostgreSQL does not allow a newly added enum value to be referenced safely
-- by other statements in the same transaction. Keep this enum transition in
-- its own migration; the durable closure schema follows in 14100.
ALTER TYPE "ReportStatus" ADD VALUE IF NOT EXISTS 'CLOSING' BEFORE 'CLOSED';
