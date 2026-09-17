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
import {
  MAX_REPORT_EVIDENCE_BYTES,
  type RequestEvidenceUploadDto
} from "./dto/evidence-upload.dto";

export interface EvidenceUploadGrant {
  version: 1;
  reservationId: string;
  clientUserId: string;
  assignmentId: string;
  conversationId: string;
  investigationKeyId: string;
  objectKey: string;
  ciphertextByteSize: number;
  ciphertextSha256: string;
  cipherSuite: string;
  manifestVersion: number;
  expiresAt: number;
}

@Injectable()
export class EvidenceGrantService {
  create(
    clientUserId: string,
    assignmentId: string,
    conversationId: string,
    input: RequestEvidenceUploadDto,
    now = new Date(Date.now())
  ): { grant: EvidenceUploadGrant; token: string } {
    const reservationId = randomUUID();
    const grant: EvidenceUploadGrant = {
      version: 1,
      reservationId,
      clientUserId,
      assignmentId,
      conversationId,
      investigationKeyId: input.investigationKeyId,
      objectKey: `investigations/report-evidence/${reservationId}`,
      ciphertextByteSize: input.ciphertextByteSize,
      ciphertextSha256: input.ciphertextSha256.toLowerCase(),
      cipherSuite: input.cipherSuite,
      manifestVersion: input.manifestVersion,
      expiresAt: now.getTime() + 10 * 60_000
    };

    const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
    return {
      grant,
      token: `${payload}.${this.sign(payload)}`
    };
  }

  verify(token: string): EvidenceUploadGrant {
    const [payload, providedSignature, extra] = token.split(".");
    if (!payload || !providedSignature || extra) {
      throw new UnauthorizedException(
        "El permiso de evidencia es inválido."
      );
    }

    if (!/^[A-Za-z0-9_-]{43}$/.test(providedSignature)) {
      throw new UnauthorizedException(
        "El permiso de evidencia es inválido."
      );
    }

    const expected = Buffer.from(this.sign(payload), "base64url");
    const provided = Buffer.from(providedSignature, "base64url");
    if (
      provided.toString("base64url") !== providedSignature ||
      expected.byteLength !== provided.byteLength ||
      !timingSafeEqual(expected, provided)
    ) {
      throw new UnauthorizedException(
        "El permiso de evidencia es inválido."
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8")
      );
    } catch {
      throw new UnauthorizedException(
        "El permiso de evidencia es inválido."
      );
    }

    if (!this.isGrant(value) || value.expiresAt <= Date.now()) {
      throw new UnauthorizedException(
        "El permiso para subir la evidencia venció o es inválido."
      );
    }
    return value;
  }

  assertOwnedBy(
    grant: EvidenceUploadGrant,
    clientUserId: string
  ): void {
    if (grant.clientUserId !== clientUserId) {
      throw new BadRequestException(
        "El permiso de evidencia no pertenece a este cliente."
      );
    }
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret())
      .update(payload)
      .digest("base64url");
  }

  private secret(): string {
    const value = process.env.EVIDENCE_UPLOAD_GRANT_SECRET;
    if (value && Buffer.byteLength(value, "utf8") >= 32) {
      return value;
    }
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "EVIDENCE_UPLOAD_GRANT_SECRET debe tener al menos 32 bytes."
      );
    }
    return "sinochat-development-evidence-grant-only";
  }

  private isGrant(value: unknown): value is EvidenceUploadGrant {
    if (!value || typeof value !== "object") {
      return false;
    }
    const candidate = value as Partial<EvidenceUploadGrant>;
    return (
      candidate.version === 1 &&
      typeof candidate.reservationId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        candidate.reservationId
      ) &&
      typeof candidate.clientUserId === "string" &&
      typeof candidate.assignmentId === "string" &&
      typeof candidate.conversationId === "string" &&
      typeof candidate.investigationKeyId === "string" &&
      typeof candidate.objectKey === "string" &&
      candidate.objectKey.startsWith(
        "investigations/report-evidence/"
      ) &&
      Number.isSafeInteger(candidate.ciphertextByteSize) &&
      (candidate.ciphertextByteSize ?? 0) > 0 &&
      (candidate.ciphertextByteSize ?? 0) <=
        MAX_REPORT_EVIDENCE_BYTES &&
      typeof candidate.ciphertextSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(candidate.ciphertextSha256) &&
      typeof candidate.cipherSuite === "string" &&
      candidate.cipherSuite.length >= 3 &&
      candidate.cipherSuite.length <= 64 &&
      /^[A-Za-z0-9._+/-]+$/.test(candidate.cipherSuite) &&
      Number.isInteger(candidate.manifestVersion) &&
      (candidate.manifestVersion ?? 0) > 0 &&
      typeof candidate.expiresAt === "number"
    );
  }
}
