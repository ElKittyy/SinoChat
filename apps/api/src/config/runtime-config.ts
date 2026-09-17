import { isIP } from "node:net";
import { normalizeMatrixServerName } from "@sinochat/contracts";
import { readInvitationEncryptionKeyring } from "./invitation-encryption-keyring";

export type RuntimeEnvironment = "development" | "test" | "production";
export type TrustProxySetting = false | number | string[];

export interface RuntimeConfig {
  nodeEnvironment: RuntimeEnvironment;
  webOrigin: string;
  matrixServerName: string;
  apiPort: number;
  databaseUrl: string;
  databasePoolMax: number;
  redisUrl: string | null;
  socketIoRedisChannelPrefix: string;
  rateLimitRedisPrefix: string;
  rateLimitHmacSecret: string | null;
  legalTimeZone: string;
  trustProxy: TrustProxySetting;
  sessionTtlHours: number;
  adminSessionTtlHours: number;
  adminSessionIdleTimeoutMinutes: number;
  sessionCookieName: string;
  csrfCookieName: string;
  webAuthnRpId: string;
  webAuthnRpName: string;
  webAuthnOrigin: string;
}

const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const REDIS_CHANNEL_PREFIX_PATTERN = /^[A-Za-z0-9:_.-]{3,96}$/;
const RATE_LIMIT_PREFIX_PATTERN = /^[A-Za-z0-9:_.-]{3,120}$/;
const TRUST_PROXY_NAMES = new Set(["loopback", "linklocal", "uniquelocal"]);
const WEBAUTHN_RP_ID_PATTERN = /^(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/;

export function readNodeEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): RuntimeEnvironment {
  const value = environment.NODE_ENV;
  if (
    value !== "development" &&
    value !== "test" &&
    value !== "production"
  ) {
    throw new Error(
      "NODE_ENV es obligatorio y debe ser development, test o production."
    );
  }
  return value;
}

export function readWebOrigin(
  environment: NodeJS.ProcessEnv = process.env,
  nodeEnvironment = readNodeEnvironment(environment)
): string {
  const configured = environment.WEB_ORIGIN?.trim();
  const value =
    configured ||
    (nodeEnvironment === "production" ? undefined : "http://localhost:5173");

  if (!value) {
    throw new Error("WEB_ORIGIN es obligatorio en producción.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("WEB_ORIGIN debe ser un origen HTTP(S) válido.");
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "WEB_ORIGIN debe contener únicamente un origen HTTP(S), sin ruta ni credenciales."
    );
  }

  if (nodeEnvironment === "production" && parsed.protocol !== "https:") {
    throw new Error("WEB_ORIGIN debe usar HTTPS en producción.");
  }

  return parsed.origin;
}

export function readMatrixServerName(
  environment: NodeJS.ProcessEnv = process.env,
  nodeEnvironment = readNodeEnvironment(environment)
): string {
  const configured = environment.MATRIX_SERVER_NAME?.trim();
  if (!configured && nodeEnvironment === "production") {
    throw new Error(
      "MATRIX_SERVER_NAME es obligatorio en produccion y no debe cambiar despues de registrar dispositivos."
    );
  }

  try {
    return normalizeMatrixServerName(configured || "sinochat.invalid");
  } catch {
    throw new Error("MATRIX_SERVER_NAME no es un ServerName Matrix valido.");
  }
}

export function readSessionConfig(
  environment: NodeJS.ProcessEnv = process.env,
  nodeEnvironment = readNodeEnvironment(environment)
): Pick<
  RuntimeConfig,
  | "sessionTtlHours"
  | "adminSessionTtlHours"
  | "adminSessionIdleTimeoutMinutes"
  | "sessionCookieName"
  | "csrfCookieName"
> {
  const sessionTtlHours = readInteger(
    environment.SESSION_TTL_HOURS,
    "SESSION_TTL_HOURS",
    168,
    1,
    720
  );
  const adminSessionTtlHours = readInteger(
    environment.ADMIN_SESSION_TTL_HOURS,
    "ADMIN_SESSION_TTL_HOURS",
    12,
    1,
    24
  );
  const adminSessionIdleTimeoutMinutes = readInteger(
    environment.ADMIN_SESSION_IDLE_TIMEOUT_MINUTES,
    "ADMIN_SESSION_IDLE_TIMEOUT_MINUTES",
    30,
    5,
    120
  );

  if (adminSessionTtlHours > sessionTtlHours) {
    throw new Error(
      "ADMIN_SESSION_TTL_HOURS no puede superar SESSION_TTL_HOURS."
    );
  }
  if (adminSessionIdleTimeoutMinutes >= adminSessionTtlHours * 60) {
    throw new Error(
      "ADMIN_SESSION_IDLE_TIMEOUT_MINUTES debe ser menor que el TTL absoluto de administrador."
    );
  }
  const sessionCookieName =
    environment.SESSION_COOKIE_NAME?.trim() ||
    (nodeEnvironment === "production"
      ? "__Host-sinochat_session"
      : "sinochat_session");
  const csrfCookieName =
    environment.CSRF_COOKIE_NAME?.trim() ||
    (nodeEnvironment === "production"
      ? "__Host-sinochat_csrf"
      : "sinochat_csrf");

  validateCookieName(sessionCookieName, "SESSION_COOKIE_NAME");
  validateCookieName(csrfCookieName, "CSRF_COOKIE_NAME");

  if (sessionCookieName === csrfCookieName) {
    throw new Error(
      "SESSION_COOKIE_NAME y CSRF_COOKIE_NAME deben ser diferentes."
    );
  }

  if (
    nodeEnvironment === "production" &&
    (!sessionCookieName.startsWith("__Host-") ||
      !csrfCookieName.startsWith("__Host-"))
  ) {
    throw new Error(
      "Las cookies de producción deben utilizar nombres con prefijo __Host-."
    );
  }

  return {
    sessionTtlHours,
    adminSessionTtlHours,
    adminSessionIdleTimeoutMinutes,
    sessionCookieName,
    csrfCookieName
  };
}

export function readWebAuthnConfig(
  environment: NodeJS.ProcessEnv = process.env,
  nodeEnvironment = readNodeEnvironment(environment),
  webOrigin = readWebOrigin(environment, nodeEnvironment)
): Pick<RuntimeConfig, "webAuthnRpId" | "webAuthnRpName" | "webAuthnOrigin"> {
  const origin = new URL(webOrigin);
  const configuredRpId = environment.WEBAUTHN_RP_ID?.trim().toLowerCase();
  if (nodeEnvironment === "production" && !configuredRpId) {
    throw new Error("WEBAUTHN_RP_ID es obligatorio en producción.");
  }

  const webAuthnRpId = configuredRpId || origin.hostname.toLowerCase();
  if (!WEBAUTHN_RP_ID_PATTERN.test(webAuthnRpId)) {
    throw new Error(
      "WEBAUTHN_RP_ID debe ser localhost o un dominio DNS canónico sin protocolo ni puerto."
    );
  }
  const originHost = origin.hostname.toLowerCase();
  if (originHost !== webAuthnRpId) {
    throw new Error(
      "WEBAUTHN_RP_ID debe coincidir exactamente con el host de WEB_ORIGIN."
    );
  }
  if (nodeEnvironment === "production" && webAuthnRpId === "localhost") {
    throw new Error("WEBAUTHN_RP_ID no puede ser localhost en producción.");
  }

  const webAuthnRpName = environment.WEBAUTHN_RP_NAME?.trim() || "SinoChat";
  if (
    webAuthnRpName.length < 1 ||
    webAuthnRpName.length > 64 ||
    /[\u0000-\u001f\u007f]/.test(webAuthnRpName)
  ) {
    throw new Error(
      "WEBAUTHN_RP_NAME debe contener entre 1 y 64 caracteres visibles."
    );
  }

  return {
    webAuthnRpId,
    webAuthnRpName,
    webAuthnOrigin: origin.origin
  };
}

export function readDatabaseConfig(
  environment: NodeJS.ProcessEnv = process.env,
  nodeEnvironment = readNodeEnvironment(environment)
): Pick<RuntimeConfig, "databaseUrl" | "databasePoolMax"> {
  const databaseUrl = required(environment.DATABASE_URL, "DATABASE_URL");
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL debe ser una URL PostgreSQL válida.");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.username ||
    !parsed.pathname ||
    parsed.pathname === "/" ||
    parsed.hash
  ) {
    throw new Error(
      "DATABASE_URL debe incluir protocolo PostgreSQL, usuario, host y base."
    );
  }
  if (
    nodeEnvironment === "production" &&
    parsed.searchParams.get("sslmode") !== "verify-full"
  ) {
    throw new Error(
      "DATABASE_URL debe usar sslmode=verify-full en producción."
    );
  }
  const databasePoolMax = readInteger(
    environment.DATABASE_POOL_MAX,
    "DATABASE_POOL_MAX",
    10,
    1,
    100
  );

  return { databaseUrl, databasePoolMax };
}

export function readRedisConfig(
  environment: NodeJS.ProcessEnv = process.env,
  nodeEnvironment = readNodeEnvironment(environment)
): Pick<RuntimeConfig, "redisUrl" | "socketIoRedisChannelPrefix"> {
  const configuredUrl = environment.REDIS_URL?.trim();
  if (!configuredUrl) {
    if (nodeEnvironment === "production") {
      throw new Error("REDIS_URL es obligatorio en producción.");
    }
    return {
      redisUrl: null,
      socketIoRedisChannelPrefix: defaultRedisChannelPrefix(nodeEnvironment)
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error("REDIS_URL debe ser una URL Redis válida.");
  }

  if (
    !["redis:", "rediss:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.hash ||
    parsed.search ||
    !/^(?:\/\d*)?$/.test(parsed.pathname)
  ) {
    throw new Error(
      "REDIS_URL debe usar redis:// o rediss:// y no incluir query ni fragmento."
    );
  }
  if (
    nodeEnvironment === "production" &&
    parsed.protocol !== "rediss:"
  ) {
    throw new Error("REDIS_URL debe usar rediss:// en producción.");
  }

  const socketIoRedisChannelPrefix =
    environment.SOCKET_IO_REDIS_CHANNEL_PREFIX?.trim() ||
    defaultRedisChannelPrefix(nodeEnvironment);
  if (!REDIS_CHANNEL_PREFIX_PATTERN.test(socketIoRedisChannelPrefix)) {
    throw new Error(
      "SOCKET_IO_REDIS_CHANNEL_PREFIX debe contener entre 3 y 96 caracteres seguros."
    );
  }

  return {
    redisUrl: parsed.toString(),
    socketIoRedisChannelPrefix
  };
}

export function readRateLimitConfig(
  environment: NodeJS.ProcessEnv = process.env,
  nodeEnvironment = readNodeEnvironment(environment),
  redis = readRedisConfig(environment, nodeEnvironment)
): Pick<
  RuntimeConfig,
  "rateLimitRedisPrefix" | "rateLimitHmacSecret"
> {
  const rateLimitRedisPrefix =
    environment.RATE_LIMIT_REDIS_PREFIX?.trim() ||
    `${redis.socketIoRedisChannelPrefix}:rate-limit`;
  if (!RATE_LIMIT_PREFIX_PATTERN.test(rateLimitRedisPrefix)) {
    throw new Error(
      "RATE_LIMIT_REDIS_PREFIX debe contener entre 3 y 120 caracteres seguros."
    );
  }

  const configuredSecret = environment.RATE_LIMIT_HMAC_SECRET?.trim();
  if (nodeEnvironment === "production" && !configuredSecret) {
    throw new Error("RATE_LIMIT_HMAC_SECRET es obligatorio en producción.");
  }
  if (
    configuredSecret &&
    Buffer.byteLength(configuredSecret, "utf8") < 32
  ) {
    throw new Error(
      "RATE_LIMIT_HMAC_SECRET debe contener al menos 32 bytes."
    );
  }

  return {
    rateLimitRedisPrefix,
    rateLimitHmacSecret: configuredSecret || null
  };
}

export function readDeviceBindingHmacSecret(
  environment: NodeJS.ProcessEnv = process.env
): string {
  const secret = required(
    environment.DEVICE_BINDING_HMAC_SECRET,
    "DEVICE_BINDING_HMAC_SECRET"
  );
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error(
      "DEVICE_BINDING_HMAC_SECRET debe contener al menos 32 bytes."
    );
  }
  return secret;
}

export function readMatrixSyncTokenSecret(
  environment: NodeJS.ProcessEnv = process.env,
  nodeEnvironment = readNodeEnvironment(environment)
): string {
  const configured = environment.MATRIX_SYNC_TOKEN_SECRET?.trim();
  if (!configured) {
    if (nodeEnvironment === "production") {
      throw new Error(
        "MATRIX_SYNC_TOKEN_SECRET es obligatorio en produccion."
      );
    }
    return readDeviceBindingHmacSecret(environment);
  }
  if (Buffer.byteLength(configured, "utf8") < 32) {
    throw new Error(
      "MATRIX_SYNC_TOKEN_SECRET debe contener al menos 32 bytes."
    );
  }
  return configured;
}

export function readTrustProxy(
  environment: NodeJS.ProcessEnv = process.env,
  nodeEnvironment = readNodeEnvironment(environment)
): TrustProxySetting {
  const configured = environment.TRUST_PROXY?.trim();

  if (!configured) {
    if (nodeEnvironment === "production") {
      throw new Error(
        "TRUST_PROXY es obligatorio en producción; usa none si no existe proxy."
      );
    }
    return false;
  }

  const normalized = configured.toLowerCase();
  if (normalized === "none" || normalized === "false" || normalized === "0") {
    return false;
  }
  if (normalized === "true") {
    throw new Error(
      "TRUST_PROXY=true no está permitido; declara saltos o direcciones concretas."
    );
  }
  if (/^\d+$/.test(normalized)) {
    return readInteger(normalized, "TRUST_PROXY", 0, 1, 10);
  }

  const addresses = configured.split(",").map((entry) => entry.trim());
  if (
    addresses.some((entry) => !entry || !isTrustedProxyAddress(entry))
  ) {
    throw new Error(
      "TRUST_PROXY debe ser none, un número de saltos o una lista de IP/CIDR confiables."
    );
  }

  return addresses.map((entry) => {
    const normalizedEntry = entry.toLowerCase();
    return TRUST_PROXY_NAMES.has(normalizedEntry) ? normalizedEntry : entry;
  });
}

export function loadRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): RuntimeConfig {
  const nodeEnvironment = readNodeEnvironment(environment);
  const webOrigin = readWebOrigin(environment, nodeEnvironment);
  const matrixServerName = readMatrixServerName(
    environment,
    nodeEnvironment
  );
  const session = readSessionConfig(environment, nodeEnvironment);
  const webAuthn = readWebAuthnConfig(
    environment,
    nodeEnvironment,
    webOrigin
  );
  const database = readDatabaseConfig(environment, nodeEnvironment);
  const redis = readRedisConfig(environment, nodeEnvironment);
  const rateLimit = readRateLimitConfig(
    environment,
    nodeEnvironment,
    redis
  );
  const apiPort = readInteger(
    environment.API_PORT,
    "API_PORT",
    3000,
    1,
    65_535
  );
  const trustProxy = readTrustProxy(environment, nodeEnvironment);
  const legalTimeZone =
    environment.LEGAL_TIME_ZONE?.trim() ||
    "America/Argentina/Buenos_Aires";
  try {
    new Intl.DateTimeFormat("es-AR", {
      timeZone: legalTimeZone
    }).format(new Date());
  } catch {
    throw new Error("LEGAL_TIME_ZONE debe ser una zona horaria IANA válida.");
  }

  if (nodeEnvironment === "production") {
    validateProductionSecrets(environment);
    validateProductionObjectStorage(environment);
  }

  return {
    nodeEnvironment,
    webOrigin,
    matrixServerName,
    apiPort,
    legalTimeZone,
    trustProxy,
    ...database,
    ...redis,
    ...rateLimit,
    ...session,
    ...webAuthn
  };
}

export function readObjectStorageForcePathStyle(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  const configured =
    environment.OBJECT_STORAGE_FORCE_PATH_STYLE?.trim().toLowerCase();
  if (!configured) {
    return false;
  }
  if (configured === "true") {
    return true;
  }
  if (configured === "false") {
    return false;
  }
  throw new Error(
    "OBJECT_STORAGE_FORCE_PATH_STYLE debe ser true o false."
  );
}

function validateProductionSecrets(environment: NodeJS.ProcessEnv): void {
  const passwordPepper = required(
    environment.PASSWORD_PEPPER,
    "PASSWORD_PEPPER"
  );
  const metadataHashSecret = required(
    environment.METADATA_HASH_SECRET,
    "METADATA_HASH_SECRET"
  );

  if (Buffer.byteLength(passwordPepper, "utf8") < 32) {
    throw new Error("PASSWORD_PEPPER debe contener al menos 32 bytes.");
  }
  if (Buffer.byteLength(metadataHashSecret, "utf8") < 32) {
    throw new Error("METADATA_HASH_SECRET debe contener al menos 32 bytes.");
  }
  if (passwordPepper === metadataHashSecret) {
    throw new Error(
      "PASSWORD_PEPPER y METADATA_HASH_SECRET deben ser secretos diferentes."
    );
  }

  const attachmentGrantSecret = required(
    environment.ATTACHMENT_GRANT_SECRET,
    "ATTACHMENT_GRANT_SECRET"
  );
  if (Buffer.byteLength(attachmentGrantSecret, "utf8") < 32) {
    throw new Error(
      "ATTACHMENT_GRANT_SECRET debe contener al menos 32 bytes."
    );
  }
  const evidenceGrantSecret = required(
    environment.EVIDENCE_UPLOAD_GRANT_SECRET,
    "EVIDENCE_UPLOAD_GRANT_SECRET"
  );
  if (Buffer.byteLength(evidenceGrantSecret, "utf8") < 32) {
    throw new Error(
      "EVIDENCE_UPLOAD_GRANT_SECRET debe contener al menos 32 bytes."
    );
  }
  const deviceBindingHmacSecret =
    readDeviceBindingHmacSecret(environment);
  const matrixSyncTokenSecret = readMatrixSyncTokenSecret(
    environment,
    "production"
  );
  const rateLimitHmacSecret = required(
    environment.RATE_LIMIT_HMAC_SECRET,
    "RATE_LIMIT_HMAC_SECRET"
  );
  if (Buffer.byteLength(rateLimitHmacSecret, "utf8") < 32) {
    throw new Error(
      "RATE_LIMIT_HMAC_SECRET debe contener al menos 32 bytes."
    );
  }
  if (
    new Set([
      passwordPepper,
      metadataHashSecret,
      attachmentGrantSecret,
      evidenceGrantSecret,
      deviceBindingHmacSecret,
      matrixSyncTokenSecret,
      rateLimitHmacSecret
    ]).size !== 7
  ) {
    throw new Error(
      "Los secretos de contraseñas, metadatos, adjuntos, evidencia, vinculación de dispositivos, sync Matrix y rate limit deben ser diferentes."
    );
  }

  readInvitationEncryptionKeyring(environment);
}

function validateProductionObjectStorage(
  environment: NodeJS.ProcessEnv
): void {
  const endpoint = required(
    environment.OBJECT_STORAGE_ENDPOINT,
    "OBJECT_STORAGE_ENDPOINT"
  );
  required(environment.OBJECT_STORAGE_REGION, "OBJECT_STORAGE_REGION");
  required(environment.OBJECT_STORAGE_BUCKET, "OBJECT_STORAGE_BUCKET");
  required(
    environment.OBJECT_STORAGE_ACCESS_KEY_ID,
    "OBJECT_STORAGE_ACCESS_KEY_ID"
  );
  required(
    environment.OBJECT_STORAGE_SECRET_ACCESS_KEY,
    "OBJECT_STORAGE_SECRET_ACCESS_KEY"
  );
  readObjectStorageForcePathStyle(environment);
  const versioningMode = required(
    environment.OBJECT_STORAGE_VERSIONING_MODE,
    "OBJECT_STORAGE_VERSIONING_MODE"
  );
  if (
    versioningMode !== "disabled" &&
    versioningMode !== "purge-all"
  ) {
    throw new Error(
      "OBJECT_STORAGE_VERSIONING_MODE debe ser disabled o purge-all."
    );
  }

  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error("OBJECT_STORAGE_ENDPOINT debe ser una URL válida.");
  }

  if (parsedEndpoint.protocol !== "https:") {
    throw new Error(
      "OBJECT_STORAGE_ENDPOINT debe usar HTTPS en producción."
    );
  }
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} es obligatorio.`);
  }
  return normalized;
}

function readInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const candidate = value === undefined || value === "" ? fallback : Number(value);
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new Error(`${name} debe ser un entero entre ${minimum} y ${maximum}.`);
  }
  return candidate;
}

function validateCookieName(value: string, name: string): void {
  if (!COOKIE_NAME_PATTERN.test(value)) {
    throw new Error(`${name} contiene caracteres no permitidos.`);
  }
}

function isTrustedProxyAddress(value: string): boolean {
  const normalized = value.toLowerCase();
  if (TRUST_PROXY_NAMES.has(normalized) || isIP(value) !== 0) {
    return true;
  }

  const [address, prefix, extra] = value.split("/");
  if (!address || !prefix || extra !== undefined || !/^\d+$/.test(prefix)) {
    return false;
  }

  const family = isIP(address);
  const prefixLength = Number(prefix);
  return (
    (family === 4 && prefixLength >= 1 && prefixLength <= 32) ||
    (family === 6 && prefixLength >= 1 && prefixLength <= 128)
  );
}

function defaultRedisChannelPrefix(
  nodeEnvironment: RuntimeEnvironment
): string {
  return `sinochat:${nodeEnvironment}:socket.io`;
}
