import type {
  AdminUserStatus,
  DeliveryStatus,
  PresenceStatus,
  ReportStatus,
  SubscriptionStatus,
  SubscriptionEffectiveStatus,
  UserRole,
} from "./types";

const dateTimeFormatter = new Intl.DateTimeFormat("es-AR", {
  dateStyle: "medium",
  timeStyle: "short",
});

const timeFormatter = new Intl.DateTimeFormat("es-AR", {
  hour: "2-digit",
  minute: "2-digit",
});

const dayFormatter = new Intl.DateTimeFormat("es-AR", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

export function formatDateTime(value?: string) {
  if (!value) return "Sin fecha";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date);
}

export function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : timeFormatter.format(date);
}

export function formatDay(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dayFormatter.format(date);
}

export function dayKey(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function expiryLabel(value: string) {
  return `Se elimina el ${formatDateTime(value)}`;
}

export function presenceLabel(
  presence: PresenceStatus,
  lastSeenAt?: string,
) {
  if (presence === "online") return "En línea";
  if (presence === "away") return "Ausente";
  return lastSeenAt
    ? `Última conexión: ${formatDateTime(lastSeenAt)}`
    : "Desconectado";
}

export function deliveryLabel(status?: DeliveryStatus) {
  const labels: Record<DeliveryStatus, string> = {
    sending: "Enviando",
    sent: "Enviado",
    delivered: "Entregado",
    read: "Leído",
  };
  return status ? labels[status] : undefined;
}

export function roleLabel(role: UserRole) {
  const labels: Record<UserRole, string> = {
    client: "Cliente",
    cashier: "Cajero",
    admin: "Administrador",
  };
  return labels[role];
}

export function userStatusLabel(status: AdminUserStatus) {
  const labels: Record<AdminUserStatus, string> = {
    active: "Activo",
    pending: "Pendiente",
    suspended: "Suspendido",
    deleted: "Eliminado",
  };
  return labels[status];
}

export function subscriptionStatusLabel(
  status: SubscriptionEffectiveStatus,
) {
  const labels: Record<SubscriptionEffectiveStatus, string> = {
    active: "Activa",
    inactive: "Inactiva",
    grace_period: "Período de gracia",
    expired: "Vencida",
    none: "Sin suscripción",
    cancelled: "Cancelada",
    scheduled: "Programada",
    expired_pending: "Vencida, conciliando",
  };
  return labels[status];
}

export function reportStatusLabel(status: ReportStatus) {
  const labels: Record<ReportStatus, string> = {
    open: "Abierto",
    under_review: "En revisión",
    closing: "Cierre en proceso",
    closed: "Cerrado",
  };
  return labels[status];
}
