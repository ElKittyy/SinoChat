import {
  equal,
  ok
} from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CASHIER_BLOCK_REVIEW_THRESHOLD,
  distinctCashierBlockCount,
  isSupportedEvidenceManifestVersion,
  requiresAccountReview
} from "./moderation-policy";

describe("política de moderación", () => {
  it("cuenta cajeros distintos y no eventos duplicados", () => {
    const ids = [
      "cashier-a",
      "cashier-b",
      "cashier-a",
      "cashier-c"
    ];

    equal(distinctCashierBlockCount(ids), 3);
    equal(requiresAccountReview(ids), false);
  });

  it("abre revisión exactamente desde el quinto cajero distinto", () => {
    const firstFour = ["a", "b", "c", "d"];
    const fifth = [...firstFour, "e"];

    equal(
      CASHIER_BLOCK_REVIEW_THRESHOLD,
      5
    );
    equal(requiresAccountReview(firstFour), false);
    ok(requiresAccountReview(fifth));
    ok(requiresAccountReview([...fifth, "e"]));
  });

  it("solo admite el manifiesto de evidencia implementado", () => {
    equal(isSupportedEvidenceManifestVersion(1), true);
    equal(isSupportedEvidenceManifestVersion(0), false);
    equal(isSupportedEvidenceManifestVersion(2), false);
  });
});
