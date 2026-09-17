import type { UserRole } from "./access";

export const INVITATION_PATH = "/invitacion";

export interface InvitationFragment {
  code: string;
  role: UserRole;
}

interface InvitationLocation {
  hash: string;
  pathname: string;
  search: string;
}

interface InvitationHistory {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export function createInvitationUrl(
  origin: string,
  invitation: InvitationFragment,
): string {
  const cleanOrigin = origin.replace(/\/+$/, "");
  return `${cleanOrigin}${INVITATION_PATH}#${invitation.role}=${encodeURIComponent(invitation.code)}`;
}

export function parseInvitationFragment(
  hash: string,
): InvitationFragment | undefined {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  const separator = fragment.indexOf("=");
  if (separator < 1) return undefined;

  const role = fragment.slice(0, separator);
  if (role !== "cliente" && role !== "cajero") return undefined;

  let code: string;
  try {
    code = decodeURIComponent(fragment.slice(separator + 1));
  } catch {
    return undefined;
  }

  if (!code || code.length > 64) return undefined;
  return { code, role };
}

/**
 * Lee el secreto una sola vez y reemplaza inmediatamente la entrada actual.
 * Nunca copia el fragmento ni el estado anterior a `history.state`.
 */
export function consumeInvitationFragment(
  location: InvitationLocation,
  history: InvitationHistory,
): InvitationFragment | undefined {
  const invitation = parseInvitationFragment(location.hash);

  if (location.hash || location.search || history.state !== null) {
    history.replaceState(null, "", location.pathname || INVITATION_PATH);
  }

  return invitation;
}
