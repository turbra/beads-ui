import { describe, expect, test, vi } from 'vitest';
import { bootstrap } from './main.js';
import { createWsClient } from './ws.js';

// Mock WS client to drive push envelopes and connection state
vi.mock('./ws.js', () => {
  /** @type {Record<string, (p: any) => void>} */
  const handlers = {};
  /** @type {Set<(s: 'connecting'|'open'|'closed'|'reconnecting') => void>} */
  const connHandlers = new Set();
  /** @type {Array<{ type: string, payload: any }>} */
  const sent = [];
  const singleton = {
    /**
     * @param {import('./protocol.js').MessageType} type
     * @param {any} payload
     */
    async send(type, payload) {
      sent.push({ type, payload });
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
    /** Test helper: trigger a server event */
    /**
     * @param {import('./protocol.js').MessageType} type
     * @param {any} payload
     */
    _trigger(type, payload) {
      if (handlers[type]) {
        handlers[type](payload);
      }
    },
    /**
     * @param {(s:'connecting'|'open'|'closed'|'reconnecting')=>void} fn
     */
    onConnection(fn) {
      connHandlers.add(fn);
      return () => connHandlers.delete(fn);
    },
    /** Test helper: emit connection state */
    /** @param {'connecting'|'open'|'closed'|'reconnecting'} s */
    _emitConn(s) {
      for (const fn of Array.from(connHandlers)) {
        try {
          fn(s);
        } catch {
          /* ignore */
        }
      }
    },
    _sent: sent,
    close() {},
    getState() {
      return 'open';
    }
  };
  return { createWsClient: () => singleton };
});

async function flushBootstrap() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe('push stores integration (board view)', () => {
  test('updates only the matching column on push events (multi-sub isolation)', async () => {
    const client = /** @type {any} */ (createWsClient());
    window.location.hash = '#/board';
    document.body.innerHTML = '<main id="app"></main>';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    // Allow router + subscriptions to wire
    await flushBootstrap();

    expect(client._sent).toContainEqual({
      type: 'subscribe-list',
      payload: {
        id: 'tab:board:ready',
        type: 'ready-issues',
        params: undefined,
        capabilities: ['subscription-delta-v1']
      }
    });

    // Initial board: no cards
    expect(document.querySelectorAll('#ready-col .board-card').length).toBe(0);
    expect(
      document.querySelectorAll('#in-progress-col .board-card').length
    ).toBe(0);

    // Send per-subscription snapshots
    client._trigger('snapshot', {
      type: 'snapshot',
      id: 'tab:board:ready',
      revision: 1,
      issues: [
        { id: 'R-1', title: 'ready 1', priority: 1, updated_at: 10_000 },
        { id: 'R-2', title: 'ready 2', priority: 2, updated_at: 11_000 }
      ]
    });
    client._trigger('snapshot', {
      type: 'snapshot',
      id: 'tab:board:in-progress',
      revision: 1,
      issues: [{ id: 'P-1', title: 'prog 1', updated_at: 20_000 }]
    });
    await Promise.resolve();

    // Verify columns reflect only their subscription data
    expect(document.querySelectorAll('#ready-col .board-card').length).toBe(2);
    expect(
      document.querySelectorAll('#in-progress-col .board-card').length
    ).toBe(1);

    // Upsert into Ready only
    client._trigger('upsert', {
      type: 'upsert',
      id: 'tab:board:ready',
      revision: 2,
      issue: { id: 'R-3', title: 'ready 3', priority: 1, updated_at: 12_000 }
    });
    await Promise.resolve();

    expect(document.querySelectorAll('#ready-col .board-card').length).toBe(3);
    // In-progress unaffected
    expect(
      document.querySelectorAll('#in-progress-col .board-card').length
    ).toBe(1);

    // Delete from In-progress only
    client._trigger('delete', {
      type: 'delete',
      id: 'tab:board:in-progress',
      revision: 2,
      issue_id: 'P-1'
    });
    await Promise.resolve();

    expect(
      document.querySelectorAll('#in-progress-col .board-card').length
    ).toBe(0);
    // Ready unaffected
    expect(document.querySelectorAll('#ready-col .board-card').length).toBe(3);

    // A capable server can update and remove Ready items atomically.
    client._trigger('delta', {
      type: 'delta',
      id: 'tab:board:ready',
      revision: 3,
      upserts: [
        {
          id: 'R-1',
          title: 'ready 1 updated',
          priority: 1,
          updated_at: 13_000
        }
      ],
      deletes: ['R-2']
    });
    await Promise.resolve();

    expect(document.querySelectorAll('#ready-col .board-card').length).toBe(2);
    expect(document.querySelector('#ready-col')?.textContent).toContain(
      'ready 1 updated'
    );
  });

  test('reconnect replay does not duplicate entries', async () => {
    const client = /** @type {any} */ (createWsClient());
    window.location.hash = '#/board';
    document.body.innerHTML = '<main id="app"></main>';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));

    bootstrap(root);
    await flushBootstrap();

    // Initial snapshot
    client._trigger('snapshot', {
      type: 'snapshot',
      id: 'tab:board:ready',
      revision: 1,
      issues: [
        { id: 'R-1', title: 'r1', priority: 1, updated_at: 10_000 },
        { id: 'R-2', title: 'r2', priority: 2, updated_at: 10_100 }
      ]
    });
    await Promise.resolve();
    expect(document.querySelectorAll('#ready-col .board-card').length).toBe(2);

    // Simulate reconnect cycle and server replaying the same snapshot
    client._emitConn('reconnecting');
    client._emitConn('open');
    client._trigger('snapshot', {
      type: 'snapshot',
      id: 'tab:board:ready',
      revision: 1,
      issues: [
        { id: 'R-1', title: 'r1', priority: 1, updated_at: 10_000 },
        { id: 'R-2', title: 'r2', priority: 2, updated_at: 10_100 }
      ]
    });
    await Promise.resolve();
    // Still exactly two cards; no duplicates
    expect(document.querySelectorAll('#ready-col .board-card').length).toBe(2);

    // Newer upsert after replay updates item without duplication
    client._trigger('upsert', {
      type: 'upsert',
      id: 'tab:board:ready',
      revision: 2,
      issue: { id: 'R-2', title: 'r2!', priority: 2, updated_at: 10_200 }
    });
    await Promise.resolve();
    expect(document.querySelectorAll('#ready-col .board-card').length).toBe(2);
  });

  test('requests a fresh snapshot after rejecting an invalid delta', async () => {
    const client = /** @type {any} */ (createWsClient());
    client._sent.length = 0;
    window.location.hash = '#/board';
    document.body.innerHTML = '<main id="app"></main>';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));
    bootstrap(root);
    await flushBootstrap();
    client._trigger('snapshot', {
      type: 'snapshot',
      id: 'tab:board:ready',
      revision: 1,
      issues: [{ id: 'R-1', title: 'ready 1', updated_at: 10_000 }]
    });
    await Promise.resolve();
    const sent_before = client._sent.length;

    client._trigger('delta', {
      type: 'delta',
      id: 'tab:board:ready',
      revision: 2,
      upserts: [{ id: 'R-2', title: 'invalid one-change delta' }],
      deletes: []
    });
    await Promise.resolve();

    expect(document.querySelectorAll('#ready-col .board-card').length).toBe(1);
    expect(client._sent.slice(sent_before)).toContainEqual({
      type: 'subscribe-list',
      payload: {
        id: 'tab:board:ready',
        type: 'ready-issues',
        params: undefined,
        capabilities: ['subscription-delta-v1']
      }
    });
  });

  test('resynchronizes after a mismatched delta payload', async () => {
    const client = /** @type {any} */ (createWsClient());
    client._sent.length = 0;
    window.location.hash = '#/board';
    document.body.innerHTML = '<main id="app"></main>';
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));
    bootstrap(root);
    await flushBootstrap();
    client._trigger('snapshot', {
      type: 'snapshot',
      id: 'tab:board:ready',
      revision: 1,
      issues: [{ id: 'R-1', title: 'ready 1', updated_at: 10_000 }]
    });
    await Promise.resolve();
    const sent_before = client._sent.length;

    client._trigger('delta', {
      type: 'upsert',
      id: 'tab:board:ready',
      revision: 2,
      issue: { id: 'R-2', title: 'misrouted' }
    });
    await Promise.resolve();

    expect(document.querySelectorAll('#ready-col .board-card')).toHaveLength(1);
    expect(client._sent.slice(sent_before)).toContainEqual({
      type: 'subscribe-list',
      payload: {
        id: 'tab:board:ready',
        type: 'ready-issues',
        params: undefined,
        capabilities: ['subscription-delta-v1']
      }
    });
  });
});
