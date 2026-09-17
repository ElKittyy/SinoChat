import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit
} from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { readDatabaseConfig } from "../config/runtime-config";
import { PrismaClient } from "../generated/prisma/client";

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  constructor() {
    const config = readDatabaseConfig();

    const adapter = new PrismaPg({
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
      max: config.databasePoolMax
    });

    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
