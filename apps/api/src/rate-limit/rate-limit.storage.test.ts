import {
  deepEqual,
  equal,
  match,
  rejects
} from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RATE_LIMIT_LUA_SCRIPT,
  RateLimitStorage,
  RateLimitUnavailableError,
  parseRedisRateLimitRecord,
  type RedisRateLimitClient
} from "./rate-limit.storage";

describe("RateLimitStorage", () => {
  it("ejecuta un contador Lua atómico y no expone la identidad en la clave", async () => {
    const client = new FakeRedisClient([3, 42, 1, 12]);
    const storage = createRedisStorage(client);
    await storage.onModuleInit();

    const record = await storage.consume(
      "ws-connect-ip",
      "203.0.113.10",
      { ttl: 60_000, limit: 2, blockDuration: 30_000 }
    );

    deepEqual(record, {
      totalHits: 3,
      timeToExpire: 42,
      isBlocked: true,
      timeToBlockExpire: 12
    });
    equal(client.evalCalls.length, 1);
    const call = client.evalCalls[0]!;
    equal(call.script, RATE_LIMIT_LUA_SCRIPT);
    equal(call.options.arguments.join(","), "60000,2,30000");
    equal(call.options.keys.length, 1);
    match(call.options.keys[0]!, /^sinochat:test:rate-limit:[0-9a-f]{64}$/);
    equal(call.options.keys[0]!.includes("203.0.113.10"), false);
    match(RATE_LIMIT_LUA_SCRIPT, /redis\.call\("TIME"\)/);
    match(RATE_LIMIT_LUA_SCRIPT, /redis\.call\("HSET"/);
    match(RATE_LIMIT_LUA_SCRIPT, /redis\.call\("PEXPIREAT"/);
  });

  it("parsea solo la forma segura esperada", () => {
    deepEqual(parseRedisRateLimitRecord(["1", 60, 0, 0]), {
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0
    });
    for (const invalid of [
      null,
      [1, 2, 0],
      [-1, 2, 0, 0],
      [1, 2, 2, 0],
      [1, Number.NaN, 0, 0]
    ]) {
      let failed = false;
      try {
        parseRedisRateLimitRecord(invalid);
      } catch {
        failed = true;
      }
      equal(failed, true);
    }
  });

  it("falla cerrado si Redis no inició, responde mal o rechaza el comando", async () => {
    const notStarted = createRedisStorage(new FakeRedisClient([1, 1, 0, 0]));
    await rejects(
      () =>
        notStarted.increment("key", 1_000, 1, 1_000, "default"),
      RateLimitUnavailableError
    );

    const malformed = createRedisStorage(new FakeRedisClient([1, 2]));
    await malformed.onModuleInit();
    await rejects(
      () => malformed.increment("key", 1_000, 1, 1_000, "default"),
      RateLimitUnavailableError
    );

    const rejectedClient = new FakeRedisClient([1, 1, 0, 0]);
    rejectedClient.evalError = new Error("secret provider detail");
    const rejected = createRedisStorage(rejectedClient);
    await rejected.onModuleInit();
    await rejects(
      () => rejected.increment("key", 1_000, 1, 1_000, "default"),
      (error: unknown) =>
        error instanceof RateLimitUnavailableError &&
        !error.message.includes("provider detail")
    );
  });

  it("mantiene almacenamiento local en desarrollo sin Redis", async () => {
    const storage = new RateLimitStorage({
      redisUrl: null,
      redisPrefix: "sinochat:test:rate-limit",
      hmacSecret: "r".repeat(32)
    });
    const first = await storage.increment(
      "identity",
      10_000,
      1,
      10_000,
      "default"
    );
    const second = await storage.increment(
      "identity",
      10_000,
      1,
      10_000,
      "default"
    );
    equal(first.isBlocked, false);
    equal(second.isBlocked, true);
    await storage.onApplicationShutdown();
  });
});

function createRedisStorage(client: FakeRedisClient): RateLimitStorage {
  return new RateLimitStorage(
    {
      redisUrl: "redis://localhost:6379/0",
      redisPrefix: "sinochat:test:rate-limit",
      hmacSecret: "r".repeat(32)
    },
    () => client
  );
}

class FakeRedisClient implements RedisRateLimitClient {
  isOpen = false;
  isReady = false;
  evalError?: Error;
  readonly evalCalls: Array<{
    script: string;
    options: { keys: string[]; arguments: string[] };
  }> = [];

  constructor(private readonly reply: unknown) {}

  async connect(): Promise<void> {
    this.isOpen = true;
    this.isReady = true;
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  async eval(
    script: string,
    options: { keys: string[]; arguments: string[] }
  ): Promise<unknown> {
    this.evalCalls.push({ script, options });
    if (this.evalError) {
      throw this.evalError;
    }
    return this.reply;
  }

  async close(): Promise<void> {
    this.isOpen = false;
    this.isReady = false;
  }

  destroy(): void {
    this.isOpen = false;
    this.isReady = false;
  }

  on(_event: "error" | "end", _listener: () => void): this {
    return this;
  }
}
