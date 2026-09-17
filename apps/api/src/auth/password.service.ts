import { Injectable, OnModuleInit } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import * as argon2 from "argon2";

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
  raw: false as const
} satisfies argon2.HashOptions & { raw?: false };

@Injectable()
export class PasswordService implements OnModuleInit {
  private dummyHash = "";

  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.hash(
      "credencial-inexistente-" + createHmac("sha256", "sinochat-dummy")
        .update(process.pid.toString())
        .digest("hex")
    );
  }

  async hash(password: string): Promise<string> {
    return argon2.hash(this.peppered(password), ARGON2_OPTIONS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, this.peppered(password));
    } catch {
      // Una cadena corrupta debe comportarse como credencial inválida.
      return false;
    }
  }

  async verifyAgainstDummy(password: string): Promise<void> {
    if (this.dummyHash) {
      await this.verify(this.dummyHash, password);
    }
  }

  constantTimeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);

    return (
      leftBuffer.length === rightBuffer.length &&
      timingSafeEqual(leftBuffer, rightBuffer)
    );
  }

  private peppered(password: string): string {
    const pepper = process.env.PASSWORD_PEPPER;

    if (!pepper) {
      if (process.env.NODE_ENV === "production") {
        throw new Error("PASSWORD_PEPPER es obligatorio en producción.");
      }
      return password;
    }

    return createHmac("sha256", pepper).update(password, "utf8").digest("base64");
  }
}
