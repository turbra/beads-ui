import { createServer } from 'node:http';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fetchListForSubscription } from './list-adapters.js';
import { registry } from './subscriptions.js';
import { attachWsServer, handleMessage } from './ws.js';

vi.mock('./list-adapters.js', () => ({
  fetchListForSubscription: vi.fn()
}));

/**
 * @param {{ type: string }} spec
 */
function makeItems(spec) {
  const type = String(spec.type || 'issues');
  return [
    {
      id: `${type}-1`,
      updated_at: 1,
      closed_at: type === 'closed-issues' ? Date.now() : null
    }
  ];
}

function resetAdapterMock() {
  const mock = /** @type {import('vitest').Mock} */ (fetchListForSubscription);
  mock.mockReset();
  mock.mockImplementation(async (spec) => ({
    ok: true,
    items: makeItems(spec)
  }));
  return mock;
}

function createSocket() {
  return {
    sent: /** @type {string[]} */ ([]),
    readyState: 1,
    OPEN: 1,
    /** @param {string} msg */
    send(msg) {
      this.sent.push(String(msg));
    }
  };
}

/**
 * @param {ReturnType<typeof createSocket>} sock
 */
async function subscribeBoardReady(sock) {
  await handleMessage(
    /** @type {any} */ (sock),
    Buffer.from(
      JSON.stringify({
        id: 'sub-board-ready',
        type: /** @type {any} */ ('subscribe-list'),
        payload: { id: 'tab:board:ready', type: 'ready-issues' }
      })
    )
  );
}

/**
 * @param {ReturnType<typeof createSocket>} sock
 */
function findSnapshot(sock) {
  return sock.sent
    .map((msg) => {
      try {
        return JSON.parse(msg);
      } catch {
        return null;
      }
    })
    .find((msg) => msg && msg.type === 'snapshot');
}

beforeEach(() => {
  registry.clear();
  resetAdapterMock();
});

describe('ws board cache', () => {
  test('serves board subscriptions from prewarmed cache', async () => {
    const server = createServer();
    const { prewarmBoardCache, wss } = attachWsServer(server, {
      path: '/ws'
    });
    const mock = resetAdapterMock();

    await prewarmBoardCache();

    expect(mock).toHaveBeenCalledTimes(4);
    mock.mockClear();

    const sock = createSocket();
    await subscribeBoardReady(sock);

    expect(mock).not.toHaveBeenCalled();
    const snapshot = findSnapshot(sock);
    expect(snapshot.payload.issues).toEqual(
      makeItems({ type: 'ready-issues' })
    );
    wss.close();
  });

  test('deduplicates concurrent board subscription fetches', async () => {
    const server = createServer();
    const { wss } = attachWsServer(server, { path: '/ws' });
    const mock = resetAdapterMock();
    const deferred = {
      resolve: /** @type {((value: unknown) => void) | null} */ (null)
    };
    mock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deferred.resolve = resolve;
        })
    );

    const first_sock = createSocket();
    const second_sock = createSocket();
    const first = subscribeBoardReady(first_sock);
    const second = subscribeBoardReady(second_sock);

    await Promise.resolve();

    expect(mock).toHaveBeenCalledTimes(1);
    const resolve_fetch = deferred.resolve;
    if (!resolve_fetch) {
      throw new Error('fetch promise was not captured');
    }
    resolve_fetch({
      ok: true,
      items: makeItems({ type: 'ready-issues' })
    });
    await Promise.all([first, second]);

    expect(findSnapshot(first_sock).payload.issues).toEqual(
      makeItems({ type: 'ready-issues' })
    );
    expect(findSnapshot(second_sock).payload.issues).toEqual(
      makeItems({ type: 'ready-issues' })
    );
    wss.close();
  });
});
