import { beforeEach, describe, expect, test, vi } from 'vitest';
import { watchDb } from './watcher.js';

/** @type {{ dir: string, cb: (event: string, filename?: string) => void, w: { close: () => void } }[]} */
const watchers = [];

vi.mock('node:fs', () => {
  const watch = vi.fn((dir, _opts, cb) => {
    // Minimal event emitter interface for FSWatcher
    const handlers = /** @type {{ close: Array<() => void> }} */ ({
      close: []
    });
    const w = {
      close: () => handlers.close.forEach((fn) => fn())
    };
    watchers.push({ dir, cb, w });
    return /** @type {any} */ (w);
  });
  return { default: { watch }, watch };
});

beforeEach(() => {
  watchers.length = 0;
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('watchDb', () => {
  test('debounces rapid change events', () => {
    const calls = [];
    const handle = watchDb(
      '/repo',
      () => {
        calls.push(null);
      },
      {
        debounce_ms: 100,
        explicit_db: '/repo/.beads/ui.db'
      }
    );
    expect(watchers.length).toBe(1);
    const { cb } = watchers[0];

    // Fire multiple changes in quick succession
    cb('change', 'ui.db');
    cb('change', 'ui.db');
    cb('rename', 'ui.db');

    // Nothing yet until debounce passes
    expect(calls.length).toBe(0);
    vi.advanceTimersByTime(99);
    expect(calls.length).toBe(0);
    vi.advanceTimersByTime(1);
    expect(calls.length).toBe(1);

    // Cleanup
    handle.close();
  });

  test('ignores other filenames', () => {
    const calls = [];
    const handle = watchDb(
      '/repo',
      () => {
        calls.push(null);
      },
      {
        debounce_ms: 50,
        explicit_db: '/repo/.beads/ui.db'
      }
    );
    const { cb } = watchers[0];
    cb('change', 'something-else.db');
    vi.advanceTimersByTime(60);
    expect(calls.length).toBe(0);
    handle.close();
  });

  test('rebind attaches to new db path', () => {
    const calls = [];
    const handle = watchDb(
      '/repo',
      () => {
        calls.push(null);
      },
      {
        debounce_ms: 50,
        explicit_db: '/repo/.beads/ui.db'
      }
    );
    expect(watchers.length).toBe(1);
    const first = watchers[0];

    // Rebind to a different DB path
    handle.rebind({ explicit_db: '/other/.beads/alt.db' });

    // A new watcher is created
    expect(watchers.length).toBe(2);
    const second = watchers[1];

    // Old watcher should ignore new file name
    first.cb('change', 'ui.db');
    vi.advanceTimersByTime(60);
    expect(calls.length).toBe(0);

    // New watcher reacts
    second.cb('change', 'alt.db');
    vi.advanceTimersByTime(60);
    expect(calls.length).toBe(1);

    handle.close();
  });

  test('coalesces cooldown changes into one trailing refresh', async () => {
    const calls = [];
    const handle = watchDb(
      '/repo',
      () => {
        calls.push(null);
      },
      {
        debounce_ms: 10,
        cooldown_ms: 100,
        explicit_db: '/repo/.beads/ui.db'
      }
    );
    const { cb } = watchers[0];

    cb('change', 'ui.db');
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.length).toBe(1);

    cb('change', 'ui.db');
    await vi.advanceTimersByTimeAsync(99);
    expect(calls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls.length).toBe(2);

    cb('change', 'ui.db');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.length).toBe(2);

    await vi.advanceTimersByTimeAsync(10);
    expect(calls.length).toBe(3);

    handle.close();
  });

  test('bounds callback-generated writes to one followup refresh', async () => {
    const calls = [];
    /** @type {((event: string, filename?: string) => void) | undefined} */
    let callback;
    const handle = watchDb(
      '/repo',
      () => {
        calls.push(null);
        callback?.('change', 'ui.db');
      },
      {
        debounce_ms: 10,
        cooldown_ms: 100,
        explicit_db: '/repo/.beads/ui.db'
      }
    );
    callback = watchers[0].cb;

    callback('change', 'ui.db');
    await vi.advanceTimersByTimeAsync(220);

    expect(calls.length).toBe(3);
    handle.close();
  });

  test('preserves an event during the trailing callback', async () => {
    const calls = [];
    /** @type {(() => void) | undefined} */
    let resolve_trailing;
    const handle = watchDb(
      '/repo',
      () => {
        calls.push(null);
        if (calls.length === 2) {
          return new Promise((resolve) => {
            resolve_trailing = resolve;
          });
        }
      },
      {
        debounce_ms: 10,
        cooldown_ms: 100,
        explicit_db: '/repo/.beads/ui.db'
      }
    );
    const callback = watchers[0].cb;

    callback('change', 'ui.db');
    await vi.advanceTimersByTimeAsync(10);
    callback('change', 'ui.db');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.length).toBe(2);

    callback('change', 'ui.db');
    resolve_trailing?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(110);

    expect(calls.length).toBe(3);
    handle.close();
  });

  test('starts a new burst for activity after the followup callback', async () => {
    const calls = [];
    /** @type {((event: string, filename?: string) => void) | undefined} */
    let callback;
    const handle = watchDb(
      '/repo',
      () => {
        calls.push(null);
        if (calls.length <= 3) {
          callback?.('change', 'ui.db');
        }
      },
      {
        debounce_ms: 10,
        cooldown_ms: 100,
        explicit_db: '/repo/.beads/ui.db'
      }
    );
    callback = watchers[0].cb;

    callback('change', 'ui.db');
    await vi.advanceTimersByTimeAsync(220);
    expect(calls.length).toBe(3);

    callback('change', 'ui.db');
    await vi.advanceTimersByTimeAsync(110);
    expect(calls.length).toBe(4);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.length).toBe(4);
    handle.close();
  });

  test('treats activity during the final callback as covered', async () => {
    const calls = [];
    /** @type {((event: string, filename?: string) => void) | undefined} */
    let callback;
    /** @type {(() => void) | undefined} */
    let resolve_followup;
    const handle = watchDb(
      '/repo',
      () => {
        calls.push(null);
        if (calls.length < 3) {
          callback?.('change', 'ui.db');
        }
        if (calls.length === 3) {
          return new Promise((resolve) => {
            resolve_followup = resolve;
          });
        }
      },
      {
        debounce_ms: 10,
        cooldown_ms: 100,
        explicit_db: '/repo/.beads/ui.db'
      }
    );
    callback = watchers[0].cb;

    callback('change', 'ui.db');
    await vi.advanceTimersByTimeAsync(220);
    expect(calls.length).toBe(3);

    callback('change', 'ui.db');
    resolve_followup?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);

    expect(calls.length).toBe(3);
    handle.close();
  });
});
