import "./config/load-env";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import cookieParser = require("cookie-parser");
import helmet from "helmet";
import type {
  NextFunction,
  Request,
  Response
} from "express";
import { AppModule } from "./app.module";
import { loadRuntimeConfig } from "./config/runtime-config";
import { RedisIoAdapter } from "./realtime/redis-io.adapter";

const REDIS_FAILURE_SHUTDOWN_TIMEOUT_MILLISECONDS = 10_000;

async function bootstrap() {
  const config = loadRuntimeConfig();
  const app = await NestFactory.create(AppModule);
  let redisAdapter: RedisIoAdapter | undefined;
  let closingForRedisFailure = false;
  const httpServer = app.getHttpAdapter().getInstance() as {
    set(name: string, value: unknown): void;
  };

  app.enableShutdownHooks();

  const closeAfterRedisFailure = async (): Promise<void> => {
    if (closingForRedisFailure) {
      return;
    }
    closingForRedisFailure = true;
    process.exitCode = 1;
    console.error(
      "Redis dejó de estar disponible. SinoChat cerrará para evitar tiempo real parcial."
    );
    const forcedExit = setTimeout(() => {
      process.exit(1);
    }, REDIS_FAILURE_SHUTDOWN_TIMEOUT_MILLISECONDS);
    forcedExit.unref();

    try {
      await app.close();
    } catch {
      console.error(
        "No se pudo completar el cierre limpio posterior a la caída de Redis."
      );
      await redisAdapter?.dispose();
    } finally {
      clearTimeout(forcedExit);
    }
  };

  try {
    if (config.redisUrl) {
      redisAdapter = new RedisIoAdapter(app, {
        redisUrl: config.redisUrl,
        channelPrefix: config.socketIoRedisChannelPrefix,
        onRuntimeFailure: closeAfterRedisFailure
      });
      await redisAdapter.connect();
      app.useWebSocketAdapter(redisAdapter);
    }

    httpServer.set("trust proxy", config.trustProxy);
    app.use(helmet());
    app.use((_request: Request, response: Response, next: NextFunction) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Pragma", "no-cache");
      next();
    });
    app.use(cookieParser());
    app.enableCors({
      origin: config.webOrigin,
      credentials: true,
      exposedHeaders: [
        "ETag",
        "X-SinoChat-Terms-Version",
        "X-SinoChat-Terms-SHA256"
      ],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"]
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true
      })
    );
    app.setGlobalPrefix("api");

    await app.listen(config.apiPort);
  } catch (error) {
    try {
      await app.close();
    } finally {
      await redisAdapter?.dispose();
    }
    throw error;
  }
}

void bootstrap().catch((error: unknown) => {
  console.error("No se pudo iniciar SinoChat API.", error);
  process.exitCode = 1;
});
