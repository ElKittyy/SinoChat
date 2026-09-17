import {
  createHash,
  createPublicKey
} from "node:crypto";
import { TextDecoder } from "node:util";

const TERMS_TYPES = new Set(["text/markdown", "text/plain"]);
const MAX_TERMS_BYTES = 5 * 1024 * 1024;
const MAX_PUBLIC_KEY_BYTES = 4_096;
const MIN_PUBLIC_KEY_BYTES = 16;

export interface TermsPublicationInput {
  file: string;
  version: string;
  sourceType: "text/markdown" | "text/plain";
  effectiveAt: Date;
  expectedSha256?: string;
}

export interface InvestigationKeyInput {
  publicKey: Buffer;
  algorithm: string;
  fingerprint: string;
  version: number;
}

interface OptionDefinition {
  flag: string;
  environmentName: string;
  required: boolean;
}

export function parseTermsPublicationInput(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv
): TermsPublicationInput {
  const values = parseOptions(argv, [
    {
      flag: "file",
      environmentName: "TERMS_DOCUMENT_FILE",
      required: true
    },
    {
      flag: "version",
      environmentName: "TERMS_DOCUMENT_VERSION",
      required: true
    },
    {
      flag: "type",
      environmentName: "TERMS_DOCUMENT_TYPE",
      required: true
    },
    {
      flag: "effective-at",
      environmentName: "TERMS_DOCUMENT_EFFECTIVE_AT",
      required: true
    },
    {
      flag: "expected-sha256",
      environmentName: "TERMS_DOCUMENT_EXPECTED_SHA256",
      required: false
    }
  ], environment);

  const file = values.get("file")!;
  const version = values.get("version")!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(version)) {
    throw new Error(
      "La versión debe tener entre 1 y 32 caracteres alfanuméricos, punto, guion o guion bajo."
    );
  }

  const sourceType = values.get("type")!;
  if (!TERMS_TYPES.has(sourceType)) {
    throw new Error(
      "El tipo debe ser text/markdown o text/plain."
    );
  }

  const expectedSha256 = values.get("expected-sha256");
  if (
    expectedSha256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(expectedSha256)
  ) {
    throw new Error(
      "El SHA-256 esperado debe contener 64 caracteres hexadecimales minúsculos."
    );
  }

  return {
    file,
    version,
    sourceType: sourceType as TermsPublicationInput["sourceType"],
    effectiveAt: parseStrictInstant(
      values.get("effective-at")!,
      "La fecha efectiva"
    ),
    expectedSha256
  };
}

export function parseInvestigationKeyInput(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv
): InvestigationKeyInput {
  assertNoPrivateKeyInput(environment);
  const values = parseOptions(argv, [
    {
      flag: "public-key-base64",
      environmentName: "INVESTIGATION_PUBLIC_KEY_BASE64",
      required: true
    },
    {
      flag: "algorithm",
      environmentName: "INVESTIGATION_KEY_ALGORITHM",
      required: true
    },
    {
      flag: "fingerprint",
      environmentName: "INVESTIGATION_KEY_FINGERPRINT",
      required: true
    },
    {
      flag: "version",
      environmentName: "INVESTIGATION_KEY_VERSION",
      required: true
    }
  ], environment);

  const publicKey = decodeStrictBase64(
    values.get("public-key-base64")!,
    "La clave pública"
  );
  if (
    publicKey.byteLength < MIN_PUBLIC_KEY_BYTES ||
    publicKey.byteLength > MAX_PUBLIC_KEY_BYTES
  ) {
    throw new Error(
      `La clave pública debe ocupar entre ${MIN_PUBLIC_KEY_BYTES} y ${MAX_PUBLIC_KEY_BYTES} bytes.`
    );
  }

  const algorithm = values.get("algorithm")!;
  if (
    algorithm.length < 2 ||
    algorithm.length > 64 ||
    !/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/.test(algorithm)
  ) {
    throw new Error(
      "El algoritmo debe tener entre 2 y 64 caracteres seguros."
    );
  }
  assertPublicSpki(publicKey, algorithm);

  const fingerprint = values.get("fingerprint")!;
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error(
      "El fingerprint debe contener 64 caracteres hexadecimales minúsculos."
    );
  }
  const calculated = sha256Hex(publicKey);
  if (fingerprint !== calculated) {
    throw new Error(
      "El fingerprint no coincide con el SHA-256 de la clave pública."
    );
  }

  const version = Number(values.get("version"));
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    version > 2_147_483_647
  ) {
    throw new Error(
      "La versión de la clave debe ser un entero entre 1 y 2147483647."
    );
  }

  return { publicKey, algorithm, fingerprint, version };
}

export function validateTermsDocument(
  bytes: Uint8Array,
  sourceType: TermsPublicationInput["sourceType"]
): { byteSize: number; sha256: string } {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_TERMS_BYTES) {
    throw new Error(
      `El documento debe ocupar entre 1 byte y ${MAX_TERMS_BYTES} bytes.`
    );
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", {
      fatal: true
    }).decode(bytes);
  } catch {
    throw new Error("El documento no contiene UTF-8 válido.");
  }
  if (!content.trim()) {
    throw new Error("El documento legal no puede estar vacío.");
  }
  if (content.includes("\u0000")) {
    throw new Error("El documento legal no puede contener bytes NUL.");
  }
  if (!TERMS_TYPES.has(sourceType)) {
    throw new Error("El tipo de documento no es compatible.");
  }

  return {
    byteSize: bytes.byteLength,
    sha256: sha256Hex(bytes)
  };
}

export function parseStrictInstant(
  raw: string,
  label: string
): Date {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      raw
    );
  if (!match) {
    throw new Error(
      `${label} debe usar ISO 8601 con Z u offset explícito.`
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    throw new Error(`${label} contiene una fecha u hora inválida.`);
  }

  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw new Error(`${label} no es una fecha válida.`);
  }
  return value;
}

export function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isHelpRequest(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

function parseOptions(
  argv: readonly string[],
  definitions: readonly OptionDefinition[],
  environment: NodeJS.ProcessEnv
): Map<string, string> {
  const allowed = new Map(
    definitions.map((definition) => [
      `--${definition.flag}`,
      definition
    ])
  );
  const argumentsByFlag = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      continue;
    }
    if (!token.startsWith("--")) {
      throw new Error(`Argumento posicional inesperado: ${token}`);
    }

    const equalsAt = token.indexOf("=");
    const flag = equalsAt >= 0 ? token.slice(0, equalsAt) : token;
    const definition = allowed.get(flag);
    if (!definition) {
      throw new Error(`Argumento desconocido: ${flag}`);
    }
    if (argumentsByFlag.has(definition.flag)) {
      throw new Error(`El argumento ${flag} está repetido.`);
    }

    const inlineValue =
      equalsAt >= 0 ? token.slice(equalsAt + 1) : undefined;
    const nextValue =
      inlineValue === undefined ? argv[index + 1] : undefined;
    const value = inlineValue ?? nextValue;
    if (!value || (inlineValue === undefined && value.startsWith("--"))) {
      throw new Error(`Falta el valor de ${flag}.`);
    }
    if (inlineValue === undefined) {
      index += 1;
    }
    argumentsByFlag.set(definition.flag, value);
  }

  const resolved = new Map<string, string>();
  for (const definition of definitions) {
    const argumentValue = argumentsByFlag.get(definition.flag);
    const environmentValue = environment[
      definition.environmentName
    ];
    if (
      argumentValue !== undefined &&
      environmentValue !== undefined &&
      environmentValue !== "" &&
      argumentValue !== environmentValue
    ) {
      throw new Error(
        `--${definition.flag} y ${definition.environmentName} contienen valores diferentes.`
      );
    }
    const value = argumentValue ?? environmentValue;
    if (definition.required && (!value || !value.trim())) {
      throw new Error(
        `Debes indicar --${definition.flag} o ${definition.environmentName}.`
      );
    }
    if (value !== undefined && value !== "") {
      if (value !== value.trim()) {
        throw new Error(
          `El valor de --${definition.flag} no puede tener espacios exteriores.`
        );
      }
      resolved.set(definition.flag, value);
    }
  }
  return resolved;
}

function decodeStrictBase64(value: string, label: string): Buffer {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  ) {
    throw new Error(`${label} no usa Base64 canónico.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`${label} no usa Base64 canónico.`);
  }
  return decoded;
}

function assertNoPrivateKeyInput(
  environment: NodeJS.ProcessEnv
): void {
  const forbidden = [
    "INVESTIGATION_PRIVATE_KEY",
    "INVESTIGATION_PRIVATE_KEY_BASE64",
    "INVESTIGATION_KEY_PRIVATE"
  ].filter((name) => Boolean(environment[name]));
  if (forbidden.length > 0) {
    throw new Error(
      `La CLI rechaza material privado: elimina ${forbidden.join(", ")} del entorno.`
    );
  }
}

function assertPublicSpki(
  value: Buffer,
  declaredAlgorithm: string
): void {
  let key;
  try {
    key = createPublicKey({
      key: value,
      format: "der",
      type: "spki"
    });
  } catch {
    throw new Error(
      "La clave debe ser una clave pública DER SPKI válida; no se admite material privado ni formato raw."
    );
  }

  const canonical = key.export({
    format: "der",
    type: "spki"
  });
  if (
    typeof canonical === "string" ||
    !Buffer.from(canonical).equals(value)
  ) {
    throw new Error("La clave pública DER SPKI no es canónica.");
  }

  const normalized = declaredAlgorithm.toUpperCase();
  const keyType = key.asymmetricKeyType;
  const algorithmMatches =
    (keyType === "x25519" && normalized.includes("X25519")) ||
    (keyType === "x448" && normalized.includes("X448")) ||
    ((keyType === "rsa" || keyType === "rsa-pss") &&
      normalized.includes("RSA")) ||
    (keyType === "ec" &&
      ecAlgorithmMatches(
        key.asymmetricKeyDetails?.namedCurve,
        normalized
      ));

  if (!algorithmMatches) {
    throw new Error(
      "El algoritmo declarado no coincide con el tipo de la clave pública DER SPKI o no es apto para cifrado."
    );
  }
}

function ecAlgorithmMatches(
  namedCurve: string | undefined,
  declaredAlgorithm: string
): boolean {
  switch (namedCurve) {
    case "prime256v1":
      return (
        declaredAlgorithm.includes("P-256") ||
        declaredAlgorithm.includes("PRIME256V1") ||
        declaredAlgorithm.includes("SECP256R1")
      );
    case "secp384r1":
      return declaredAlgorithm.includes("P-384");
    case "secp521r1":
      return declaredAlgorithm.includes("P-521");
    default:
      return false;
  }
}
