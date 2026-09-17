-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CLIENT', 'CASHIER', 'ADMIN');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "CashierApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AssignmentStartReason" AS ENUM ('INVITATION', 'CLIENT_BLOCKED_CASHIER', 'CLIENT_REPORTED_CASHIER', 'CASHIER_BLOCKED_CLIENT', 'CASHIER_UNAVAILABLE', 'ADMINISTRATIVE');

-- CreateEnum
CREATE TYPE "AssignmentEndReason" AS ENUM ('CLIENT_BLOCKED_CASHIER', 'CLIENT_REPORTED_CASHIER', 'CASHIER_BLOCKED_CLIENT', 'CASHIER_UNAVAILABLE', 'CLIENT_SUSPENDED', 'CASHIER_SUSPENDED', 'ACCOUNT_DELETED', 'ADMINISTRATIVE');

-- CreateEnum
CREATE TYPE "ReassignmentReason" AS ENUM ('CLIENT_BLOCKED_CASHIER', 'CLIENT_REPORTED_CASHIER', 'CASHIER_BLOCKED_CLIENT', 'CASHIER_UNAVAILABLE', 'ADMINISTRATIVE');

-- CreateEnum
CREATE TYPE "ReassignmentStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "RecoveryBundleProtection" AS ENUM ('RECOVERY_CODE', 'TRUSTED_DEVICE');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('TEXT', 'IMAGE');

-- CreateEnum
CREATE TYPE "MessageDeliveryStatus" AS ENUM ('SENT', 'DELIVERED', 'READ');

-- CreateEnum
CREATE TYPE "AttachmentUploadStatus" AS ENUM ('PENDING', 'AVAILABLE', 'PURGE_PENDING', 'PURGE_FAILED');

-- CreateEnum
CREATE TYPE "BlockInitiator" AS ENUM ('CLIENT', 'CASHIER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'CLOSED');

-- CreateEnum
CREATE TYPE "ReportOutcome" AS ENUM ('NO_ACTION', 'WARNING', 'CASHIER_SUSPENDED', 'CASHIER_DELETED', 'OTHER');

-- CreateEnum
CREATE TYPE "AccountReviewReason" AS ENUM ('FIVE_DISTINCT_CASHIER_BLOCKS', 'ADMINISTRATIVE');

-- CreateEnum
CREATE TYPE "AccountReviewStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'CLOSED');

-- CreateEnum
CREATE TYPE "AccountReviewOutcome" AS ENUM ('REACTIVATED', 'REMAINS_SUSPENDED', 'ACCOUNT_DELETED', 'OTHER');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('NEW_MESSAGE', 'MESSAGE_DELIVERED', 'MESSAGE_READ', 'ASSIGNMENT_CHANGED', 'ACCOUNT_STATUS_CHANGED', 'REPORT_RESOLVED');

-- CreateEnum
CREATE TYPE "AdminAuditAction" AS ENUM ('USER_CREATED', 'USER_UPDATED', 'USER_SUSPENDED', 'USER_REACTIVATED', 'USER_DELETED', 'PASSWORD_RESET', 'CASHIER_APPROVED', 'CASHIER_REJECTED', 'CASHIER_APPROVAL_REVOKED', 'SUBSCRIPTION_ACTIVATED', 'SUBSCRIPTION_DEACTIVATED', 'CLIENT_REASSIGNED', 'REPORT_OPENED', 'REPORT_REVIEW_STARTED', 'REPORT_EVIDENCE_ACCESSED', 'REPORT_CLOSED', 'ACCOUNT_REVIEW_OPENED', 'ACCOUNT_REVIEW_CLOSED', 'CASHIER_ONBOARDING_INVITATION_CREATED', 'CASHIER_ONBOARDING_INVITATION_REVOKED', 'INVITATION_REVOKED');

-- CreateEnum
CREATE TYPE "AdminAuditTargetType" AS ENUM ('USER', 'CASHIER_PROFILE', 'SUBSCRIPTION', 'ASSIGNMENT', 'REPORT', 'ACCOUNT_REVIEW', 'CASHIER_ONBOARDING_INVITATION', 'INVITATION');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "role" "UserRole" NOT NULL,
    "username" VARCHAR(50) NOT NULL,
    "normalized_username" VARCHAR(50) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "password_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "session_version" INTEGER NOT NULL DEFAULT 1,
    "status" "AccountStatus" NOT NULL DEFAULT 'PENDING',
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "suspended_at" TIMESTAMPTZ(6),
    "suspension_reason_code" VARCHAR(64),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_profiles" (
    "user_id" UUID NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "declared_adult_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "cashier_profiles" (
    "user_id" UUID NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "declared_adult_at" TIMESTAMPTZ(6) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "normalized_email" VARCHAR(254) NOT NULL,
    "phone_e164" VARCHAR(20) NOT NULL,
    "email_verified_at" TIMESTAMPTZ(6),
    "phone_verified_at" TIMESTAMPTZ(6),
    "approval_status" "CashierApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "approved_at" TIMESTAMPTZ(6),
    "approved_by_admin_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cashier_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "terms_documents" (
    "id" UUID NOT NULL,
    "version" VARCHAR(32) NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "effective_at" TIMESTAMPTZ(6) NOT NULL,
    "retired_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terms_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terms_acceptances" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "terms_document_id" UUID NOT NULL,
    "accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_hash" CHAR(64),

    CONSTRAINT "terms_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID,
    "token_hash" CHAR(64) NOT NULL,
    "csrf_secret_hash" CHAR(64) NOT NULL,
    "session_version" INTEGER NOT NULL,
    "ip_hash" CHAR(64),
    "user_agent_hash" CHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revocation_reason" VARCHAR(64),

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "registration_id" INTEGER NOT NULL,
    "identity_public_key" BYTEA NOT NULL,
    "identity_key_fingerprint" CHAR(64) NOT NULL,
    "signed_pre_key_id" INTEGER NOT NULL,
    "signed_pre_key_public" BYTEA NOT NULL,
    "signed_pre_key_signature" BYTEA NOT NULL,
    "protocol_version" VARCHAR(32) NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "one_time_pre_keys" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "key_id" INTEGER NOT NULL,
    "public_key" BYTEA NOT NULL,
    "signature" BYTEA,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(6),

    CONSTRAINT "one_time_pre_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encrypted_key_bundles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source_device_id" UUID,
    "version" INTEGER NOT NULL,
    "protection" "RecoveryBundleProtection" NOT NULL,
    "cipher_suite" VARCHAR(64) NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "salt" BYTEA,
    "kdf_algorithm" VARCHAR(32),
    "kdf_parameters" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_at" TIMESTAMPTZ(6),

    CONSTRAINT "encrypted_key_bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cashier_onboarding_invitations" (
    "id" UUID NOT NULL,
    "created_by_admin_user_id" UUID NOT NULL,
    "redeemed_by_cashier_id" UUID,
    "code_lookup_hash" CHAR(64) NOT NULL,
    "code_ciphertext" BYTEA NOT NULL,
    "code_nonce" BYTEA NOT NULL,
    "encryption_key_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "redeemed_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "cashier_onboarding_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cashier_invitations" (
    "id" UUID NOT NULL,
    "cashier_user_id" UUID NOT NULL,
    "code_lookup_hash" CHAR(64) NOT NULL,
    "code_ciphertext" BYTEA NOT NULL,
    "code_nonce" BYTEA NOT NULL,
    "encryption_key_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "cashier_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cashier_subscriptions" (
    "id" UUID NOT NULL,
    "cashier_user_id" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'INACTIVE',
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6),
    "managed_by_admin_user_id" UUID NOT NULL,
    "reason_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cashier_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" UUID NOT NULL,
    "client_user_id" UUID NOT NULL,
    "cashier_user_id" UUID NOT NULL,
    "invitation_id" UUID,
    "previous_assignment_id" UUID,
    "created_by_admin_user_id" UUID,
    "start_reason" "AssignmentStartReason" NOT NULL,
    "end_reason" "AssignmentEndReason",
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reassignment_requests" (
    "id" UUID NOT NULL,
    "client_user_id" UUID NOT NULL,
    "previous_assignment_id" UUID NOT NULL,
    "excluded_cashier_user_id" UUID NOT NULL,
    "trigger_block_id" UUID,
    "resulting_assignment_id" UUID,
    "reason" "ReassignmentReason" NOT NULL,
    "status" "ReassignmentStatus" NOT NULL DEFAULT 'PENDING',
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMPTZ(6),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "completed_at" TIMESTAMPTZ(6),
    "cancellation_reason_code" VARCHAR(64),

    CONSTRAINT "reassignment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sender_user_id" UUID NOT NULL,
    "sender_device_id" UUID NOT NULL,
    "client_message_id" UUID NOT NULL,
    "server_sequence" BIGSERIAL NOT NULL,
    "kind" "MessageKind" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '48 hours'),

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_envelopes" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "recipient_device_id" UUID NOT NULL,
    "protocol_version" VARCHAR(32) NOT NULL,
    "cipher_suite" VARCHAR(64) NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_envelopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_receipts" (
    "message_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "status" "MessageDeliveryStatus" NOT NULL DEFAULT 'SENT',
    "delivered_at" TIMESTAMPTZ(6),
    "read_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "message_receipts_pkey" PRIMARY KEY ("message_id","recipient_user_id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "object_key" VARCHAR(512) NOT NULL,
    "declared_mime_type" VARCHAR(32) NOT NULL,
    "plaintext_byte_size" INTEGER NOT NULL,
    "ciphertext_byte_size" INTEGER NOT NULL,
    "ciphertext_sha256" CHAR(64) NOT NULL,
    "cipher_suite" VARCHAR(64) NOT NULL,
    "status" "AttachmentUploadStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purge_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_purge_attempt_at" TIMESTAMPTZ(6),
    "last_purge_error_code" VARCHAR(64),

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocks" (
    "id" UUID NOT NULL,
    "client_user_id" UUID NOT NULL,
    "cashier_user_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "initiated_by" "BlockInitiator" NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investigation_keys" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "algorithm" VARCHAR(64) NOT NULL,
    "public_key" BYTEA NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMPTZ(6) NOT NULL,
    "retired_at" TIMESTAMPTZ(6),

    CONSTRAINT "investigation_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "block_id" UUID NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "reviewed_by_admin_user_id" UUID,
    "review_started_at" TIMESTAMPTZ(6),
    "outcome" "ReportOutcome",
    "resolution_summary" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "evidence_purged_at" TIMESTAMPTZ(6),
    "subject_notified_at" TIMESTAMPTZ(6),

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_evidence" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "investigation_key_id" UUID NOT NULL,
    "object_key" VARCHAR(512) NOT NULL,
    "ciphertext_byte_size" BIGINT NOT NULL,
    "ciphertext_sha256" CHAR(64) NOT NULL,
    "cipher_suite" VARCHAR(64) NOT NULL,
    "manifest_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_reviews" (
    "id" UUID NOT NULL,
    "client_user_id" UUID NOT NULL,
    "reason" "AccountReviewReason" NOT NULL,
    "status" "AccountReviewStatus" NOT NULL DEFAULT 'OPEN',
    "assigned_admin_user_id" UUID,
    "closed_by_admin_user_id" UUID,
    "outcome" "AccountReviewOutcome",
    "resolution_summary" VARCHAR(2000),
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "review_started_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "account_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "endpoint_hash" CHAR(64) NOT NULL,
    "sealed_payload" BYTEA NOT NULL,
    "payload_nonce" BYTEA NOT NULL,
    "encryption_key_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_success_at" TIMESTAMPTZ(6),
    "disabled_at" TIMESTAMPTZ(6),

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "in_app_notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "message_id" UUID,
    "type" "NotificationType" NOT NULL,
    "related_entity_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "in_app_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_events" (
    "id" UUID NOT NULL,
    "actor_admin_id" UUID NOT NULL,
    "action" "AdminAuditAction" NOT NULL,
    "target_type" "AdminAuditTargetType" NOT NULL,
    "target_id" UUID,
    "target_user_id" UUID,
    "reason_code" VARCHAR(64),
    "state_before" VARCHAR(64),
    "state_after" VARCHAR(64),
    "request_id" UUID NOT NULL,
    "ip_hash" CHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_normalized_username_key" ON "users"("normalized_username");

-- CreateIndex
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");

-- CreateIndex
CREATE INDEX "users_deleted_at_idx" ON "users"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "cashier_profiles_normalized_email_key" ON "cashier_profiles"("normalized_email");

-- CreateIndex
CREATE UNIQUE INDEX "cashier_profiles_phone_e164_key" ON "cashier_profiles"("phone_e164");

-- CreateIndex
CREATE INDEX "cashier_profiles_approval_status_idx" ON "cashier_profiles"("approval_status");

-- CreateIndex
CREATE UNIQUE INDEX "terms_documents_version_key" ON "terms_documents"("version");

-- CreateIndex
CREATE INDEX "terms_acceptances_document_at_idx" ON "terms_acceptances"("terms_document_id", "accepted_at");

-- CreateIndex
CREATE UNIQUE INDEX "terms_acceptances_user_document_key" ON "terms_acceptances"("user_id", "terms_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_token_hash_key" ON "auth_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "auth_sessions_user_expires_idx" ON "auth_sessions"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "auth_sessions_expires_idx" ON "auth_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "devices_identity_fingerprint_key" ON "devices"("identity_key_fingerprint");

-- CreateIndex
CREATE INDEX "devices_user_status_idx" ON "devices"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "devices_id_user_key" ON "devices"("id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_user_registration_key" ON "devices"("user_id", "registration_id");

-- CreateIndex
CREATE INDEX "one_time_pre_keys_available_idx" ON "one_time_pre_keys"("device_id", "claimed_at");

-- CreateIndex
CREATE UNIQUE INDEX "one_time_pre_keys_device_key_id_key" ON "one_time_pre_keys"("device_id", "key_id");

-- CreateIndex
CREATE INDEX "encrypted_key_bundles_current_idx" ON "encrypted_key_bundles"("user_id", "superseded_at");

-- CreateIndex
CREATE UNIQUE INDEX "encrypted_key_bundles_user_version_key" ON "encrypted_key_bundles"("user_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "cashier_onboarding_invitations_redeemed_by_key" ON "cashier_onboarding_invitations"("redeemed_by_cashier_id");

-- CreateIndex
CREATE UNIQUE INDEX "cashier_onboarding_invitations_lookup_hash_key" ON "cashier_onboarding_invitations"("code_lookup_hash");

-- CreateIndex
CREATE INDEX "cashier_onboarding_invitations_availability_idx" ON "cashier_onboarding_invitations"("expires_at", "redeemed_at", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "cashier_invitations_code_lookup_hash_key" ON "cashier_invitations"("code_lookup_hash");

-- CreateIndex
CREATE INDEX "cashier_invitations_cashier_revoked_idx" ON "cashier_invitations"("cashier_user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "cashier_subscriptions_availability_idx" ON "cashier_subscriptions"("cashier_user_id", "status", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "assignments_previous_assignment_key" ON "assignments"("previous_assignment_id");

-- CreateIndex
CREATE INDEX "assignments_client_ended_idx" ON "assignments"("client_user_id", "ended_at");

-- CreateIndex
CREATE INDEX "assignments_cashier_ended_idx" ON "assignments"("cashier_user_id", "ended_at");

-- CreateIndex
CREATE INDEX "assignments_started_at_idx" ON "assignments"("started_at");

-- CreateIndex
CREATE UNIQUE INDEX "reassignment_requests_previous_assignment_key" ON "reassignment_requests"("previous_assignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "reassignment_requests_trigger_block_key" ON "reassignment_requests"("trigger_block_id");

-- CreateIndex
CREATE UNIQUE INDEX "reassignment_requests_resulting_assignment_key" ON "reassignment_requests"("resulting_assignment_id");

-- CreateIndex
CREATE INDEX "reassignment_requests_status_requested_idx" ON "reassignment_requests"("status", "requested_at");

-- CreateIndex
CREATE INDEX "reassignment_requests_client_status_idx" ON "reassignment_requests"("client_user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_assignment_key" ON "conversations"("assignment_id");

-- CreateIndex
CREATE INDEX "conversations_status_created_idx" ON "conversations"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_server_sequence_key" ON "messages"("server_sequence");

-- CreateIndex
CREATE INDEX "messages_conversation_created_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_expires_at_idx" ON "messages"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_sender_client_id_key" ON "messages"("sender_device_id", "client_message_id");

-- CreateIndex
CREATE INDEX "message_envelopes_device_created_idx" ON "message_envelopes"("recipient_device_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "message_envelopes_message_device_key" ON "message_envelopes"("message_id", "recipient_device_id");

-- CreateIndex
CREATE INDEX "message_receipts_recipient_status_idx" ON "message_receipts"("recipient_user_id", "status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_message_key" ON "attachments"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_object_key_key" ON "attachments"("object_key");

-- CreateIndex
CREATE INDEX "attachments_status_idx" ON "attachments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "blocks_assignment_key" ON "blocks"("assignment_id");

-- CreateIndex
CREATE INDEX "blocks_client_initiator_idx" ON "blocks"("client_user_id", "initiated_by");

-- CreateIndex
CREATE INDEX "blocks_cashier_initiator_idx" ON "blocks"("cashier_user_id", "initiated_by");

-- CreateIndex
CREATE UNIQUE INDEX "blocks_pair_initiator_key" ON "blocks"("client_user_id", "cashier_user_id", "initiated_by");

-- CreateIndex
CREATE UNIQUE INDEX "investigation_keys_version_key" ON "investigation_keys"("version");

-- CreateIndex
CREATE UNIQUE INDEX "investigation_keys_fingerprint_key" ON "investigation_keys"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "reports_block_key" ON "reports"("block_id");

-- CreateIndex
CREATE INDEX "reports_status_created_idx" ON "reports"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "report_evidence_report_key" ON "report_evidence"("report_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_evidence_object_key_key" ON "report_evidence"("object_key");

-- CreateIndex
CREATE INDEX "account_reviews_status_opened_idx" ON "account_reviews"("status", "opened_at");

-- CreateIndex
CREATE INDEX "account_reviews_client_status_idx" ON "account_reviews"("client_user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_hash_key" ON "push_subscriptions"("endpoint_hash");

-- CreateIndex
CREATE INDEX "push_subscriptions_device_disabled_idx" ON "push_subscriptions"("device_id", "disabled_at");

-- CreateIndex
CREATE INDEX "in_app_notifications_user_unread_idx" ON "in_app_notifications"("user_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "in_app_notifications_expires_at_idx" ON "in_app_notifications"("expires_at");

-- CreateIndex
CREATE INDEX "admin_audit_events_actor_created_idx" ON "admin_audit_events"("actor_admin_id", "created_at");

-- CreateIndex
CREATE INDEX "admin_audit_events_target_created_idx" ON "admin_audit_events"("target_type", "target_id", "created_at");

-- CreateIndex
CREATE INDEX "admin_audit_events_target_user_idx" ON "admin_audit_events"("target_user_id", "created_at");

-- AddForeignKey
ALTER TABLE "client_profiles" ADD CONSTRAINT "client_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashier_profiles" ADD CONSTRAINT "cashier_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashier_profiles" ADD CONSTRAINT "cashier_profiles_approved_by_admin_id_fkey" FOREIGN KEY ("approved_by_admin_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_terms_document_id_fkey" FOREIGN KEY ("terms_document_id") REFERENCES "terms_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "one_time_pre_keys" ADD CONSTRAINT "one_time_pre_keys_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encrypted_key_bundles" ADD CONSTRAINT "encrypted_key_bundles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encrypted_key_bundles" ADD CONSTRAINT "encrypted_key_bundles_source_device_id_fkey" FOREIGN KEY ("source_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashier_onboarding_invitations" ADD CONSTRAINT "cashier_onboarding_invitations_created_by_admin_user_id_fkey" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashier_onboarding_invitations" ADD CONSTRAINT "cashier_onboarding_invitations_redeemed_by_cashier_id_fkey" FOREIGN KEY ("redeemed_by_cashier_id") REFERENCES "cashier_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashier_invitations" ADD CONSTRAINT "cashier_invitations_cashier_user_id_fkey" FOREIGN KEY ("cashier_user_id") REFERENCES "cashier_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashier_subscriptions" ADD CONSTRAINT "cashier_subscriptions_cashier_user_id_fkey" FOREIGN KEY ("cashier_user_id") REFERENCES "cashier_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashier_subscriptions" ADD CONSTRAINT "cashier_subscriptions_managed_by_admin_user_id_fkey" FOREIGN KEY ("managed_by_admin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_client_user_id_fkey" FOREIGN KEY ("client_user_id") REFERENCES "client_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_cashier_user_id_fkey" FOREIGN KEY ("cashier_user_id") REFERENCES "cashier_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "cashier_invitations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_previous_assignment_id_fkey" FOREIGN KEY ("previous_assignment_id") REFERENCES "assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_created_by_admin_user_id_fkey" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reassignment_requests" ADD CONSTRAINT "reassignment_requests_client_user_id_fkey" FOREIGN KEY ("client_user_id") REFERENCES "client_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reassignment_requests" ADD CONSTRAINT "reassignment_requests_previous_assignment_id_fkey" FOREIGN KEY ("previous_assignment_id") REFERENCES "assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reassignment_requests" ADD CONSTRAINT "reassignment_requests_excluded_cashier_user_id_fkey" FOREIGN KEY ("excluded_cashier_user_id") REFERENCES "cashier_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reassignment_requests" ADD CONSTRAINT "reassignment_requests_trigger_block_id_fkey" FOREIGN KEY ("trigger_block_id") REFERENCES "blocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reassignment_requests" ADD CONSTRAINT "reassignment_requests_resulting_assignment_id_fkey" FOREIGN KEY ("resulting_assignment_id") REFERENCES "assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_device_id_sender_user_id_fkey" FOREIGN KEY ("sender_device_id", "sender_user_id") REFERENCES "devices"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_envelopes" ADD CONSTRAINT "message_envelopes_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_envelopes" ADD CONSTRAINT "message_envelopes_recipient_device_id_fkey" FOREIGN KEY ("recipient_device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_receipts" ADD CONSTRAINT "message_receipts_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_receipts" ADD CONSTRAINT "message_receipts_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_client_user_id_fkey" FOREIGN KEY ("client_user_id") REFERENCES "client_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_cashier_user_id_fkey" FOREIGN KEY ("cashier_user_id") REFERENCES "cashier_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "blocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reviewed_by_admin_user_id_fkey" FOREIGN KEY ("reviewed_by_admin_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_evidence" ADD CONSTRAINT "report_evidence_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_evidence" ADD CONSTRAINT "report_evidence_investigation_key_id_fkey" FOREIGN KEY ("investigation_key_id") REFERENCES "investigation_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_reviews" ADD CONSTRAINT "account_reviews_client_user_id_fkey" FOREIGN KEY ("client_user_id") REFERENCES "client_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_reviews" ADD CONSTRAINT "account_reviews_assigned_admin_user_id_fkey" FOREIGN KEY ("assigned_admin_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_reviews" ADD CONSTRAINT "account_reviews_closed_by_admin_user_id_fkey" FOREIGN KEY ("closed_by_admin_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "in_app_notifications" ADD CONSTRAINT "in_app_notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "in_app_notifications" ADD CONSTRAINT "in_app_notifications_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_events" ADD CONSTRAINT "admin_audit_events_actor_admin_id_fkey" FOREIGN KEY ("actor_admin_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_events" ADD CONSTRAINT "admin_audit_events_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- PostgreSQL invariants that Prisma cannot express.
-- These indexes serialize the business transitions that must have one current row.
CREATE UNIQUE INDEX "assignments_one_active_per_client_key"
    ON "assignments" ("client_user_id")
    WHERE "ended_at" IS NULL;

CREATE INDEX "assignments_active_cashier_idx"
    ON "assignments" ("cashier_user_id", "client_user_id")
    WHERE "ended_at" IS NULL;

CREATE UNIQUE INDEX "cashier_invitations_one_active_per_cashier_key"
    ON "cashier_invitations" ("cashier_user_id")
    WHERE "revoked_at" IS NULL;

CREATE UNIQUE INDEX "cashier_subscriptions_one_active_per_cashier_key"
    ON "cashier_subscriptions" ("cashier_user_id")
    WHERE "status" = 'ACTIVE';

CREATE UNIQUE INDEX "encrypted_key_bundles_one_current_per_user_key"
    ON "encrypted_key_bundles" ("user_id")
    WHERE "superseded_at" IS NULL;

CREATE UNIQUE INDEX "account_reviews_one_open_per_client_key"
    ON "account_reviews" ("client_user_id")
    WHERE "status" IN ('OPEN', 'IN_REVIEW');

CREATE UNIQUE INDEX "reassignment_requests_one_pending_per_client_key"
    ON "reassignment_requests" ("client_user_id")
    WHERE "status" = 'PENDING';

-- Scalar validation and lifecycle consistency.
ALTER TABLE "users"
    ADD CONSTRAINT "users_username_length_check"
        CHECK (char_length(btrim("username")) BETWEEN 3 AND 50),
    ADD CONSTRAINT "users_normalized_username_check"
        CHECK ("normalized_username" = lower(btrim("normalized_username"))),
    ADD CONSTRAINT "users_session_version_check"
        CHECK ("session_version" > 0),
    ADD CONSTRAINT "users_failed_login_attempts_check"
        CHECK ("failed_login_attempts" >= 0),
    ADD CONSTRAINT "users_deleted_state_check"
        CHECK (("status" = 'DELETED') = ("deleted_at" IS NOT NULL)),
    ADD CONSTRAINT "users_suspended_state_check"
        CHECK (("status" = 'SUSPENDED') = ("suspended_at" IS NOT NULL));

ALTER TABLE "client_profiles"
    ADD CONSTRAINT "client_profiles_adult_declaration_check"
        CHECK (
            "declared_adult_at" >= "created_at" - INTERVAL '5 minutes'
            AND "date_of_birth" <= (
                ("declared_adult_at" AT TIME ZONE 'UTC')::DATE
                - INTERVAL '18 years'
            )::DATE
        );

ALTER TABLE "cashier_profiles"
    ADD CONSTRAINT "cashier_profiles_adult_declaration_check"
        CHECK (
            "declared_adult_at" >= "created_at" - INTERVAL '5 minutes'
            AND "date_of_birth" <= (
                ("declared_adult_at" AT TIME ZONE 'UTC')::DATE
                - INTERVAL '18 years'
            )::DATE
        ),
    ADD CONSTRAINT "cashier_profiles_normalized_email_check"
        CHECK ("normalized_email" = lower(btrim("normalized_email"))),
    ADD CONSTRAINT "cashier_profiles_phone_e164_check"
        CHECK ("phone_e164" ~ '^\+[1-9][0-9]{7,14}$'),
    ADD CONSTRAINT "cashier_profiles_approved_state_check"
        CHECK (
            "approval_status" <> 'APPROVED'
            OR (
                "approved_at" IS NOT NULL
                AND "approved_by_admin_id" IS NOT NULL
                AND "email_verified_at" IS NOT NULL
                AND "phone_verified_at" IS NOT NULL
            )
        );

ALTER TABLE "cashier_onboarding_invitations"
    ADD CONSTRAINT "cashier_onboarding_invitations_lookup_hash_check"
        CHECK ("code_lookup_hash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "cashier_onboarding_invitations_ciphertext_check"
        CHECK (octet_length("code_ciphertext") > 0 AND octet_length("code_nonce") > 0),
    ADD CONSTRAINT "cashier_onboarding_invitations_key_version_check"
        CHECK ("encryption_key_version" > 0),
    ADD CONSTRAINT "cashier_onboarding_invitations_lifetime_check"
        CHECK ("expires_at" > "created_at"),
    ADD CONSTRAINT "cashier_onboarding_invitations_terminal_state_check"
        CHECK (
            (
                "redeemed_at" IS NULL
                AND "redeemed_by_cashier_id" IS NULL
            )
            OR (
                "redeemed_at" IS NOT NULL
                AND "redeemed_by_cashier_id" IS NOT NULL
                AND "redeemed_at" >= "created_at"
                AND "redeemed_at" <= "expires_at"
                AND "revoked_at" IS NULL
            )
        ),
    ADD CONSTRAINT "cashier_onboarding_invitations_revoked_at_check"
        CHECK (
            "revoked_at" IS NULL
            OR (
                "revoked_at" >= "created_at"
                AND "redeemed_at" IS NULL
            )
        );

ALTER TABLE "terms_documents"
    ADD CONSTRAINT "terms_documents_content_hash_check"
        CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "terms_documents_retirement_check"
        CHECK ("retired_at" IS NULL OR "retired_at" > "effective_at");

ALTER TABLE "auth_sessions"
    ADD CONSTRAINT "auth_sessions_token_hash_check"
        CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "auth_sessions_csrf_hash_check"
        CHECK ("csrf_secret_hash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "auth_sessions_lifetime_check"
        CHECK ("expires_at" > "created_at"),
    ADD CONSTRAINT "auth_sessions_revocation_check"
        CHECK (
            ("revoked_at" IS NULL AND "revocation_reason" IS NULL)
            OR (
                "revoked_at" IS NOT NULL
                AND "revoked_at" >= "created_at"
                AND "revocation_reason" IS NOT NULL
            )
        );

ALTER TABLE "devices"
    ADD CONSTRAINT "devices_registration_id_check"
        CHECK ("registration_id" >= 0),
    ADD CONSTRAINT "devices_identity_fingerprint_check"
        CHECK ("identity_key_fingerprint" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "devices_revocation_state_check"
        CHECK (
            ("status" = 'ACTIVE' AND "revoked_at" IS NULL)
            OR ("status" = 'REVOKED' AND "revoked_at" IS NOT NULL)
        );

ALTER TABLE "one_time_pre_keys"
    ADD CONSTRAINT "one_time_pre_keys_key_id_check"
        CHECK ("key_id" >= 0),
    ADD CONSTRAINT "one_time_pre_keys_claimed_at_check"
        CHECK ("claimed_at" IS NULL OR "claimed_at" >= "created_at");

ALTER TABLE "encrypted_key_bundles"
    ADD CONSTRAINT "encrypted_key_bundles_version_check"
        CHECK ("version" > 0),
    ADD CONSTRAINT "encrypted_key_bundles_ciphertext_check"
        CHECK (octet_length("ciphertext") > 0 AND octet_length("nonce") > 0),
    ADD CONSTRAINT "encrypted_key_bundles_superseded_check"
        CHECK ("superseded_at" IS NULL OR "superseded_at" >= "created_at");

ALTER TABLE "cashier_invitations"
    ADD CONSTRAINT "cashier_invitations_lookup_hash_check"
        CHECK ("code_lookup_hash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "cashier_invitations_ciphertext_check"
        CHECK (octet_length("code_ciphertext") > 0 AND octet_length("code_nonce") > 0),
    ADD CONSTRAINT "cashier_invitations_key_version_check"
        CHECK ("encryption_key_version" > 0),
    ADD CONSTRAINT "cashier_invitations_revoked_at_check"
        CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at");

ALTER TABLE "cashier_subscriptions"
    ADD CONSTRAINT "cashier_subscriptions_period_check"
        CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at");

ALTER TABLE "assignments"
    ADD CONSTRAINT "assignments_end_state_check"
        CHECK (
            ("ended_at" IS NULL AND "end_reason" IS NULL)
            OR (
                "ended_at" IS NOT NULL
                AND "end_reason" IS NOT NULL
                AND "ended_at" >= "started_at"
            )
        ),
    ADD CONSTRAINT "assignments_origin_check"
        CHECK (
            (
                "start_reason" = 'INVITATION'
                AND "invitation_id" IS NOT NULL
                AND "previous_assignment_id" IS NULL
            )
            OR (
                "start_reason" <> 'INVITATION'
                AND "invitation_id" IS NULL
                AND "previous_assignment_id" IS NOT NULL
            )
        ),
    ADD CONSTRAINT "assignments_not_self_previous_check"
        CHECK ("previous_assignment_id" IS NULL OR "previous_assignment_id" <> "id");

ALTER TABLE "reassignment_requests"
    ADD CONSTRAINT "reassignment_requests_attempt_count_check"
        CHECK ("attempt_count" >= 0),
    ADD CONSTRAINT "reassignment_requests_terminal_state_check"
        CHECK (
            (
                "status" = 'PENDING'
                AND "resulting_assignment_id" IS NULL
                AND "completed_at" IS NULL
                AND "cancellation_reason_code" IS NULL
            )
            OR (
                "status" = 'COMPLETED'
                AND "resulting_assignment_id" IS NOT NULL
                AND "completed_at" IS NOT NULL
                AND "cancellation_reason_code" IS NULL
            )
            OR (
                "status" = 'CANCELLED'
                AND "resulting_assignment_id" IS NULL
                AND "completed_at" IS NOT NULL
                AND "cancellation_reason_code" IS NOT NULL
            )
        ),
    ADD CONSTRAINT "reassignment_requests_attempt_time_check"
        CHECK ("last_attempt_at" IS NULL OR "last_attempt_at" >= "requested_at"),
    ADD CONSTRAINT "reassignment_requests_completed_time_check"
        CHECK ("completed_at" IS NULL OR "completed_at" >= "requested_at"),
    ADD CONSTRAINT "reassignment_requests_block_source_check"
        CHECK (
            (
                "reason" IN (
                    'CLIENT_BLOCKED_CASHIER',
                    'CLIENT_REPORTED_CASHIER',
                    'CASHIER_BLOCKED_CLIENT'
                )
                AND "trigger_block_id" IS NOT NULL
            )
            OR (
                "reason" IN ('CASHIER_UNAVAILABLE', 'ADMINISTRATIVE')
                AND "trigger_block_id" IS NULL
            )
        );

ALTER TABLE "conversations"
    ADD CONSTRAINT "conversations_closed_state_check"
        CHECK (
            ("status" = 'ACTIVE' AND "closed_at" IS NULL)
            OR (
                "status" = 'CLOSED'
                AND "closed_at" IS NOT NULL
                AND "closed_at" >= "created_at"
            )
        );

ALTER TABLE "messages"
    ADD CONSTRAINT "messages_exact_retention_check"
        CHECK ("expires_at" = "created_at" + INTERVAL '48 hours');

ALTER TABLE "message_envelopes"
    ADD CONSTRAINT "message_envelopes_ciphertext_size_check"
        CHECK (octet_length("ciphertext") BETWEEN 1 AND 131072);

ALTER TABLE "message_receipts"
    ADD CONSTRAINT "message_receipts_state_check"
        CHECK (
            (
                "status" = 'SENT'
                AND "delivered_at" IS NULL
                AND "read_at" IS NULL
            )
            OR (
                "status" = 'DELIVERED'
                AND "delivered_at" IS NOT NULL
                AND "read_at" IS NULL
            )
            OR (
                "status" = 'READ'
                AND "delivered_at" IS NOT NULL
                AND "read_at" IS NOT NULL
                AND "read_at" >= "delivered_at"
            )
        );

ALTER TABLE "attachments"
    ADD CONSTRAINT "attachments_mime_type_check"
        CHECK ("declared_mime_type" IN ('image/jpeg', 'image/png', 'image/webp')),
    ADD CONSTRAINT "attachments_plaintext_size_check"
        CHECK ("plaintext_byte_size" BETWEEN 1 AND 5242880),
    ADD CONSTRAINT "attachments_ciphertext_size_check"
        CHECK (
            "ciphertext_byte_size" >= "plaintext_byte_size"
            AND "ciphertext_byte_size" <= 6291456
        ),
    ADD CONSTRAINT "attachments_ciphertext_hash_check"
        CHECK ("ciphertext_sha256" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "attachments_purge_attempts_check"
        CHECK ("purge_attempts" >= 0);

ALTER TABLE "blocks"
    ADD CONSTRAINT "blocks_reason_length_check"
        CHECK (char_length(btrim("reason")) BETWEEN 20 AND 1000);

ALTER TABLE "investigation_keys"
    ADD CONSTRAINT "investigation_keys_version_check"
        CHECK ("version" > 0),
    ADD CONSTRAINT "investigation_keys_public_key_check"
        CHECK (octet_length("public_key") > 0),
    ADD CONSTRAINT "investigation_keys_fingerprint_check"
        CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "investigation_keys_lifecycle_check"
        CHECK (
            "activated_at" >= "created_at"
            AND ("retired_at" IS NULL OR "retired_at" > "activated_at")
        );

ALTER TABLE "reports"
    ADD CONSTRAINT "reports_lifecycle_check"
        CHECK (
            (
                "status" = 'OPEN'
                AND "reviewed_by_admin_user_id" IS NULL
                AND "review_started_at" IS NULL
                AND "outcome" IS NULL
                AND "resolution_summary" IS NULL
                AND "closed_at" IS NULL
                AND "evidence_purged_at" IS NULL
            )
            OR (
                "status" = 'IN_REVIEW'
                AND "reviewed_by_admin_user_id" IS NOT NULL
                AND "review_started_at" IS NOT NULL
                AND "outcome" IS NULL
                AND "resolution_summary" IS NULL
                AND "closed_at" IS NULL
                AND "evidence_purged_at" IS NULL
            )
            OR (
                "status" = 'CLOSED'
                AND "reviewed_by_admin_user_id" IS NOT NULL
                AND "review_started_at" IS NOT NULL
                AND "outcome" IS NOT NULL
                AND "resolution_summary" IS NOT NULL
                AND char_length(btrim("resolution_summary")) > 0
                AND "closed_at" IS NOT NULL
                AND "evidence_purged_at" IS NOT NULL
                AND "closed_at" >= "review_started_at"
                AND "evidence_purged_at" >= "closed_at"
            )
        ),
    ADD CONSTRAINT "reports_subject_notification_check"
        CHECK (
            "subject_notified_at" IS NULL
            OR (
                "status" = 'CLOSED'
                AND "subject_notified_at" >= "closed_at"
            )
        );

ALTER TABLE "report_evidence"
    ADD CONSTRAINT "report_evidence_size_check"
        CHECK ("ciphertext_byte_size" > 0),
    ADD CONSTRAINT "report_evidence_hash_check"
        CHECK ("ciphertext_sha256" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "report_evidence_manifest_version_check"
        CHECK ("manifest_version" > 0);

ALTER TABLE "account_reviews"
    ADD CONSTRAINT "account_reviews_lifecycle_check"
        CHECK (
            (
                "status" = 'OPEN'
                AND "review_started_at" IS NULL
                AND "closed_by_admin_user_id" IS NULL
                AND "outcome" IS NULL
                AND "resolution_summary" IS NULL
                AND "closed_at" IS NULL
            )
            OR (
                "status" = 'IN_REVIEW'
                AND "assigned_admin_user_id" IS NOT NULL
                AND "review_started_at" IS NOT NULL
                AND "closed_by_admin_user_id" IS NULL
                AND "outcome" IS NULL
                AND "resolution_summary" IS NULL
                AND "closed_at" IS NULL
            )
            OR (
                "status" = 'CLOSED'
                AND "closed_by_admin_user_id" IS NOT NULL
                AND "outcome" IS NOT NULL
                AND "resolution_summary" IS NOT NULL
                AND char_length(btrim("resolution_summary")) > 0
                AND "closed_at" IS NOT NULL
                AND "closed_at" >= "opened_at"
            )
        );

ALTER TABLE "push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_endpoint_hash_check"
        CHECK ("endpoint_hash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "push_subscriptions_payload_check"
        CHECK (octet_length("sealed_payload") > 0 AND octet_length("payload_nonce") > 0),
    ADD CONSTRAINT "push_subscriptions_key_version_check"
        CHECK ("encryption_key_version" > 0);

ALTER TABLE "in_app_notifications"
    ADD CONSTRAINT "in_app_notifications_lifetime_check"
        CHECK ("expires_at" IS NULL OR "expires_at" > "created_at");

-- Reusable role assertion. It never reads or receives conversation content.
CREATE FUNCTION "sinochat_assert_user_role"("candidate_user_id" UUID, "expected_role" "UserRole")
RETURNS VOID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    "actual_role" "UserRole";
BEGIN
    SELECT "role"
      INTO "actual_role"
      FROM "users"
     WHERE "id" = "candidate_user_id";

    IF "actual_role" IS NULL OR "actual_role" <> "expected_role" THEN
        RAISE EXCEPTION 'user % must have role %', "candidate_user_id", "expected_role"
            USING ERRCODE = '23514';
    END IF;
END;
$$;

CREATE FUNCTION "sinochat_enforce_profile_role"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_TABLE_NAME = 'client_profiles' THEN
        PERFORM "sinochat_assert_user_role"(NEW."user_id", 'CLIENT');
    ELSIF TG_TABLE_NAME = 'cashier_profiles' THEN
        PERFORM "sinochat_assert_user_role"(NEW."user_id", 'CASHIER');
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "client_profiles_role_trigger"
BEFORE INSERT OR UPDATE OF "user_id" ON "client_profiles"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_profile_role"();

CREATE TRIGGER "cashier_profiles_role_trigger"
BEFORE INSERT OR UPDATE OF "user_id" ON "cashier_profiles"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_profile_role"();

CREATE FUNCTION "sinochat_prevent_user_role_change"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."role" <> OLD."role" THEN
        RAISE EXCEPTION 'user roles are immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "users_role_immutable_trigger"
BEFORE UPDATE OF "role" ON "users"
FOR EACH ROW EXECUTE FUNCTION "sinochat_prevent_user_role_change"();

CREATE FUNCTION "sinochat_enforce_admin_reference"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "admin_id" UUID;
BEGIN
    "admin_id" := (to_jsonb(NEW) ->> TG_ARGV[0])::UUID;
    IF "admin_id" IS NOT NULL THEN
        PERFORM "sinochat_assert_user_role"("admin_id", 'ADMIN');
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "cashier_profiles_approver_role_trigger"
BEFORE INSERT OR UPDATE OF "approved_by_admin_id" ON "cashier_profiles"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_admin_reference"('approved_by_admin_id');

CREATE TRIGGER "cashier_onboarding_invitations_creator_role_trigger"
BEFORE INSERT OR UPDATE OF "created_by_admin_user_id" ON "cashier_onboarding_invitations"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_admin_reference"('created_by_admin_user_id');

CREATE TRIGGER "cashier_subscriptions_manager_role_trigger"
BEFORE INSERT OR UPDATE OF "managed_by_admin_user_id" ON "cashier_subscriptions"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_admin_reference"('managed_by_admin_user_id');

CREATE TRIGGER "assignments_admin_role_trigger"
BEFORE INSERT OR UPDATE OF "created_by_admin_user_id" ON "assignments"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_admin_reference"('created_by_admin_user_id');

CREATE TRIGGER "reports_reviewer_role_trigger"
BEFORE INSERT OR UPDATE OF "reviewed_by_admin_user_id" ON "reports"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_admin_reference"('reviewed_by_admin_user_id');

CREATE TRIGGER "account_reviews_assignee_role_trigger"
BEFORE INSERT OR UPDATE OF "assigned_admin_user_id" ON "account_reviews"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_admin_reference"('assigned_admin_user_id');

CREATE TRIGGER "account_reviews_closer_role_trigger"
BEFORE INSERT OR UPDATE OF "closed_by_admin_user_id" ON "account_reviews"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_admin_reference"('closed_by_admin_user_id');

CREATE TRIGGER "admin_audit_events_actor_role_trigger"
BEFORE INSERT OR UPDATE OF "actor_admin_id" ON "admin_audit_events"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_admin_reference"('actor_admin_id');

-- Assignment rows form an immutable history. Only the first transition from active
-- to ended is allowed.
CREATE FUNCTION "sinochat_enforce_assignment_history"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW."client_user_id" <> OLD."client_user_id"
           OR NEW."cashier_user_id" <> OLD."cashier_user_id"
           OR NEW."invitation_id" IS DISTINCT FROM OLD."invitation_id"
           OR NEW."previous_assignment_id" IS DISTINCT FROM OLD."previous_assignment_id"
           OR NEW."created_by_admin_user_id" IS DISTINCT FROM OLD."created_by_admin_user_id"
           OR NEW."start_reason" <> OLD."start_reason"
           OR NEW."started_at" <> OLD."started_at" THEN
            RAISE EXCEPTION 'assignment history fields are immutable'
                USING ERRCODE = '23514';
        END IF;

        IF OLD."ended_at" IS NOT NULL
           AND (
               NEW."ended_at" IS DISTINCT FROM OLD."ended_at"
               OR NEW."end_reason" IS DISTINCT FROM OLD."end_reason"
           ) THEN
            RAISE EXCEPTION 'an ended assignment cannot be reopened or changed'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "assignments_history_trigger"
BEFORE UPDATE ON "assignments"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_assignment_history"();

CREATE FUNCTION "sinochat_validate_assignment_origin"()
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
        RAISE EXCEPTION 'new assignments require an active, approved and subscribed cashier'
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

CREATE CONSTRAINT TRIGGER "assignments_origin_trigger"
AFTER INSERT OR UPDATE ON "assignments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_assignment_origin"();

CREATE FUNCTION "sinochat_enforce_conversation_history"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."assignment_id" <> OLD."assignment_id"
       OR NEW."created_at" <> OLD."created_at"
       OR (
           OLD."closed_at" IS NOT NULL
           AND (
               NEW."closed_at" IS DISTINCT FROM OLD."closed_at"
               OR NEW."status" <> OLD."status"
           )
       )
       OR (
           OLD."status" = 'ACTIVE'
           AND NEW."status" = 'CLOSED'
           AND NEW."closed_at" IS NULL
       )
       OR (
           OLD."status" = 'ACTIVE'
           AND NEW."status" NOT IN ('ACTIVE', 'CLOSED')
       ) THEN
        RAISE EXCEPTION 'conversation history fields are immutable except for first closure'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "conversations_history_trigger"
BEFORE UPDATE ON "conversations"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_conversation_history"();

CREATE FUNCTION "sinochat_validate_assignment_conversation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "target_assignment_id" UUID;
    "row_data" JSONB;
    "assignment_ended_at" TIMESTAMPTZ;
    "conversation_count" INTEGER;
    "conversation_status" "ConversationStatus";
BEGIN
    "row_data" := CASE
        WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
        ELSE to_jsonb(NEW)
    END;

    "target_assignment_id" := CASE
        WHEN TG_TABLE_NAME = 'assignments' THEN
            ("row_data" ->> 'id')::UUID
        ELSE
            ("row_data" ->> 'assignment_id')::UUID
    END;

    SELECT "ended_at"
      INTO "assignment_ended_at"
      FROM "assignments"
     WHERE "id" = "target_assignment_id";

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT count(*), max("status"::TEXT)::"ConversationStatus"
      INTO "conversation_count", "conversation_status"
      FROM "conversations"
     WHERE "assignment_id" = "target_assignment_id";

    IF "conversation_count" <> 1
       OR ("assignment_ended_at" IS NULL AND "conversation_status" <> 'ACTIVE')
       OR ("assignment_ended_at" IS NOT NULL AND "conversation_status" <> 'CLOSED') THEN
        RAISE EXCEPTION 'every assignment requires one conversation with matching lifecycle state'
            USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "assignments_conversation_trigger"
AFTER INSERT OR UPDATE ON "assignments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_assignment_conversation"();

CREATE CONSTRAINT TRIGGER "conversations_assignment_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "conversations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_assignment_conversation"();

-- The database clock is authoritative for the 48-hour retention window. Message
-- metadata is immutable, and no plaintext message column exists.
CREATE FUNCTION "sinochat_prepare_message"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "assignment_client_id" UUID;
    "assignment_cashier_id" UUID;
    "conversation_status" "ConversationStatus";
    "assignment_ended_at" TIMESTAMPTZ;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'message metadata is immutable'
            USING ERRCODE = '23514';
    END IF;

    SELECT a."client_user_id", a."cashier_user_id", c."status", a."ended_at"
      INTO "assignment_client_id", "assignment_cashier_id", "conversation_status", "assignment_ended_at"
      FROM "conversations" c
      JOIN "assignments" a ON a."id" = c."assignment_id"
     WHERE c."id" = NEW."conversation_id";

    IF "conversation_status" IS NULL
       OR "conversation_status" <> 'ACTIVE'
       OR "assignment_ended_at" IS NOT NULL THEN
        RAISE EXCEPTION 'messages can only be sent to an active conversation'
            USING ERRCODE = '23514';
    END IF;

    IF NEW."sender_user_id" <> "assignment_client_id"
       AND NEW."sender_user_id" <> "assignment_cashier_id" THEN
        RAISE EXCEPTION 'message sender is not a conversation participant'
            USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM "devices" d
          JOIN "users" u ON u."id" = d."user_id"
         WHERE d."id" = NEW."sender_device_id"
           AND d."user_id" = NEW."sender_user_id"
           AND d."status" = 'ACTIVE'
           AND u."status" = 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'message sender account and device must be active'
            USING ERRCODE = '23514';
    END IF;

    NEW."created_at" := clock_timestamp();
    NEW."expires_at" := NEW."created_at" + INTERVAL '48 hours';
    RETURN NEW;
END;
$$;

CREATE TRIGGER "messages_prepare_trigger"
BEFORE INSERT OR UPDATE ON "messages"
FOR EACH ROW EXECUTE FUNCTION "sinochat_prepare_message"();

CREATE FUNCTION "sinochat_validate_message_envelope"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "recipient_user_id" UUID;
    "recipient_status" "DeviceStatus";
    "assignment_client_id" UUID;
    "assignment_cashier_id" UUID;
    "message_expires_at" TIMESTAMPTZ;
BEGIN
    SELECT "user_id", "status"
      INTO "recipient_user_id", "recipient_status"
      FROM "devices"
     WHERE "id" = NEW."recipient_device_id";

    SELECT a."client_user_id", a."cashier_user_id", m."expires_at"
      INTO "assignment_client_id", "assignment_cashier_id", "message_expires_at"
      FROM "messages" m
      JOIN "conversations" c ON c."id" = m."conversation_id"
      JOIN "assignments" a ON a."id" = c."assignment_id"
     WHERE m."id" = NEW."message_id";

    IF "recipient_status" IS NULL OR "recipient_status" <> 'ACTIVE' THEN
        RAISE EXCEPTION 'message envelope recipient device must be active'
            USING ERRCODE = '23514';
    END IF;

    IF "recipient_user_id" <> "assignment_client_id"
       AND "recipient_user_id" <> "assignment_cashier_id" THEN
        RAISE EXCEPTION 'message envelope recipient is not a conversation participant'
            USING ERRCODE = '23514';
    END IF;

    IF "message_expires_at" <= clock_timestamp() THEN
        RAISE EXCEPTION 'cannot add an envelope to an expired message'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "message_envelopes_participant_trigger"
BEFORE INSERT OR UPDATE OF "message_id", "recipient_device_id" ON "message_envelopes"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_message_envelope"();

CREATE FUNCTION "sinochat_validate_message_receipt"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "message_sender_id" UUID;
    "assignment_client_id" UUID;
    "assignment_cashier_id" UUID;
BEGIN
    SELECT m."sender_user_id", a."client_user_id", a."cashier_user_id"
      INTO "message_sender_id", "assignment_client_id", "assignment_cashier_id"
      FROM "messages" m
      JOIN "conversations" c ON c."id" = m."conversation_id"
      JOIN "assignments" a ON a."id" = c."assignment_id"
     WHERE m."id" = NEW."message_id";

    IF NEW."recipient_user_id" = "message_sender_id"
       OR (
           NEW."recipient_user_id" <> "assignment_client_id"
           AND NEW."recipient_user_id" <> "assignment_cashier_id"
       ) THEN
        RAISE EXCEPTION 'message receipt recipient must be the other conversation participant'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "message_receipts_participant_trigger"
BEFORE INSERT OR UPDATE OF "message_id", "recipient_user_id" ON "message_receipts"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_message_receipt"();

CREATE FUNCTION "sinochat_validate_message_payload"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "target_message_id" UUID;
    "row_data" JSONB;
    "target_kind" "MessageKind";
    "attachment_count" INTEGER;
BEGIN
    "row_data" := CASE
        WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
        ELSE to_jsonb(NEW)
    END;

    "target_message_id" := CASE
        WHEN TG_TABLE_NAME = 'messages' THEN
            ("row_data" ->> 'id')::UUID
        ELSE
            ("row_data" ->> 'message_id')::UUID
    END;

    SELECT "kind"
      INTO "target_kind"
      FROM "messages"
     WHERE "id" = "target_message_id";

    IF "target_kind" IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT count(*)
      INTO "attachment_count"
      FROM "attachments"
     WHERE "message_id" = "target_message_id";

    IF ("target_kind" = 'IMAGE' AND "attachment_count" <> 1)
       OR ("target_kind" = 'TEXT' AND "attachment_count" <> 0) THEN
        RAISE EXCEPTION 'IMAGE messages require exactly one attachment and TEXT messages require none'
            USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "messages_payload_trigger"
AFTER INSERT ON "messages"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_message_payload"();

CREATE CONSTRAINT TRIGGER "attachments_payload_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "attachments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_message_payload"();

CREATE FUNCTION "sinochat_validate_block"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "assignment_client_id" UUID;
    "assignment_cashier_id" UUID;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'block records are immutable'
            USING ERRCODE = '23514';
    END IF;

    SELECT "client_user_id", "cashier_user_id"
      INTO "assignment_client_id", "assignment_cashier_id"
      FROM "assignments"
     WHERE "id" = NEW."assignment_id";

    IF NEW."client_user_id" <> "assignment_client_id"
       OR NEW."cashier_user_id" <> "assignment_cashier_id" THEN
        RAISE EXCEPTION 'block participants must match its assignment'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "blocks_assignment_trigger"
BEFORE INSERT OR UPDATE ON "blocks"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_block"();

CREATE FUNCTION "sinochat_validate_block_lifecycle"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "assignment_end_reason" "AssignmentEndReason";
    "has_report" BOOLEAN;
BEGIN
    SELECT "end_reason"
      INTO "assignment_end_reason"
      FROM "assignments"
     WHERE "id" = NEW."assignment_id";

    SELECT EXISTS (
        SELECT 1 FROM "reports" WHERE "block_id" = NEW."id"
    ) INTO "has_report";

    IF ("assignment_end_reason" IS NULL)
       OR (
           NEW."initiated_by" = 'CASHIER'
           AND "assignment_end_reason" <> 'CASHIER_BLOCKED_CLIENT'
       )
       OR (
           NEW."initiated_by" = 'CLIENT'
           AND (
               NOT "has_report"
               OR "assignment_end_reason" <> 'CLIENT_REPORTED_CASHIER'
           )
       ) THEN
        RAISE EXCEPTION 'block initiator, report and assignment end reason are inconsistent'
            USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "blocks_lifecycle_trigger"
AFTER INSERT ON "blocks"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_block_lifecycle"();

CREATE FUNCTION "sinochat_validate_report_source"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "block_initiator" "BlockInitiator";
    "assignment_end_reason" "AssignmentEndReason";
BEGIN
    SELECT b."initiated_by", a."end_reason"
      INTO "block_initiator", "assignment_end_reason"
      FROM "blocks" b
      JOIN "assignments" a ON a."id" = b."assignment_id"
     WHERE b."id" = NEW."block_id";

    IF "block_initiator" IS NULL
       OR "block_initiator" <> 'CLIENT'
       OR "assignment_end_reason" <> 'CLIENT_REPORTED_CASHIER' THEN
        RAISE EXCEPTION 'only a client block may create a report against a cashier'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "reports_source_trigger"
AFTER INSERT OR UPDATE ON "reports"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_report_source"();

CREATE FUNCTION "sinochat_validate_report_evidence_lifecycle"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "target_report_id" UUID;
    "row_data" JSONB;
    "target_status" "ReportStatus";
    "evidence_count" INTEGER;
BEGIN
    "row_data" := CASE
        WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
        ELSE to_jsonb(NEW)
    END;

    "target_report_id" := CASE
        WHEN TG_TABLE_NAME = 'reports' THEN
            ("row_data" ->> 'id')::UUID
        ELSE
            ("row_data" ->> 'report_id')::UUID
    END;

    SELECT "status"
      INTO "target_status"
      FROM "reports"
     WHERE "id" = "target_report_id";

    IF "target_status" IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT count(*)
      INTO "evidence_count"
      FROM "report_evidence"
     WHERE "report_id" = "target_report_id";

    IF ("target_status" IN ('OPEN', 'IN_REVIEW') AND "evidence_count" <> 1)
       OR ("target_status" = 'CLOSED' AND "evidence_count" <> 0) THEN
        RAISE EXCEPTION 'open reports require one encrypted evidence package; closed reports require it to be purged'
            USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "reports_evidence_lifecycle_trigger"
AFTER INSERT OR UPDATE ON "reports"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_report_evidence_lifecycle"();

CREATE CONSTRAINT TRIGGER "report_evidence_lifecycle_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "report_evidence"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_report_evidence_lifecycle"();

CREATE FUNCTION "sinochat_validate_reassignment_request"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "current_request" "reassignment_requests"%ROWTYPE;
    "previous_client_id" UUID;
    "previous_cashier_id" UUID;
    "previous_ended_at" TIMESTAMPTZ;
    "previous_end_reason" "AssignmentEndReason";
    "block_client_id" UUID;
    "block_cashier_id" UUID;
    "block_initiator" "BlockInitiator";
    "result_client_id" UUID;
    "result_cashier_id" UUID;
    "result_previous_id" UUID;
    "result_start_reason" "AssignmentStartReason";
BEGIN
    SELECT *
      INTO "current_request"
      FROM "reassignment_requests"
     WHERE "id" = NEW."id";

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT "client_user_id", "cashier_user_id", "ended_at", "end_reason"
      INTO "previous_client_id", "previous_cashier_id", "previous_ended_at", "previous_end_reason"
      FROM "assignments"
     WHERE "id" = "current_request"."previous_assignment_id";

    IF "previous_client_id" IS NULL
       OR "previous_client_id" <> "current_request"."client_user_id"
       OR "previous_cashier_id" <> "current_request"."excluded_cashier_user_id"
       OR "previous_ended_at" IS NULL THEN
        RAISE EXCEPTION 'reassignment source must be the ended assignment for this client and excluded cashier'
            USING ERRCODE = '23514';
    END IF;

    IF "current_request"."reason" = 'CLIENT_BLOCKED_CASHIER'
       OR (
           "current_request"."reason" = 'CLIENT_REPORTED_CASHIER'
           AND "previous_end_reason" <> 'CLIENT_REPORTED_CASHIER'
       )
       OR (
           "current_request"."reason" = 'CASHIER_BLOCKED_CLIENT'
           AND "previous_end_reason" <> 'CASHIER_BLOCKED_CLIENT'
       )
       OR (
           "current_request"."reason" = 'CASHIER_UNAVAILABLE'
           AND "previous_end_reason" NOT IN ('CASHIER_UNAVAILABLE', 'CASHIER_SUSPENDED')
       )
       OR (
           "current_request"."reason" = 'ADMINISTRATIVE'
           AND "previous_end_reason" <> 'ADMINISTRATIVE'
       ) THEN
        RAISE EXCEPTION 'reassignment reason must match the previous assignment end reason'
            USING ERRCODE = '23514';
    END IF;

    IF "current_request"."trigger_block_id" IS NOT NULL THEN
        SELECT "client_user_id", "cashier_user_id", "initiated_by"
          INTO "block_client_id", "block_cashier_id", "block_initiator"
          FROM "blocks"
         WHERE "id" = "current_request"."trigger_block_id";

        IF "block_client_id" <> "current_request"."client_user_id"
           OR "block_cashier_id" <> "current_request"."excluded_cashier_user_id"
           OR (
               "current_request"."reason" = 'CASHIER_BLOCKED_CLIENT'
               AND "block_initiator" <> 'CASHIER'
           )
           OR (
               "current_request"."reason" IN ('CLIENT_BLOCKED_CASHIER', 'CLIENT_REPORTED_CASHIER')
               AND "block_initiator" <> 'CLIENT'
           ) THEN
            RAISE EXCEPTION 'reassignment block must match the client and excluded cashier'
                USING ERRCODE = '23514';
        END IF;
    ELSIF "current_request"."reason" IN ('CLIENT_BLOCKED_CASHIER', 'CLIENT_REPORTED_CASHIER', 'CASHIER_BLOCKED_CLIENT') THEN
        RAISE EXCEPTION 'block-triggered reassignments require their block record'
            USING ERRCODE = '23514';
    END IF;

    IF "current_request"."status" = 'PENDING'
       AND EXISTS (
           SELECT 1
             FROM "assignments"
            WHERE "client_user_id" = "current_request"."client_user_id"
              AND "ended_at" IS NULL
       ) THEN
        RAISE EXCEPTION 'a pending reassignment cannot coexist with an active assignment'
            USING ERRCODE = '23514';
    END IF;

    IF "current_request"."status" = 'COMPLETED' THEN
        SELECT "client_user_id", "cashier_user_id", "previous_assignment_id", "start_reason"
          INTO "result_client_id", "result_cashier_id", "result_previous_id", "result_start_reason"
          FROM "assignments"
         WHERE "id" = "current_request"."resulting_assignment_id";

        IF "result_client_id" <> "current_request"."client_user_id"
           OR "result_cashier_id" = "current_request"."excluded_cashier_user_id"
           OR "result_previous_id" <> "current_request"."previous_assignment_id"
           OR (
               "current_request"."reason" = 'CLIENT_REPORTED_CASHIER'
               AND "result_start_reason" <> 'CLIENT_REPORTED_CASHIER'
           )
           OR (
               "current_request"."reason" = 'CASHIER_BLOCKED_CLIENT'
               AND "result_start_reason" <> 'CASHIER_BLOCKED_CLIENT'
           )
           OR (
               "current_request"."reason" = 'CASHIER_UNAVAILABLE'
               AND "result_start_reason" <> 'CASHIER_UNAVAILABLE'
           )
           OR (
               "current_request"."reason" = 'ADMINISTRATIVE'
               AND "result_start_reason" <> 'ADMINISTRATIVE'
           ) THEN
            RAISE EXCEPTION 'completed reassignment result is inconsistent'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "reassignment_requests_consistency_trigger"
AFTER INSERT OR UPDATE ON "reassignment_requests"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_reassignment_request"();

-- Cashier onboarding links are one-time administrative credentials and are
-- deliberately separate from the unlimited client invitation owned by a cashier.
CREATE FUNCTION "sinochat_enforce_cashier_onboarding_invitation_history"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."created_by_admin_user_id" <> OLD."created_by_admin_user_id"
       OR NEW."code_lookup_hash" <> OLD."code_lookup_hash"
       OR NEW."code_ciphertext" <> OLD."code_ciphertext"
       OR NEW."code_nonce" <> OLD."code_nonce"
       OR NEW."encryption_key_version" <> OLD."encryption_key_version"
       OR NEW."created_at" <> OLD."created_at"
       OR NEW."expires_at" <> OLD."expires_at"
       OR (
           OLD."redeemed_at" IS NOT NULL
           AND (
               NEW."redeemed_at" IS DISTINCT FROM OLD."redeemed_at"
               OR NEW."redeemed_by_cashier_id" IS DISTINCT FROM OLD."redeemed_by_cashier_id"
           )
       )
       OR (
           OLD."revoked_at" IS NOT NULL
           AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
       ) THEN
        RAISE EXCEPTION 'cashier onboarding invitation history is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "cashier_onboarding_invitations_history_trigger"
BEFORE UPDATE ON "cashier_onboarding_invitations"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_cashier_onboarding_invitation_history"();

-- Invitation identifiers and ciphertext are immutable. Regeneration creates a new
-- row and revokes the old one, preserving auditability without plaintext codes.
CREATE FUNCTION "sinochat_enforce_invitation_history"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."cashier_user_id" <> OLD."cashier_user_id"
       OR NEW."code_lookup_hash" <> OLD."code_lookup_hash"
       OR NEW."code_ciphertext" <> OLD."code_ciphertext"
       OR NEW."code_nonce" <> OLD."code_nonce"
       OR NEW."encryption_key_version" <> OLD."encryption_key_version"
       OR NEW."created_at" <> OLD."created_at"
       OR (
           OLD."revoked_at" IS NOT NULL
           AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
       ) THEN
        RAISE EXCEPTION 'invitation history is immutable except for first revocation'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "cashier_invitations_history_trigger"
BEFORE UPDATE ON "cashier_invitations"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_invitation_history"();

-- Durable compliance records are append-only. Terms may only be retired once;
-- acceptances and administrative audit events can never be rewritten or removed.
CREATE FUNCTION "sinochat_reject_ledger_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "terms_acceptances_append_only_trigger"
BEFORE UPDATE OR DELETE ON "terms_acceptances"
FOR EACH ROW EXECUTE FUNCTION "sinochat_reject_ledger_mutation"();

CREATE TRIGGER "admin_audit_events_append_only_trigger"
BEFORE UPDATE OR DELETE ON "admin_audit_events"
FOR EACH ROW EXECUTE FUNCTION "sinochat_reject_ledger_mutation"();

CREATE FUNCTION "sinochat_enforce_terms_document_history"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'published terms cannot be deleted'
            USING ERRCODE = '23514';
    END IF;

    IF NEW."version" <> OLD."version"
       OR NEW."content_hash" <> OLD."content_hash"
       OR NEW."effective_at" <> OLD."effective_at"
       OR NEW."created_at" <> OLD."created_at"
       OR (
           OLD."retired_at" IS NOT NULL
           AND NEW."retired_at" IS DISTINCT FROM OLD."retired_at"
       ) THEN
        RAISE EXCEPTION 'published terms are immutable except for first retirement'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "terms_documents_history_trigger"
BEFORE UPDATE OR DELETE ON "terms_documents"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_terms_document_history"();

-- A session or recovery bundle may only reference a device owned by the same
-- account. Composite ownership is enforced here because nullable composite
-- relations cannot use SET NULL safely in the ORM schema.
CREATE FUNCTION "sinochat_enforce_owned_device_reference"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "candidate_device_id" UUID;
BEGIN
    "candidate_device_id" := CASE
        WHEN TG_TABLE_NAME = 'auth_sessions' THEN NEW."device_id"
        ELSE NEW."source_device_id"
    END;

    IF "candidate_device_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
             FROM "devices"
            WHERE "id" = "candidate_device_id"
              AND "user_id" = NEW."user_id"
       ) THEN
        RAISE EXCEPTION 'referenced device must belong to the same user'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "auth_sessions_device_owner_trigger"
BEFORE INSERT OR UPDATE OF "device_id", "user_id" ON "auth_sessions"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_owned_device_reference"();

CREATE TRIGGER "encrypted_key_bundles_device_owner_trigger"
BEFORE INSERT OR UPDATE OF "source_device_id", "user_id" ON "encrypted_key_bundles"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_owned_device_reference"();

-- Public key material and encrypted payloads are immutable. Rotation creates a
-- new row; only lifecycle timestamps may advance.
CREATE FUNCTION "sinochat_enforce_device_key_history"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."user_id" <> OLD."user_id"
       OR NEW."registration_id" <> OLD."registration_id"
       OR NEW."identity_public_key" <> OLD."identity_public_key"
       OR NEW."identity_key_fingerprint" <> OLD."identity_key_fingerprint"
       OR NEW."signed_pre_key_id" <> OLD."signed_pre_key_id"
       OR NEW."signed_pre_key_public" <> OLD."signed_pre_key_public"
       OR NEW."signed_pre_key_signature" <> OLD."signed_pre_key_signature"
       OR NEW."protocol_version" <> OLD."protocol_version"
       OR NEW."created_at" <> OLD."created_at"
       OR (OLD."status" = 'REVOKED' AND NEW."status" <> 'REVOKED')
       OR (OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at")
       OR (NEW."status" = 'REVOKED' AND NEW."revoked_at" IS NULL) THEN
        RAISE EXCEPTION 'device cryptographic identity is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "devices_key_history_trigger"
BEFORE UPDATE ON "devices"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_device_key_history"();

CREATE FUNCTION "sinochat_enforce_pre_key_history"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."device_id" <> OLD."device_id"
       OR NEW."key_id" <> OLD."key_id"
       OR NEW."public_key" <> OLD."public_key"
       OR NEW."signature" IS DISTINCT FROM OLD."signature"
       OR NEW."created_at" <> OLD."created_at"
       OR (OLD."claimed_at" IS NOT NULL AND NEW."claimed_at" IS DISTINCT FROM OLD."claimed_at")
       OR (OLD."claimed_at" IS NULL AND NEW."claimed_at" IS NULL) THEN
        RAISE EXCEPTION 'one-time pre-key history is immutable except for first claim'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "one_time_pre_keys_history_trigger"
BEFORE UPDATE ON "one_time_pre_keys"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_pre_key_history"();

CREATE FUNCTION "sinochat_enforce_recovery_bundle_history"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."user_id" <> OLD."user_id"
       OR NEW."source_device_id" IS DISTINCT FROM OLD."source_device_id"
       OR NEW."version" <> OLD."version"
       OR NEW."protection" <> OLD."protection"
       OR NEW."cipher_suite" <> OLD."cipher_suite"
       OR NEW."ciphertext" <> OLD."ciphertext"
       OR NEW."nonce" <> OLD."nonce"
       OR NEW."salt" IS DISTINCT FROM OLD."salt"
       OR NEW."kdf_algorithm" IS DISTINCT FROM OLD."kdf_algorithm"
       OR NEW."kdf_parameters" IS DISTINCT FROM OLD."kdf_parameters"
       OR NEW."created_at" <> OLD."created_at"
       OR (OLD."superseded_at" IS NOT NULL AND NEW."superseded_at" IS DISTINCT FROM OLD."superseded_at")
       OR (OLD."superseded_at" IS NULL AND NEW."superseded_at" IS NULL) THEN
        RAISE EXCEPTION 'encrypted recovery bundle history is immutable except for supersession'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "encrypted_key_bundles_history_trigger"
BEFORE UPDATE ON "encrypted_key_bundles"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_recovery_bundle_history"();

CREATE TRIGGER "message_envelopes_immutable_trigger"
BEFORE UPDATE ON "message_envelopes"
FOR EACH ROW EXECUTE FUNCTION "sinochat_reject_ledger_mutation"();

-- Reports are never deleted or reopened. Closing purges the immutable evidence
-- row, while later allowing exactly one subject-notification timestamp.
CREATE FUNCTION "sinochat_enforce_report_history"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'reports cannot be deleted'
            USING ERRCODE = '23514';
    END IF;

    IF NEW."block_id" <> OLD."block_id"
       OR NEW."created_at" <> OLD."created_at"
       OR (OLD."status" = 'OPEN' AND NEW."status" NOT IN ('OPEN', 'IN_REVIEW'))
       OR (OLD."status" = 'IN_REVIEW' AND NEW."status" NOT IN ('IN_REVIEW', 'CLOSED'))
       OR (OLD."status" = 'CLOSED' AND NEW."status" <> 'CLOSED')
       OR (
           OLD."reviewed_by_admin_user_id" IS NOT NULL
           AND NEW."reviewed_by_admin_user_id" IS DISTINCT FROM OLD."reviewed_by_admin_user_id"
       )
       OR (
           OLD."review_started_at" IS NOT NULL
           AND NEW."review_started_at" IS DISTINCT FROM OLD."review_started_at"
       )
       OR (
           OLD."subject_notified_at" IS NOT NULL
           AND NEW."subject_notified_at" IS DISTINCT FROM OLD."subject_notified_at"
       )
       OR (
           OLD."status" = 'CLOSED'
           AND (
               NEW."outcome" IS DISTINCT FROM OLD."outcome"
               OR NEW."resolution_summary" IS DISTINCT FROM OLD."resolution_summary"
               OR NEW."closed_at" IS DISTINCT FROM OLD."closed_at"
               OR NEW."evidence_purged_at" IS DISTINCT FROM OLD."evidence_purged_at"
           )
       ) THEN
        RAISE EXCEPTION 'report history is monotonic and cannot be deleted or reopened'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "reports_history_trigger"
BEFORE UPDATE OR DELETE ON "reports"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_report_history"();

CREATE FUNCTION "sinochat_enforce_report_evidence_history"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "parent_status" "ReportStatus";
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'report evidence is immutable'
            USING ERRCODE = '23514';
    END IF;

    SELECT "status"
      INTO "parent_status"
      FROM "reports"
     WHERE "id" = OLD."report_id";

    IF "parent_status" NOT IN ('IN_REVIEW', 'CLOSED') THEN
        RAISE EXCEPTION 'report evidence may only be purged during closure'
            USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER "report_evidence_history_trigger"
BEFORE UPDATE OR DELETE ON "report_evidence"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_report_evidence_history"();

CREATE FUNCTION "sinochat_enforce_account_review_history"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'account reviews cannot be deleted'
            USING ERRCODE = '23514';
    END IF;

    IF NEW."client_user_id" <> OLD."client_user_id"
       OR NEW."reason" <> OLD."reason"
       OR NEW."opened_at" <> OLD."opened_at"
       OR (OLD."status" = 'OPEN' AND NEW."status" NOT IN ('OPEN', 'IN_REVIEW'))
       OR (OLD."status" = 'IN_REVIEW' AND NEW."status" NOT IN ('IN_REVIEW', 'CLOSED'))
       OR (OLD."status" = 'CLOSED' AND NEW."status" <> 'CLOSED')
       OR (
           OLD."status" = 'CLOSED'
           AND (
               NEW."outcome" IS DISTINCT FROM OLD."outcome"
               OR NEW."resolution_summary" IS DISTINCT FROM OLD."resolution_summary"
               OR NEW."closed_at" IS DISTINCT FROM OLD."closed_at"
           )
       ) THEN
        RAISE EXCEPTION 'account review history is monotonic and cannot be deleted or reopened'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "account_reviews_history_trigger"
BEFORE UPDATE OR DELETE ON "account_reviews"
FOR EACH ROW EXECUTE FUNCTION "sinochat_enforce_account_review_history"();

-- Upload grants are persisted before the browser sends ciphertext so abandoned
-- photos can be discovered and deleted even when no Message row is created.
CREATE TABLE "pending_attachment_uploads" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "object_key" VARCHAR(512) NOT NULL,
    "declared_mime_type" VARCHAR(32) NOT NULL,
    "plaintext_byte_size" INTEGER NOT NULL,
    "ciphertext_byte_size" INTEGER NOT NULL,
    "ciphertext_sha256" CHAR(64) NOT NULL,
    "grant_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "purge_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_purge_attempt_at" TIMESTAMPTZ(6),
    "last_purge_error_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_attachment_uploads_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pending_attachment_uploads_mime_check"
        CHECK ("declared_mime_type" IN ('image/jpeg', 'image/png', 'image/webp')),
    CONSTRAINT "pending_attachment_uploads_plaintext_size_check"
        CHECK ("plaintext_byte_size" BETWEEN 1 AND 5242880),
    CONSTRAINT "pending_attachment_uploads_ciphertext_size_check"
        CHECK ("ciphertext_byte_size" BETWEEN 1 AND 5505024),
    CONSTRAINT "pending_attachment_uploads_hash_check"
        CHECK ("ciphertext_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "pending_attachment_uploads_expiration_check"
        CHECK ("grant_expires_at" > "created_at"),
    CONSTRAINT "pending_attachment_uploads_purge_attempts_check"
        CHECK ("purge_attempts" >= 0)
);

CREATE UNIQUE INDEX "pending_attachment_uploads_object_key_key"
    ON "pending_attachment_uploads"("object_key");
CREATE INDEX "pending_attachment_uploads_expires_idx"
    ON "pending_attachment_uploads"("grant_expires_at");
CREATE INDEX "pending_attachment_uploads_owner_conversation_idx"
    ON "pending_attachment_uploads"("user_id", "conversation_id");

ALTER TABLE "pending_attachment_uploads"
    ADD CONSTRAINT "pending_attachment_uploads_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "pending_attachment_uploads_conversation_id_fkey"
        FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION "sinochat_validate_pending_attachment_upload"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW."user_id" <> OLD."user_id"
           OR NEW."conversation_id" <> OLD."conversation_id"
           OR NEW."object_key" <> OLD."object_key"
           OR NEW."declared_mime_type" <> OLD."declared_mime_type"
           OR NEW."plaintext_byte_size" <> OLD."plaintext_byte_size"
           OR NEW."ciphertext_byte_size" <> OLD."ciphertext_byte_size"
           OR NEW."ciphertext_sha256" <> OLD."ciphertext_sha256"
           OR NEW."grant_expires_at" <> OLD."grant_expires_at"
           OR NEW."created_at" <> OLD."created_at" THEN
            RAISE EXCEPTION 'pending upload grant identity is immutable'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM "conversations" c
          JOIN "assignments" a ON a."id" = c."assignment_id"
         WHERE c."id" = NEW."conversation_id"
           AND c."status" = 'ACTIVE'
           AND a."ended_at" IS NULL
           AND NEW."user_id" IN (a."client_user_id", a."cashier_user_id")
    ) THEN
        RAISE EXCEPTION 'pending upload must belong to an active conversation participant'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "pending_attachment_uploads_validation_trigger"
BEFORE INSERT OR UPDATE ON "pending_attachment_uploads"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_pending_attachment_upload"();

CREATE TABLE "pending_report_evidence_uploads" (
    "id" UUID NOT NULL,
    "client_user_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "investigation_key_id" UUID NOT NULL,
    "object_key" VARCHAR(512) NOT NULL,
    "ciphertext_byte_size" INTEGER NOT NULL,
    "ciphertext_sha256" CHAR(64) NOT NULL,
    "cipher_suite" VARCHAR(64) NOT NULL,
    "manifest_version" INTEGER NOT NULL,
    "grant_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "purge_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_purge_attempt_at" TIMESTAMPTZ(6),
    "last_purge_error_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_report_evidence_uploads_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pending_report_evidence_uploads_size_check"
        CHECK ("ciphertext_byte_size" BETWEEN 1 AND 536870912),
    CONSTRAINT "pending_report_evidence_uploads_hash_check"
        CHECK ("ciphertext_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "pending_report_evidence_uploads_cipher_suite_check"
        CHECK ("cipher_suite" ~ '^[A-Za-z0-9._+/-]{3,64}$'),
    CONSTRAINT "pending_report_evidence_uploads_manifest_version_check"
        CHECK ("manifest_version" > 0),
    CONSTRAINT "pending_report_evidence_uploads_expiration_check"
        CHECK ("grant_expires_at" > "created_at"),
    CONSTRAINT "pending_report_evidence_uploads_purge_attempts_check"
        CHECK ("purge_attempts" >= 0)
);

CREATE UNIQUE INDEX "pending_report_evidence_uploads_object_key_key"
    ON "pending_report_evidence_uploads"("object_key");
CREATE INDEX "pending_report_evidence_uploads_expires_idx"
    ON "pending_report_evidence_uploads"("grant_expires_at");
CREATE INDEX "pending_report_evidence_uploads_owner_assignment_idx"
    ON "pending_report_evidence_uploads"("client_user_id", "assignment_id");

ALTER TABLE "pending_report_evidence_uploads"
    ADD CONSTRAINT "pending_report_evidence_uploads_client_user_id_fkey"
        FOREIGN KEY ("client_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "pending_report_evidence_uploads_assignment_id_fkey"
        FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "pending_report_evidence_uploads_conversation_id_fkey"
        FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "pending_report_evidence_uploads_investigation_key_id_fkey"
        FOREIGN KEY ("investigation_key_id") REFERENCES "investigation_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "sinochat_validate_pending_report_evidence_upload"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW."client_user_id" <> OLD."client_user_id"
           OR NEW."assignment_id" <> OLD."assignment_id"
           OR NEW."conversation_id" <> OLD."conversation_id"
           OR NEW."investigation_key_id" <> OLD."investigation_key_id"
           OR NEW."object_key" <> OLD."object_key"
           OR NEW."ciphertext_byte_size" <> OLD."ciphertext_byte_size"
           OR NEW."ciphertext_sha256" <> OLD."ciphertext_sha256"
           OR NEW."cipher_suite" <> OLD."cipher_suite"
           OR NEW."manifest_version" <> OLD."manifest_version"
           OR NEW."grant_expires_at" <> OLD."grant_expires_at"
           OR NEW."created_at" <> OLD."created_at" THEN
            RAISE EXCEPTION 'pending evidence upload grant identity is immutable'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM "assignments" a
          JOIN "conversations" c ON c."assignment_id" = a."id"
          JOIN "users" u ON u."id" = a."client_user_id"
         WHERE a."id" = NEW."assignment_id"
           AND a."client_user_id" = NEW."client_user_id"
           AND a."ended_at" IS NULL
           AND c."id" = NEW."conversation_id"
           AND c."status" = 'ACTIVE'
           AND u."role" = 'CLIENT'
           AND u."status" = 'ACTIVE'
    ) OR NOT EXISTS (
        SELECT 1
          FROM "investigation_keys"
         WHERE "id" = NEW."investigation_key_id"
           AND "activated_at" <= clock_timestamp()
           AND ("retired_at" IS NULL OR "retired_at" > clock_timestamp())
    ) THEN
        RAISE EXCEPTION 'pending evidence upload requires an active client conversation and investigation key'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "pending_report_evidence_uploads_validation_trigger"
BEFORE INSERT OR UPDATE ON "pending_report_evidence_uploads"
FOR EACH ROW EXECUTE FUNCTION "sinochat_validate_pending_report_evidence_upload"();
