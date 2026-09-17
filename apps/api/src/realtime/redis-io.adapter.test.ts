import { EventEmitter } from "node:events";
import {
  equal,
  match,
  rejects
} from "node:assert/strict";
import { describe, it } from "node:test";
import type { INestApplicationContext } from "@nestjs/common";
import { RedisIoAdapter } from "./redis-io.adapter";

describe("RedisIoAdapter", () => {
  it("conecta publicador y suscriptor con cola offline deshabilitada", async () => {
    const clients = pairedClients();
    let receivedOptions: Record<string, unknown> | undefined;
    const clientFactory = ((options: Record<string, unknown>) => {
      receivedOptions = options;
      return clients.publisher;
    }) as unknown as ConstructorParameters<typeof RedisIoAdapter>[2];
    const adapter = new RedisIoAdapter(
      {} as INestApplicationContext,
      {
        redisUrl: "rediss://redis.example.com:6380/0",
        channelPrefix: "sinochat:test:socket.io",
        onRuntimeFailure: () => undefined
      },
      clientFactory
    );

    await adapter.connect();

    equal(adapter.isReady, true);
    equal(clients.publisher.connectCalls, 1);
    equal(clients.subscriber.connectCalls, 1);
    equal(clients.publisher.pingCalls, 1);
    equal(clients.subscriber.pingCalls, 1);
    equal(receivedOptions?.disableOfflineQueue, true);
    equal(
      (
        receivedOptions?.socket as
          | { reconnectStrategy?: unknown }
          | undefined
      )?.reconnectStrategy,
      false
    );

    await adapter.dispose();
    equal(adapter.isReady, false);
    equal(clients.publisher.closed, true);
    equal(clients.subscriber.closed, true);
  });

  it("falla el arranque y limpia conexiones si Redis no está listo", async () => {
    const clients = pairedClients();
    clients.subscriber.connectFailure = true;
    const adapter = new RedisIoAdapter(
      {} as INestApplicationContext,
      {
        redisUrl: "rediss://redis.example.com:6380/0",
        channelPrefix: "sinochat:test:socket.io",
        onRuntimeFailure: () => undefined
      },
      (() => clients.publisher) as unknown as ConstructorParameters<
        typeof RedisIoAdapter
      >[2]
    );

    await rejects(
      adapter.connect(),
      /No se pudo inicializar el transporte distribuido/
    );
    equal(adapter.isReady, false);
    equal(clients.publisher.closed, true);
    equal(clients.subscriber.closed, true);
  });

  it("notifica una sola vez y queda fail-closed ante una caída", async () => {
    const clients = pairedClients();
    let failures = 0;
    let failureMessage = "";
    const adapter = new RedisIoAdapter(
      {} as INestApplicationContext,
      {
        redisUrl: "rediss://redis.example.com:6380/0",
        channelPrefix: "sinochat:test:socket.io",
        onRuntimeFailure: (error) => {
          failures += 1;
          failureMessage = error.message;
        }
      },
      (() => clients.publisher) as unknown as ConstructorParameters<
        typeof RedisIoAdapter
      >[2]
    );
    await adapter.connect();

    clients.publisher.emit("error", new Error("socket cerrado"));
    clients.subscriber.emit("end");
    await Promise.resolve();

    equal(adapter.isReady, false);
    equal(failures, 1);
    match(failureMessage, /transporte distribuido/);
    await adapter.dispose();
  });
});

class FakeRedisClient extends EventEmitter {
  isOpen = false;
  isReady = false;
  connectCalls = 0;
  pingCalls = 0;
  connectFailure = false;
  closed = false;
  duplicateClient?: FakeRedisClient;

  duplicate(): FakeRedisClient {
    if (!this.duplicateClient) {
      throw new Error("No existe cliente duplicado.");
    }
    return this.duplicateClient;
  }

  async connect(): Promise<FakeRedisClient> {
    this.connectCalls += 1;
    if (this.connectFailure) {
      this.emit("error", new Error("conexión rechazada"));
      throw new Error("conexión rechazada");
    }
    this.isOpen = true;
    this.isReady = true;
    return this;
  }

  async ping(): Promise<string> {
    this.pingCalls += 1;
    if (!this.isReady) {
      throw new Error("cliente no disponible");
    }
    return "PONG";
  }

  async close(): Promise<void> {
    this.closed = true;
    this.isOpen = false;
    this.isReady = false;
    this.emit("end");
  }

  destroy(): void {
    this.closed = true;
    this.isOpen = false;
    this.isReady = false;
  }
}

function pairedClients(): {
  publisher: FakeRedisClient;
  subscriber: FakeRedisClient;
} {
  const publisher = new FakeRedisClient();
  const subscriber = new FakeRedisClient();
  publisher.duplicateClient = subscriber;
  return { publisher, subscriber };
}
