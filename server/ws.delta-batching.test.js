import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fetchListForSubscription } from './list-adapters.js';
import { keyOf, registry } from './subscriptions.js';
import {
  MAX_PUSH_FRAME_BYTES,
  MAX_SOCKET_BUFFERED_BYTES,
  attachWsServer,
  handleMessage,
  scheduleListRefresh
} from './ws.js';

vi.mock('./list-adapters.js', () => ({
  fetchListForSubscription: vi.fn()
}));

const mockedFetch = /** @type {import('vitest').Mock} */ (
  fetchListForSubscription
);

/**
 * @param {string} id
 * @param {number} updated_at
 * @param {Record<string, unknown>} [extra]
 */
function issue(id, updated_at, extra = {}) {
  return { id, updated_at, closed_at: null, ...extra };
}

class TestSocket extends EventEmitter {
  /**
   * @param {{ buffered_amount?: number, fail_snapshot?: boolean }} [options]
   */
  constructor(options = {}) {
    super();
    /** @type {string[]} */
    this.sent = [];
    /** @type {Array<{ code: number, reason: string }>} */
    this.closed = [];
    this.readyState = 1;
    this.OPEN = 1;
    this.bufferedAmount = options.buffered_amount || 0;
    this.fail_snapshot = options.fail_snapshot === true;
  }

  /** @param {string} message */
  send(message) {
    const encoded = String(message);
    if (this.fail_snapshot && JSON.parse(encoded).type === 'snapshot') {
      throw new Error('snapshot enqueue failed');
    }
    this.sent.push(encoded);
  }

  /**
   * @param {number} code
   * @param {string} reason
   */
  close(code, reason) {
    this.closed.push({ code, reason });
    this.readyState = 3;
  }

  terminate() {
    this.readyState = 3;
  }
}

/**
 * @param {TestSocket} socket
 * @param {string} request_id
 * @param {string} client_id
 * @param {string[]} [capabilities]
 */
async function subscribe(socket, request_id, client_id, capabilities = []) {
  await handleMessage(
    /** @type {any} */ (socket),
    Buffer.from(
      JSON.stringify({
        id: request_id,
        type: 'subscribe-list',
        payload: {
          id: client_id,
          type: 'all-issues',
          capabilities
        }
      })
    )
  );
}

/**
 * @param {TestSocket} socket
 */
function decodedMessages(socket) {
  return socket.sent.map((message) => JSON.parse(message));
}

/**
 * @param {TestSocket} socket
 */
function attachTestRuntime(socket) {
  const server = createServer();
  const runtime = attachWsServer(server, {
    heartbeat_ms: 60_000,
    refresh_debounce_ms: 10
  });
  runtime.wss.clients.add(/** @type {any} */ (socket));
  return runtime;
}

describe('subscription delta batching', () => {
  beforeEach(() => {
    registry.clear();
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({
      ok: true,
      items: [issue('A', 1), issue('B', 1)],
      truncated: false
    });
  });

  test('batches capable ids while preserving legacy delivery on one key', async () => {
    vi.useFakeTimers();
    const socket = new TestSocket();
    attachTestRuntime(socket);
    await subscribe(socket, 'req-capable', 'capable', [
      'subscription-delta-v1'
    ]);
    await subscribe(socket, 'req-legacy', 'legacy');
    socket.sent = [];
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      items: [issue('C', 1), issue('A', 2)],
      truncated: false
    });

    const refresh = scheduleListRefresh();
    await vi.advanceTimersByTimeAsync(20);
    await refresh;

    const updates = decodedMessages(socket);
    const delta = updates.find((message) => message.type === 'delta');
    expect(delta.payload).toMatchObject({
      id: 'capable',
      upserts: [{ id: 'A' }, { id: 'C' }],
      deletes: ['B']
    });
    expect(
      updates.filter(
        (message) =>
          message.payload.id === 'legacy' &&
          (message.type === 'upsert' || message.type === 'delete')
      )
    ).toHaveLength(3);
    vi.useRealTimers();
  });

  test('retains legacy envelope for one capable change', async () => {
    vi.useFakeTimers();
    const socket = new TestSocket();
    attachTestRuntime(socket);
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      items: [issue('A', 1)],
      truncated: false
    });
    await subscribe(socket, 'req-capable', 'capable', [
      'subscription-delta-v1'
    ]);
    socket.sent = [];
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      items: [issue('A', 2)],
      truncated: false
    });

    const refresh = scheduleListRefresh();
    await vi.advanceTimersByTimeAsync(20);
    await refresh;

    expect(decodedMessages(socket).map((message) => message.type)).toEqual([
      'upsert'
    ]);
    vi.useRealTimers();
  });

  test('treats an initialized empty list as a delta baseline', async () => {
    vi.useFakeTimers();
    const socket = new TestSocket();
    attachTestRuntime(socket);
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      items: [],
      truncated: false
    });
    await subscribe(socket, 'req-empty', 'capable', ['subscription-delta-v1']);
    socket.sent = [];
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      items: [issue('A', 1), issue('B', 1)],
      truncated: false
    });

    const refresh = scheduleListRefresh();
    await vi.advanceTimersByTimeAsync(20);
    await refresh;

    expect(decodedMessages(socket).map((message) => message.type)).toEqual([
      'delta'
    ]);
    vi.useRealTimers();
  });

  test('delivers one frame for one hundred capable changes', async () => {
    vi.useFakeTimers();
    const socket = new TestSocket();
    attachTestRuntime(socket);
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      items: [],
      truncated: false
    });
    await subscribe(socket, 'req-empty', 'capable', ['subscription-delta-v1']);
    socket.sent = [];
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      items: Array.from({ length: 100 }, (_, index) => issue(`I-${index}`, 1)),
      truncated: false
    });

    const refresh = scheduleListRefresh();
    await vi.advanceTimersByTimeAsync(20);
    await refresh;

    expect(decodedMessages(socket)).toMatchObject([
      {
        type: 'delta',
        payload: { id: 'capable', upserts: expect.any(Array), deletes: [] }
      }
    ]);
    expect(decodedMessages(socket)[0].payload.upserts).toHaveLength(100);
    vi.useRealTimers();
  });

  test('keeps a sibling id attached after unsubscribe', async () => {
    vi.useFakeTimers();
    const socket = new TestSocket();
    attachTestRuntime(socket);
    await subscribe(socket, 'req-one', 'one');
    await subscribe(socket, 'req-two', 'two');
    await handleMessage(
      /** @type {any} */ (socket),
      Buffer.from(
        JSON.stringify({
          id: 'unsub-one',
          type: 'unsubscribe-list',
          payload: { id: 'one' }
        })
      )
    );
    socket.sent = [];
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      items: [issue('A', 2), issue('B', 1)],
      truncated: false
    });

    const refresh = scheduleListRefresh();
    await vi.advanceTimersByTimeAsync(20);
    await refresh;

    expect(decodedMessages(socket)).toMatchObject([
      { type: 'upsert', payload: { id: 'two' } }
    ]);
    vi.useRealTimers();
  });
});

describe('subscription resource bounds', () => {
  beforeEach(() => {
    registry.clear();
    mockedFetch.mockReset();
  });

  test('reports selected capabilities and exact truncation after snapshot', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      items: [issue('A', 1)],
      truncated: true
    });
    const socket = new TestSocket();

    await subscribe(socket, 'req-one', 'one', [
      'future-capability',
      'subscription-delta-v1'
    ]);

    const messages = decodedMessages(socket);
    expect(messages.map((message) => message.type)).toEqual([
      'snapshot',
      'subscribe-list'
    ]);
    expect(messages[0].payload.truncated).toBe(true);
    expect(messages[1].payload.capabilities).toEqual(['subscription-delta-v1']);
  });

  test('rejects a thirty-third pending id before fetching', async () => {
    /** @type {(value: FetchListResult) => void} */
    let resolveFetch = () => {};
    const pending_fetch = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    mockedFetch.mockReturnValue(pending_fetch);
    const socket = new TestSocket();
    const pending = Array.from({ length: 32 }, (_, index) =>
      subscribe(socket, `req-${index}`, `id-${index}`)
    );

    await subscribe(socket, 'req-over', 'id-over');

    const rejection = decodedMessages(socket).find(
      (message) => message.id === 'req-over'
    );
    expect(rejection.error.code).toBe('resource_limit');
    expect(mockedFetch).toHaveBeenCalledTimes(32);

    resolveFetch({ ok: true, items: [], truncated: false });
    await Promise.all(pending);
  });

  test('keeps the newest same-id reservation when an older fetch completes', async () => {
    /** @type {(value: FetchListResult) => void} */
    let resolveFirst = () => {};
    const first_fetch = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    mockedFetch.mockReturnValueOnce(first_fetch).mockResolvedValueOnce({
      ok: true,
      items: [issue('new', 2)],
      truncated: false
    });
    const socket = new TestSocket();
    const first = subscribe(socket, 'req-old', 'same');

    await subscribe(socket, 'req-new', 'same');
    resolveFirst({
      ok: true,
      items: [issue('old', 1)],
      truncated: false
    });
    await first;

    const key = keyOf({ type: 'all-issues' });
    expect(
      registry.get(key)?.subscribers.has(/** @type {any} */ (socket))
    ).toBe(true);
    expect(
      decodedMessages(socket).find((message) => message.id === 'req-old').error
        .code
    ).toBe('subscription_superseded');
  });

  test('does not reattach a pending subscription after disconnect', async () => {
    /** @type {(value: FetchListResult) => void} */
    let resolveFetch = () => {};
    mockedFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    const socket = new TestSocket();
    const runtime = attachTestRuntime(socket);
    runtime.wss.emit('connection', /** @type {any} */ (socket));
    const pending = subscribe(socket, 'req-pending', 'pending');
    socket.readyState = 3;
    socket.emit('close');

    resolveFetch({ ok: true, items: [issue('A', 1)], truncated: false });
    await pending;

    expect(
      registry.get(keyOf({ type: 'all-issues' }))?.subscribers.size || 0
    ).toBe(0);
    expect(socket.sent).toEqual([]);
  });

  test('rejects an oversized initial snapshot without attaching', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      items: [issue('A', 1, { title: 'x'.repeat(MAX_PUSH_FRAME_BYTES) })],
      truncated: false
    });
    const socket = new TestSocket();

    await subscribe(socket, 'req-large', 'large');

    const messages = decodedMessages(socket);
    expect(messages).toMatchObject([
      { id: 'req-large', ok: false, error: { code: 'resource_limit' } }
    ]);
    expect(
      registry.get(keyOf({ type: 'all-issues' }))?.subscribers.size || 0
    ).toBe(0);
  });

  test('rejects an initial snapshot above the prospective buffer limit', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      items: [issue('A', 1)],
      truncated: false
    });
    const socket = new TestSocket({
      buffered_amount: MAX_SOCKET_BUFFERED_BYTES - 1
    });

    await subscribe(socket, 'req-buffered', 'buffered');

    expect(decodedMessages(socket)).toMatchObject([
      { id: 'req-buffered', error: { code: 'resource_limit' } }
    ]);
  });

  test('detaches and suppresses acknowledgement on snapshot enqueue failure', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      items: [issue('A', 1)],
      truncated: false
    });
    const socket = new TestSocket({ fail_snapshot: true });

    await subscribe(socket, 'req-fail', 'fail');

    expect(decodedMessages(socket)).toMatchObject([
      { id: 'req-fail', ok: false, error: { code: 'bd_error' } }
    ]);
    expect(
      registry.get(keyOf({ type: 'all-issues' }))?.subscribers.size || 0
    ).toBe(0);

    socket.fail_snapshot = false;
    socket.sent = [];
    await subscribe(socket, 'req-retry', 'fail');

    expect(decodedMessages(socket)[0]).toMatchObject({
      type: 'snapshot',
      payload: { revision: 1 }
    });
  });

  test('closes a lagging connection before sending any update frame', async () => {
    vi.useFakeTimers();
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      items: [issue('A', 1)],
      truncated: false
    });
    const socket = new TestSocket();
    attachTestRuntime(socket);
    await subscribe(socket, 'req-one', 'one');
    socket.sent = [];
    socket.bufferedAmount = MAX_SOCKET_BUFFERED_BYTES;
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      items: [issue('A', 2), issue('B', 1)],
      truncated: false
    });

    const refresh = scheduleListRefresh();
    await vi.advanceTimersByTimeAsync(20);
    await refresh;

    expect(socket.sent).toEqual([]);
    expect(socket.closed).toMatchObject([{ code: 1013 }]);
    vi.useRealTimers();
  });

  test('closes before sending a partial update when encoding fails', async () => {
    vi.useFakeTimers();
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      items: [issue('A', 1)],
      truncated: false
    });
    const socket = new TestSocket();
    attachTestRuntime(socket);
    await subscribe(socket, 'req-one', 'one');
    socket.sent = [];
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      items: [issue('A', 2), issue('B', 1, { invalid: 1n })],
      truncated: false
    });

    const refresh = scheduleListRefresh();
    await vi.advanceTimersByTimeAsync(20);
    await refresh;

    expect(socket.sent).toEqual([]);
    expect(socket.closed).toMatchObject([{ code: 1013 }]);
    vi.useRealTimers();
  });
});

/**
 * Local test type matching successful adapter results.
 *
 * @typedef {{ ok: true, items: Array<Record<string, unknown>>, truncated: boolean }} FetchListResult
 */
