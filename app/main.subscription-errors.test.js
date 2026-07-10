import { beforeEach, describe, expect, test, vi } from 'vitest';
import { bootstrap } from './main.js';

/** @type {ReturnType<typeof createClient> | null} */
let CLIENT = null;

vi.mock('./ws.js', () => ({
  createWsClient: () => CLIENT
}));

/**
 * @param {(type: string, payload: any) => Promise<unknown>} send
 */
function createClient(send) {
  return {
    calls: /** @type {Array<{ type: string, payload: any }>} */ ([]),
    /**
     * @param {string} type
     * @param {any} payload
     */
    async send(type, payload) {
      this.calls.push({ type, payload });
      return send(type, payload);
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
}

async function flushPromises() {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

describe('subscription recovery banners', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.body.innerHTML = '<main id="app"></main>';
  });

  test('retries an Issues subscription and clears its alert on success', async () => {
    let issues_attempts = 0;
    CLIENT = createClient(async (type, payload) => {
      if (type === 'list-workspaces') {
        return { current: null, workspaces: [] };
      }
      if (type === 'subscribe-list' && payload.id === 'tab:issues') {
        issues_attempts += 1;
        if (issues_attempts === 1) {
          throw { code: 'bd_error', message: 'Dolt is busy' };
        }
      }
      return null;
    });
    window.location.hash = '#/issues';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    await flushPromises();
    const alert = /** @type {HTMLElement} */ (
      document.querySelector('[data-subscription-id="tab:issues"]')
    );
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('Issues list: Dolt is busy');
    expect(document.querySelector('#fatal-error-dialog[open]')).toBeNull();

    /** @type {HTMLButtonElement} */ (alert.querySelector('button')).click();
    await flushPromises();

    expect(issues_attempts).toBe(2);
    expect(
      document.querySelector('[data-subscription-id="tab:issues"]')
    ).toBeNull();
  });

  test('keeps successful Board lanes visible when one lane fails', async () => {
    CLIENT = createClient(async (type, payload) => {
      if (type === 'list-workspaces') {
        return { current: null, workspaces: [] };
      }
      if (type === 'subscribe-list' && payload.id === 'tab:board:ready') {
        throw { code: 'bd_error', message: 'Ready failed' };
      }
      return null;
    });
    window.location.hash = '#/board';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    await flushPromises();

    expect(document.querySelector('.board-root')).not.toBeNull();
    expect(document.querySelectorAll('.subscription-error')).toHaveLength(1);
    expect(
      document.querySelector('[data-subscription-id="tab:board:ready"]')
        ?.textContent
    ).toContain('Board Ready: Ready failed');
    expect(
      CLIENT.calls.filter(
        (call) =>
          call.type === 'subscribe-list' &&
          call.payload.id.startsWith('tab:board:')
      )
    ).toHaveLength(4);
  });

  test('clears a stale route alert after navigation', async () => {
    CLIENT = createClient(async (type, payload) => {
      if (type === 'list-workspaces') {
        return { current: null, workspaces: [] };
      }
      if (type === 'subscribe-list' && payload.id === 'tab:issues') {
        throw { code: 'bd_error', message: 'Issues failed' };
      }
      return null;
    });
    window.location.hash = '#/issues';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));
    bootstrap(root);
    await flushPromises();
    expect(document.querySelector('.subscription-error')).not.toBeNull();

    window.location.hash = '#/epics';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flushPromises();

    expect(
      document.querySelector('[data-subscription-id="tab:issues"]')
    ).toBeNull();
  });

  test('shows detail failures inside the open issue dialog', async () => {
    let detail_attempts = 0;
    CLIENT = createClient(async (type, payload) => {
      if (type === 'list-workspaces') {
        return { current: null, workspaces: [] };
      }
      if (type === 'subscribe-list' && payload.id === 'detail:UI-1') {
        detail_attempts += 1;
        if (detail_attempts === 1) {
          throw { code: 'bd_error', message: 'Detail failed' };
        }
      }
      return null;
    });
    window.location.hash = '#/issues?issue=UI-1';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    await flushPromises();
    const alert = /** @type {HTMLElement} */ (
      document.querySelector('[data-subscription-id="detail:UI-1"]')
    );
    expect(alert.closest('#issue-dialog')).not.toBeNull();
    expect(alert.textContent).toContain('Issue details: Detail failed');

    /** @type {HTMLButtonElement} */ (alert.querySelector('button')).click();
    await flushPromises();

    expect(detail_attempts).toBe(2);
    expect(
      document.querySelector('[data-subscription-id="detail:UI-1"]')
    ).toBeNull();
  });
});
