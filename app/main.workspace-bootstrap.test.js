import { beforeEach, describe, expect, test, vi } from 'vitest';
import { bootstrap } from './main.js';

/** @type {any} */
let CLIENT = null;

vi.mock('./ws.js', () => ({
  createWsClient: () => CLIENT
}));

/**
 * @returns {{ promise: Promise<any>, resolve: (value: any) => void }}
 */
function deferred() {
  /** @type {(value: any) => void} */
  let resolve = () => {};
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('workspace bootstrap subscriptions', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.location.hash = '#/issues';
    document.body.innerHTML = '<main id="app"></main>';
  });

  test('restores the saved workspace before the first subscription', async () => {
    const workspaces = deferred();
    const workspace_switch = deferred();
    /** @type {{ type: string, payload: any }[]} */
    const calls = [];
    CLIENT = {
      /**
       * @param {string} type
       * @param {any} payload
       */
      async send(type, payload) {
        calls.push({ type, payload });
        if (type === 'list-workspaces') {
          return workspaces.promise;
        }
        if (type === 'set-workspace') {
          return workspace_switch.promise;
        }
        return null;
      },
      on() {
        return () => {};
      },
      onConnection() {
        return () => {};
      },
      close() {},
      getState() {
        return 'open';
      }
    };
    window.localStorage.setItem('beads-ui.workspace', '/work/saved');
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    await flushPromises();

    expect(calls.map((call) => call.type)).toEqual(['list-workspaces']);

    workspaces.resolve({
      current: { root_dir: '/work/default', db_path: '/work/default/.beads' },
      workspaces: [
        { path: '/work/default', database: '/work/default/.beads' },
        { path: '/work/saved', database: '/work/saved/.beads' }
      ]
    });
    await flushPromises();

    expect(calls.some((call) => call.type === 'set-workspace')).toBe(true);
    expect(calls.some((call) => call.type === 'subscribe-list')).toBe(false);

    workspace_switch.resolve({
      changed: true,
      workspace: {
        root_dir: '/work/saved',
        db_path: '/work/saved/.beads'
      }
    });
    await flushPromises();

    const switch_index = calls.findIndex(
      (call) => call.type === 'set-workspace'
    );
    const subscribe_index = calls.findIndex(
      (call) => call.type === 'subscribe-list'
    );
    expect(switch_index).toBeGreaterThanOrEqual(0);
    expect(subscribe_index).toBeGreaterThan(switch_index);
  });

  test('replaces an in-flight subscription after a workspace change', async () => {
    const first_subscription = deferred();
    /** @type {Record<string, (payload: any) => void>} */
    const handlers = {};
    let subscription_count = 0;
    CLIENT = {
      /**
       * @param {string} type
       * @param {any} payload
       */
      async send(type, payload) {
        void payload;
        if (type === 'list-workspaces') {
          return {
            current: { root_dir: '/work/current', db_path: '/work/db' },
            workspaces: []
          };
        }
        if (type === 'subscribe-list') {
          subscription_count += 1;
          if (subscription_count === 1) {
            return first_subscription.promise;
          }
        }
        return null;
      },
      /**
       * @param {string} type
       * @param {(payload: any) => void} handler
       */
      on(type, handler) {
        handlers[type] = handler;
        return () => {
          delete handlers[type];
        };
      },
      onConnection() {
        return () => {};
      },
      close() {},
      getState() {
        return 'open';
      }
    };
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));
    bootstrap(root);
    await flushPromises();
    expect(subscription_count).toBe(1);

    handlers['workspace-changed']({
      root_dir: '/work/next',
      db_path: '/work/next-db'
    });
    await flushPromises();
    expect(subscription_count).toBe(1);

    first_subscription.resolve(null);
    await flushPromises();
    await flushPromises();

    expect(subscription_count).toBe(2);
  });

  test('does not reapply a saved preference after an external switch', async () => {
    /** @type {Record<string, (payload: any) => void>} */
    const handlers = {};
    let current_path = '/work/saved';
    let set_workspace_calls = 0;
    CLIENT = {
      /**
       * @param {string} type
       * @param {any} payload
       */
      async send(type, payload) {
        void payload;
        if (type === 'list-workspaces') {
          return {
            current: { root_dir: current_path, db_path: `${current_path}/db` },
            workspaces: []
          };
        }
        if (type === 'set-workspace') {
          set_workspace_calls += 1;
        }
        return null;
      },
      /**
       * @param {string} type
       * @param {(payload: any) => void} handler
       */
      on(type, handler) {
        handlers[type] = handler;
        return () => {
          delete handlers[type];
        };
      },
      onConnection() {
        return () => {};
      },
      close() {},
      getState() {
        return 'open';
      }
    };
    window.localStorage.setItem('beads-ui.workspace', '/work/saved');
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));
    bootstrap(root);
    await flushPromises();
    expect(set_workspace_calls).toBe(0);

    current_path = '/work/external';
    handlers['workspace-changed']({
      root_dir: current_path,
      db_path: `${current_path}/db`
    });
    await flushPromises();

    expect(set_workspace_calls).toBe(0);
  });
});
