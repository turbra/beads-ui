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
  await subscribeList(sock, 'tab:board:ready', 'ready-issues');
}

/**
 * @param {ReturnType<typeof createSocket>} sock
 * @param {string} id
 * @param {string} type
 * @param {Record<string, string | number | boolean>} [params]
 */
async function subscribeList(sock, id, type, params = undefined) {
  await handleMessage(
    /** @type {any} */ (sock),
    Buffer.from(
      JSON.stringify({
        id: `sub-${id}`,
        type: /** @type {any} */ ('subscribe-list'),
        payload: params ? { id, type, params } : { id, type }
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

    expect(mock).toHaveBeenCalledTimes(3);
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

  test('refresh populates board cache before prewarm runs', async () => {
    const server = createServer();
    const { scheduleListRefresh, wss } = attachWsServer(server, {
      path: '/ws',
      prewarm_board_cache: true,
      refresh_debounce_ms: 0
    });
    const mock = resetAdapterMock();

    await new Promise((resolve) => setTimeout(resolve, 10));
    mock.mockClear();

    const sock = createSocket();
    wss.clients.add(/** @type {any} */ (sock));
    const since = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      new Date().getDate(),
      0,
      0,
      0,
      0
    ).getTime();
    await subscribeList(sock, 'tab:board:ready', 'ready-issues');
    await subscribeList(sock, 'tab:board:blocked', 'blocked-issues');
    await subscribeList(sock, 'tab:board:in-progress', 'in-progress-issues');
    await subscribeList(sock, 'tab:board:closed', 'closed-issues', { since });

    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith(
      { type: 'closed-issues', params: { since } },
      expect.any(Object)
    );
    mock.mockClear();

    scheduleListRefresh();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mock).toHaveBeenCalledTimes(4);
    wss.close();
  });

  test('fetches each active closed range instead of prewarming today', async () => {
    const server = createServer();
    const { prewarmBoardCache, wss } = attachWsServer(server, { path: '/ws' });
    const mock = resetAdapterMock();
    await prewarmBoardCache();
    expect(mock).toHaveBeenCalledTimes(3);
    mock.mockClear();
    const now = Date.now();
    const three_days = now - 3 * 24 * 60 * 60 * 1000;
    const seven_days = now - 7 * 24 * 60 * 60 * 1000;

    await subscribeList(createSocket(), 'tab:board:closed', 'closed-issues', {
      since: three_days
    });
    await subscribeList(createSocket(), 'tab:board:closed', 'closed-issues', {
      since: seven_days
    });

    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls.map(([spec]) => spec)).toEqual([
      { type: 'closed-issues', params: { since: three_days } },
      { type: 'closed-issues', params: { since: seven_days } }
    ]);
    wss.close();
  });

  test('does not prewarm board lanes after a non-board refresh', async () => {
    const server = createServer();
    const { scheduleListRefresh, wss } = attachWsServer(server, {
      path: '/ws',
      prewarm_board_cache: true,
      refresh_debounce_ms: 0
    });
    const mock = resetAdapterMock();
    await new Promise((resolve) => setTimeout(resolve, 10));
    mock.mockClear();

    const sock = createSocket();
    wss.clients.add(/** @type {any} */ (sock));
    await subscribeList(sock, 'tab:issues', 'all-issues');
    mock.mockClear();

    await scheduleListRefresh();

    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith(
      { type: 'all-issues', params: undefined },
      expect.objectContaining({ priority: 'background' })
    );
    wss.close();
  });
});
