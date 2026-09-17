import { equal } from "node:assert/strict";
import { describe, it } from "node:test";
import { AssignmentsService } from "./assignments.service";
import { SubscriptionExpiryWorker } from "./subscription-expiry.worker";

describe("SubscriptionExpiryWorker", () => {
  it("continua vencimientos y reprograma pendientes al llenar el lote", async () => {
    let expiryCalls = 0;
    let pendingCalls = 0;
    const assignments = {
      reconcileNextExpiredSubscription: async () => {
        expiryCalls += 1;
        if (expiryCalls === 1) {
          return {
            subscriptionId: "suscripcion",
            cashierUserId: "cajero",
            assignmentsProcessed: 25,
            reassigned: 25,
            pending: 0,
            subscriptionExpired: false,
            hasMore: true
          };
        }
        return null;
      },
      reconcilePendingReassignments: async () => {
        pendingCalls += 1;
        return pendingCalls === 1
          ? {
              requestsProcessed: 50,
              reassigned: 50,
              stillPending: 0,
              hasMore: true
            }
          : {
              requestsProcessed: 12,
              reassigned: 12,
              stillPending: 0,
              hasMore: false
            };
      }
    } as unknown as AssignmentsService;
    const worker = new SubscriptionExpiryWorker(assignments);

    await worker.runBatch();
    equal(expiryCalls, 2);
    equal(pendingCalls, 1);

    await worker.runBatch();
    equal(expiryCalls, 3);
    equal(pendingCalls, 2);
  });

  it("no superpone dos ejecuciones dentro de una instancia", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let expiryCalls = 0;
    const assignments = {
      reconcileNextExpiredSubscription: async () => {
        expiryCalls += 1;
        await gate;
        return null;
      },
      reconcilePendingReassignments: async () => ({
        requestsProcessed: 0,
        reassigned: 0,
        stillPending: 0,
        hasMore: false
      })
    } as unknown as AssignmentsService;
    const worker = new SubscriptionExpiryWorker(assignments);

    const first = worker.runBatch();
    const second = worker.runBatch();
    await Promise.resolve();
    equal(expiryCalls, 1);
    release();
    await Promise.all([first, second]);
    equal(expiryCalls, 1);
  });
});
