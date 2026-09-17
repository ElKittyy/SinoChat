import {
  deepEqual,
  equal,
  throws
} from "node:assert/strict";
import { describe, it } from "node:test";
import {
  loadRuntimeConfig,
  readObjectStorageForcePathStyle
} from "./runtime-config";

describe("readObjectStorageForcePathStyle", () => {
  it("acepta booleanos explicitos y usa false por defecto", () => {
    equal(readObjectStorageForcePathStyle({}), false);
    equal(
      readObjectStorageForcePathStyle({
        OBJECT_STORAGE_FORCE_PATH_STYLE: " true "
      }),
      true
    );
    equal(
      readObjectStorageForcePathStyle({
        OBJECT_STORAGE_FORCE_PATH_STYLE: "FALSE"
      }),
      false
    );
  });

  it("rechaza valores ambiguos", () => {
    throws(
      () =>
        readObjectStorageForcePathStyle({
          OBJECT_STORAGE_FORCE_PATH_STYLE: "1"
        }),
      /debe ser true o false/
    );
  });
});

describe("loadRuntimeConfig", () => {
  it("usa valores locales seguros y explícitos", () => {
    const config = loadRuntimeConfig({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://user:password@localhost:5432/sinochat"
    });

    equal(config.webOrigin, "http://localhost:5173");
    equal(config.matrixServerName, "sinochat.invalid");
    equal(config.apiPort, 3000);
    equal(config.databasePoolMax, 10);
    equal(config.redisUrl, null);
    equal(
      config.socketIoRedisChannelPrefix,
      "sinochat:development:socket.io"
    );
    equal(
      config.rateLimitRedisPrefix,
      "sinochat:development:socket.io:rate-limit"
    );
    equal(config.rateLimitHmacSecret, null);
    equal(config.trustProxy, false);
    equal(config.sessionTtlHours, 168);
    equal(config.adminSessionTtlHours, 12);
    equal(config.adminSessionIdleTimeoutMinutes, 30);
    equal(config.sessionCookieName, "sinochat_session");
    equal(config.csrfCookieName, "sinochat_csrf");
    equal(config.webAuthnRpId, "localhost");
    equal(config.webAuthnRpName, "SinoChat");
    equal(config.webAuthnOrigin, "http://localhost:5173");
  });

  it("acepta una configuración productiva completa", () => {
    const config = loadRuntimeConfig(productionEnvironment());

    equal(config.nodeEnvironment, "production");
    equal(config.webOrigin, "https://chat.example.com");
    equal(config.matrixServerName, "chat.example.com");
    equal(config.apiPort, 443);
    equal(config.webAuthnRpId, "chat.example.com");
    equal(config.webAuthnOrigin, "https://chat.example.com");
    equal(config.databasePoolMax, 20);
    equal(config.redisUrl, "rediss://redis.example.com:6380/0");
    equal(
      config.socketIoRedisChannelPrefix,
      "sinochat:production:socket.io"
    );
    equal(
      config.rateLimitRedisPrefix,
      "sinochat:production:socket.io:rate-limit"
    );
    equal(config.rateLimitHmacSecret, "r".repeat(32));
    deepEqual(config.trustProxy, ["loopback", "10.0.0.0/8"]);
    equal(config.sessionTtlHours, 24);
    equal(config.adminSessionTtlHours, 8);
    equal(config.adminSessionIdleTimeoutMinutes, 20);
    equal(config.sessionCookieName, "__Host-sinochat_session");
    equal(config.csrfCookieName, "__Host-sinochat_csrf");
  });

  it("rechaza NODE_ENV ausente o desconocido", () => {
    throws(
      () =>
        loadRuntimeConfig({
          DATABASE_URL: "postgresql://user:password@localhost:5432/sinochat"
        }),
      /NODE_ENV es obligatorio/
    );
    throws(
      () =>
        loadRuntimeConfig({
          NODE_ENV: "staging",
          DATABASE_URL: "postgresql://user:password@localhost:5432/sinochat"
        }),
      /NODE_ENV es obligatorio/
    );
  });

  it("liga WebAuthn al origen y exige un RP ID explícito en producción", () => {
    const missing = productionEnvironment();
    delete missing.WEBAUTHN_RP_ID;
    throws(() => loadRuntimeConfig(missing), /WEBAUTHN_RP_ID es obligatorio/);

    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          WEBAUTHN_RP_ID: "otro.example.net"
        }),
      /coincidir exactamente/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          WEBAUTHN_RP_ID: "example.com"
        }),
      /coincidir exactamente/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          WEBAUTHN_RP_ID: "https://example.com"
        }),
      /dominio DNS canónico/
    );
  });

  it("fija un ServerName Matrix valido y lo exige en produccion", () => {
    equal(
      loadRuntimeConfig({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://user:password@localhost:5432/sinochat",
        MATRIX_SERVER_NAME: "CHAT.Example.COM:8448"
      }).matrixServerName,
      "chat.example.com:8448"
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          MATRIX_SERVER_NAME: "bad/name"
        }),
      /MATRIX_SERVER_NAME/
    );
    const missing = productionEnvironment();
    delete missing.MATRIX_SERVER_NAME;
    throws(() => loadRuntimeConfig(missing), /MATRIX_SERVER_NAME/);
  });

  it("exige HTTPS, secretos fuertes y cookies __Host- en producción", () => {
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          WEB_ORIGIN: "http://chat.example.com"
        }),
      /HTTPS/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          PASSWORD_PEPPER: "débil"
        }),
      /PASSWORD_PEPPER/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          SESSION_COOKIE_NAME: "sinochat_session"
        }),
      /__Host-/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          ATTACHMENT_GRANT_SECRET: "débil"
        }),
      /ATTACHMENT_GRANT_SECRET/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          EVIDENCE_UPLOAD_GRANT_SECRET: "débil"
        }),
      /EVIDENCE_UPLOAD_GRANT_SECRET/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          DEVICE_BINDING_HMAC_SECRET: "débil"
        }),
      /DEVICE_BINDING_HMAC_SECRET/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          DEVICE_BINDING_HMAC_SECRET: "p".repeat(32)
        }),
      /deben ser diferentes/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          MATRIX_SYNC_TOKEN_SECRET: "debil"
        }),
      /MATRIX_SYNC_TOKEN_SECRET/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          MATRIX_SYNC_TOKEN_SECRET: "d".repeat(32)
        }),
      /deben ser diferentes/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          RATE_LIMIT_HMAC_SECRET: "débil"
        }),
      /RATE_LIMIT_HMAC_SECRET/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          RATE_LIMIT_HMAC_SECRET: "m".repeat(32)
        }),
      /deben ser diferentes/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          OBJECT_STORAGE_ENDPOINT: "http://storage.example.com"
        }),
      /OBJECT_STORAGE_ENDPOINT debe usar HTTPS/
    );

    const withoutStorageRegion = productionEnvironment();
    delete withoutStorageRegion.OBJECT_STORAGE_REGION;
    throws(
      () => loadRuntimeConfig(withoutStorageRegion),
      /OBJECT_STORAGE_REGION es obligatorio/
    );
  });

  it("exige Redis con TLS en producción", () => {
    const withoutRedis = productionEnvironment();
    delete withoutRedis.REDIS_URL;
    throws(
      () => loadRuntimeConfig(withoutRedis),
      /REDIS_URL es obligatorio/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          REDIS_URL: "redis://redis.example.com:6379/0"
        }),
      /rediss:\/\//
    );
  });

  it("exige PostgreSQL con verificación TLS completa en producción", () => {
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          DATABASE_URL:
            "postgresql://sinochat:secret@database.example.com:5432/sinochat?sslmode=require"
        }),
      /sslmode=verify-full/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          DATABASE_URL: "no-es-postgresql"
        }),
      /PostgreSQL válida/
    );
  });

  it("valida el keyring versionado de invitaciones en producción", () => {
    const previousKey = Buffer.alloc(32, 8).toString("base64");
    const rotated = loadRuntimeConfig({
      ...productionEnvironment(),
      INVITATION_ENCRYPTION_KEY_VERSION: "2",
      INVITATION_ENCRYPTION_PREVIOUS_KEYS: JSON.stringify({
        1: previousKey
      })
    });
    equal(rotated.nodeEnvironment, "production");

    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          INVITATION_ENCRYPTION_PREVIOUS_KEYS: "no-es-json"
        }),
      /objeto JSON válido/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          INVITATION_ENCRYPTION_PREVIOUS_KEYS: JSON.stringify({
            1: Buffer.alloc(32, 8).toString("base64")
          })
        }),
      /versión actual no debe repetirse/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          INVITATION_ENCRYPTION_KEY_VERSION: "2",
          INVITATION_ENCRYPTION_PREVIOUS_KEYS: JSON.stringify({
            1: Buffer.alloc(32, 7).toString("base64")
          })
        }),
      /debe usar una clave diferente/
    );
  });

  it("permite Redis opcional local y valida URL y prefijo", () => {
    const local = loadRuntimeConfig({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://user:password@localhost:5432/sinochat",
      REDIS_URL: "redis://localhost:6379/2",
      SOCKET_IO_REDIS_CHANNEL_PREFIX: "sinochat:dev-a:socket.io"
    });
    equal(local.redisUrl, "redis://localhost:6379/2");
    equal(
      local.socketIoRedisChannelPrefix,
      "sinochat:dev-a:socket.io"
    );
    equal(
      local.rateLimitRedisPrefix,
      "sinochat:dev-a:socket.io:rate-limit"
    );

    throws(
      () =>
        loadRuntimeConfig({
          NODE_ENV: "development",
          DATABASE_URL:
            "postgresql://user:password@localhost:5432/sinochat",
          REDIS_URL: "https://redis.example.com"
        }),
      /redis:\/\/ o rediss:\/\//
    );
    throws(
      () =>
        loadRuntimeConfig({
          NODE_ENV: "development",
          DATABASE_URL:
            "postgresql://user:password@localhost:5432/sinochat",
          REDIS_URL: "redis://localhost:6379/0?secret=visible"
        }),
      /query ni fragmento/
    );
    throws(
      () =>
        loadRuntimeConfig({
          NODE_ENV: "development",
          DATABASE_URL:
            "postgresql://user:password@localhost:5432/sinochat",
          REDIS_URL: "redis://localhost:6379",
          SOCKET_IO_REDIS_CHANNEL_PREFIX: "inseguro *"
        }),
      /SOCKET_IO_REDIS_CHANNEL_PREFIX/
    );
    throws(
      () =>
        loadRuntimeConfig({
          NODE_ENV: "development",
          DATABASE_URL:
            "postgresql://user:password@localhost:5432/sinochat",
          RATE_LIMIT_REDIS_PREFIX: "inseguro *"
        }),
      /RATE_LIMIT_REDIS_PREFIX/
    );
  });

  it("rechaza cookies duplicadas y trust proxy abierto", () => {
    throws(
      () =>
        loadRuntimeConfig({
          NODE_ENV: "development",
          DATABASE_URL: "postgresql://user:password@localhost:5432/sinochat",
          SESSION_COOKIE_NAME: "same",
          CSRF_COOKIE_NAME: "same"
        }),
      /deben ser diferentes/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          TRUST_PROXY: "true"
        }),
      /no está permitido/
    );
  });

  it("valida puerto, pool y rangos de proxy", () => {
    throws(
      () =>
        loadRuntimeConfig({
          NODE_ENV: "development",
          DATABASE_URL: "postgresql://user:password@localhost:5432/sinochat",
          API_PORT: "0"
        }),
      /API_PORT/
    );
    throws(
      () =>
        loadRuntimeConfig({
          NODE_ENV: "development",
          DATABASE_URL: "postgresql://user:password@localhost:5432/sinochat",
          DATABASE_POOL_MAX: "2.5"
        }),
      /DATABASE_POOL_MAX/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          TRUST_PROXY: "10.0.0.0/99"
        }),
      /TRUST_PROXY/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...productionEnvironment(),
          TRUST_PROXY: "0.0.0.0/0"
        }),
      /TRUST_PROXY/
    );
  });

  it("limita el TTL absoluto y la inactividad de administrador", () => {
    const local = {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://user:password@localhost:5432/sinochat",
      SESSION_TTL_HOURS: "24"
    } satisfies NodeJS.ProcessEnv;

    equal(
      loadRuntimeConfig({
        ...local,
        ADMIN_SESSION_TTL_HOURS: "1",
        ADMIN_SESSION_IDLE_TIMEOUT_MINUTES: "59"
      }).adminSessionTtlHours,
      1
    );
    equal(
      loadRuntimeConfig({
        ...local,
        ADMIN_SESSION_TTL_HOURS: "24",
        ADMIN_SESSION_IDLE_TIMEOUT_MINUTES: "120"
      }).adminSessionIdleTimeoutMinutes,
      120
    );

    for (const value of ["0", "25", "1.5", "no-numero"]) {
      throws(
        () =>
          loadRuntimeConfig({
            ...local,
            ADMIN_SESSION_TTL_HOURS: value
          }),
        /ADMIN_SESSION_TTL_HOURS/
      );
    }
    for (const value of ["4", "121", "5.5", "no-numero"]) {
      throws(
        () =>
          loadRuntimeConfig({
            ...local,
            ADMIN_SESSION_IDLE_TIMEOUT_MINUTES: value
          }),
        /ADMIN_SESSION_IDLE_TIMEOUT_MINUTES/
      );
    }
    throws(
      () =>
        loadRuntimeConfig({
          ...local,
          SESSION_TTL_HOURS: "8",
          ADMIN_SESSION_TTL_HOURS: "12"
        }),
      /no puede superar SESSION_TTL_HOURS/
    );
    throws(
      () =>
        loadRuntimeConfig({
          ...local,
          ADMIN_SESSION_TTL_HOURS: "1",
          ADMIN_SESSION_IDLE_TIMEOUT_MINUTES: "60"
        }),
      /debe ser menor que el TTL absoluto/
    );
  });
});

function productionEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    WEB_ORIGIN: "https://chat.example.com",
    WEBAUTHN_RP_ID: "chat.example.com",
    WEBAUTHN_RP_NAME: "SinoChat",
    MATRIX_SERVER_NAME: "chat.example.com",
    API_PORT: "443",
    DATABASE_URL:
      "postgresql://sinochat:secret@database.example.com:5432/sinochat?sslmode=verify-full",
    DATABASE_POOL_MAX: "20",
    REDIS_URL: "rediss://redis.example.com:6380/0",
    TRUST_PROXY: "loopback,10.0.0.0/8",
    SESSION_COOKIE_NAME: "__Host-sinochat_session",
    CSRF_COOKIE_NAME: "__Host-sinochat_csrf",
    SESSION_TTL_HOURS: "24",
    ADMIN_SESSION_TTL_HOURS: "8",
    ADMIN_SESSION_IDLE_TIMEOUT_MINUTES: "20",
    PASSWORD_PEPPER: "p".repeat(32),
    METADATA_HASH_SECRET: "m".repeat(32),
    ATTACHMENT_GRANT_SECRET: "a".repeat(32),
    EVIDENCE_UPLOAD_GRANT_SECRET: "e".repeat(32),
    DEVICE_BINDING_HMAC_SECRET: "d".repeat(32),
    MATRIX_SYNC_TOKEN_SECRET: "s".repeat(32),
    RATE_LIMIT_HMAC_SECRET: "r".repeat(32),
    INVITATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    INVITATION_ENCRYPTION_KEY_VERSION: "1",
    OBJECT_STORAGE_ENDPOINT: "https://storage.example.com",
    OBJECT_STORAGE_REGION: "auto",
    OBJECT_STORAGE_BUCKET: "sinochat-ephemeral",
    OBJECT_STORAGE_ACCESS_KEY_ID: "access-key",
    OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret-key",
    OBJECT_STORAGE_FORCE_PATH_STYLE: "false",
    OBJECT_STORAGE_VERSIONING_MODE: "disabled"
  };
}
