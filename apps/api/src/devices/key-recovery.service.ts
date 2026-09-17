import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { Prisma } from "../generated/prisma/client";
import {
  DeviceStatus,
  RecoveryBundleProtection
} from "../generated/prisma/enums";
import { PrismaService } from "../database/prisma.service";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import type { SaveRecoveryBundleDto } from "./dto/save-recovery-bundle.dto";

const MAX_BUNDLE_BYTES = 1024 * 1024;

@Injectable()
export class KeyRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: ConversationEligibilityService
  ) {}

  async save(userId: string, input: SaveRecoveryBundleDto) {
    const ciphertext = Buffer.from(input.ciphertext, "base64");
    const nonce = Buffer.from(input.nonce, "base64");
    const salt = input.salt ? Buffer.from(input.salt, "base64") : null;

    if (ciphertext.byteLength < 32 || ciphertext.byteLength > MAX_BUNDLE_BYTES) {
      throw new BadRequestException(
        "El paquete cifrado de recuperación tiene un tamaño inválido."
      );
    }
    if (nonce.byteLength < 12 || nonce.byteLength > 64) {
      throw new BadRequestException("El nonce de recuperación es inválido.");
    }
    if (salt && (salt.byteLength < 16 || salt.byteLength > 128)) {
      throw new BadRequestException("La sal de recuperación es inválida.");
    }
    if (
      input.protection === RecoveryBundleProtection.RECOVERY_CODE &&
      (!salt || !input.kdfAlgorithm || !input.kdfParameters)
    ) {
      throw new BadRequestException(
        "La recuperación por código requiere sal y parámetros KDF."
      );
    }
    if (
      input.protection === RecoveryBundleProtection.TRUSTED_DEVICE &&
      !input.sourceDeviceId
    ) {
      throw new BadRequestException(
        "La recuperación por dispositivo requiere el dispositivo de origen."
      );
    }

    if (input.sourceDeviceId) {
      const sourceDevice = await this.prisma.device.findFirst({
        where: {
          id: input.sourceDeviceId,
          userId,
          status: DeviceStatus.ACTIVE
        },
        select: { id: true }
      });
      if (!sourceDevice) {
        throw new BadRequestException(
          "El dispositivo de origen no pertenece a la cuenta."
        );
      }
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            await this.eligibility.lockOperationalUser(transaction, userId);
            const current = await transaction.encryptedKeyBundle.findFirst({
              where: { userId },
              orderBy: { version: "desc" },
              select: { version: true }
            });
            const now = new Date();
            await transaction.encryptedKeyBundle.updateMany({
              where: {
                userId,
                supersededAt: null
              },
              data: { supersededAt: now }
            });
            const created =
              await transaction.encryptedKeyBundle.create({
                data: {
                  userId,
                  sourceDeviceId: input.sourceDeviceId,
                  version: (current?.version ?? 0) + 1,
                  protection: input.protection,
                  cipherSuite: input.cipherSuite,
                  ciphertext,
                  nonce,
                  salt,
                  kdfAlgorithm: input.kdfAlgorithm,
                  kdfParameters: input.kdfParameters
                },
                select: {
                  id: true,
                  version: true,
                  protection: true,
                  cipherSuite: true,
                  createdAt: true
                }
              });
            return created;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable
          }
        );
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === "P2034" || error.code === "P2002");
        if (!retryable || attempt === 3) {
          if (retryable) {
            throw new ConflictException(
              "No se pudo guardar el paquete por una actualización concurrente."
            );
          }
          throw error;
        }
      }
    }
    throw new ConflictException("No se pudo guardar el paquete.");
  }

  async getLatest(userId: string) {
    const bundle = await this.prisma.encryptedKeyBundle.findFirst({
      where: {
        userId,
        supersededAt: null,
        user: {
          passwordResetRequired: false
        }
      },
      orderBy: { version: "desc" }
    });
    if (!bundle) {
      throw new NotFoundException("No hay un paquete de recuperación disponible.");
    }

    return {
      id: bundle.id,
      version: bundle.version,
      protection: bundle.protection,
      sourceDeviceId: bundle.sourceDeviceId,
      cipherSuite: bundle.cipherSuite,
      ciphertext: Buffer.from(bundle.ciphertext).toString("base64"),
      nonce: Buffer.from(bundle.nonce).toString("base64"),
      salt: bundle.salt
        ? Buffer.from(bundle.salt).toString("base64")
        : null,
      kdfAlgorithm: bundle.kdfAlgorithm,
      kdfParameters: bundle.kdfParameters,
      createdAt: bundle.createdAt
    };
  }
}
