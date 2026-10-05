import type { AuthenticatedUser } from '../middleware/auth.ts';

declare global {
  namespace Express {
    interface Request {
      /** Set by the requestId middleware for every request. */
      requestId: string;
      /** Set by authenticate() on protected routes. */
      user?: AuthenticatedUser;
    }
  }
}

export {};
