interface InvitationEncryptionKeyring {
  currentVersion: number;
  keys: ReadonlyMap<number, Buffer>;
}

const MAX_PREVIOUS_KEYS = 32;
const MAX_KEYRING_JSON_BYTES = 16 * 1024;

export function readInvitationEncryptionKeyring(
  environment: NodeJS.ProcessEnv = process.env
): InvitationEncryptionKeyring {
  const currentVersion = parseVersion(
    environment.INVITATION_ENCRYPTION_KEY_VERSION ?? "1",
    "INVITATION_ENCRYPTION_KEY_VERSION"
  );
  const currentKey = decodeKey(
    environment.INVITATION_ENCRYPTION_KEY,
    "INVITATION_ENCRYPTION_KEY"
  );
  const keys = new Map<number, Buffer>([[currentVersion, currentKey]]);
  const previous = environment.INVITATION_ENCRYPTION_PREVIOUS_KEYS?.trim();

  if (previous) {
    if (Buffer.byteLength(previous, "utf8") > MAX_KEYRING_JSON_BYTES) {
      throw new Error(
        "INVITATION_ENCRYPTION_PREVIOUS_KEYS supera el tamaño permitido."
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(previous);
    } catch {
      throw new Error(
        "INVITATION_ENCRYPTION_PREVIOUS_KEYS debe ser un objeto JSON válido."
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        "INVITATION_ENCRYPTION_PREVIOUS_KEYS debe ser un objeto JSON."
      );
    }

    const entries = Object.entries(parsed);
    if (entries.length > MAX_PREVIOUS_KEYS) {
      throw new Error(
        `INVITATION_ENCRYPTION_PREVIOUS_KEYS admite hasta ${MAX_PREVIOUS_KEYS} claves.`
      );
    }
    for (const [rawVersion, rawKey] of entries) {
      const version = parseVersion(
        rawVersion,
        "una versión de INVITATION_ENCRYPTION_PREVIOUS_KEYS"
      );
      if (version === currentVersion) {
        throw new Error(
          "La versión actual no debe repetirse entre las claves anteriores."
        );
      }
      if (typeof rawKey !== "string") {
        throw new Error(
          `La clave anterior de la versión ${version} debe ser Base64.`
        );
      }
      keys.set(
        version,
        decodeKey(
          rawKey,
          `INVITATION_ENCRYPTION_PREVIOUS_KEYS[${version}]`
        )
      );
    }
  }

  const fingerprints = new Set<string>();
  for (const key of keys.values()) {
    const fingerprint = key.toString("base64");
    if (fingerprints.has(fingerprint)) {
      throw new Error(
        "Cada versión de cifrado de invitaciones debe usar una clave diferente."
      );
    }
    fingerprints.add(fingerprint);
  }

  return { currentVersion, keys };
}

function parseVersion(value: string, name: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} debe ser un entero positivo.`);
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version > 2_147_483_647) {
    throw new Error(`${name} debe estar entre 1 y 2147483647.`);
  }
  return version;
}

function decodeKey(value: string | undefined, name: string): Buffer {
  const encoded = value?.trim();
  if (
    !encoded ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded
    )
  ) {
    throw new Error(`${name} debe contener Base64 canónico.`);
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== encoded) {
    throw new Error(`${name} debe contener exactamente 32 bytes en Base64.`);
  }
  return decoded;
}
