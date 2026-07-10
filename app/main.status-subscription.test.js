import { beforeEach, describe, expect, test, vi } from 'vitest';
import { bootstrap } from './main.js';

/** @type {any} */
let CLIENT = null;

vi.mock('./ws.js', () => ({
  createWsClient: () => CLIENT
}));

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function deferred() {
  /** @type {(value: any) => void} */
  let resolve = () => {};
  /** @type {(reason?: any) => void} */
  let reject = () => {};
  const promise = new Promise((resolve_fn, reject_fn) => {
    resolve = resolve_fn;
    reject = reject_fn;
  });
  return { promise, reject, resolve };
}

describe('issues status subscriptions', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.location.hash = '#/issues';
    document.body.innerHTML = '<main id="app"></main>';
  });

  test('subscribes to canonical mixed stored statuses', async () => {
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
          return { current: null, workspaces: [] };
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
    window.localStorage.setItem(
      'beads-ui.filters',
      JSON.stringify({
        status: ['closed', 'open', 'closed'],
        type: [],
        search: ''
      })
    );
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    await flushPromises();

    expect(calls).toContainEqual({
      type: 'subscribe-list',
      payload: {
        id: 'tab:issues',
        type: 'status-issues',
        params: { statuses: 'open,closed' }
      }
    });
  });

  test('writes legacy filters back as canonical arrays', async () => {
    CLIENT = {
      /** @param {string} type */
      async send(type) {
        if (type === 'list-workspaces') {
          return { current: null, workspaces: [] };
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
    window.localStorage.setItem(
      'beads-ui.filters',
      JSON.stringify({ status: 'closed', types: ['chore', 'bug'], search: '' })
    );
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));
    bootstrap(root);
    await flushPromises();
    const search = /** @type {HTMLInputElement} */ (
      document.querySelector('input[type="search"]')
    );

    search.value = 'needle';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 130));

    expect(
      JSON.parse(String(window.localStorage.getItem('beads-ui.filters')))
    ).toEqual({
      status: ['closed'],
      search: 'needle',
      type: ['bug', 'chore']
    });
  });

  test('ignores an expected superseded subscription failure', async () => {
    const first_subscription = deferred();
    let subscription_count = 0;
    CLIENT = {
      /**
       * @param {string} type
       */
      async send(type) {
        if (type === 'list-workspaces') {
          return { current: null, workspaces: [] };
        }
        if (type === 'subscribe-list') {
          subscription_count += 1;
          if (subscription_count === 1) {
            return first_subscription.promise;
          }
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
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));
    bootstrap(root);
    await flushPromises();
    const closed_option = Array.from(
      document.querySelectorAll('#status-filter-menu label')
    ).find((option) => option.textContent?.trim() === 'Closed');
    const checkbox = /** @type {HTMLInputElement} */ (
      closed_option?.querySelector('input[type="checkbox"]')
    );

    checkbox.click();
    await flushPromises();
    first_subscription.reject({
      code: 'subscription_superseded',
      message: 'Subscription request was superseded'
    });
    await flushPromises();

    expect(subscription_count).toBe(2);
    expect(document.querySelector('#fatal-error-dialog[open]')).toBeNull();
  });
});
