import { RequestType, type Sas, type ToDeviceRequest } from "@matrix-org/matrix-sdk-crypto-wasm";

type SasRequest = Awaited<ReturnType<Sas["confirm"]>>[number];
type ComparisonState = "waiting" | "waiting-peer" | "comparison-complete" | "cancelled" | "expired" | "failed" | "closed";
export type MatrixSasComparisonView =
  | Readonly<{ state: ComparisonState }>
  | Readonly<{ state: "compare"; comparisonId: string; decimals: readonly [number, number, number] }>;

export interface MatrixSasComparisonScope {
  userId: string;
  deviceId: string;
  otherDeviceId: string;
  flowId: string;
  expiresAtMs: number;
}

/** Must use the SAME exclusive queue as all other operations on the OlmMachine. */
export interface MatrixSasComparisonChannel {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
  /** Future quarantine transport, NOT the existing conversation to-device route.
   * Resolve only after validated transport success and the real SDK ACK.
   * The comparison controller retains/frees the request wrapper. */
  send(request: ToDeviceRequest, signal: AbortSignal): Promise<void>;
}

export class MatrixSasComparisonError extends Error {
  constructor(readonly code: string) { super(code); this.name = "MatrixSasComparisonError"; }
}

/**
 * Presentation/explicit-confirmation phase of an existing SDK self-SAS flow.
 * Does not start a handshake, activate a device, publish certificates, recover
 * secrets or grant chat access. "comparison-complete" is NOT server approval.
 * Caller transfers ownership of Sas after successful construction and MUST close
 * on logout/unmount. No callbacks or codes are saved in persistent storage.
 */
export class MatrixSasComparison {
  private readonly scope: Readonly<MatrixSasComparisonScope>;
  private readonly startedAt: number;
  private readonly duration: number;
  private readonly abort = new AbortController();
  private readonly confirmationAbort = new AbortController();
  private readonly deadlineTimer: ReturnType<typeof setTimeout>;
  private cancelRequested?: string;
  private terminal?: "cancelled" | "expired" | "failed" | "closed";
  private displayed?: { id: string; decimals: [number, number, number] };
  private confirmedHere = false;
  private freed = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly sas: Sas,
    scope: MatrixSasComparisonScope,
    private readonly channel: MatrixSasComparisonChannel,
    private readonly clock = { wall: () => Date.now(), monotonic: () => performance.now() },
  ) {
    const now = clock.wall();
    this.startedAt = clock.monotonic();
    this.duration = scope.expiresAtMs - now;
    if (!/^@u[0-9a-f]{32}:[^\s/@]{1,255}$/.test(scope.userId) ||
      !/^D[0-9A-F]{32}$/.test(scope.deviceId) || !/^D[0-9A-F]{32}$/.test(scope.otherDeviceId) ||
      scope.deviceId === scope.otherDeviceId || typeof scope.flowId !== "string" ||
      !/^[A-Za-z0-9._~-]{1,255}$/.test(scope.flowId) || !Number.isSafeInteger(scope.expiresAtMs) ||
      !Number.isFinite(now) || !Number.isFinite(this.startedAt) || this.duration <= 0 || this.duration > 600_000) {
      fail("MATRIX_SAS_SCOPE_INVALID");
    }
    this.scope = Object.freeze({ ...scope });
    this.deadlineTimer = setTimeout(() => {
      if (this.terminal) return;
      this.terminal = "expired";
      this.displayed = undefined;
      this.abort.abort();
      // Abort I/O immediately, but mutate Rust Crypto only under its queue.
      void this.channel.runExclusive(async () => {
        if (!this.freed && this.terminal === "expired") this.cancelSdkLocally("m.timeout");
      }).catch(() => { /* Remain expired; never expose SDK details. */ });
    }, this.duration);
  }

  read(): Promise<MatrixSasComparisonView> {
    return this.exclusive(() => Promise.resolve(this.view()));
  }

  /** Only call from an explicit user action after displaying these exact values. */
  confirm(comparisonId: string): Promise<MatrixSasComparisonView> {
    return this.exclusive(async () => {
      const previouslyDisplayed = this.displayed;
      const current = this.view();
      if (current.state !== "compare" || !previouslyDisplayed ||
        comparisonId !== previouslyDisplayed.id || current.comparisonId !== comparisonId) {
        fail("MATRIX_SAS_COMPARISON_STALE");
      }
      this.displayed = undefined;
      // Consumed before any asynchronous effect; a queued double click cannot
      // confirm twice. SDK/HTTP failure is terminal, never an automatic retry.
      this.confirmedHere = true;
      await this.sendRequests(await this.sas.confirm());
      return this.view();
    });
  }

  reject(): Promise<MatrixSasComparisonView> { return this.cancelWithCode("m.mismatched_sas"); }
  cancel(): Promise<MatrixSasComparisonView> { return this.cancelWithCode("m.user"); }

  close(): Promise<void> {
    this.terminal = "closed";
    clearTimeout(this.deadlineTimer);
    this.displayed = undefined;
    this.abort.abort();
    this.closePromise ??= this.channel.runExclusive(async () => {
      if (!this.freed) {
        try { this.cancelSdkLocally("m.user"); }
        finally { this.freed = true; this.sas.free(); }
      }
    });
    return this.closePromise;
  }

  private cancelWithCode(code: string): Promise<MatrixSasComparisonView> {
    // An intent to cancel must stop a confirmation already waiting on I/O,
    // without mutating the machine outside the shared exclusive queue.
    if (!this.terminal) {
      this.cancelRequested ??= code;
      this.displayed = undefined;
      this.confirmationAbort.abort();
    }
    return this.exclusive(async () => {
      const current = this.view();
      if (this.terminal) return current;
      this.displayed = undefined;
      this.terminal = "cancelled";
      clearTimeout(this.deadlineTimer);
      const request = this.sas.cancelWithCode(this.cancelRequested!);
      if (request) await this.sendRequests([request], true);
      return Object.freeze({ state: "cancelled" });
    });
  }

  private view(): MatrixSasComparisonView {
    if (this.terminal) return Object.freeze({ state: this.terminal });
    this.assertBound();
    const wall = this.clock.wall(), monotonic = this.clock.monotonic();
    if (!Number.isFinite(wall) || !Number.isFinite(monotonic) || monotonic < this.startedAt ||
      wall >= this.scope.expiresAtMs || monotonic - this.startedAt >= this.duration || this.sas.timedOut()) {
      this.terminal = "expired";
      this.displayed = undefined;
      clearTimeout(this.deadlineTimer);
      this.abort.abort();
      this.cancelSdkLocally("m.timeout");
      return Object.freeze({ state: "expired" });
    }
    if (this.cancelRequested) return Object.freeze({ state: "cancelled" });
    if (this.sas.isCancelled()) {
      this.terminal = "cancelled";
      clearTimeout(this.deadlineTimer);
      this.displayed = undefined;
      return Object.freeze({ state: "cancelled" });
    }
    if (this.sas.isDone()) {
      if (!this.confirmedHere || !this.sas.haveWeConfirmed()) fail("MATRIX_SAS_UNCONFIRMED_COMPLETION");
      this.displayed = undefined;
      return Object.freeze({ state: "comparison-complete" });
    }
    if (this.confirmedHere || this.sas.haveWeConfirmed()) {
      if (!this.confirmedHere) fail("MATRIX_SAS_UNCONFIRMED_COMPLETION");
      return Object.freeze({ state: "waiting-peer" });
    }
    if (!this.sas.canBePresented()) {
      this.displayed = undefined;
      return Object.freeze({ state: "waiting" });
    }
    const decimals = this.sas.decimals();
    if (!decimals || decimals.length !== 3 ||
      Array.from(decimals).some((n) => !Number.isInteger(n) || n < 1000 || n > 9191)) {
      fail("MATRIX_SAS_DECIMALS_INVALID");
    }
    const values: [number, number, number] = [decimals[0]!, decimals[1]!, decimals[2]!];
    if (!this.displayed || this.displayed.decimals.some((n, i) => n !== values[i])) {
      this.displayed = { id: crypto.randomUUID(), decimals: values };
    }
    return Object.freeze({ state: "compare", comparisonId: this.displayed.id,
      decimals: Object.freeze([...this.displayed.decimals] as [number, number, number]) });
  }

  private assertBound(): void {
    const handles = [this.sas.userId, this.sas.deviceId, this.sas.otherUserId, this.sas.otherDeviceId];
    const room = this.sas.roomId;
    try {
      if (handles.map((id) => id.toString()).join("\n") !==
        [this.scope.userId, this.scope.deviceId, this.scope.userId, this.scope.otherDeviceId].join("\n") ||
        this.sas.flowId !== this.scope.flowId || room !== undefined || !this.sas.isSelfVerification() ||
        !this.sas.startedFromRequest()) fail("MATRIX_SAS_FLOW_MISMATCH");
    } finally { handles.forEach((id) => id.free()); room?.free(); }
  }

  private async sendRequests(requests: SasRequest[], cancelling = false): Promise<void> {
    try {
      for (const request of requests) {
        if (request.type !== RequestType.ToDevice || !request.id ||
          !(cancelling ? ["m.key.verification.cancel"] : ["m.key.verification.mac", "m.key.verification.done"])
            .includes(request.event_type)) {
          fail("MATRIX_SAS_OUTGOING_INVALID");
        }
        let body;
        try { body = JSON.parse(request.body); } catch { fail("MATRIX_SAS_OUTGOING_INVALID"); }
        if (!body || Object.keys(body).join() !== "messages" || !body.messages ||
          Object.keys(body.messages).join() !== this.scope.userId ||
          Object.keys(body.messages[this.scope.userId] ?? {}).join() !== this.scope.otherDeviceId ||
          body.messages[this.scope.userId][this.scope.otherDeviceId]?.transaction_id !== this.scope.flowId) {
          fail("MATRIX_SAS_OUTGOING_INVALID");
        }
      }
      for (const request of requests) {
        // Recheck after previous I/O too. Closing/expiry never sends a later packet.
        if (this.terminal === "closed" || this.terminal === "expired") break;
        this.assertBound();
        if (!cancelling && ["cancelled", "expired", "failed", "closed"].includes(this.view().state)) break;
        const signal = cancelling ? this.abort.signal : AbortSignal.any([this.abort.signal, this.confirmationAbort.signal]);
        await this.channel.send(request as ToDeviceRequest, signal);
      }
    } finally { for (const request of requests) request.free(); }
  }

  private cancelSdkLocally(code: string): void {
    if (this.sas.isDone() || this.sas.isCancelled()) return;
    // Teardown/timeout never sends on an invalid session. Cancel in the SDK so
    // a later inbound MAC cannot complete an abandoned, still-live flow.
    const request = this.sas.cancelWithCode(code);
    request?.free();
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.channel.runExclusive(async () => {
      try { return await operation(); }
      catch (error) {
        if (error instanceof MatrixSasComparisonError && error.code === "MATRIX_SAS_COMPARISON_STALE") throw error;
        if (!this.terminal && !this.cancelRequested) this.terminal = "failed";
        this.displayed = undefined;
        if (this.terminal === "failed") {
          clearTimeout(this.deadlineTimer);
          this.abort.abort();
          try { this.cancelSdkLocally("m.user"); } catch { /* Preserve the original safe failure. */ }
        }
        throw error instanceof MatrixSasComparisonError ? error : new MatrixSasComparisonError("MATRIX_SAS_OPERATION_FAILED");
      }
    });
  }
}

function fail(code: string): never { throw new MatrixSasComparisonError(code); }
