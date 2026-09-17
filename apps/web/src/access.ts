export type UserRole = "cliente" | "cajero";

export interface LoginInput {
  username: string;
  password: string;
}

export interface CompleteAdminResetInput {
  username: string;
  recoveryCode: string;
  newPassword: string;
}

export interface CashierRegistrationResult {
  recoveryCodes: string[];
  recoveryCodesExpireAt: string | null;
}

export interface InvitationInput {
  code: string;
  role: UserRole;
}

export interface ClientRegistrationInput {
  invitationCode: string;
  username: string;
  password: string;
  birthDate: string;
  acceptsTerms: true;
  termsVersion: string;
  termsContentHash: string;
}

export interface CashierRegistrationInput {
  invitationCode: string;
  email: string;
  username: string;
  password: string;
  phone: string;
  birthDate: string;
  acceptsTerms: true;
  termsVersion: string;
  termsContentHash: string;
}

/**
 * Contrato de integración para la API de acceso.
 *
 * Todos los métodos son opcionales mientras se construye el backend. Los
 * formularios conservan validación, estados de envío y manejo de errores sin
 * simular respuestas del servidor. Login y registro solo deben resolverse
 * cuando el navegador ya haya recibido las cookies; App validará después la
 * sesión mediante `/api/auth/me`.
 */
export interface AccessActions {
  login?: (input: LoginInput) => Promise<void>;
  completeAdminReset?: (input: CompleteAdminResetInput) => Promise<void>;
  validateInvitation?: (input: InvitationInput) => Promise<void>;
  registerClient?: (input: ClientRegistrationInput) => Promise<void>;
  registerCashier?: (
    input: CashierRegistrationInput,
  ) => Promise<CashierRegistrationResult>;
}

export type SubmissionState =
  | { status: "idle" }
  | { status: "submitting"; message: string }
  | { status: "ready"; message: string }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export const INITIAL_SUBMISSION_STATE: SubmissionState = { status: "idle" };

export function normalizeInvitationCode(code: string) {
  return code.trim().toUpperCase().replace(/\s+/g, "-");
}

export function isValidInvitationFormat(code: string) {
  return /^[A-Z0-9][A-Z0-9-]{6,62}[A-Z0-9]$/.test(code);
}

export function isAdult(birthDate: string, today = new Date()) {
  const parts = birthDate.split("-").map(Number);

  if (parts.length !== 3) {
    return false;
  }

  const [year, month, day] = parts;
  const date = new Date(year, month - 1, day);

  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return false;
  }

  const eighteenthBirthday = new Date(year + 18, month - 1, day);
  return eighteenthBirthday <= today;
}

export function latestAdultBirthDate(today = new Date()) {
  const year = today.getFullYear() - 18;
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function messageFromError(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "No pudimos completar la solicitud. Inténtalo nuevamente.";
}
