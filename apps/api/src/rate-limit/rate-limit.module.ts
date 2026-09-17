import { Global, Module } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import {
  readNodeEnvironment,
  readRateLimitConfig,
  readRedisConfig
} from "../config/runtime-config";
import { RateLimitStorage } from "./rate-limit.storage";

@Global()
@Module({
  providers: [
    {
      provide: RateLimitStorage,
      useFactory: () => {
        const nodeEnvironment = readNodeEnvironment();
        const redis = readRedisConfig(process.env, nodeEnvironment);
        const rateLimit = readRateLimitConfig(
          process.env,
          nodeEnvironment,
          redis
        );
        return new RateLimitStorage({
          redisUrl: redis.redisUrl,
          redisPrefix: rateLimit.rateLimitRedisPrefix,
          hmacSecret:
            rateLimit.rateLimitHmacSecret ?? randomBytes(32)
        });
      }
    }
  ],
  exports: [RateLimitStorage]
})
export class RateLimitModule {}
