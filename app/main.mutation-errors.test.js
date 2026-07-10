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

describe('main mutation failures', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.location.hash = '#/issues';
    document.body.innerHTML = '<main id="app"></main>';
  });

  test('rolls back an optimistic list edit and shows an error', async () => {
    /** @type {Record<string, (payload: any) => void>} */
    const handlers = {};
    CLIENT = {
      /**
       * @param {string} type
       * @param {any} payload
       */
      async send(type, payload) {
        void payload;
        if (type === 'list-workspaces') {
          return { current: null, workspaces: [] };
        }
        if (type === 'update-status') {
          throw new Error('validation failed');
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
    handlers.snapshot({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues: [{ id: 'UI-FAIL', title: 'Failure', status: 'open' }]
    });
    await flushPromises();
    let status = /** @type {HTMLSelectElement} */ (
      document.querySelector('select.badge--status')
    );

    status.value = 'in_progress';
    status.dispatchEvent(new Event('change', { bubbles: true }));
    expect(
      /** @type {HTMLSelectElement} */ (
        document.querySelector('select.badge--status')
      ).value
    ).toBe('in_progress');
    await flushPromises();

    status = /** @type {HTMLSelectElement} */ (
      document.querySelector('select.badge--status')
    );
    expect(status.value).toBe('open');
    expect(document.querySelector('.toast--error')?.textContent).toContain(
      'status'
    );
  });
});
