import { describe, expect, test, vi } from 'vitest';
import { bootstrap } from './main.js';

// Mock ws client factory to inject a controllable client
/** @type {any} */
let CLIENT = null;
vi.mock('./ws.js', () => ({
  createWsClient: () => CLIENT
}));

describe('main websocket toast notifications', () => {
  test('shows toast on connection loss and on reconnect', async () => {
    vi.useFakeTimers();
    CLIENT = {
      // Minimal send used during bootstrap (push-only tests avoid read RPCs)
      send: vi.fn(async () => []),
      /**
       * @param {string} type
       * @param {(p:any)=>void} handler
       */
      on(type, handler) {
        this._handler = handler;
        void type;
        return () => {};
      },
      /**
       * @param {(s: 'connecting'|'open'|'closed'|'reconnecting')=>void} handler
       */
      onConnection(handler) {
        this._conn = handler;
        return () => {};
      },
      /**
       * @param {'connecting'|'open'|'closed'|'reconnecting'} state
       */
      triggerConn(state) {
        if (this._conn) {
          this._conn(state);
        }
      },
      close() {},
      getState() {
        return 'open';
      }
    };

    document.body.innerHTML = '<main id="app"></main>';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    await Promise.resolve();

    // Simulate reconnecting -> toast appears
    CLIENT.triggerConn('reconnecting');
    await Promise.resolve();
    const lost = /** @type {HTMLElement} */ (document.querySelector('.toast'));
    expect(lost).not.toBeNull();
    expect((lost.textContent || '').toLowerCase()).toContain('connection lost');

    // Simulate open after disconnect -> success toast
    CLIENT.triggerConn('open');
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
    const toasts = Array.from(document.querySelectorAll('.toast'));
    expect(
      toasts.some((t) =>
        (t.textContent || '').toLowerCase().includes('reconnected')
      )
    ).toBe(true);

    // Let timers flush auto-dismiss to avoid leaking DOM between tests
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
  });

  test('reports replay failure without a success toast', async () => {
    vi.useFakeTimers();
    let fail_replay = false;
    CLIENT = {
      /** @param {string} type */
      send: vi.fn(async (type) => {
        if (fail_replay && type === 'subscribe-list') {
          throw new Error('replay unavailable');
        }
        return [];
      }),
      on() {
        return () => {};
      },
      /** @param {(state: 'connecting'|'open'|'closed'|'reconnecting') => void} handler */
      onConnection(handler) {
        this._conn = handler;
        return () => {};
      },
      /** @param {'connecting'|'open'|'closed'|'reconnecting'} state */
      triggerConn(state) {
        this._conn?.(state);
      },
      close() {},
      getState() {
        return 'open';
      }
    };
    document.body.innerHTML = '<main id="app"></main>';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));
    bootstrap(root);
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
    fail_replay = true;

    CLIENT.triggerConn('closed');
    CLIENT.triggerConn('open');
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(3000);
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }

    const error_toasts = Array.from(document.querySelectorAll('.toast--error'));
    expect(
      error_toasts.some((toast) =>
        toast.textContent?.includes('live updates failed')
      )
    ).toBe(true);
    expect(document.querySelector('.toast--success')).toBeNull();

    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
  });

  test('recovers live updates after a transient replay failure', async () => {
    vi.useFakeTimers();
    let reconnecting = false;
    let replay_attempts = 0;
    CLIENT = {
      /** @param {string} type */
      send: vi.fn(async (type) => {
        if (reconnecting && type === 'subscribe-list') {
          replay_attempts += 1;
          if (replay_attempts === 1) {
            throw new Error('temporary failure');
          }
        }
        return [];
      }),
      on() {
        return () => {};
      },
      /** @param {(state: 'connecting'|'open'|'closed'|'reconnecting') => void} handler */
      onConnection(handler) {
        this._conn = handler;
        return () => {};
      },
      /** @param {'connecting'|'open'|'closed'|'reconnecting'} state */
      triggerConn(state) {
        this._conn?.(state);
      },
      close() {},
      getState() {
        return 'open';
      }
    };
    document.body.innerHTML = '<main id="app"></main>';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));
    bootstrap(root);
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
    reconnecting = true;

    CLIENT.triggerConn('closed');
    CLIENT.triggerConn('open');
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
    expect(document.querySelector('.toast--success')).toBeNull();

    await vi.advanceTimersByTimeAsync(1000);
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }

    expect(replay_attempts).toBe(2);
    expect(document.querySelector('.toast--success')?.textContent).toContain(
      'Reconnected'
    );

    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
  });

  test('replays an initial subscription interrupted by disconnect', async () => {
    vi.useFakeTimers();
    let subscription_attempts = 0;
    CLIENT = {
      /** @param {string} type */
      send: vi.fn(async (type) => {
        if (type === 'list-workspaces') {
          return { current: null, workspaces: [] };
        }
        if (type === 'subscribe-list') {
          subscription_attempts += 1;
          if (subscription_attempts === 1) {
            throw Object.assign(new Error('ws disconnected'), {
              code: 'ws_disconnected'
            });
          }
        }
        return [];
      }),
      on() {
        return () => {};
      },
      /** @param {(state: 'connecting'|'open'|'closed'|'reconnecting') => void} handler */
      onConnection(handler) {
        this._conn = handler;
        return () => {};
      },
      /** @param {'connecting'|'open'|'closed'|'reconnecting'} state */
      triggerConn(state) {
        this._conn?.(state);
      },
      close() {},
      getState() {
        return 'open';
      }
    };
    document.body.innerHTML = '<main id="app"></main>';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
    CLIENT.triggerConn('closed');
    CLIENT.triggerConn('open');
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }

    expect(subscription_attempts).toBe(2);
    expect(document.querySelector('#fatal-error-dialog[open]')).toBeNull();
    expect(document.querySelector('.toast--success')?.textContent).toContain(
      'Reconnected'
    );

    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
  });
});
