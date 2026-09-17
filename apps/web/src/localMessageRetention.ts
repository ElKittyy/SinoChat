import { useEffect } from "react";
import type { ChatConversation } from "./dashboard/types";

/** Incluye las conversaciones no seleccionadas del cajero que siguen en memoria. */
export function nextConversationExpiry(
  conversations: readonly ChatConversation[],
): number | undefined {
  let nearest = Number.POSITIVE_INFINITY;
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      const expiry = Date.parse(message.expiresAt);
      // Una fecha inválida no puede conservar contenido indefinidamente.
      if (!Number.isFinite(expiry)) return 0;
      nearest = Math.min(nearest, expiry);
    }
  }
  return Number.isFinite(nearest) ? nearest : undefined;
}

export function pruneExpiredConversation(
  conversation: ChatConversation,
  now: number,
): ChatConversation {
  const messages = conversation.messages.filter(
    (message) => Date.parse(message.expiresAt) > now,
  );
  if (messages.length === conversation.messages.length) return conversation;
  return { ...conversation, messages, lastMessagePreview: undefined };
}

/**
 * Reloj local independiente del polling HTTP. Cuando el navegador suspende sus
 * timers, foco/pageshow/visibilitychange vuelven a comprobar la caducidad.
 * No puede borrar capturas ni copias externas, ni ejecutar durante una suspensión.
 */
export function useLocalMessageExpiry(
  nextExpiry: number | undefined,
  onExpired: (now: number) => void,
): void {
  useEffect(() => {
    if (nextExpiry === undefined) return;
    let timeout: number | undefined;
    const check = () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
      const now = Date.now();
      if (nextExpiry <= now) {
        onExpired(now);
        return;
      }
      timeout = window.setTimeout(check, Math.min(nextExpiry - now, 2_147_483_647));
    };
    check();
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [nextExpiry, onExpired]);
}
