import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit
} from "@nestjs/common";
import { AssignmentsService } from "./assignments.service";

const DEFAULT_INTERVAL_MILLISECONDS = 10_000;
const MIN_INTERVAL_MILLISECONDS = 5_000;
const MAX_INTERVAL_MILLISECONDS = 60_000;
const ASSIGNMENT_BATCH_SIZE = 25;
const PENDING_BATCH_SIZE = 50;
const MAX_EXPIRY_TRANSACTIONS_PER_RUN = 8;

@Injectable()
export class SubscriptionExpiryWorker
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(SubscriptionExpiryWorker.name);
  private timer?: NodeJS.Timeout;
  private currentRun?: Promise<void>;
  private stopping = false;

  constructor(private readonly assignments: AssignmentsService) {}

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV === "test") {
      return;
    }
    if (process.env.SUBSCRIPTION_EXPIRY_WORKER_ENABLED === "false") {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "SUBSCRIPTION_EXPIRY_WORKER_ENABLED no puede desactivarse en produccion."
        );
      }
      return;
    }

    const interval = Number(
      process.env.SUBSCRIPTION_EXPIRY_WORKER_INTERVAL_MS ??
        DEFAULT_INTERVAL_MILLISECONDS
    );
    if (
      !Number.isSafeInteger(interval) ||
      interval < MIN_INTERVAL_MILLISECONDS ||
      interval > MAX_INTERVAL_MILLISECONDS
    ) {
      throw new Error(
        "SUBSCRIPTION_EXPIRY_WORKER_INTERVAL_MS debe estar entre 5000 y 60000."
      );
    }

    await this.assignments.assertDatabaseClockAvailable();
    if (process.env.NODE_ENV === "production") {
      // En produccion el proceso no queda listo si la primera conciliacion
      // no puede ejecutarse. Las conversaciones igualmente se bloquean por
      // elegibilidad en cada operacion, aun antes de esta conciliacion.
      await this.runBatch();
    } else {
      this.triggerRun();
    }

    this.timer = setInterval(() => this.triggerRun(), interval);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.currentRun;
  }

  async runBatch(): Promise<void> {
    if (this.currentRun) {
      return this.currentRun;
    }

    const operation = this.reconcileBatch();
    this.currentRun = operation;
    try {
      await operation;
    } finally {
      if (this.currentRun === operation) {
        this.currentRun = undefined;
      }
    }
  }

  private triggerRun(): void {
    if (this.stopping) {
      return;
    }
    void this.runBatch().catch((error: unknown) => {
      this.logger.error(
        JSON.stringify({
          event: "subscription_expiry_batch_failed",
          errorCode: this.errorCode(error)
        })
      );
    });
  }

  private async reconcileBatch(): Promise<void> {
    for (
      let index = 0;
      index < MAX_EXPIRY_TRANSACTIONS_PER_RUN;
      index += 1
    ) {
      const result =
        await this.assignments.reconcileNextExpiredSubscription(
          ASSIGNMENT_BATCH_SIZE
        );
      if (!result) {
        break;
      }
      this.logger.log(
        JSON.stringify({
          event: "subscription_expiry_reconciled",
          ...result
        })
      );
    }

    const pending =
      await this.assignments.reconcilePendingReassignments(
        PENDING_BATCH_SIZE
      );
    if (pending.requestsProcessed > 0) {
      this.logger.log(
        JSON.stringify({
          event: "pending_reassignments_reconciled",
          ...pending,
          continuationScheduled: pending.hasMore
        })
      );
    }
  }

  private errorCode(error: unknown): string {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
    ) {
      return error.code.slice(0, 64);
    }
    return "SUBSCRIPTION_EXPIRY_RECONCILIATION_FAILED";
  }
}
