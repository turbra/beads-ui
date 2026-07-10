import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runBd } from './bd.js';
import { fetchListForSubscription } from './list-adapters.js';
import { keyOf, registry } from './subscriptions.js';
import { attachWsServer, handleMessage } from './ws.js';

vi.mock('./bd.js', () => ({
  getGitUserName: vi.fn(),
  runBd: vi.fn(),
  runBdJson: vi.fn()
}));
vi.mock('./list-adapters.js', () => ({ fetchListForSubscription: vi.fn() }));

const mockedFetch = /** @type {import('vitest').Mock} */ (
  fetchListForSubscription
);
const mockedRunBd = /** @type {import('vitest').Mock} */ (runBd);
/** @type {string[]} */
const temp_dirs = [];

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdui-workspace-'));
  fs.mkdirSync(path.join(dir, '.beads'));
  fs.writeFileSync(path.join(dir, '.beads', 'metadata.json'), '{}');
  temp_dirs.push(dir);
  return dir;
}

function makeSocket() {
  return {
    sent: /** @type {string[]} */ ([]),
    readyState: 1,
    OPEN: 1,
    /** @param {string} message */
    send(message) {
      this.sent.push(String(message));
    }
  };
}

/**
 * @param {ReturnType<typeof makeSocket>} socket
 * @param {string} root_dir
 */
async function requestWorkspaceChange(socket, root_dir) {
  await handleMessage(
    /** @type {any} */ (socket),
    Buffer.from(
      JSON.stringify({
        id: 'workspace-request',
        type: /** @type {any} */ ('set-workspace'),
        payload: { path: root_dir }
      })
    )
  );
}

/**
 * @param {ReturnType<typeof makeSocket>} socket
 * @param {string} id
 * @param {string} type
 * @param {Record<string, string | number | boolean>} [params]
 */
function subscribe(socket, id, type, params = undefined) {
  return handleMessage(
    /** @type {any} */ (socket),
    Buffer.from(
      JSON.stringify({
        id: `request-${id}`,
        type: /** @type {any} */ ('subscribe-list'),
        payload: params ? { id, type, params } : { id, type }
      })
    )
  );
}

/**
 * @param {ReturnType<typeof makeSocket>} socket
 * @param {string} id
 */
function unsubscribe(socket, id) {
  return handleMessage(
    /** @type {any} */ (socket),
    Buffer.from(
      JSON.stringify({
        id: `unsubscribe-${id}`,
        type: /** @type {any} */ ('unsubscribe-list'),
        payload: { id }
      })
    )
  );
}

function deferredFetch() {
  /** @type {(value: { ok: true, items: Array<Record<string, unknown>> }) => void} */
  let resolve = () => {};
  const promise = new Promise((promise_resolve) => {
    resolve = promise_resolve;
  });
  return { promise, resolve };
}

beforeEach(() => {
  registry.clear();
  mockedFetch.mockReset();
  mockedRunBd.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of temp_dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('workspace lifecycle', () => {
  test('notifies other clients once and lets them resubscribe', async () => {
    const initial_root = makeWorkspace();
    const next_root = makeWorkspace();
    const watcher = { path: '', rebind: vi.fn() };
    const server = createServer();
    const { wss } = attachWsServer(server, {
      path: '/ws',
      root_dir: initial_root,
      watcher
    });
    const initiator = makeSocket();
    const observer = makeSocket();
    wss.clients.add(/** @type {any} */ (initiator));
    wss.clients.add(/** @type {any} */ (observer));

    await requestWorkspaceChange(initiator, next_root);

    const initiating_messages = initiator.sent.map((message) =>
      JSON.parse(message)
    );
    const observer_messages = observer.sent.map((message) =>
      JSON.parse(message)
    );
    expect(
      initiating_messages.filter((message) => message.type === 'set-workspace')
    ).toHaveLength(1);
    expect(
      initiating_messages.filter(
        (message) => message.type === 'workspace-changed'
      )
    ).toHaveLength(0);
    expect(
      observer_messages.filter(
        (message) => message.type === 'workspace-changed'
      )
    ).toHaveLength(1);
    expect(watcher.rebind).toHaveBeenCalledWith({ root_dir: next_root });

    mockedFetch.mockResolvedValue({
      ok: true,
      items: [{ id: 'NEXT-1', updated_at: 1, closed_at: null }]
    });
    await subscribe(observer, 'tab:issues', 'all-issues');

    expect(
      observer.sent
        .map((message) => JSON.parse(message))
        .find((message) => message.type === 'snapshot').payload.issues
    ).toEqual([{ id: 'NEXT-1', updated_at: 1, closed_at: null }]);
    expect(mockedFetch).toHaveBeenLastCalledWith(
      { type: 'all-issues', params: undefined },
      expect.objectContaining({ cwd: next_root })
    );
    wss.close();
  });

  test('rejects stale ordinary, detail, and board initial fetches', async () => {
    const server = createServer();
    const first_root = makeWorkspace();
    const { setWorkspace, wss } = attachWsServer(server, {
      path: '/ws',
      root_dir: first_root
    });
    const cases = [
      { id: 'tab:issues', type: 'all-issues', params: undefined },
      {
        id: 'detail:STALE-1',
        type: 'issue-detail',
        params: { id: 'STALE-1' }
      },
      { id: 'tab:board:ready', type: 'ready-issues', params: undefined }
    ];

    for (const test_case of cases) {
      const socket = makeSocket();
      wss.clients.add(/** @type {any} */ (socket));
      const pending = deferredFetch();
      mockedFetch.mockImplementationOnce(() => pending.promise);
      const subscription = subscribe(
        socket,
        test_case.id,
        test_case.type,
        test_case.params
      );
      await Promise.resolve();
      setWorkspace(makeWorkspace());
      pending.resolve({
        ok: true,
        items: [{ id: 'STALE-1', updated_at: 1, closed_at: null }]
      });
      await subscription;

      const messages = socket.sent.map((message) => JSON.parse(message));
      expect(messages.some((message) => message.type === 'snapshot')).toBe(
        false
      );
      expect(
        messages.some((message) => message.error?.code === 'workspace_changed')
      ).toBe(true);
      expect(
        registry.get(keyOf({ type: test_case.type, params: test_case.params }))
      ).toBeNull();
    }
    wss.close();
  });

  test('attaches a same-workspace delayed fetch and schedules freshness refresh', async () => {
    vi.useFakeTimers();
    const server = createServer();
    const { scheduleListRefresh: schedule_refresh, wss } = attachWsServer(
      server,
      {
        path: '/ws',
        root_dir: makeWorkspace(),
        refresh_debounce_ms: 50
      }
    );
    const socket = makeSocket();
    wss.clients.add(/** @type {any} */ (socket));
    const delayed = deferredFetch();
    mockedFetch
      .mockImplementationOnce(() => delayed.promise)
      .mockResolvedValueOnce({
        ok: true,
        items: [{ id: 'FRESH-1', updated_at: 2, closed_at: null }]
      });
    const subscription = subscribe(socket, 'tab:issues', 'all-issues');
    await Promise.resolve();

    const missed_refresh = schedule_refresh();
    await vi.advanceTimersByTimeAsync(50);
    await missed_refresh;
    delayed.resolve({
      ok: true,
      items: [{ id: 'INITIAL-1', updated_at: 1, closed_at: null }]
    });
    await subscription;

    const initial_messages = socket.sent.map((message) => JSON.parse(message));
    expect(
      initial_messages.some(
        (message) => message.error?.code === 'workspace_changed'
      )
    ).toBe(false);
    expect(
      initial_messages.some((message) => message.type === 'snapshot')
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(50);

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    wss.emit('close');
  });

  test('newer subscribe intent wins an out-of-order fetch race', async () => {
    const server = createServer();
    const { wss } = attachWsServer(server, {
      path: '/ws',
      root_dir: makeWorkspace()
    });
    const socket = makeSocket();
    wss.clients.add(/** @type {any} */ (socket));
    const delayed = deferredFetch();
    mockedFetch
      .mockImplementationOnce(() => delayed.promise)
      .mockResolvedValueOnce({
        ok: true,
        items: [{ id: 'CURRENT-1', updated_at: 2, closed_at: null }]
      });

    const older = subscribe(socket, 'tab:issues', 'all-issues');
    await Promise.resolve();
    await subscribe(socket, 'tab:issues', 'status-issues', {
      statuses: 'open'
    });
    delayed.resolve({
      ok: true,
      items: [{ id: 'STALE-1', updated_at: 1, closed_at: null }]
    });
    await older;

    const messages = socket.sent.map((message) => JSON.parse(message));
    const snapshots = messages.filter((message) => message.type === 'snapshot');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].payload.issues[0].id).toBe('CURRENT-1');
    expect(
      messages.some(
        (message) => message.error?.code === 'subscription_superseded'
      )
    ).toBe(true);
    expect(registry.get(keyOf({ type: 'all-issues' }))).toBeNull();
    expect(
      registry.get(
        keyOf({
          type: 'status-issues',
          params: { statuses: 'open' }
        })
      )
    ).not.toBeNull();
    wss.close();
  });

  test('unsubscribe invalidates an in-flight subscribe intent', async () => {
    const server = createServer();
    const { wss } = attachWsServer(server, {
      path: '/ws',
      root_dir: makeWorkspace()
    });
    const socket = makeSocket();
    wss.clients.add(/** @type {any} */ (socket));
    const delayed = deferredFetch();
    mockedFetch.mockImplementationOnce(() => delayed.promise);

    const subscription = subscribe(socket, 'tab:issues', 'all-issues');
    await Promise.resolve();
    await unsubscribe(socket, 'tab:issues');
    delayed.resolve({
      ok: true,
      items: [{ id: 'STALE-1', updated_at: 1, closed_at: null }]
    });
    await subscription;

    const messages = socket.sent.map((message) => JSON.parse(message));
    expect(messages.some((message) => message.type === 'snapshot')).toBe(false);
    expect(
      messages.some(
        (message) => message.error?.code === 'subscription_superseded'
      )
    ).toBe(true);
    expect(registry.get(keyOf({ type: 'all-issues' }))).toBeNull();
    wss.close();
  });

  test('cancels startup and refresh timers before a later attach', async () => {
    vi.useFakeTimers();
    mockedFetch.mockResolvedValue({ ok: true, items: [] });
    const old_server = createServer();
    const {
      broadcast: old_broadcast,
      prewarmBoardCache: old_prewarm,
      scheduleListRefresh: old_schedule,
      wss: old_wss
    } = attachWsServer(old_server, {
      path: '/ws',
      root_dir: makeWorkspace(),
      prewarm_board_cache: true,
      refresh_debounce_ms: 50
    });
    const old_refresh = old_schedule();
    old_wss.emit('close');
    const next_server = createServer();
    const { wss: next_wss } = attachWsServer(next_server, {
      path: '/ws',
      root_dir: makeWorkspace()
    });
    const next_socket = makeSocket();
    next_wss.clients.add(/** @type {any} */ (next_socket));

    await old_refresh;
    await old_schedule();
    await old_prewarm();
    old_broadcast(/** @type {any} */ ('workspace-changed'), {});
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockedFetch).not.toHaveBeenCalled();
    expect(next_socket.sent).toHaveLength(0);
    next_wss.emit('close');
  });

  test('cancels a mutation gate before a later attach', async () => {
    vi.useFakeTimers();
    mockedFetch.mockResolvedValue({ ok: true, items: [] });
    mockedRunBd.mockResolvedValue({ code: 0, stdout: 'NEW-1', stderr: '' });
    const old_server = createServer();
    const { wss: old_wss } = attachWsServer(old_server, {
      path: '/ws',
      root_dir: makeWorkspace()
    });
    const socket = makeSocket();
    old_wss.clients.add(/** @type {any} */ (socket));
    await subscribe(socket, 'tab:issues', 'all-issues');
    mockedFetch.mockClear();
    await handleMessage(
      /** @type {any} */ (socket),
      Buffer.from(
        JSON.stringify({
          id: 'create',
          type: /** @type {any} */ ('create-issue'),
          payload: { title: 'New' }
        })
      )
    );
    old_wss.emit('close');
    const next_server = createServer();
    const { wss: next_wss } = attachWsServer(next_server, {
      path: '/ws',
      root_dir: makeWorkspace()
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(mockedFetch).not.toHaveBeenCalled();
    next_wss.emit('close');
  });
});
