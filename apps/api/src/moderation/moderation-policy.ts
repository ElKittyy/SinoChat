export const CASHIER_BLOCK_REVIEW_THRESHOLD = 5;
export const SUPPORTED_EVIDENCE_MANIFEST_VERSION = 1;

export function distinctCashierBlockCount(
  cashierUserIds: readonly string[]
): number {
  return new Set(cashierUserIds).size;
}

export function requiresAccountReview(
  cashierUserIds: readonly string[]
): boolean {
  return (
    distinctCashierBlockCount(cashierUserIds) >=
    CASHIER_BLOCK_REVIEW_THRESHOLD
  );
}

export function isSupportedEvidenceManifestVersion(
  version: number
): boolean {
  return version === SUPPORTED_EVIDENCE_MANIFEST_VERSION;
}
