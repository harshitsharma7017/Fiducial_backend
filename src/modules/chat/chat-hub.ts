import type { ChatEvent } from '../../shared/index.ts';

// The chat's live delivery: each signed-in browser holds one server-sent events connection
// (GET /chat/events), subscribed here under its user; the services publish to the members of a
// conversation. In process: one API instance (PM2 runs one); several instances would need a shared
// bus (Redis or MongoDB change streams) in place of this map.

export type ChatListener = (event: ChatEvent) => void;

export class ChatHub {
  private readonly listeners = new Map<string, Set<ChatListener>>();
  private readonly closers = new Set<() => void>();

  /**
   * Listens for a user's events until the returned function is called. `close` ends the
   * connection when the server shuts down (the browser reconnects to the next process).
   */
  subscribe(userId: string, listener: ChatListener, close?: () => void): () => void {
    const set = this.listeners.get(userId) ?? new Set<ChatListener>();
    set.add(listener);
    this.listeners.set(userId, set);
    if (close) this.closers.add(close);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(userId);
      if (close) this.closers.delete(close);
    };
  }

  /** Ends every open connection, so a shutting-down server is not held open by them. */
  closeAll(): void {
    for (const close of [...this.closers]) close();
  }

  /** Sends an event to every open connection of the users (each user once). */
  publish(userIds: Iterable<string>, event: ChatEvent): void {
    for (const userId of new Set(userIds)) {
      for (const listener of this.listeners.get(userId) ?? []) {
        try {
          listener(event);
        } catch {
          // A connection that cannot be written to is closed by its own route.
        }
      }
    }
  }

  /** How many connections a user has open (for tests and diagnostics). */
  connections(userId: string): number {
    return this.listeners.get(userId)?.size ?? 0;
  }
}
