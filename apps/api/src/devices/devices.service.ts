import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from "@nestjs/common";
import type { SessionPrincipal } from "../auth/auth.types";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import { MatrixDeviceListPublisher } from "../database/matrix-device-list.publisher";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import {
  AccountStatus,
  DeviceStatus
} from "../generated/prisma/enums";
import { RealtimeService } from "../realtime/realtime.service";
import {
  issueDeviceBindingSecret,
  verifyDeviceBindingSecret
} from "./device-binding-secret";
import { evaluateFirstDeviceRegistration } from "./device-registration.policy";
import type { BindDeviceSessionDto } from "./dto/bind-device-session.dto";
import type { RegisterDeviceDto } from "./dto/register-device.dto";
import type { PreKeyDto } from "./dto/pre-key.dto";

const MIN_KEY_BYTES = 16;
const MAX_KEY_BYTES = 4_096;
const MAX_SIGNATURE_BYTES = 4_096;
const INVALID_BINDING_SECRET_HASH = "0".repeat(64);
const SECOND_DEVICE_REGISTRATION_MESSAGE =
  "Esta cuenta ya tuvo un dispositivo. El alta de otro dispositivo está bloqueada hasta que el ADR E2EE implemente aprobación firmada o recuperación segura.";

type DurablePreKeyClaim = {
  id: string;
  claimedAt: Date;
  oneTimePreKey: {
    keyId: number;
    publicKey: Uint8Array;
    signature: Uint8Array | null;
  } | null;
};

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly eligibility: ConversationEligibilityService,
    private readonly deviceLists?: MatrixDeviceListPublisher
  ) {}

  async register(
    principal: SessionPrincipal,
    input: RegisterDeviceDto
  ) {
    this.assertKeyMaterial(input.identityPublicKey, "identityPublicKey");
    this.assertKeyMaterial(input.signedPreKeyPublic, "signedPreKeyPublic");
    this.assertSignature(input.signedPreKeySignature, "signedPreKeySignature");
    this.assertPreKeys(input.oneTimePreKeys);
    this.assertDistinctPreKeyIds(input.oneTimePreKeys);

    try {
      return await this.runDeviceTransaction(async (transaction) => {
        await this.lockDeviceSet(transaction, principal.id);
        const now = await this.databaseNow(transaction);
        const session = await this.getCurrentSession(
          transaction,
          principal,
          now
        );
        const historicalDeviceCount = await transaction.device.count({
          where: { userId: principal.id }
        });
        this.assertFirstRegistrationAllowed(
          historicalDeviceCount,
          session.deviceId
        );

        const binding = issueDeviceBindingSecret();
        const device = await transaction.device.create({
          data: {
            userId: principal.id,
            registrationId: input.registrationId,
            identityPublicKey: Buffer.from(
              input.identityPublicKey,
              "base64"
            ),
            identityKeyFingerprint:
              input.identityKeyFingerprint.toLowerCase(),
            signedPreKeyId: input.signedPreKeyId,
            signedPreKeyPublic: Buffer.from(
              input.signedPreKeyPublic,
              "base64"
            ),
            signedPreKeySignature: Buffer.from(
              input.signedPreKeySignature,
              "base64"
            ),
            bindingSecretHash: binding.hash,
            protocolVersion: input.protocolVersion,
            oneTimePreKeys: {
              create: input.oneTimePreKeys.map((key) => ({
                keyId: key.keyId,
                publicKey: Buffer.from(key.publicKey, "base64"),
                signature: key.signature
                  ? Buffer.from(key.signature, "base64")
                  : null
              }))
            }
          },
          select: {
            id: true,
            registrationId: true,
            identityKeyFingerprint: true,
            protocolVersion: true,
            status: true,
            createdAt: true
          }
        });

        await this.linkSession(
          transaction,
          principal,
          session.sessionVersion,
          device.id,
          now
        );

        return {
          ...device,
          bindingSecret: binding.secret
        };
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const historicalDeviceCount = await this.prisma.device.count({
          where: { userId: principal.id }
        });
        if (historicalDeviceCount > 0) {
          throw new ConflictException(
            SECOND_DEVICE_REGISTRATION_MESSAGE
          );
        }
      }
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          "Ese dispositivo o identidad criptográfica ya está registrado."
        );
      }
      throw error;
    }
  }

  async bindSession(
    principal: SessionPrincipal,
    deviceId: string,
    input: BindDeviceSessionDto
  ) {
    return this.runDeviceTransaction(async (transaction) => {
      await this.lockDeviceSet(transaction, principal.id);
      const now = await this.databaseNow(transaction);
      const session = await this.getCurrentSession(
        transaction,
        principal,
        now
      );
      if (session.deviceId !== null) {
        throw new ConflictException(
          "Esta sesión ya está vinculada a un dispositivo."
        );
      }

      const device = await transaction.device.findFirst({
        where: {
          id: deviceId,
          userId: principal.id,
          status: DeviceStatus.ACTIVE
        },
        select: {
          id: true,
          bindingSecretHash: true
        }
      });
      const secretMatches = verifyDeviceBindingSecret(
        input.bindingSecret,
        device?.bindingSecretHash ?? INVALID_BINDING_SECRET_HASH
      );
      if (!device || !secretMatches) {
        throw new UnauthorizedException(
          "No se pudo vincular la sesión al dispositivo."
        );
      }

      await this.linkSession(
        transaction,
        principal,
        session.sessionVersion,
        device.id,
        now
      );

      return {
        deviceId: device.id,
        bound: true as const
      };
    });
  }

  async listOwn(userId: string) {
    return this.prisma.device.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        registrationId: true,
        identityKeyFingerprint: true,
        protocolVersion: true,
        status: true,
        createdAt: true,
        lastSeenAt: true,
        revokedAt: true,
        _count: {
          select: {
            oneTimePreKeys: {
              where: { claimedAt: null }
            }
          }
        }
      }
    });
  }

  async revoke(userId: string, deviceId: string) {
    await this.runDeviceTransaction(async (transaction) => {
      await this.lockDeviceSet(transaction, userId);
      const now = await this.databaseNow(transaction);
      const result = await transaction.device.updateMany({
        where: {
          id: deviceId,
          userId,
          status: DeviceStatus.ACTIVE
        },
        data: {
          status: DeviceStatus.REVOKED,
          revokedAt: now
        }
      });

      if (result.count !== 1) {
        throw new NotFoundException(
          "Dispositivo activo no encontrado."
        );
      }

      await transaction.authSession.updateMany({
        where: { deviceId, revokedAt: null },
        data: {
          revokedAt: now,
          revocationReason: "DEVICE_REVOKED"
        }
      });
      await this.deviceLists?.publishDeviceSetChanged(
        transaction,
        userId,
        deviceId,
        now
      );
    });
    this.realtime.disconnectUser(userId);
  }

  async uploadPreKeys(
    userId: string,
    deviceId: string,
    keys: PreKeyDto[]
  ) {
    this.assertPreKeys(keys);
    this.assertDistinctPreKeyIds(keys);

    try {
      await this.runDeviceTransaction(async (transaction) => {
        await this.lockDeviceSet(transaction, userId);
        await this.eligibility.lockOperationalUser(transaction, userId);
        const device = await transaction.device.findFirst({
          where: {
            id: deviceId,
            userId,
            status: DeviceStatus.ACTIVE
          },
          select: { id: true }
        });
        if (!device) {
          throw new NotFoundException(
            "Dispositivo activo no encontrado."
          );
        }

        await transaction.oneTimePreKey.createMany({
          data: keys.map((key) => ({
            deviceId,
            keyId: key.keyId,
            publicKey: Buffer.from(key.publicKey, "base64"),
            signature: key.signature
              ? Buffer.from(key.signature, "base64")
              : null
          }))
        });
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          "Uno o más identificadores de preclave ya existen."
        );
      }
      throw error;
    }

    return { added: keys.length };
  }

  async claimPeerBundles(
    userId: string,
    requesterDeviceId: string,
    conversationId: string
  ) {
    return this.runDeviceTransaction(async (transaction) => {
      const conversation = await this.eligibility.lockCurrent(
        transaction,
        userId,
        conversationId
      );

      const peerUserId =
        conversation.clientUserId === userId
          ? conversation.cashierUserId
          : conversation.clientUserId;
      for (const participantId of [userId, peerUserId].sort()) {
        await this.lockDeviceSet(transaction, participantId);
      }
      const requesterDevice = await transaction.device.findFirst({
        where: {
          id: requesterDeviceId,
          userId,
          status: DeviceStatus.ACTIVE
        },
        select: { id: true }
      });
      if (!requesterDevice) {
        throw new ForbiddenException(
          "Dispositivo solicitante no autorizado."
        );
      }
      const authorizationStillCurrent =
        await this.eligibility.lockCurrent(
          transaction,
          userId,
          conversationId,
          requesterDeviceId
        );
      if (
        authorizationStillCurrent.assignmentId !==
        conversation.assignmentId
      ) {
        throw new ForbiddenException(
          "La asignación de la conversación cambió."
        );
      }
      const claimedAt = await this.databaseNow(transaction);

      const devices = await transaction.device.findMany({
        where: {
          userId: peerUserId,
          status: DeviceStatus.ACTIVE,
          registrationId: { not: null },
          identityPublicKey: { not: null },
          identityKeyFingerprint: { not: null },
          signedPreKeyId: { not: null },
          signedPreKeyPublic: { not: null },
          signedPreKeySignature: { not: null }
        },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          registrationId: true,
          identityPublicKey: true,
          identityKeyFingerprint: true,
          signedPreKeyId: true,
          signedPreKeyPublic: true,
          signedPreKeySignature: true,
          protocolVersion: true
        }
      });

      if (devices.length === 0) {
        throw new ConflictException(
          "El otro participante todavía no configuró un dispositivo seguro."
        );
      }

      const bundles = [];
      for (const device of devices) {
        if (
          device.registrationId === null ||
          device.identityPublicKey === null ||
          device.identityKeyFingerprint === null ||
          device.signedPreKeyId === null ||
          device.signedPreKeyPublic === null ||
          device.signedPreKeySignature === null
        ) {
          throw new Error(
            "La consulta de transporte legado devolvio un dispositivo Matrix."
          );
        }
        const claim = await this.getOrCreatePreKeyClaim(
          transaction,
          requesterDeviceId,
          conversationId,
          device.id,
          claimedAt
        );
        const claimedPreKey = claim.oneTimePreKey;

        bundles.push({
          deviceId: device.id,
          registrationId: device.registrationId,
          identityPublicKey: this.toBase64(device.identityPublicKey),
          identityKeyFingerprint: device.identityKeyFingerprint,
          signedPreKeyId: device.signedPreKeyId,
          signedPreKeyPublic: this.toBase64(device.signedPreKeyPublic),
          signedPreKeySignature: this.toBase64(
            device.signedPreKeySignature
          ),
          protocolVersion: device.protocolVersion,
          claimId: claim.id,
          claimedAt: claim.claimedAt,
          oneTimePreKey: claimedPreKey
            ? {
                keyId: claimedPreKey.keyId,
                publicKey: this.toBase64(claimedPreKey.publicKey),
                signature: claimedPreKey.signature
                  ? this.toBase64(claimedPreKey.signature)
                  : null
              }
            : null
        });
      }

      // Revierte los claims si endsAt se alcanza durante el consumo de
      // preclaves. Esta consulta usa un clock_timestamp nuevo.
      await this.eligibility.lockCurrent(
        transaction,
        userId,
        conversationId,
        requesterDeviceId
      );

      return {
        peerUserId,
        devices: bundles
      };
    });
  }

  private async getOrCreatePreKeyClaim(
    transaction: Prisma.TransactionClient,
    requesterDeviceId: string,
    conversationId: string,
    recipientDeviceId: string,
    claimedAt: Date
  ): Promise<DurablePreKeyClaim> {
    const claimKey = {
      requesterDeviceId,
      conversationId,
      recipientDeviceId
    };
    const select = {
      id: true,
      claimedAt: true,
      oneTimePreKey: {
        select: {
          keyId: true,
          publicKey: true,
          signature: true
        }
      }
    } as const;
    const existing =
      await transaction.oneTimePreKeyClaim.findUnique({
        where: {
          requesterDeviceId_conversationId_recipientDeviceId:
            claimKey
        },
        select
      });
    if (existing) {
      return existing;
    }

    const [candidate] = await transaction.$queryRaw<
      Array<{ id: string }>
    >`
      SELECT "id"
        FROM "one_time_pre_keys"
       WHERE "device_id" = ${recipientDeviceId}::uuid
         AND "claimed_at" IS NULL
       ORDER BY "created_at" ASC, "id" ASC
       FOR UPDATE
       LIMIT 1
    `;

    if (candidate) {
      const claimed = await transaction.oneTimePreKey.updateMany({
        where: {
          id: candidate.id,
          deviceId: recipientDeviceId,
          claimedAt: null
        },
        data: { claimedAt }
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          "La preclave dejó de estar disponible durante el claim."
        );
      }
    }

    return transaction.oneTimePreKeyClaim.create({
      data: {
        ...claimKey,
        oneTimePreKeyId: candidate?.id ?? null,
        claimedAt
      },
      select
    });
  }

  private runDeviceTransaction<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    return this.prisma.$transaction(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: 30_000
    });
  }

  private async lockDeviceSet(
    transaction: Prisma.TransactionClient,
    userId: string
  ): Promise<void> {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended('sinochat:devices:' || ${userId}::text, 0)
      )
    `;
  }

  private async databaseNow(
    transaction: Prisma.TransactionClient
  ): Promise<Date> {
    const [clock] = await transaction.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS "now"
    `;
    if (!clock) {
      throw new Error(
        "No se pudo obtener el reloj de la base de datos."
      );
    }
    return clock.now;
  }

  private async getCurrentSession(
    transaction: Prisma.TransactionClient,
    principal: SessionPrincipal,
    now: Date
  ) {
    const session = await transaction.authSession.findUnique({
      where: { id: principal.sessionId },
      select: {
        userId: true,
        deviceId: true,
        revokedAt: true,
        expiresAt: true,
        sessionVersion: true,
        user: {
          select: {
            status: true,
            passwordResetRequired: true,
            sessionVersion: true
          }
        }
      }
    });

    if (
      !session ||
      session.userId !== principal.id ||
      session.revokedAt !== null ||
      session.expiresAt <= now ||
      session.sessionVersion !== session.user.sessionVersion ||
      session.user.passwordResetRequired ||
      session.user.status === AccountStatus.SUSPENDED ||
      session.user.status === AccountStatus.DELETED
    ) {
      throw new UnauthorizedException(
        "La sesión ya no está vigente."
      );
    }

    return session;
  }

  private async linkSession(
    transaction: Prisma.TransactionClient,
    principal: SessionPrincipal,
    sessionVersion: number,
    deviceId: string,
    now: Date
  ): Promise<void> {
    const linked = await transaction.authSession.updateMany({
      where: {
        id: principal.sessionId,
        userId: principal.id,
        deviceId: null,
        revokedAt: null,
        expiresAt: { gt: now },
        sessionVersion,
        user: {
          sessionVersion,
          passwordResetRequired: false,
          status: {
            notIn: [AccountStatus.SUSPENDED, AccountStatus.DELETED]
          }
        }
      },
      data: { deviceId }
    });

    if (linked.count !== 1) {
      throw new UnauthorizedException(
        "La sesión ya no está disponible para vinculación."
      );
    }
  }

  private assertFirstRegistrationAllowed(
    historicalDeviceCount: number,
    sessionDeviceId: string | null
  ): void {
    const decision = evaluateFirstDeviceRegistration(
      historicalDeviceCount,
      sessionDeviceId
    );
    if (decision === "DEVICE_HISTORY_EXISTS") {
      throw new ConflictException(
        SECOND_DEVICE_REGISTRATION_MESSAGE
      );
    }
    if (decision === "SESSION_ALREADY_BOUND") {
      throw new ConflictException(
        "Esta sesión ya está vinculada a un dispositivo."
      );
    }
  }

  private assertPreKeys(keys: PreKeyDto[]): void {
    for (const [index, key] of keys.entries()) {
      this.assertKeyMaterial(
        key.publicKey,
        `oneTimePreKeys[${index}].publicKey`
      );
      if (key.signature) {
        this.assertSignature(
          key.signature,
          `oneTimePreKeys[${index}].signature`
        );
      }
    }
  }

  private assertDistinctPreKeyIds(keys: PreKeyDto[]): void {
    if (new Set(keys.map((key) => key.keyId)).size !== keys.length) {
      throw new BadRequestException(
        "Los identificadores de preclave deben ser únicos."
      );
    }
  }

  private assertKeyMaterial(value: string, field: string): void {
    const size = Buffer.from(value, "base64").byteLength;
    if (size < MIN_KEY_BYTES || size > MAX_KEY_BYTES) {
      throw new BadRequestException(
        `${field} tiene un tamaño criptográfico inválido.`
      );
    }
  }

  private assertSignature(value: string, field: string): void {
    const size = Buffer.from(value, "base64").byteLength;
    if (size < MIN_KEY_BYTES || size > MAX_SIGNATURE_BYTES) {
      throw new BadRequestException(`${field} tiene un tamaño inválido.`);
    }
  }

  private toBase64(value: Uint8Array): string {
    return Buffer.from(value).toString("base64");
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    );
  }

}
