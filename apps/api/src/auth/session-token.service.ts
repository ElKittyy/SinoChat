import { Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { readSessionConfig } from "../config/runtime-config";
import { UserRole } from "../generated/prisma/enums";

@Injectable()
export class SessionTokenService {
  create(): { token: string; tokenHash: string } {
    const token = this.random();

    return {
      token,
      tokenHash: this.hash(token)
    };
  }

  createCsrf(): { token: string; tokenHash: string } {
    const token = this.random();

    return {
      token,
      tokenHash: this.hash(token)
    };
  }

  hash(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  expiresAt(now = new Date(), role?: UserRole): Date {
    const config = readSessionConfig();
    const hours =
      role === UserRole.ADMIN
        ? config.adminSessionTtlHours
        : config.sessionTtlHours;
    return new Date(now.getTime() + hours * 60 * 60 * 1_000);
  }

  private random(): string {
    return randomBytes(32).toString("base64url");
  }
}
