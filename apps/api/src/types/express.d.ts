import type { SessionPrincipal } from "../auth/auth.types";

declare global {
  namespace Express {
    interface Request {
      user?: SessionPrincipal;
    }
  }
}

export {};
