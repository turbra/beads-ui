import { createServer } from 'node:http';
import { afterEach, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import { createSubscriptionIssueStore } from '../app/data/subscription-issue-store.js';
import { fetchListForSubscription } from './list-adapters.js';
import { attachWsServer, scheduleListRefresh } from './ws.js';

vi.mock('./list-adapters.js', () => ({
  fetchListForSubscription: vi.fn()
}));

const mockedFetch = /** @type {import('vitest').Mock} */ (
  fetchListForSubscription
);

/** @type {Array<() => Promise<void>>} */
const cleanups = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

/**
 * @param {WebSocket} socket
 * @param {(message: any) => boolean} predicate
 */
function waitForMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('timed out waiting for WebSocket message'));
    }, 5000);
    /** @param {Buffer} data */
    function onMessage(data) {
      const message = JSON.parse(String(data));
      if (!predicate(message)) {
        return;
      }
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(message);
    }
    socket.on('message', onMessage);
  });
}

/**
 * @param {WebSocket} socket
 * @returns {Promise<void>}
 */
function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

/**
 * @param {ReturnType<typeof createServer>} server
 * @returns {Promise<void>}
 */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

/**
 * @param {ReturnType<typeof createServer>} server
 * @returns {Promise<void>}
 */
function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * @param {WebSocket} socket
 * @returns {Promise<void>}
 */
function closeSocket(socket) {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    socket.once('close', () => resolve());
    socket.close();
  });
}

/**
 * @param {number} count
 */
function issues(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `I-${String(index + 1).padStart(3, '0')}`,
    title: `Issue ${index + 1}`,
    status: 'open',
    priority: index % 5,
    created_at: index,
    updated_at: index + 1,
    closed_at: null
  }));
}

describe('server and client delta integration', () => {
  test('delivers one atomic capable update beside complete legacy fallback', async () => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({ ok: true, items: [], truncated: false });
    const server = createServer();
    const runtime = attachWsServer(server, {
      heartbeat_ms: 60_000,
      refresh_debounce_ms: 0
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected TCP server address');
    }
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    cleanups.push(async () => {
      await closeSocket(socket);
      runtime.wss.close();
      await closeServer(server);
    });
    await waitForOpen(socket);

    const sort = vi.fn((a, b) => String(a.id).localeCompare(String(b.id)));
    const capable_store = createSubscriptionIssueStore('capable', { sort });
    const legacy_store = createSubscriptionIssueStore('legacy');
    const capable_listener = vi.fn();
    capable_store.subscribe(capable_listener);
    /** @type {Array<{ encoded: string, message: any }>} */
    const received = [];
    socket.on('message', (data) => {
      const encoded = String(data);
      const message = JSON.parse(encoded);
      received.push({ encoded, message });
      if (
        message.type === 'snapshot' ||
        message.type === 'upsert' ||
        message.type === 'delete' ||
        message.type === 'delta'
      ) {
        capable_store.applyPush(message.payload);
        legacy_store.applyPush(message.payload);
      }
    });

    const capable_ack = waitForMessage(
      socket,
      (message) => message.id === 'req-capable'
    );
    socket.send(
      JSON.stringify({
        id: 'req-capable',
        type: 'subscribe-list',
        payload: {
          id: 'capable',
          type: 'all-issues',
          capabilities: ['subscription-delta-v1']
        }
      })
    );
    await capable_ack;

    const legacy_ack = waitForMessage(
      socket,
      (message) => message.id === 'req-legacy'
    );
    socket.send(
      JSON.stringify({
        id: 'req-legacy',
        type: 'subscribe-list',
        payload: { id: 'legacy', type: 'all-issues' }
      })
    );
    await legacy_ack;
    await Promise.resolve();

    const capable_snapshot_index = received.findIndex(
      ({ message }) =>
        message.type === 'snapshot' && message.payload.id === 'capable'
    );
    const capable_ack_index = received.findIndex(
      ({ message }) => message.id === 'req-capable'
    );
    expect(capable_snapshot_index).toBeGreaterThanOrEqual(0);
    expect(capable_snapshot_index).toBeLessThan(capable_ack_index);

    capable_listener.mockClear();
    sort.mockClear();
    received.length = 0;
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      items: issues(100),
      truncated: false
    });

    const final_legacy_update = waitForMessage(
      socket,
      (message) =>
        message.type === 'upsert' &&
        message.payload.id === 'legacy' &&
        message.payload.issue.id === 'I-100'
    );
    await Promise.all([scheduleListRefresh(), final_legacy_update]);
    await Promise.resolve();

    const capable_frames = received.filter(
      ({ message }) => message.payload?.id === 'capable'
    );
    const legacy_frames = received.filter(
      ({ message }) => message.payload?.id === 'legacy'
    );
    expect(capable_frames).toHaveLength(1);
    expect(capable_frames[0].message.type).toBe('delta');
    expect(capable_frames[0].message.payload.upserts).toHaveLength(100);
    expect(legacy_frames).toHaveLength(100);
    expect(
      legacy_frames.every(({ message }) => message.type === 'upsert')
    ).toBe(true);
    expect(capable_listener).toHaveBeenCalledTimes(1);
    // The focused store test instruments the two-item comparator to prove one
    // sort. Here the comparator runs within that single 100-item sort pass.
    expect(sort).toHaveBeenCalled();
    expect(sort.mock.calls.length).toBeLessThan(200);
    expect(capable_store.snapshot()).toHaveLength(100);
    expect(legacy_store.snapshot()).toHaveLength(100);

    const capable_bytes = Buffer.byteLength(capable_frames[0].encoded, 'utf8');
    const legacy_bytes = legacy_frames.reduce(
      (total, frame) => total + Buffer.byteLength(frame.encoded, 'utf8'),
      0
    );
    expect(capable_bytes).toBeLessThan(legacy_bytes);
  });
});
