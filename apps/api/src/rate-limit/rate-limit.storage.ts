import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit
} from "@nestjs/common";
import {
  ThrottlerStorageService,
  type ThrottlerStorage
} from "@nestjs/throttler";
import { createHmac, randomBytes } from "node:crypto";
import { createClient } from "redis";

const CONNECT_TIMEOUT_MILLISECONDS = 5_000;
const COMMAND_TIMEOUT_MILLISECONDS = 1_000;
const MAX_QUEUED_COMMANDS = 1_000;

export const RATE_LIMIT_LUA_SCRIPT = `
local clock = redis.call("TIME")
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local block_duration = tonumber(ARGV[3])
local state = redis.call("HMGET", KEYS[1], "hits", "window_end", "block_end")
local hits = tonumber(state[1]) or 0
local window_end = tonumber(state[2]) or 0
local block_end = tonumber(state[3]) or 0

if block_end > now then
  local ttl_end = math.max(window_end, block_end)
  redis.call("PEXPIREAT", KEYS[1], ttl_end)
  return {
    hits,
    math.max(1, math.ceil((window_end - now) / 1000)),
    1,
    math.max(1, math.ceil((block_end - now) / 1000))
  }
end

if block_end > 0 or window_end <= now then
  hits = 0
  window_end = now + ttl
  block_end = 0
end

hits = hits + 1
if hits > limit then
  block_end = now + block_duration
end

redis.call("HSET", KEYS[1],
  "hits", hits,
  "window_end", window_end,
  "block_end", block_end
)
redis.call("PEXPIREAT", KEYS[1], math.max(window_end, block_end))

local blocked = 0
local block_remaining = 0
if block_end > now then
  blocked = 1
  block_remaining = math.max(1, math.ceil((block_end - now) / 1000))
end

return {
  hits,
  math.max(1, math.ceil((window_end - now) / 1000)),
  blocked,
  block_remaining
}
`;

export interface RedisRateLimitClient {
  readonly isOpen: boolean;
  readonly isReady: boolean;
  connect(): Promise<unknown>;
  ping(): Promise<unknown>;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] }
  ): Promise<unknown>;
  close(): Promise<unknown>;
  destroy(): void;
  on(event: "error" | "end", listener: () => void): unknown;
}

export type RedisRateLimitClientFactory = (
  options: Parameters<typeof createClient>[0]
) => RedisRateLimitClient;

export interface RateLimitStorageOptions {
  redisUrl: string | null;
  redisPrefix: string;
  hmacSecret?: string | Buffer | null;
  commandTimeoutMilliseconds?: number;
}

export interface RateLimitRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

type StorageState =
  | "new"
  | "connecting"
  | "ready"
  | "unavailable"
  | "closing"
  | "closed";

export class RateLimitUnavailableError extends Error {
  constructor() {
    super("El servicio de control de tráfico no está disponible.");
    this.name = "RateLimitUnavailableError";
  }
}

@Injectable()
export class RateLimitStorage
  implements ThrottlerStorage, OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(RateLimitStorage.name);
  private readonly memoryStorage = new ThrottlerStorageService();
  private readonly hmacSecret: Buffer;
  private readonly clientFactory: RedisRateLimitClientFactory;
  private client?: RedisRateLimitClient;
  private state: StorageState = "new";
  private initialization?: Promise<void>;

  constructor(
    private readonly options: RateLimitStorageOptions,
    clientFactory: RedisRateLimitClientFactory = (clientOptions) =>
      createClient(clientOptions) as unknown as RedisRateLimitClient
  ) {
    this.hmacSecret = options.hmacSecret
      ? Buffer.from(options.hmacSecret)
      : randomBytes(32);
    this.clientFactory = clientFactory;
  }

  get usesRedis(): boolean {
    return Boolean(this.options.redisUrl);
  }

  async onModuleInit(): Promise<void> {
    if (!this.options.redisUrl || this.state === "ready") {
      return;
    }
    if (this.initialization) {
      return this.initialization;
    }
    if (this.state !== "new") {
      throw new RateLimitUnavailableError();
    }

    this.state = "connecting";
    this.initialization = this.initializeRedis();
    return this.initialization;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string
  ): Promise<RateLimitRecord> {
    this.assertPolicy(ttl, limit, blockDuration, throttlerName);
    const opaqueKey = this.opaqueKey(key, throttlerName);

    if (!this.options.redisUrl) {
      return this.memoryStorage.increment(
        opaqueKey,
        ttl,
        limit,
        blockDuration,
        throttlerName
      );
    }

    const client = this.client;
    if (this.state !== "ready" || !client?.isReady) {
      throw new RateLimitUnavailableError();
    }

    try {
      const rawRecord = await withTimeout(
        client.eval(RATE_LIMIT_LUA_SCRIPT, {
          keys: [`${this.options.redisPrefix}:${opaqueKey}`],
          arguments: [
            String(ttl),
            String(limit),
            String(blockDuration)
          ]
        }),
        this.options.commandTimeoutMilliseconds ??
          COMMAND_TIMEOUT_MILLISECONDS
      );
      return parseRedisRateLimitRecord(rawRecord);
    } catch {
      throw new RateLimitUnavailableError();
    }
  }

  async consume(
    scope: string,
    identity: string,
    policy: { ttl: number; limit: number; blockDuration: number }
  ): Promise<RateLimitRecord> {
    return this.increment(
      `${scope}\0${identity}`,
      policy.ttl,
      policy.limit,
      policy.blockDuration,
      scope
    );
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.state === "closing" || this.state === "closed") {
      return;
    }
    this.state = "closing";
    this.memoryStorage.onApplicationShutdown();
    const client = this.client;
    this.client = undefined;

    if (client) {
      try {
        if (client.isOpen) {
          await withTimeout(client.close(), CONNECT_TIMEOUT_MILLISECONDS);
        } else {
          client.destroy();
        }
      } catch {
        try {
          client.destroy();
        } catch {
          // El proceso debe poder terminar aunque Redis no responda.
        }
      }
    }
    this.state = "closed";
  }

  private async initializeRedis(): Promise<void> {
    const client = this.clientFactory({
      url: this.options.redisUrl!,
      socket: {
        connectTimeout: CONNECT_TIMEOUT_MILLISECONDS,
        reconnectStrategy: false
      },
      commandsQueueMaxLength: MAX_QUEUED_COMMANDS,
      disableOfflineQueue: true,
      clientInfoTag: "sinochat-rate-limit"
    });
    this.client = client;
    client.on("error", () => {
      if (this.state === "ready") {
        this.state = "unavailable";
        this.logger.error(
          "Redis de rate limit dejó de estar disponible; las solicitudes fallarán cerradas."
        );
      }
    });
    client.on("end", () => {
      if (this.state === "ready") {
        this.state = "unavailable";
      }
    });

    try {
      await withTimeout(client.connect(), CONNECT_TIMEOUT_MILLISECONDS);
      await withTimeout(client.ping(), CONNECT_TIMEOUT_MILLISECONDS);
      if (!client.isReady) {
        throw new Error("Redis no alcanzó el estado ready.");
      }
      this.state = "ready";
    } catch {
      this.state = "unavailable";
      try {
        client.destroy();
      } catch {
        // El error de inicialización que sigue es el dato relevante.
      }
      throw new RateLimitUnavailableError();
    }
  }

  private opaqueKey(key: string, throttlerName: string): string {
    return createHmac("sha256", this.hmacSecret)
      .update("sinochat-rate-limit-v1\0", "utf8")
      .update(throttlerName, "utf8")
      .update("\0", "utf8")
      .update(key, "utf8")
      .digest("hex");
  }

  private assertPolicy(
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string
  ): void {
    if (
      !Number.isSafeInteger(ttl) ||
      ttl < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(blockDuration) ||
      blockDuration < 1 ||
      !throttlerName
    ) {
      throw new Error("Política de rate limit inválida.");
    }
  }
}

export function parseRedisRateLimitRecord(
  value: unknown
): RateLimitRecord {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error("Respuesta Redis inválida.");
  }
  const values = value.map((entry) => Number(entry));
  if (
    values.some(
      (entry) => !Number.isSafeInteger(entry) || entry < 0
    ) ||
    (values[2] !== 0 && values[2] !== 1)
  ) {
    throw new Error("Respuesta Redis inválida.");
  }

  return {
    totalHits: values[0]!,
    timeToExpire: values[1]!,
    isBlocked: values[2] === 1,
    timeToBlockExpire: values[3]!
  };
}

async function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Redis excedió el timeout.")),
      milliseconds
    );
    timeout.unref();
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
