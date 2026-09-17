import { Logger } from "@nestjs/common";
import type { INestApplicationContext } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import type { Server, ServerOptions } from "socket.io";

const DEFAULT_CONNECT_TIMEOUT_MILLISECONDS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 5_000;
const DEFAULT_PING_INTERVAL_MILLISECONDS = 15_000;
const MAX_QUEUED_COMMANDS = 1_000;

type AdapterState =
  | "new"
  | "connecting"
  | "ready"
  | "failed"
  | "closing"
  | "closed";

type RedisAdapterClient = ReturnType<typeof createClient>;
type RedisClientFactory = (
  options: Parameters<typeof createClient>[0]
) => RedisAdapterClient;

export interface RedisIoAdapterOptions {
  redisUrl: string;
  channelPrefix: string;
  onRuntimeFailure: (error: Error) => void | Promise<void>;
  connectTimeoutMilliseconds?: number;
  requestsTimeoutMilliseconds?: number;
}

export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private readonly clientFactory: RedisClientFactory;
  private publisher?: RedisAdapterClient;
  private subscriber?: RedisAdapterClient;
  private adapterFactory?: ReturnType<typeof createAdapter>;
  private state: AdapterState = "new";
  private connectionErrorObserved = false;

  constructor(
    app: INestApplicationContext,
    private readonly options: RedisIoAdapterOptions,
    clientFactory: RedisClientFactory = (clientOptions) =>
      createClient(clientOptions)
  ) {
    super(app);
    this.clientFactory = clientFactory;
  }

  get isReady(): boolean {
    return this.state === "ready";
  }

  async connect(): Promise<void> {
    if (this.state !== "new") {
      throw new Error("El adaptador Redis ya fue inicializado.");
    }
    this.state = "connecting";

    const publisher = this.clientFactory({
      url: this.options.redisUrl,
      socket: {
        connectTimeout:
          this.options.connectTimeoutMilliseconds ??
          DEFAULT_CONNECT_TIMEOUT_MILLISECONDS,
        reconnectStrategy: false
      },
      commandsQueueMaxLength: MAX_QUEUED_COMMANDS,
      disableOfflineQueue: true,
      pingInterval: DEFAULT_PING_INTERVAL_MILLISECONDS,
      clientInfoTag: "sinochat-socket.io"
    });
    const subscriber = publisher.duplicate();
    this.publisher = publisher;
    this.subscriber = subscriber;
    this.observeClient(publisher, "publicador");
    this.observeClient(subscriber, "suscriptor");

    try {
      await Promise.all([publisher.connect(), subscriber.connect()]);
      await Promise.all([publisher.ping(), subscriber.ping()]);
      if (
        this.connectionErrorObserved ||
        !publisher.isReady ||
        !subscriber.isReady
      ) {
        throw new Error("Redis no alcanzó el estado ready.");
      }
    } catch {
      this.state = "failed";
      await this.closeClients();
      throw new Error(
        "No se pudo inicializar el transporte distribuido de tiempo real."
      );
    }

    this.adapterFactory = createAdapter(publisher, subscriber, {
      key: this.options.channelPrefix,
      publishOnSpecificResponseChannel: true,
      requestsTimeout:
        this.options.requestsTimeoutMilliseconds ??
        DEFAULT_REQUEST_TIMEOUT_MILLISECONDS
    });
    this.state = "ready";
  }

  override createIOServer(
    port: number,
    options?: ServerOptions
  ): Server {
    if (!this.adapterFactory || this.state !== "ready") {
      throw new Error(
        "El transporte distribuido no está disponible; Socket.IO no puede iniciarse."
      );
    }

    const server = super.createIOServer(port, options) as Server;
    server.adapter(this.adapterFactory);
    return server;
  }

  override async close(
    server: Parameters<IoAdapter["close"]>[0]
  ): Promise<void> {
    if (this.state === "ready") {
      this.state = "closing";
    }
    await super.close(server);
  }

  override async dispose(): Promise<void> {
    if (this.state === "closed") {
      return;
    }
    this.state = "closing";
    this.adapterFactory = undefined;
    await this.closeClients();
    this.state = "closed";
    await super.dispose();
  }

  private observeClient(
    client: RedisAdapterClient,
    role: "publicador" | "suscriptor"
  ): void {
    client.on("error", () => {
      if (this.state === "connecting") {
        this.connectionErrorObserved = true;
        return;
      }
      this.failAtRuntime(role);
    });
    client.on("end", () => {
      this.failAtRuntime(role);
    });
  }

  private failAtRuntime(role: "publicador" | "suscriptor"): void {
    if (this.state !== "ready") {
      return;
    }

    this.state = "failed";
    this.logger.error(
      `Redis ${role} dejó de estar disponible; SinoChat cerrará para evitar emisiones parciales.`
    );
    const error = new Error(
      "El transporte distribuido de tiempo real dejó de estar disponible."
    );
    void Promise.resolve(this.options.onRuntimeFailure(error)).catch(() => {
      this.logger.error(
        "Falló el cierre coordinado posterior a la caída de Redis."
      );
    });
  }

  private async closeClients(): Promise<void> {
    const clients = [this.subscriber, this.publisher].filter(
      (client): client is RedisAdapterClient => Boolean(client)
    );
    this.subscriber = undefined;
    this.publisher = undefined;

    await Promise.all(
      clients.map(async (client) => {
        try {
          if (client.isOpen) {
            await client.close();
          } else {
            client.destroy();
          }
        } catch {
          try {
            client.destroy();
          } catch {
            // El proceso continuará cerrándose aunque Redis ya no responda.
          }
        }
      })
    );
  }
}
