import {
  BadRequestException,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import {
  createHmac,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import type { RequestUploadDto } from "./dto/request-upload.dto";

export interface UploadGrant {
  version: 1;
  reservationId: string;
  userId: string;
  conversationId: string;
  objectKey: string;
  declaredMimeType: "image/jpeg" | "image/png" | "image/webp";
  plaintextByteSize: number;
  ciphertextByteSize: number;
  ciphertextSha256: string;
  expiresAt: number;
}

@Injectable()
export class UploadGrantService {
  create(
    userId: string,
    conversationId: string,
    input: RequestUploadDto,
    now = new Date(Date.now())
  ): { grant: UploadGrant; token: string } {
    const reservationId = randomUUID();
    const grant: UploadGrant = {
      version: 1,
      reservationId,
      userId,
      conversationId,
      objectKey: `ephemeral/messages/${reservationId}`,
      declaredMimeType: input.declaredMimeType,
      plaintextByteSize: input.plaintextByteSize,
      ciphertextByteSize: input.ciphertextByteSize,
      ciphertextSha256: input.ciphertextSha256.toLowerCase(),
      expiresAt: now.getTime() + 10 * 60_000
    };

    const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
    const signature = this.sign(payload);
    return {
      grant,
      token: `${payload}.${signature}`
    };
  }

  verify(token: string): UploadGrant {
    const [payload, providedSignature, extra] = token.split(".");
    if (!payload || !providedSignature || extra) {
      throw new UnauthorizedException("Permiso de foto inválido.");
    }

    if (!/^[A-Za-z0-9_-]{43}$/.test(providedSignature)) {
      throw new UnauthorizedException("Permiso de foto inválido.");
    }

    const expectedSignature = this.sign(payload);
    const expected = Buffer.from(expectedSignature, "base64url");
    const provided = Buffer.from(providedSignature, "base64url");
    if (
      provided.toString("base64url") !== providedSignature ||
      expected.byteLength !== provided.byteLength ||
      !timingSafeEqual(expected, provided)
    ) {
      throw new UnauthorizedException("Permiso de foto inválido.");
    }

    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw new UnauthorizedException("Permiso de foto inválido.");
    }

    if (!this.isGrant(value) || value.expiresAt <= Date.now()) {
      throw new UnauthorizedException(
        "El permiso para subir la foto venció o es inválido."
      );
    }

    return value;
  }

  assertMatches(
    grant: UploadGrant,
    userId: string,
    conversationId: string
  ): void {
    if (
      grant.userId !== userId ||
      grant.conversationId !== conversationId
    ) {
      throw new BadRequestException(
        "El permiso de foto no corresponde a esta conversación."
      );
    }
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret())
      .update(payload)
      .digest("base64url");
  }

  private secret(): string {
    const value = process.env.ATTACHMENT_GRANT_SECRET;
    if (value && Buffer.byteLength(value) >= 32) {
      return value;
    }
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "ATTACHMENT_GRANT_SECRET debe tener al menos 32 bytes."
      );
    }
    return "sinochat-development-upload-grant-only";
  }

  private isGrant(value: unknown): value is UploadGrant {
    if (!value || typeof value !== "object") {
      return false;
    }
    const candidate = value as Partial<UploadGrant>;
    return (
      candidate.version === 1 &&
      typeof candidate.reservationId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        candidate.reservationId
      ) &&
      typeof candidate.userId === "string" &&
      typeof candidate.conversationId === "string" &&
      typeof candidate.objectKey === "string" &&
      candidate.objectKey.startsWith("ephemeral/messages/") &&
      ["image/jpeg", "image/png", "image/webp"].includes(
        candidate.declaredMimeType ?? ""
      ) &&
      Number.isInteger(candidate.plaintextByteSize) &&
      Number.isInteger(candidate.ciphertextByteSize) &&
      typeof candidate.ciphertextSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(candidate.ciphertextSha256) &&
      typeof candidate.expiresAt === "number"
    );
  }
}
