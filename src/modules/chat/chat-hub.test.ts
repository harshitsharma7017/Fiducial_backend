import { describe, expect, it, vi } from 'vitest';
import { ChatHub } from './chat-hub.ts';

const USER = 'a'.repeat(24);
const OTHER = 'b'.repeat(24);
const event = { type: 'read', conversationId: 'c'.repeat(24) } as const;

describe('ChatHub', () => {
  it('delivers to each open connection of each user once, until unsubscribed', () => {
    const hub = new ChatHub();
    const first = vi.fn();
    const second = vi.fn();
    const other = vi.fn();
    const stop = hub.subscribe(USER, first);
    hub.subscribe(USER, second);
    hub.subscribe(OTHER, other);
    hub.publish([USER, USER], event);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    stop();
    hub.publish([USER], event);
    expect(first).toHaveBeenCalledTimes(1);
    expect(hub.connections(USER)).toBe(1);
  });

  it('keeps delivering when one connection fails, and ends them all on shutdown', () => {
    const hub = new ChatHub();
    const healthy = vi.fn();
    const close = vi.fn();
    hub.subscribe(USER, () => {
      throw new Error('closed socket');
    });
    hub.subscribe(USER, healthy, close);
    hub.publish([USER], event);
    expect(healthy).toHaveBeenCalledOnce();
    hub.closeAll();
    expect(close).toHaveBeenCalledOnce();
  });
});
