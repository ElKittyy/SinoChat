import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from "@nestjs/common";
import {
  matrixDeviceIdFromUuid,
  matrixUserIdFromUuid,
  sinochatUserIdFromMatrixUserId
} from "@sinochat/contracts";
import type { SessionPrincipal } from "../auth/auth.types";
import { ConversationEligibilityService } from "../assignments/conversation-eligibility.service";
import { readMatrixServerName } from "../config/runtime-config";
import { MatrixDeviceListPublisher } from "../database/matrix-device-list.publisher";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import {
  AccountStatus,
  DeviceStatus
} from "../generated/prisma/enums";
import { deriveMatrixDeviceBindingSecret } from "../devices/device-binding-secret";
import {
  MATRIX_SIGNED_CURVE25519_ALGORITHM,
  MatrixKeyUploadValidationError,
  hashMatrixCanonicalJson,
  parseInitialMatrixKeyUpload,
  parseMatrixKeyUpload,
  type MatrixDeviceKeys,
  type MatrixSignedCurveKey
} from "./matrix-key-upload";
import {
  MatrixKeyRequestValidationError,
  matrixClaimHashInput,
  parseMatrixClaimRequestId,
  parseMatrixKeysClaim,
  parseMatrixKeysQuery,
  type MatrixKeysClaim,
  type MatrixKeysQuery
} from "./matrix-key-requests";

const REGISTRATION_TTL_MS = 10 * 60_000;
const MATRIX_PROTOCOL_VERSION = "matrix-olm-v1";

type MatrixTransaction = Prisma.TransactionClient;

interface MatrixTargetScope {
  conversationId: string | null;
  matrixUserId: string;
  userId: string;
}

@Injectable()
export class MatrixKeyDirectoryService {
  private readonly matrixServerName = readMatrixServerName();

  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: ConversationEligibilityService,
    private readonly deviceLists?: MatrixDeviceListPublisher
  ) {}

  async reserveDevice(principal: SessionPrincipal) {
    if (principal.deviceId !== null) {
      throw new ConflictException(
        "Esta sesion ya esta vinculada a un dispositivo."
      );
    }

    return this.runTransaction(async (transaction) => {
      await this.lockDeviceSet(transaction, principal.id);
      await this.eligibility.lockOperationalUser(transaction, principal.id);
      const now = await this.databaseNow(transaction);
      await this.requireCurrentSession(transaction, principal, now, null);

      await transaction.matrixDeviceRegistration.deleteMany({
        where: {
          sessionId: principal.sessionId,
          consumedAt: null,
          expiresAt: { lte: now }
        }
      });

      const openRegistration =
        await transaction.matrixDeviceRegistration.findFirst({
          where: {
            sessionId: principal.sessionId,
            userId: principal.id,
            consumedAt: null,
            expiresAt: { gt: now }
          },
          select: { id: true, expiresAt: true }
        });
      if (openRegistration) {
        return this.registrationResponse(
          principal.id,
          openRegistration.id,
          openRegistration.expiresAt
        );
      }

      const historicalDevices = await transaction.device.count({
        where: { userId: principal.id }
      });
      if (historicalDevices !== 0) {
        throw new ConflictException(
          "El alta de otro dispositivo requiere la ceremonia de autorizacion E2EE pendiente."
        );
      }

      const expiresAt = new Date(now.getTime() + REGISTRATION_TTL_MS);
      const registration =
        await transaction.matrixDeviceRegistration.create({
          data: {
            userId: principal.id,
            sessionId: principal.sessionId,
            createdAt: now,
            expiresAt
          },
          select: { id: true, expiresAt: true }
        });

      return this.registrationResponse(
        principal.id,
        registration.id,
        registration.expiresAt
      );
    });
  }

  async completeInitialUpload(
    principal: SessionPrincipal,
    registrationId: string,
    value: unknown
  ) {
    const matrixUserId = matrixUserIdFromUuid(
      principal.id,
      this.matrixServerName
    );
    const matrixDeviceId = matrixDeviceIdFromUuid(registrationId);
    const upload = this.parseInitialUpload(value, {
      userId: matrixUserId,
      deviceId: matrixDeviceId
    });
    const initialUploadSha256 = hashMatrixCanonicalJson(value);
    const binding = deriveMatrixDeviceBindingSecret(registrationId);

    if (principal.deviceId !== null) {
      if (principal.deviceId !== registrationId) {
        throw new ConflictException(
          "Esta sesion ya esta vinculada a otro dispositivo."
        );
      }
      const replay = await this.replayInitialUpload(
        principal,
        registrationId,
        initialUploadSha256,
        binding.hash
      );
      return {
        deviceId: registrationId,
        matrixUserId,
        matrixDeviceId,
        bindingSecret: binding.secret,
        publishedAt: replay.publishedAt,
        one_time_key_counts: {
          [MATRIX_SIGNED_CURVE25519_ALGORITHM]:
            replay.oneTimeKeyCount
        }
      };
    }

    const result = await this.runTransaction(async (transaction) => {
      await this.lockDeviceSet(transaction, principal.id);
      await this.eligibility.lockOperationalUser(transaction, principal.id);
      const now = await this.databaseNow(transaction);
      await this.lockRegistration(transaction, registrationId);
      const currentSessionVersion = await this.requireCurrentSession(
        transaction,
        principal,
        now,
        null
      );

      const registration =
        await transaction.matrixDeviceRegistration.findUnique({
          where: { id: registrationId },
          select: {
            userId: true,
            sessionId: true,
            expiresAt: true,
            consumedAt: true
          }
        });
      if (
        !registration ||
        registration.userId !== principal.id ||
        registration.sessionId !== principal.sessionId
      ) {
        throw new NotFoundException(
          "Reserva de dispositivo no encontrada."
        );
      }
      if (
        registration.consumedAt !== null ||
        registration.expiresAt <= now
      ) {
        throw new ConflictException(
          "La reserva de dispositivo ya no esta disponible."
        );
      }

      if (
        (await transaction.device.count({
          where: { userId: principal.id }
        })) !== 0
      ) {
        throw new ConflictException(
          "La cuenta ya posee historial de dispositivo."
        );
      }

      await transaction.device.create({
        data: {
          id: registrationId,
          userId: principal.id,
          bindingSecretHash: binding.hash,
          protocolVersion: MATRIX_PROTOCOL_VERSION,
          createdAt: now
        }
      });
      await transaction.matrixDeviceListState.create({
        data: {
          userId: principal.id,
          matrixUserId,
          version: 0,
          updatedAt: now
        }
      });
      await transaction.matrixDeviceKey.create({
        data: this.deviceKeyData(
          registrationId,
          principal.id,
          upload.deviceKeys,
          now
        )
      });
      await transaction.matrixToDeviceCursor.create({
        data: {
          deviceId: registrationId,
          latestSequence: 0,
          updatedAt: now
        }
      });

      await this.insertOneTimeKeys(
        transaction,
        registrationId,
        upload.oneTimeKeys,
        now
      );
      await this.rotateFallbackKey(
        transaction,
        registrationId,
        upload.fallbackKeys,
        now
      );

      await this.deviceLists?.publishDeviceSetChanged(
        transaction,
        principal.id,
        registrationId,
        now
      );
      await this.deviceLists?.publishCurrentPeersToRecipient(
        transaction,
        principal.id,
        now
      );

      const linked = await transaction.authSession.updateMany({
        where: {
          id: principal.sessionId,
          userId: principal.id,
          deviceId: null,
          revokedAt: null,
          expiresAt: { gt: now },
          sessionVersion: currentSessionVersion,
          user: {
            status: AccountStatus.ACTIVE,
            passwordResetRequired: false,
            sessionVersion: currentSessionVersion
          }
        },
        data: { deviceId: registrationId }
      });
      if (linked.count !== 1) {
        throw new UnauthorizedException(
          "La sesion dejo de estar disponible para vincular el dispositivo."
        );
      }

      const oneTimeKeyCount =
        await transaction.matrixOneTimeKey.count({
          where: {
            deviceId: registrationId,
            algorithm: MATRIX_SIGNED_CURVE25519_ALGORITHM,
            claimedAt: null
          }
        });
      await transaction.matrixDeviceRegistration.update({
        where: { id: registrationId },
        data: {
          consumedAt: now,
          initialUploadSha256,
          initialOneTimeKeyCount: oneTimeKeyCount
        }
      });
      return { oneTimeKeyCount, publishedAt: now };
    }).catch((error: unknown) => {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          "El dispositivo o alguna de sus claves Matrix ya fue publicado."
        );
      }
      throw error;
    });

    return {
      deviceId: registrationId,
      matrixUserId,
      matrixDeviceId,
      bindingSecret: binding.secret,
      publishedAt: result.publishedAt,
      one_time_key_counts: {
        [MATRIX_SIGNED_CURVE25519_ALGORITHM]: result.oneTimeKeyCount
      }
    };
  }

  private async replayInitialUpload(
    principal: SessionPrincipal,
    registrationId: string,
    initialUploadSha256: string,
    bindingSecretHash: string
  ): Promise<{ oneTimeKeyCount: number; publishedAt: Date }> {
    return this.runTransaction(async (transaction) => {
      await this.lockDeviceSet(transaction, principal.id);
      await this.eligibility.lockOperationalUser(
        transaction,
        principal.id
      );
      const now = await this.databaseNow(transaction);
      await this.lockRegistration(transaction, registrationId);
      await this.requireCurrentSession(
        transaction,
        principal,
        now,
        registrationId
      );

      const registration =
        await transaction.matrixDeviceRegistration.findUnique({
          where: { id: registrationId },
          select: {
            userId: true,
            sessionId: true,
            expiresAt: true,
            consumedAt: true,
            initialUploadSha256: true,
            initialOneTimeKeyCount: true
          }
        });
      if (
        !registration ||
        registration.userId !== principal.id ||
        registration.sessionId !== principal.sessionId
      ) {
        throw new NotFoundException(
          "Reserva de dispositivo no encontrada."
        );
      }
      if (
        registration.consumedAt === null ||
        registration.expiresAt <= now ||
        registration.initialUploadSha256 !== initialUploadSha256 ||
        registration.initialOneTimeKeyCount === null
      ) {
        throw new ConflictException(
          "La confirmacion del dispositivo no coincide con el alta original o ya no puede repetirse."
        );
      }

      const device = await transaction.device.findFirst({
        where: {
          id: registrationId,
          userId: principal.id,
          status: DeviceStatus.ACTIVE,
          protocolVersion: MATRIX_PROTOCOL_VERSION,
          bindingSecretHash
        },
        select: { id: true }
      });
      if (!device) {
        throw new ConflictException(
          "El dispositivo publicado no coincide con la reserva."
        );
      }

      return {
        oneTimeKeyCount: registration.initialOneTimeKeyCount,
        publishedAt: registration.consumedAt
      };
    });
  }

  async uploadKeys(principal: SessionPrincipal, value: unknown) {
    const deviceId = this.requireBoundDevice(principal);

    try {
      return await this.runTransaction(async (transaction) => {
        await this.lockDeviceSet(transaction, principal.id);
        await this.eligibility.lockOperationalUser(
          transaction,
          principal.id
        );
        const now = await this.databaseNow(transaction);
        await this.requireCurrentSession(
          transaction,
          principal,
          now,
          deviceId
        );

        const current = await transaction.matrixDeviceKey.findUnique({
          where: { deviceId },
          select: {
            matrixUserId: true,
            matrixDeviceId: true,
            ed25519Key: true,
            canonicalSha256: true
          }
        });
        if (!current) {
          throw new ConflictException(
            "El dispositivo no publico una identidad Matrix."
          );
        }

        const upload = this.parseUpload(value, {
          userId: current.matrixUserId,
          deviceId: current.matrixDeviceId,
          existingEd25519PublicKey: current.ed25519Key
        });
        if (
          upload.deviceKeys &&
          hashMatrixCanonicalJson(upload.deviceKeys) !==
            current.canonicalSha256
        ) {
          throw new ConflictException(
            "Las claves de identidad del dispositivo son inmutables."
          );
        }

        await this.insertOneTimeKeys(
          transaction,
          deviceId,
          upload.oneTimeKeys,
          now
        );
        await this.rotateFallbackKey(
          transaction,
          deviceId,
          upload.fallbackKeys,
          now
        );

        const oneTimeKeyCount =
          await transaction.matrixOneTimeKey.count({
            where: {
              deviceId,
              algorithm: MATRIX_SIGNED_CURVE25519_ALGORITHM,
              claimedAt: null
            }
          });
        return {
          one_time_key_counts: {
            [MATRIX_SIGNED_CURVE25519_ALGORITHM]: oneTimeKeyCount
          }
        };
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          "Una clave Matrix ya existe con otro identificador o contenido."
        );
      }
      throw error;
    }
  }

  async queryKeys(
    principal: SessionPrincipal,
    conversationId: string,
    value: unknown
  ) {
    const deviceId = this.requireBoundDevice(principal);
    const query = this.parseQuery(value);

    return this.runTransaction(async (transaction) => {
      const conversation = await this.lockConversationDeviceSets(
        transaction,
        principal.id,
        conversationId,
        deviceId
      );
      const now = await this.databaseNow(transaction);
      await this.requireCurrentSession(
        transaction,
        principal,
        now,
        deviceId
      );

      const peerUserId =
        conversation.clientUserId === principal.id
          ? conversation.cashierUserId
          : conversation.clientUserId;
      const ownMatrixUserId = matrixUserIdFromUuid(
        principal.id,
        this.matrixServerName
      );
      const peerMatrixUserId = matrixUserIdFromUuid(
        peerUserId,
        this.matrixServerName
      );
      const requestedUsers = Object.keys(query.deviceKeys);
      const allowedUsers = new Set([ownMatrixUserId, peerMatrixUserId]);
      if (requestedUsers.some((userId) => !allowedUsers.has(userId))) {
        throw new ForbiddenException(
          "La consulta de claves contiene una identidad no autorizada."
        );
      }

      return this.queryResponse(transaction, query, ownMatrixUserId);
    });
  }

  /**
   * Adaptador para las solicitudes producidas directamente por Rust Crypto.
   * A diferencia de la ruta historica con conversationId, cada identidad se
   * resuelve y autoriza en servidor. Esto permite que un cajero consulte en un
   * unico batch sus propias claves y las de varios clientes vigentes sin
   * confiar en un mapa de conversaciones aportado por el navegador.
   */
  async queryRelatedKeys(principal: SessionPrincipal, value: unknown) {
    const deviceId = this.requireBoundDevice(principal);
    const query = this.parseQuery(value);

    return this.runTransaction(async (transaction) => {
      const now = await this.databaseNow(transaction);
      await this.requireCurrentSession(
        transaction,
        principal,
        now,
        deviceId
      );
      await this.lockRelatedTargets(
        transaction,
        principal,
        deviceId,
        Object.keys(query.deviceKeys)
      );

      // Waiting for relationship/device locks must not resurrect a session
      // which expired or was revoked after the initial HTTP/transaction check.
      await this.requireCurrentSession(transaction, principal, await this.databaseNow(transaction), deviceId);

      return this.queryResponse(transaction, query, matrixUserIdFromUuid(principal.id, this.matrixServerName));
    });
  }

  async claimKeys(
    principal: SessionPrincipal,
    conversationId: string,
    rawRequestId: string,
    value: unknown
  ) {
    const deviceId = this.requireBoundDevice(principal);
    const requestId = this.parseClaimRequestId(rawRequestId);
    const claim = this.parseClaim(value);
    const requestSha256 = hashMatrixCanonicalJson(matrixClaimHashInput(claim));

    return this.runTransaction(async (transaction) => {
      const conversation = await this.lockConversationDeviceSets(
        transaction,
        principal.id,
        conversationId,
        deviceId
      );
      const now = await this.databaseNow(transaction);
      await this.requireCurrentSession(
        transaction,
        principal,
        now,
        deviceId
      );

      const peerUserId =
        conversation.clientUserId === principal.id
          ? conversation.cashierUserId
          : conversation.clientUserId;
      const peerMatrixUserId = matrixUserIdFromUuid(
        peerUserId,
        this.matrixServerName
      );
      const requestedUsers = Object.keys(claim.oneTimeKeys);
      if (
        requestedUsers.length !== 1 ||
        requestedUsers[0] !== peerMatrixUserId
      ) {
        throw new ForbiddenException(
          "El reclamo de claves solo puede dirigirse a la contraparte actual."
        );
      }

      await this.lockClaimRequest(transaction, deviceId, requestId);
      const previous =
        await transaction.matrixKeyClaimRequest.findUnique({
          where: {
            requesterDeviceId_requestId: {
              requesterDeviceId: deviceId,
              requestId
            }
          },
          select: {
            id: true,
            conversationId: true,
            requestSha256: true
          }
        });
      if (previous) {
        if (
          previous.conversationId !== conversationId ||
          previous.requestSha256 !== requestSha256
        ) {
          throw new ConflictException(
            "El identificador de reclamo ya pertenece a otra solicitud."
          );
        }
        return this.buildClaimResponse(transaction, previous.id);
      }

      const request = await transaction.matrixKeyClaimRequest.create({
        data: {
          requesterDeviceId: deviceId,
          conversationId,
          requestId,
          requestSha256,
          createdAt: now
        },
        select: { id: true }
      });
      const requestedDevices = Object.keys(
        claim.oneTimeKeys[peerMatrixUserId] ?? {}
      );
      const targetRows = await transaction.matrixDeviceKey.findMany({
        where: {
          userId: peerUserId,
          matrixUserId: peerMatrixUserId,
          matrixDeviceId: { in: requestedDevices },
          device: { status: DeviceStatus.ACTIVE }
        },
        select: { deviceId: true, matrixDeviceId: true },
        orderBy: { deviceId: "asc" }
      });
      await this.lockMatrixDevices(
        transaction,
        targetRows.map((target) => target.deviceId)
      );

      for (const target of targetRows) {
        await this.claimRecipientKey(
          transaction,
          request.id,
          target.deviceId,
          now
        );
      }

      return this.buildClaimResponse(transaction, request.id);
    });
  }

  /**
   * Reclama claves para una sola identidad autorizada. El cliente divide un
   * KeysClaimRequest multiusuario en subsolicitudes idempotentes; una fila no
   * puede quedar ambiguamente asociada a varias conversaciones. Tambien admite
   * otros dispositivos activos de la misma cuenta con conversationId NULL,
   * tal como exige el trigger de integridad de PostgreSQL.
   */
  async claimRelatedKeys(
    principal: SessionPrincipal,
    rawRequestId: string,
    value: unknown
  ) {
    const deviceId = this.requireBoundDevice(principal);
    const requestId = this.parseClaimRequestId(rawRequestId);
    const claim = this.parseClaim(value);
    const requestedUsers = Object.keys(claim.oneTimeKeys);
    if (requestedUsers.length !== 1) {
      throw new BadRequestException({
        error: "MATRIX_KEYS_CLAIM_SINGLE_USER_REQUIRED",
        message: "Cada subsolicitud de claves Matrix debe tener un destinatario."
      });
    }
    const matrixUserId = requestedUsers[0]!;
    const requestSha256 = hashMatrixCanonicalJson(matrixClaimHashInput(claim));

    return this.runTransaction(async (transaction) => {
      const now = await this.databaseNow(transaction);
      await this.requireCurrentSession(
        transaction,
        principal,
        now,
        deviceId
      );
      const [scope] = await this.lockRelatedTargets(
        transaction,
        principal,
        deviceId,
        [matrixUserId]
      );
      if (!scope) {
        throw new ForbiddenException(
          "La identidad Matrix no esta disponible para esta sesion."
        );
      }

      await this.lockClaimRequest(transaction, deviceId, requestId);
      const previous =
        await transaction.matrixKeyClaimRequest.findUnique({
          where: {
            requesterDeviceId_requestId: {
              requesterDeviceId: deviceId,
              requestId
            }
          },
          select: {
            id: true,
            conversationId: true,
            requestSha256: true
          }
        });
      if (previous) {
        if (
          previous.conversationId !== scope.conversationId ||
          previous.requestSha256 !== requestSha256
        ) {
          throw new ConflictException(
            "El identificador de reclamo ya pertenece a otra solicitud."
          );
        }
        return this.buildClaimResponse(transaction, previous.id);
      }

      const request = await transaction.matrixKeyClaimRequest.create({
        data: {
          requesterDeviceId: deviceId,
          conversationId: scope.conversationId,
          requestId,
          requestSha256,
          createdAt: now
        },
        select: { id: true }
      });
      const requestedDevices = Object.keys(
        claim.oneTimeKeys[matrixUserId] ?? {}
      );
      const targetRows = await transaction.matrixDeviceKey.findMany({
        where: {
          userId: scope.userId,
          matrixUserId,
          matrixDeviceId: { in: requestedDevices },
          deviceId: { not: deviceId },
          device: { status: DeviceStatus.ACTIVE }
        },
        select: { deviceId: true, matrixDeviceId: true },
        orderBy: { deviceId: "asc" }
      });
      await this.lockMatrixDevices(
        transaction,
        targetRows.map((target) => target.deviceId)
      );

      for (const target of targetRows) {
        await this.claimRecipientKey(
          transaction,
          request.id,
          target.deviceId,
          now
        );
      }

      return this.buildClaimResponse(transaction, request.id);
    });
  }

  private async queryResponse(
    transaction: MatrixTransaction,
    query: MatrixKeysQuery,
    ownMatrixUserId: string
  ) {
    const requestedUsers = Object.keys(query.deviceKeys);
    const rows = await transaction.matrixDeviceKey.findMany({
      where: {
        matrixUserId: { in: requestedUsers },
        device: { status: DeviceStatus.ACTIVE }
      },
      select: {
        deviceId: true,
        matrixUserId: true,
        matrixDeviceId: true,
        deviceKeys: true
      },
      orderBy: [{ matrixUserId: "asc" }, { matrixDeviceId: "asc" }]
    });
    // The relation scope and active devices have already been checked. Never
    // mutate the original self-signed directory JSON when adding a certificate.
    const certificates = await transaction.matrixDeviceCrossSigning.findMany({
      where: { deviceId: { in: rows.map((row) => row.deviceId) } },
      select: { deviceId: true, signedDeviceKeys: true }
    });
    const certifiedDevices = new Map(certificates.map((certificate) => [certificate.deviceId, certificate.signedDeviceKeys]));
    const deviceKeys: Record<string, Record<string, unknown>> = {};
    for (const userId of requestedUsers) deviceKeys[userId] = {};
    for (const row of rows) {
      const requestedDevices = query.deviceKeys[row.matrixUserId];
      if (
        requestedDevices &&
        (requestedDevices.length === 0 ||
          requestedDevices.includes(row.matrixDeviceId))
      ) {
        deviceKeys[row.matrixUserId]![row.matrixDeviceId] = certifiedDevices.get(row.deviceId) ?? row.deviceKeys;
      }
    }
    const identities = await transaction.matrixCrossSigningIdentity.findMany({
      where: { matrixUserId: { in: requestedUsers } },
      select: { matrixUserId: true, signingKeys: true }
    });
    const masterKeys: Record<string, Prisma.JsonValue> = {};
    const selfSigningKeys: Record<string, Prisma.JsonValue> = {};
    const userSigningKeys: Record<string, Prisma.JsonValue> = {};
    for (const identity of identities) {
      const signing = identity.signingKeys as { [key: string]: Prisma.JsonValue };
      masterKeys[identity.matrixUserId] = signing.master_key;
      selfSigningKeys[identity.matrixUserId] = signing.self_signing_key;
      // Even this PUBLIC key is owner-only to avoid exposing trust relationships.
      if (identity.matrixUserId === ownMatrixUserId) userSigningKeys[identity.matrixUserId] = signing.user_signing_key;
    }
    return {
      device_keys: deviceKeys,
      failures: {},
      master_keys: masterKeys,
      self_signing_keys: selfSigningKeys,
      user_signing_keys: userSigningKeys
    };
  }

  private async lockRelatedTargets(
    transaction: MatrixTransaction,
    principal: SessionPrincipal,
    deviceId: string,
    matrixUserIds: string[]
  ): Promise<MatrixTargetScope[]> {
    const ownMatrixUserId = matrixUserIdFromUuid(
      principal.id,
      this.matrixServerName
    );
    const published = await transaction.matrixDeviceKey.findUnique({
      where: { deviceId },
      select: { userId: true, matrixUserId: true }
    });
    if (
      !published ||
      published.userId !== principal.id ||
      published.matrixUserId !== ownMatrixUserId
    ) {
      throw new ForbiddenException(
        "La identidad Matrix no esta disponible para esta sesion."
      );
    }

    const targets = matrixUserIds.map((matrixUserId) => {
      let userId: string;
      try {
        userId = sinochatUserIdFromMatrixUserId(
          matrixUserId,
          this.matrixServerName
        );
      } catch {
        throw new ForbiddenException(
          "La identidad Matrix no esta disponible para esta sesion."
        );
      }
      return { matrixUserId, userId };
    });

    const scopes: MatrixTargetScope[] = [];
    for (const target of [...targets].sort((left, right) =>
      left.userId.localeCompare(right.userId)
    )) {
      if (target.userId === principal.id) {
        scopes.push({ ...target, conversationId: null });
        continue;
      }

      const conversation =
        principal.role === "CLIENT"
          ? await this.eligibility.lockCurrentByParticipants(
              transaction,
              principal.id,
              target.userId
            )
          : principal.role === "CASHIER"
            ? await this.eligibility.lockCurrentByParticipants(
                transaction,
                target.userId,
                principal.id
              )
            : null;
      if (!conversation) {
        throw new ForbiddenException(
          "La identidad Matrix no esta disponible para esta sesion."
        );
      }
      scopes.push({ ...target, conversationId: conversation.id });
    }

    for (const userId of [...new Set([
      principal.id,
      ...scopes.map((scope) => scope.userId)
    ])].sort()) {
      await this.lockDeviceSet(transaction, userId);
    }

    const ownScope = scopes.find((scope) => scope.userId === principal.id);
    if (ownScope && ownScope.matrixUserId !== ownMatrixUserId) {
      throw new ForbiddenException(
        "La identidad Matrix no esta disponible para esta sesion."
      );
    }

    return matrixUserIds.map((matrixUserId) => {
      const scope = scopes.find((candidate) =>
        candidate.matrixUserId === matrixUserId
      );
      if (!scope) {
        throw new ForbiddenException(
          "La identidad Matrix no esta disponible para esta sesion."
        );
      }
      return scope;
    });
  }

  private async lockConversationDeviceSets(
    transaction: MatrixTransaction,
    userId: string,
    conversationId: string,
    deviceId: string
  ): Promise<{ clientUserId: string; cashierUserId: string }> {
    const conversation = await this.eligibility.lockCurrent(
      transaction,
      userId,
      conversationId,
      deviceId
    );
    for (const participantId of [
      conversation.clientUserId,
      conversation.cashierUserId
    ].sort()) {
      await this.lockDeviceSet(transaction, participantId);
    }
    return conversation;
  }

  private async lockClaimRequest(
    transaction: MatrixTransaction,
    requesterDeviceId: string,
    requestId: string
  ): Promise<void> {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          'sinochat:matrix:claim:' || ${requesterDeviceId}::text || ':' || ${requestId},
          0
        )
      )
    `;
  }

  private async lockMatrixDevices(
    transaction: MatrixTransaction,
    deviceIds: string[]
  ): Promise<void> {
    for (const deviceId of [...deviceIds].sort()) {
      const rows = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT d."id"
          FROM "devices" d
          JOIN "matrix_device_keys" k ON k."device_id" = d."id"
         WHERE d."id" = ${deviceId}::uuid
           AND d."status" = 'ACTIVE'
         FOR UPDATE OF d
      `;
      if (rows.length !== 1) {
        throw new ConflictException(
          "Un dispositivo destinatario dejo de estar disponible."
        );
      }
    }
  }

  private async claimRecipientKey(
    transaction: MatrixTransaction,
    claimRequestId: string,
    recipientDeviceId: string,
    claimedAt: Date
  ): Promise<void> {
    const oneTimeKey = await transaction.matrixOneTimeKey.findFirst({
      where: {
        deviceId: recipientDeviceId,
        algorithm: MATRIX_SIGNED_CURVE25519_ALGORITHM,
        claimedAt: null
      },
      select: { id: true },
      orderBy: [{ uploadedAt: "asc" }, { id: "asc" }]
    });
    if (oneTimeKey) {
      await transaction.matrixOneTimeKey.update({
        where: { id: oneTimeKey.id },
        data: { claimedAt }
      });
      await transaction.matrixKeyClaimResult.create({
        data: {
          claimRequestId,
          recipientDeviceId,
          algorithm: MATRIX_SIGNED_CURVE25519_ALGORITHM,
          oneTimeKeyId: oneTimeKey.id,
          claimedAt
        }
      });
      return;
    }

    const fallback = await transaction.matrixFallbackKeySlot.findUnique({
      where: {
        deviceId_algorithm: {
          deviceId: recipientDeviceId,
          algorithm: MATRIX_SIGNED_CURVE25519_ALGORITHM
        }
      },
      select: {
        currentKey: {
          select: { id: true, firstClaimedAt: true }
        }
      }
    });
    if (fallback) {
      if (fallback.currentKey.firstClaimedAt === null) {
        const marked = await transaction.matrixFallbackKey.updateMany({
          where: {
            id: fallback.currentKey.id,
            firstClaimedAt: null
          },
          data: { firstClaimedAt: claimedAt }
        });
        if (marked.count !== 1) {
          throw new ConflictException(
            "La fallback Matrix cambio durante el reclamo."
          );
        }
      }
      await transaction.matrixKeyClaimResult.create({
        data: {
          claimRequestId,
          recipientDeviceId,
          algorithm: MATRIX_SIGNED_CURVE25519_ALGORITHM,
          fallbackKeyId: fallback.currentKey.id,
          claimedAt
        }
      });
      return;
    }

    await transaction.matrixKeyClaimResult.create({
      data: {
        claimRequestId,
        recipientDeviceId,
        algorithm: MATRIX_SIGNED_CURVE25519_ALGORITHM,
        claimedAt
      }
    });
  }

  private async buildClaimResponse(
    transaction: MatrixTransaction,
    claimRequestId: string
  ) {
    const results = await transaction.matrixKeyClaimResult.findMany({
      where: { claimRequestId },
      select: {
        algorithm: true,
        recipientDevice: {
          select: {
            matrixDeviceKey: {
              select: { matrixUserId: true, matrixDeviceId: true }
            }
          }
        },
        oneTimeKey: { select: { keyId: true, signedKey: true } },
        fallbackKey: { select: { keyId: true, signedKey: true } }
      },
      orderBy: { recipientDeviceId: "asc" }
    });
    const oneTimeKeys: Record<
      string,
      Record<string, Record<string, unknown>>
    > = {};
    for (const result of results) {
      const identity = result.recipientDevice.matrixDeviceKey;
      const key = result.oneTimeKey ?? result.fallbackKey;
      if (!identity || !key) continue;
      const devices = (oneTimeKeys[identity.matrixUserId] ??= {});
      devices[identity.matrixDeviceId] = {
        [`${result.algorithm}:${key.keyId}`]: key.signedKey
      };
    }
    return { failures: {}, one_time_keys: oneTimeKeys };
  }

  private async insertOneTimeKeys(
    transaction: MatrixTransaction,
    deviceId: string,
    keys: Record<string, MatrixSignedCurveKey>,
    uploadedAt: Date
  ): Promise<void> {
    for (const [fullKeyId, signedKey] of Object.entries(keys)) {
      const keyId = this.curveKeyId(fullKeyId);
      const canonicalSha256 = hashMatrixCanonicalJson(signedKey);
      const existing = await transaction.matrixOneTimeKey.findUnique({
        where: {
          deviceId_algorithm_keyId: {
            deviceId,
            algorithm: MATRIX_SIGNED_CURVE25519_ALGORITHM,
            keyId
          }
        },
        select: {
          curve25519Key: true,
          canonicalSha256: true
        }
      });
      if (existing) {
        if (
          existing.curve25519Key !== signedKey.key ||
          existing.canonicalSha256 !== canonicalSha256
        ) {
          throw new ConflictException(
            "Una preclave Matrix existente no puede sustituirse."
          );
        }
        continue;
      }

      await transaction.matrixOneTimeKey.create({
        data: {
          deviceId,
          algorithm: MATRIX_SIGNED_CURVE25519_ALGORITHM,
          keyId,
          curve25519Key: signedKey.key,
          signedKey: signedKey as unknown as Prisma.InputJsonValue,
          canonicalSha256,
          uploadedAt
        }
      });
    }
  }

  private async rotateFallbackKey(
    transaction: MatrixTransaction,
    deviceId: string,
    keys: Record<string, MatrixSignedCurveKey>,
    uploadedAt: Date
  ): Promise<void> {
    const entry = Object.entries(keys)[0];
    if (!entry) return;
    const [fullKeyId, signedKey] = entry;
    const keyId = this.curveKeyId(fullKeyId);
    const canonicalSha256 = hashMatrixCanonicalJson(signedKey);
    let fallback = await transaction.matrixFallbackKey.findUnique({
      where: {
        deviceId_algorithm_keyId: {
          deviceId,
          algorithm: MATRIX_SIGNED_CURVE25519_ALGORITHM,
          keyId
        }
      },
      select: {
        id: true,
        curve25519Key: true,
        canonicalSha256: true,
        uploadedAt: true
      }
    });
    if (fallback) {
      if (
        fallback.curve25519Key !== signedKey.key ||
        fallback.canonicalSha256 !== canonicalSha256
      ) {
        throw new ConflictException(
          "Una fallback Matrix existente no puede sustituirse."
        );
      }
    } else {
      fallback = await transaction.matrixFallbackKey.create({
        data: {
          deviceId,
          algorithm: MATRIX_SIGNED_CURVE25519_ALGORITHM,
          keyId,
          curve25519Key: signedKey.key,
          signedKey: signedKey as unknown as Prisma.InputJsonValue,
          canonicalSha256,
          uploadedAt
        },
        select: {
          id: true,
          curve25519Key: true,
          canonicalSha256: true,
          uploadedAt: true
        }
      });
    }

    const slot = await transaction.matrixFallbackKeySlot.findUnique({
      where: {
        deviceId_algorithm: {
          deviceId,
          algorithm: MATRIX_SIGNED_CURVE25519_ALGORITHM
        }
      },
      select: {
        currentFallbackKeyId: true,
        currentKey: { select: { uploadedAt: true } }
      }
    });
    if (!slot) {
      await transaction.matrixFallbackKeySlot.create({
        data: {
          deviceId,
          algorithm: MATRIX_SIGNED_CURVE25519_ALGORITHM,
          currentFallbackKeyId: fallback.id
        }
      });
    } else if (slot.currentFallbackKeyId !== fallback.id) {
      if (fallback.uploadedAt <= slot.currentKey.uploadedAt) {
        throw new ConflictException(
          "La rotacion fallback debe reintentarse con un reloj posterior."
        );
      }
      await transaction.matrixFallbackKeySlot.update({
        where: {
          deviceId_algorithm: {
            deviceId,
            algorithm: MATRIX_SIGNED_CURVE25519_ALGORITHM
          }
        },
        data: { currentFallbackKeyId: fallback.id }
      });
    }
  }

  private deviceKeyData(
    deviceId: string,
    userId: string,
    deviceKeys: MatrixDeviceKeys,
    uploadedAt: Date
  ): Prisma.MatrixDeviceKeyUncheckedCreateInput {
    const matrixDeviceId = deviceKeys.device_id;
    const curve25519Key = deviceKeys.keys[`curve25519:${matrixDeviceId}`];
    const ed25519Key = deviceKeys.keys[`ed25519:${matrixDeviceId}`];
    if (!curve25519Key || !ed25519Key) {
      throw new BadRequestException("Claves publicas Matrix incompletas.");
    }
    return {
      deviceId,
      userId,
      matrixUserId: deviceKeys.user_id,
      matrixDeviceId,
      curve25519Key,
      ed25519Key,
      deviceKeys: deviceKeys as unknown as Prisma.InputJsonValue,
      canonicalSha256: hashMatrixCanonicalJson(deviceKeys),
      uploadedAt
    };
  }

  private async requireCurrentSession(
    transaction: MatrixTransaction,
    principal: SessionPrincipal,
    now: Date,
    expectedDeviceId: string | null
  ): Promise<number> {
    const session = await transaction.authSession.findUnique({
      where: { id: principal.sessionId },
      select: {
        userId: true,
        deviceId: true,
        expiresAt: true,
        revokedAt: true,
        sessionVersion: true,
        user: {
          select: {
            sessionVersion: true,
            status: true,
            passwordResetRequired: true
          }
        }
      }
    });
    if (
      !session ||
      session.userId !== principal.id ||
      session.deviceId !== expectedDeviceId ||
      session.revokedAt !== null ||
      session.expiresAt <= now ||
      session.sessionVersion !== session.user.sessionVersion ||
      session.user.status !== AccountStatus.ACTIVE ||
      session.user.passwordResetRequired
    ) {
      throw new UnauthorizedException("La sesion ya no esta vigente.");
    }
    return session.sessionVersion;
  }

  private async lockRegistration(
    transaction: MatrixTransaction,
    registrationId: string
  ): Promise<void> {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
        FROM "matrix_device_registrations"
       WHERE "id" = ${registrationId}::uuid
       FOR UPDATE
    `;
    if (rows.length !== 1) {
      throw new NotFoundException("Reserva de dispositivo no encontrada.");
    }
  }

  private async lockDeviceSet(
    transaction: MatrixTransaction,
    userId: string
  ): Promise<void> {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended('sinochat:devices:' || ${userId}::text, 0)
      )::text
    `;
  }

  private async databaseNow(transaction: MatrixTransaction): Promise<Date> {
    const [clock] = await transaction.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS "now"
    `;
    if (!clock) throw new Error("No se pudo obtener el reloj PostgreSQL.");
    return clock.now;
  }

  private runTransaction<T>(
    operation: (transaction: MatrixTransaction) => Promise<T>
  ): Promise<T> {
    return this.prisma.$transaction(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: 30_000
    });
  }

  private parseInitialUpload(
    value: unknown,
    expected: { userId: string; deviceId: string }
  ) {
    try {
      return parseInitialMatrixKeyUpload(value, expected);
    } catch (error) {
      this.rethrowUploadValidation(error);
    }
  }

  private parseUpload(
    value: unknown,
    expected: {
      userId: string;
      deviceId: string;
      existingEd25519PublicKey: string;
    }
  ) {
    try {
      return parseMatrixKeyUpload(value, expected);
    } catch (error) {
      this.rethrowUploadValidation(error);
    }
  }

  private parseQuery(value: unknown): MatrixKeysQuery {
    try {
      return parseMatrixKeysQuery(value);
    } catch (error) {
      this.rethrowKeyRequestValidation(error);
    }
  }

  private parseClaim(value: unknown): MatrixKeysClaim {
    try {
      return parseMatrixKeysClaim(value);
    } catch (error) {
      this.rethrowKeyRequestValidation(error);
    }
  }

  private parseClaimRequestId(value: string): string {
    try {
      return parseMatrixClaimRequestId(value);
    } catch (error) {
      this.rethrowKeyRequestValidation(error);
    }
  }

  private rethrowUploadValidation(error: unknown): never {
    if (error instanceof MatrixKeyUploadValidationError) {
      throw new BadRequestException({
        error: error.code,
        message: "La publicacion de claves Matrix no es valida."
      });
    }
    throw error;
  }

  private rethrowKeyRequestValidation(error: unknown): never {
    if (error instanceof MatrixKeyRequestValidationError) {
      throw new BadRequestException({
        error: error.code,
        message: "La solicitud del directorio Matrix no es valida."
      });
    }
    throw error;
  }

  private requireBoundDevice(principal: SessionPrincipal): string {
    if (principal.role !== "CLIENT" && principal.role !== "CASHIER") {
      throw new ForbiddenException("El rol no puede consultar identidades de chat.");
    }
    if (!principal.deviceId) {
      throw new ForbiddenException(
        "La sesion no esta vinculada a un dispositivo."
      );
    }
    return principal.deviceId;
  }

  private registrationResponse(
    userId: string,
    registrationId: string,
    expiresAt: Date
  ) {
    return {
      deviceId: registrationId,
      matrixUserId: matrixUserIdFromUuid(userId, this.matrixServerName),
      matrixDeviceId: matrixDeviceIdFromUuid(registrationId),
      matrixServerName: this.matrixServerName,
      expiresAt
    };
  }

  private curveKeyId(fullKeyId: string): string {
    const prefix = `${MATRIX_SIGNED_CURVE25519_ALGORITHM}:`;
    if (!fullKeyId.startsWith(prefix)) {
      throw new BadRequestException("Identificador de preclave invalido.");
    }
    return fullKeyId.slice(prefix.length);
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
