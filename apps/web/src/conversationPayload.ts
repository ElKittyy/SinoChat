import type { ChatConversation } from "./dashboard";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVER_SEQUENCE_PATTERN = /^\d{1,20}$/;

export interface ConversationPage {
  items: readonly ChatConversation[];
  page: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Convierte exclusivamente metadatos de conversación. Cualquier campo de
 * contenido, sobre o adjunto inesperado hace fallar la carga para evitar que
 * una ampliación accidental del backend termine consumida por el panel.
 */
export function parseConversationPage(payload: unknown): ConversationPage {
  const response = record(payload, "conversaciones");
  onlyKeys(response, ["items", "page", "limit", "hasMore"], "conversaciones");
  if (!Array.isArray(response.items)) invalid("conversaciones");

  const page = positiveInteger(response.page, 10_000, "conversaciones");
  const limit = positiveInteger(response.limit, 100, "conversaciones");
  const hasMore = response.hasMore;
  if (typeof hasMore !== "boolean" || response.items.length > limit) {
    invalid("conversaciones");
  }
  if (hasMore && response.items.length !== limit) {
    invalid("conversaciones");
  }

  return {
    items: response.items.map(parseConversation),
    page,
    limit,
    hasMore,
  };
}

function parseConversation(value: unknown): ChatConversation {
  const conversation = record(value, "conversaciones");
  onlyKeys(
    conversation,
    ["id", "participant", "assignedAt", "unreadCount", "lastMessage"],
    "conversaciones",
  );
  const participant = record(conversation.participant, "conversaciones");
  onlyKeys(participant, ["id", "username", "status"], "conversaciones");

  const id = uuid(conversation.id, "conversaciones");
  const participantId = uuid(participant.id, "conversaciones");
  const username = nonEmptyString(participant.username, "conversaciones");
  if (participant.status !== "ACTIVE") invalid("conversaciones");
  const assignedAt = isoDate(conversation.assignedAt, "conversaciones");
  const unreadCount = nonNegativeInteger(
    conversation.unreadCount,
    "conversaciones",
  );

  let lastActivityAt = assignedAt;
  let lastMessagePreview: string | undefined;
  if (conversation.lastMessage !== null) {
    const lastMessage = record(conversation.lastMessage, "conversaciones");
    onlyKeys(
      lastMessage,
      ["kind", "createdAt", "serverSequence"],
      "conversaciones",
    );
    if (lastMessage.kind !== "TEXT" && lastMessage.kind !== "IMAGE") {
      invalid("conversaciones");
    }
    lastActivityAt = isoDate(lastMessage.createdAt, "conversaciones");
    if (
      typeof lastMessage.serverSequence !== "string" ||
      !SERVER_SEQUENCE_PATTERN.test(lastMessage.serverSequence)
    ) {
      invalid("conversaciones");
    }
    lastMessagePreview =
      lastMessage.kind === "IMAGE" ? "Foto cifrada" : "Mensaje cifrado";
  }

  return {
    id,
    participant: {
      id: participantId,
      username,
      // La API todavía no publica presencia. Mostrar offline evita inventar
      // actividad o exponer lastSeen antes de tener su contrato de privacidad.
      presence: "offline",
    },
    messages: [],
    unreadCount,
    lastActivityAt,
    lastMessagePreview,
  };
}

function record(value: unknown, subject: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid(subject);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  subject: string,
) {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    invalid(subject);
  }
}

function positiveInteger(value: unknown, maximum: number, subject: string) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    invalid(subject);
  }
  return value;
}

function nonNegativeInteger(value: unknown, subject: string) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    invalid(subject);
  }
  return value;
}

function nonEmptyString(value: unknown, subject: string) {
  if (typeof value !== "string" || value.length === 0 || value.length > 50) {
    invalid(subject);
  }
  return value;
}

function uuid(value: unknown, subject: string) {
  if (typeof value !== "string" || !UUID_V4_PATTERN.test(value)) {
    invalid(subject);
  }
  return value;
}

function isoDate(value: unknown, subject: string) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    invalid(subject);
  }
  return value;
}

function invalid(subject: string): never {
  throw new Error(`La API devolvió ${subject} con un formato inesperado.`);
}
