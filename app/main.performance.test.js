import { beforeEach, describe, expect, test, vi } from 'vitest';
import { bootstrap } from './main.js';
import { createWsClient } from './ws.js';

/** @type {{ type: string, payload: any }[]} */
const calls = [];

vi.mock('./ws.js', () => {
  /** @type {Record<string, (p: any) => void>} */
  const handlers = {};
  const singleton = {
    /**
     * @param {import('./protocol.js').MessageType} type
     * @param {any} payload
     */
    async send(type, payload) {
      calls.push({ type, payload });
      return null;
    },
    /**
     * @param {import('./protocol.js').MessageType} type
     * @param {(p:any)=>void} handler
     */
    on(type, handler) {
      handlers[type] = handler;
      return () => {
        delete handlers[type];
      };
    },
    close() {},
    getState() {
      return 'open';
    },
    /**
     * @param {import('./protocol.js').MessageType} type
     * @param {any} payload
     */
    _trigger(type, payload) {
      if (handlers[type]) {
        handlers[type](payload);
      }
    }
  };
  return { createWsClient: () => singleton };
});

/**
 * Flush pending subscription and render microtasks.
 */
async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('main performance-sensitive subscriptions', () => {
  beforeEach(() => {
    calls.length = 0;
    window.localStorage.clear();
    window.location.hash = '#/issues';
    document.body.innerHTML = '';
  });

  test('subscribes board closed issues with a since filter', async () => {
    window.location.hash = '#/board';
    document.body.innerHTML = '<main id="app"></main>';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    await flushPromises();

    const closed_subs = calls.filter(
      (call) =>
        call.type === 'subscribe-list' &&
        call.payload &&
        call.payload.id === 'tab:board:closed'
    );
    expect(closed_subs.length).toBe(1);
    const first_since = Number(closed_subs[0].payload.params.since);
    expect(Number.isFinite(first_since)).toBe(true);

    const select = /** @type {HTMLSelectElement} */ (
      document.querySelector('#closed-filter')
    );
    select.value = '7';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    const next_closed_subs = calls.filter(
      (call) =>
        call.type === 'subscribe-list' &&
        call.payload &&
        call.payload.id === 'tab:board:closed'
    );
    expect(next_closed_subs.length).toBe(2);
    expect(
      calls.some(
        (call) =>
          call.type === 'unsubscribe-list' &&
          call.payload &&
          call.payload.id === 'tab:board:closed'
      )
    ).toBe(true);
    expect(Number(next_closed_subs[1].payload.params.since)).toBeLessThan(
      first_since
    );
  });

  test('does not resubscribe detail for unrelated state changes', async () => {
    const client = /** @type {any} */ (createWsClient());
    window.location.hash = '#/issue/UI-1';
    document.body.innerHTML = '<main id="app"></main>';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    await flushPromises();

    client._trigger('snapshot', {
      type: 'snapshot',
      id: 'detail:UI-1',
      revision: 1,
      issues: [{ id: 'UI-1', title: 'One', status: 'open', updated_at: 1 }]
    });
    await flushPromises();

    const initial_detail_subs = calls.filter(
      (call) =>
        call.type === 'subscribe-list' &&
        call.payload &&
        call.payload.id === 'detail:UI-1'
    );
    expect(initial_detail_subs.length).toBe(1);

    const search = /** @type {HTMLInputElement} */ (
      document.querySelector('#issues-root input[type="search"]')
    );
    search.value = 'one';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();

    const final_detail_subs = calls.filter(
      (call) =>
        call.type === 'subscribe-list' &&
        call.payload &&
        call.payload.id === 'detail:UI-1'
    );
    expect(final_detail_subs.length).toBe(1);
  });

  test('renders detail immediately from active list snapshot', async () => {
    const client = /** @type {any} */ (createWsClient());
    window.location.hash = '#/issues';
    document.body.innerHTML = '<main id="app"></main>';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    await flushPromises();

    client._trigger('snapshot', {
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues: [
        {
          id: 'UI-FAST',
          title: 'Seeded detail title',
          status: 'open',
          priority: 2,
          comment_count: 0,
          created_at: 1,
          updated_at: 1,
          closed_at: null
        }
      ]
    });
    await flushPromises();

    window.location.hash = '#/issues?issue=UI-FAST';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flushPromises();

    const detail = document.querySelector('#detail-root');
    expect(detail?.textContent || '').toContain('Seeded detail title');
    expect(calls.some((call) => call.type === 'get-comments')).toBe(false);
    expect(
      calls.some(
        (call) =>
          call.type === 'subscribe-list' &&
          call.payload &&
          call.payload.id === 'detail:UI-FAST'
      )
    ).toBe(true);
  });
});
