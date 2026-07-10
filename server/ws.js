/**
 * @import { Server } from 'node:http'
 * @import { RawData, WebSocket } from 'ws'
 * @import { MessageType } from '../app/protocol.js'
 */
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { isRequest, makeError, makeOk } from '../app/protocol.js';
import { getGitUserName, runBd, runBdJson } from './bd.js';
import { resolveWorkspaceDatabase } from './db.js';
import { fetchListForSubscription } from './list-adapters.js';
import { debug } from './logging.js';
import { getAvailableWorkspaces } from './registry-watcher.js';
import { keyOf, registry } from './subscriptions.js';
import {
  SUBSCRIPTION_DELTA_CAPABILITY,
  validateSubscribeListPayload
} from './validators.js';

const log = debug('ws');

/**
 * @typedef {{ id: string, updated_at: number, closed_at: number | null } & Record<string, unknown>} SubscriptionIssue
 * @typedef {Awaited<ReturnType<typeof fetchListForSubscription>>} FetchListResult
 */

const BOARD_LIST_CLIENT_TYPES = new Map([
  ['tab:board:ready', 'ready-issues'],
  ['tab:board:in-progress', 'in-progress-issues'],
  ['tab:board:closed', 'closed-issues'],
  ['tab:board:blocked', 'blocked-issues']
]);

export const MAX_CONNECTION_SUBSCRIPTIONS = 32;
export const MAX_PUSH_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_SOCKET_BUFFERED_BYTES = 8 * 1024 * 1024;

/** @type {Map<string, { items: SubscriptionIssue[], truncated: boolean }>} */
const BOARD_LIST_CACHE = new Map();
/** @type {Map<string, Promise<FetchListResult>>} */
const BOARD_LIST_INFLIGHT = new Map();
/**
 * Short-lived caches for issue detail snapshots and comments. Entries only
 * live between database change events: both caches are cleared on
 * watcher-driven refresh, mutations, and workspace switch.
 */
/** @type {Map<string, { items: SubscriptionIssue[], truncated: boolean }>} */
const ISSUE_DETAIL_CACHE = new Map();
/** @type {Map<string, unknown>} */
const COMMENTS_CACHE = new Map();
const DETAIL_CACHE_LIMIT = 500;
/** @type {Promise<void> | null} */
let BOARD_LIST_PREWARM_PROMISE = null;
let BOARD_LIST_CACHE_GENERATION = 0;
let DETAIL_CACHE_GENERATION = 0;
let BOARD_LIST_PREWARM_ENABLED = false;
let BOARD_SUBSCRIPTION_PREWARM_GENERATION = -1;
let EVENT_SEQUENCE = 0;
let RUNTIME_GENERATION = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let STARTUP_PREWARM_TIMER = null;

/**
 * Debounced refresh scheduling for active list subscriptions.
 * A trailing window coalesces rapid change bursts into a single refresh run.
 */
/** @type {ReturnType<typeof setTimeout> | null} */
let REFRESH_TIMER = null;
let REFRESH_DEBOUNCE_MS = 75;
/** @type {Promise<void> | null} */
let REFRESH_CYCLE_PROMISE = null;
/** @type {(() => void) | null} */
let RESOLVE_REFRESH_CYCLE = null;
/** @type {Promise<void> | null} */
let REFRESH_RUNNING_PROMISE = null;
let REFRESH_DIRTY = false;

/**
 * Mutation refresh window gate. When active, watcher-driven list refresh
 * scheduling is suppressed. The gate resolves either when a watcher event
 * arrives (via scheduleListRefresh) or when a timeout elapses, at which
 * point a single refresh pass over all active list subscriptions is run.
 */
/**
 * @typedef {Object} MutationGate
 * @property {boolean} resolved
 * @property {(reason: 'watcher'|'timeout') => void} resolve
 * @property {ReturnType<typeof setTimeout>} timer
 * @property {Promise<void>} completion
 * @property {() => void} complete
 */
/** @type {MutationGate | null} */
let MUTATION_GATE = null;

/**
 * Start a mutation window gate if not already active. The gate resolves on the
 * next watcher event or after `timeout_ms`, then triggers a single refresh run
 * across all active list subscriptions. Watcher-driven refresh scheduling is
 * suppressed during the window.
 *
 * Fire-and-forget; callers should not await this.
 *
 * @param {number} [timeout_ms]
 */
function triggerMutationRefreshOnce(timeout_ms = 500) {
  // Drop cached detail/comments immediately so re-subscribes during the
  // mutation window never see pre-mutation data.
  clearDetailCaches();
  if (MUTATION_GATE) {
    return;
  }
  if (REFRESH_TIMER) {
    clearTimeout(REFRESH_TIMER);
    REFRESH_TIMER = null;
  }
  /** @type {(r: 'watcher'|'timeout') => void} */
  let doResolve = () => {};
  const p = new Promise((resolve) => {
    doResolve = resolve;
  });
  /** @type {(value?: void | PromiseLike<void>) => void} */
  let resolve_completion = () => {};
  const completion = new Promise((resolve) => {
    resolve_completion = resolve;
  });
  const runtime_generation = RUNTIME_GENERATION;
  MUTATION_GATE = {
    resolved: false,
    resolve: (reason) => {
      if (!MUTATION_GATE || MUTATION_GATE.resolved) {
        return;
      }
      MUTATION_GATE.resolved = true;
      try {
        doResolve(reason);
      } catch {
        // ignore resolve errors
      }
    },
    timer: setTimeout(() => {
      try {
        MUTATION_GATE?.resolve('timeout');
      } catch {
        // ignore
      }
    }, timeout_ms),
    completion,
    complete: resolve_completion
  };
  MUTATION_GATE.timer.unref?.();

  // After resolution, run a single refresh across active subs and clear gate
  void p.then(async () => {
    log('mutation window resolved → refresh active subs');
    try {
      if (runtime_generation !== RUNTIME_GENERATION) {
        return;
      }
      try {
        if (MUTATION_GATE?.timer) {
          clearTimeout(MUTATION_GATE.timer);
        }
      } catch {
        // ignore
      }
      MUTATION_GATE = null;
      await queueListRefresh(true);
    } catch {
      // ignore refresh errors
    } finally {
      resolve_completion();
    }
  });
}

/**
 * Collect unique active list subscription specs across all connected clients.
 *
 * @returns {Array<{ type: string, params?: Record<string,string|number|boolean> }>}
 */
function collectActiveListSpecs() {
  /** @type {Array<{ type: string, params?: Record<string,string|number|boolean> }>} */
  const specs = [];
  /** @type {Set<string>} */
  const seen = new Set();
  const wss = CURRENT_WSS;
  if (!wss) {
    return specs;
  }
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) {
      continue;
    }
    const s = ensureSubs(/** @type {any} */ (ws));
    if (!s.list_subs) {
      continue;
    }
    for (const { key, spec } of s.list_subs.values()) {
      if (!seen.has(key)) {
        seen.add(key);
        specs.push(spec);
      }
    }
  }
  return specs;
}

/**
 * Run refresh for all active list subscription specs and publish deltas.
 */
async function refreshAllActiveListSubscriptions() {
  clearBoardListCache();
  const specs = collectActiveListSpecs();
  // Run refreshes concurrently; locking is handled per key in the registry
  await Promise.all(
    specs.map(async (spec) => {
      try {
        await refreshAndPublish(spec);
      } catch {
        // ignore refresh errors per spec
      }
    })
  );
}

/**
 * Schedule a coalesced refresh of all active list subscriptions.
 *
 * @returns {Promise<void>}
 */
export function scheduleListRefresh() {
  // Suppress watcher-driven refreshes during an active mutation gate; resolve gate once
  if (MUTATION_GATE) {
    try {
      MUTATION_GATE.resolve('watcher');
    } catch {
      // ignore
    }
    return MUTATION_GATE.completion;
  }
  return queueListRefresh(false);
}

/**
 * Queue one refresh cycle. Calls during the debounce reset it; calls during an
 * active run mark one immediate trailing pass.
 *
 * @param {boolean} immediate
 * @returns {Promise<void>}
 */
function queueListRefresh(immediate) {
  if (REFRESH_RUNNING_PROMISE) {
    REFRESH_DIRTY = true;
    return REFRESH_CYCLE_PROMISE || REFRESH_RUNNING_PROMISE;
  }
  if (!REFRESH_CYCLE_PROMISE) {
    REFRESH_CYCLE_PROMISE = new Promise((resolve) => {
      RESOLVE_REFRESH_CYCLE = resolve;
    });
  }
  if (REFRESH_TIMER) {
    clearTimeout(REFRESH_TIMER);
  }
  const runtime_generation = RUNTIME_GENERATION;
  REFRESH_TIMER = setTimeout(
    () => {
      REFRESH_TIMER = null;
      if (runtime_generation !== RUNTIME_GENERATION) {
        return;
      }
      REFRESH_RUNNING_PROMISE = runRefreshCycle(runtime_generation).finally(
        () => {
          if (runtime_generation !== RUNTIME_GENERATION) {
            return;
          }
          REFRESH_RUNNING_PROMISE = null;
          const resolve_cycle = RESOLVE_REFRESH_CYCLE;
          RESOLVE_REFRESH_CYCLE = null;
          REFRESH_CYCLE_PROMISE = null;
          resolve_cycle?.();
        }
      );
    },
    immediate ? 0 : REFRESH_DEBOUNCE_MS
  );
  REFRESH_TIMER.unref?.();
  return REFRESH_CYCLE_PROMISE;
}

/**
 * Run the active refresh and any single dirty trailing pass.
 *
 * @param {number} runtime_generation
 */
async function runRefreshCycle(runtime_generation) {
  do {
    REFRESH_DIRTY = false;
    await refreshAllActiveListSubscriptions();
  } while (REFRESH_DIRTY && runtime_generation === RUNTIME_GENERATION);
}

/**
 * @typedef {{
 *   show_id?: string | null,
 *   list_subs?: Map<string, { key: string, spec: { type: string, params?: Record<string, string | number | boolean> }, capabilities: string[], intent: number }>,
 *   list_revisions?: Map<string, number>,
 *   subscribe_intents?: Map<string, number>,
 *   pending_subscriptions?: Map<string, number>
 * }} ConnectionSubs
 */

/** @type {WeakMap<WebSocket, any>} */
const SUBS = new WeakMap();

/** @type {WebSocketServer | null} */
let CURRENT_WSS = null;

/**
 * Current workspace configuration.
 *
 * @type {{ root_dir: string, db_path: string } | null}
 */
let CURRENT_WORKSPACE = null;

/**
 * Reference to the database watcher for rebinding on workspace change.
 *
 * @type {{ rebind: (opts?: { root_dir?: string }) => void, path: string } | null}
 */
let DB_WATCHER = null;

/**
 * Get or initialize the subscription state for a socket.
 *
 * @param {WebSocket} ws
 * @returns {any}
 */
function ensureSubs(ws) {
  let s = SUBS.get(ws);
  if (!s) {
    s = {
      show_id: null,
      list_subs: new Map(),
      list_revisions: new Map(),
      subscribe_intents: new Map(),
      pending_subscriptions: new Map()
    };
    SUBS.set(ws, s);
  }
  return s;
}

/**
 * Supersede prior subscribe or unsubscribe work for a client-chosen id.
 *
 * @param {WebSocket} ws
 * @param {string} client_id
 */
function nextSubscribeIntent(ws, client_id) {
  const s = ensureSubs(ws);
  const intents = s.subscribe_intents || new Map();
  s.subscribe_intents = intents;
  const intent = (intents.get(client_id) || 0) + 1;
  intents.set(client_id, intent);
  return intent;
}

/**
 * @param {WebSocket} ws
 * @param {string} client_id
 * @param {number} intent
 */
function isSubscribeIntentCurrent(ws, client_id, intent) {
  return ensureSubs(ws).subscribe_intents?.get(client_id) === intent;
}

/**
 * Reserve a distinct client subscription id before starting its initial fetch.
 * Replacing the same id transfers the existing reservation to the new intent.
 *
 * @param {WebSocket} ws
 * @param {string} client_id
 * @returns {number | null}
 */
function beginSubscribeIntent(ws, client_id) {
  const s = ensureSubs(ws);
  const active = s.list_subs || new Map();
  const pending = s.pending_subscriptions || new Map();
  s.list_subs = active;
  s.pending_subscriptions = pending;

  if (!active.has(client_id) && !pending.has(client_id)) {
    /** @type {Set<string>} */
    const reserved_ids = new Set([...active.keys(), ...pending.keys()]);
    if (reserved_ids.size >= MAX_CONNECTION_SUBSCRIPTIONS) {
      return null;
    }
  }

  const intent = nextSubscribeIntent(ws, client_id);
  pending.set(client_id, intent);
  return intent;
}

/**
 * Release only the reservation owned by this exact pending intent.
 *
 * @param {WebSocket} ws
 * @param {string} client_id
 * @param {number} intent
 */
function finishSubscribeIntent(ws, client_id, intent) {
  const pending = ensureSubs(ws).pending_subscriptions;
  if (pending?.get(client_id) === intent) {
    pending.delete(client_id);
  }
}

/**
 * Return whether another active id on this connection references a key.
 *
 * @param {ConnectionSubs} s
 * @param {string} key
 * @param {string} [excluded_id]
 */
function hasConnectionSubscriptionForKey(s, key, excluded_id = '') {
  const subscriptions = s.list_subs || new Map();
  for (const [client_id, subscription] of subscriptions) {
    if (client_id !== excluded_id && subscription.key === key) {
      return true;
    }
  }
  return false;
}

/**
 * Remove an active id and detach the socket only when no sibling id uses the key.
 *
 * @param {WebSocket} ws
 * @param {string} client_id
 * @param {number} [expected_intent]
 */
function detachClientSubscription(ws, client_id, expected_intent) {
  const s = ensureSubs(ws);
  const subscription = s.list_subs?.get(client_id);
  if (!subscription) {
    return false;
  }
  if (
    expected_intent !== undefined &&
    subscription.intent !== expected_intent
  ) {
    return false;
  }
  s.list_subs?.delete(client_id);
  if (!hasConnectionSubscriptionForKey(s, subscription.key)) {
    registry.detach(subscription.spec, ws);
  }
  return true;
}

/**
 * @param {WebSocket} ws
 */
function isSocketOpen(ws) {
  return ws.readyState === ws.OPEN;
}

/**
 * Get next monotonically increasing revision for a subscription key on this connection.
 *
 * @param {WebSocket} ws
 * @param {string} key
 */
function nextListRevision(ws, key) {
  const s = ensureSubs(ws);
  const m = s.list_revisions || new Map();
  s.list_revisions = m;
  const prev = m.get(key) || 0;
  const next = prev + 1;
  m.set(key, next);
  return next;
}

/**
 * @param {WebSocket} ws
 * @param {string} key
 */
function currentListRevision(ws, key) {
  return ensureSubs(ws).list_revisions?.get(key) || 0;
}

/**
 * Restore a revision reserved for an initial snapshot that was not enqueued.
 * The per-key registry lock prevents a concurrent event from using the value.
 *
 * @param {WebSocket} ws
 * @param {string} key
 * @param {number} revision
 */
function restoreListRevision(ws, key, revision) {
  const revisions = ensureSubs(ws).list_revisions;
  if (!revisions) {
    return;
  }
  if (revision === 0) {
    revisions.delete(key);
  } else {
    revisions.set(key, revision);
  }
}

/** @typedef {{ encoded: string, bytes: number }} PreparedPushFrame */

/**
 * Encode one push envelope and retain its exact wire size.
 *
 * @param {'snapshot'|'upsert'|'delete'|'delta'} type
 * @param {Record<string, unknown>} payload
 * @returns {PreparedPushFrame}
 */
function preparePushFrame(type, payload) {
  const encoded = JSON.stringify({
    id: nextEventId(),
    ok: true,
    type: /** @type {MessageType} */ (type),
    payload
  });
  return { encoded, bytes: Buffer.byteLength(encoded, 'utf8') };
}

/**
 * @param {WebSocket} ws
 * @param {PreparedPushFrame[]} frames
 */
function assertPushCapacity(ws, frames) {
  let total_bytes = 0;
  for (const frame of frames) {
    if (frame.bytes > MAX_PUSH_FRAME_BYTES) {
      throw resourceLimitError('Encoded push frame exceeds the 8 MiB limit');
    }
    total_bytes += frame.bytes;
  }
  const buffered_amount = Number(ws.bufferedAmount) || 0;
  if (buffered_amount + total_bytes > MAX_SOCKET_BUFFERED_BYTES) {
    throw resourceLimitError('Socket push buffer would exceed the 8 MiB limit');
  }
}

/**
 * @param {string} message
 */
function resourceLimitError(message) {
  const error = new Error(message);
  // @ts-expect-error structured transport error
  error.code = 'resource_limit';
  return error;
}

/**
 * Preflight the complete delivery set before enqueuing its first frame.
 *
 * @param {WebSocket} ws
 * @param {PreparedPushFrame[]} frames
 */
function sendPreparedPushFrames(ws, frames) {
  assertPushCapacity(ws, frames);
  for (const frame of frames) {
    ws.send(frame.encoded);
  }
}

/**
 * Close a lagging connection so its reconnect starts from a fresh snapshot.
 *
 * @param {WebSocket} ws
 * @param {unknown} err
 */
function closeForBackpressure(ws, err) {
  log('closing lagging subscription connection: %o', err);
  try {
    ws.close(1013, 'subscription backpressure');
  } catch {
    try {
      ws.terminate();
    } catch {
      // ignore close failures
    }
  }
}

/**
 * @param {WebSocket} ws
 * @param {string} client_id
 * @param {string} key
 * @param {Array<Record<string, unknown>>} issues
 * @param {boolean} truncated
 */
function prepareSubscriptionSnapshot(ws, client_id, key, issues, truncated) {
  return preparePushFrame('snapshot', {
    type: 'snapshot',
    id: client_id,
    revision: nextListRevision(ws, key),
    issues,
    truncated
  });
}

/**
 * Build the complete refresh delivery for one socket and one registry key.
 *
 * @param {WebSocket} ws
 * @param {string} key
 * @param {Array<[string, { capabilities: string[] }]>} subscriptions
 * @param {string[]} changed_ids
 * @param {string[]} removed_ids
 * @param {Map<string, Record<string, unknown>>} by_id
 */
function prepareSubscriptionChanges(
  ws,
  key,
  subscriptions,
  changed_ids,
  removed_ids,
  by_id
) {
  /** @type {PreparedPushFrame[]} */
  const frames = [];
  const total_changes = changed_ids.length + removed_ids.length;
  for (const [client_id, subscription] of subscriptions) {
    if (
      total_changes >= 2 &&
      subscription.capabilities.includes(SUBSCRIPTION_DELTA_CAPABILITY)
    ) {
      const upserts = changed_ids
        .map((issue_id) => by_id.get(issue_id))
        .filter((issue) => issue !== undefined);
      frames.push(
        preparePushFrame('delta', {
          type: 'delta',
          id: client_id,
          revision: nextListRevision(ws, key),
          upserts,
          deletes: removed_ids
        })
      );
      continue;
    }
    for (const issue_id of changed_ids) {
      const issue = by_id.get(issue_id);
      if (issue) {
        frames.push(
          preparePushFrame('upsert', {
            type: 'upsert',
            id: client_id,
            revision: nextListRevision(ws, key),
            issue
          })
        );
      }
    }
    for (const issue_id of removed_ids) {
      frames.push(
        preparePushFrame('delete', {
          type: 'delete',
          id: client_id,
          revision: nextListRevision(ws, key),
          issue_id
        })
      );
    }
  }
  return frames;
}

// issues-changed removed in v2: detail and lists are pushed via subscriptions

/**
 * Refresh a subscription spec: fetch via adapter, apply to registry and emit
 * per-subscription full-issue envelopes to subscribers. Serialized per key.
 *
 * @param {{ type: string, params?: Record<string, string|number|boolean> }} spec
 */
async function refreshAndPublish(spec) {
  const key = keyOf(spec);
  await registry.withKeyLock(key, async () => {
    const generation = BOARD_LIST_CACHE_GENERATION;
    const detail_generation = DETAIL_CACHE_GENERATION;
    // Detail refreshes update an open dialog; keep them ahead of list refreshes
    const is_detail = String(spec.type) === 'issue-detail';
    const res = await fetchListForSubscription(spec, {
      cwd: CURRENT_WORKSPACE?.root_dir,
      priority: is_detail ? 'interactive' : 'background'
    });
    if (!res.ok) {
      log('refresh failed for %s: %s %o', key, res.error.message, res.error);
      return;
    }
    if (
      generation !== BOARD_LIST_CACHE_GENERATION ||
      (is_detail && detail_generation !== DETAIL_CACHE_GENERATION)
    ) {
      log('discarding stale refresh result for %s', key);
      return;
    }
    const items = applyClosedIssuesFilter(spec, res.items);
    const truncated = res.truncated === true;
    populateBoardListCache(spec, items, generation, truncated);
    if (is_detail) {
      populateIssueDetailCache(spec, items, detail_generation, truncated);
    }
    const previous_entry = registry.get(key);
    const was_initialized = previous_entry?.initialized === true;
    const previous_truncated = previous_entry?.truncated === true;
    const delta = registry.applyItems(key, items);
    const entry = registry.get(key);
    if (!entry) {
      return;
    }
    entry.truncated = truncated;
    if (entry.subscribers.size === 0) {
      return;
    }
    /** @type {Map<string, any>} */
    const by_id = new Map();
    for (const it of items) {
      if (it && typeof it.id === 'string') {
        by_id.set(it.id, it);
      }
    }
    for (const ws of entry.subscribers) {
      if (!isSocketOpen(ws)) {
        continue;
      }
      const s = ensureSubs(ws);
      const subs = s.list_subs || new Map();
      /** @type {Array<[string, { capabilities: string[] }]>} */
      const client_subscriptions = [];
      for (const [cid, v] of subs.entries()) {
        if (v.key === key) {
          client_subscriptions.push([cid, v]);
        }
      }
      if (client_subscriptions.length === 0) {
        continue;
      }
      try {
        /** @type {PreparedPushFrame[]} */
        let frames = [];
        if (!was_initialized || previous_truncated !== truncated) {
          frames = client_subscriptions.map(([client_id]) =>
            prepareSubscriptionSnapshot(ws, client_id, key, items, truncated)
          );
        } else {
          const changed_ids = [...delta.added, ...delta.updated].sort();
          const removed_ids = delta.removed.slice().sort();
          if (changed_ids.length + removed_ids.length === 0) {
            continue;
          }
          frames = prepareSubscriptionChanges(
            ws,
            key,
            client_subscriptions,
            changed_ids,
            removed_ids,
            by_id
          );
        }
        sendPreparedPushFrames(ws, frames);
      } catch (err) {
        closeForBackpressure(ws, err);
      }
    }
  });
}

/**
 * Apply pre-diff filtering for closed-issues lists based on spec.params.since (epoch ms).
 *
 * @param {{ type: string, params?: Record<string, string|number|boolean> }} spec
 * @param {Array<{ id: string, updated_at: number, closed_at: number | null } & Record<string, unknown>>} items
 */
function applyClosedIssuesFilter(spec, items) {
  if (String(spec.type) !== 'closed-issues') {
    return items;
  }
  const p = spec.params || {};
  const since = typeof p.since === 'number' ? p.since : 0;
  if (!Number.isFinite(since) || since <= 0) {
    return items;
  }
  /** @type {typeof items} */
  const out = [];
  for (const it of items) {
    const ca = it.closed_at;
    if (typeof ca === 'number' && Number.isFinite(ca) && ca >= since) {
      out.push(it);
    }
  }
  return out;
}

/**
 * @param {{ type: string, params?: Record<string, string|number|boolean> }} spec
 */
function isCacheableBoardListSpec(spec) {
  const type = String(spec.type || '');
  if (
    type === 'ready-issues' ||
    type === 'in-progress-issues' ||
    type === 'blocked-issues'
  ) {
    return true;
  }
  if (type !== 'closed-issues') {
    return false;
  }
  const since = spec.params?.since;
  return typeof since === 'number' && Number.isFinite(since) && since > 0;
}

/**
 * @param {string} client_id
 * @param {{ type: string, params?: Record<string, string|number|boolean> }} spec
 */
function isBoardListSubscription(client_id, spec) {
  const expected_type = BOARD_LIST_CLIENT_TYPES.get(client_id);
  return (
    expected_type === String(spec.type || '') && isCacheableBoardListSpec(spec)
  );
}

/**
 * @param {{ type: string, params?: Record<string, string|number|boolean> }} spec
 */
function boardListCacheKey(spec) {
  const root_dir = CURRENT_WORKSPACE?.root_dir || '';
  const db_path = CURRENT_WORKSPACE?.db_path || '';
  return `${root_dir}\0${db_path}\0${keyOf(spec)}`;
}

function clearBoardListCache() {
  BOARD_LIST_CACHE.clear();
  BOARD_LIST_INFLIGHT.clear();
  BOARD_LIST_PREWARM_PROMISE = null;
  BOARD_LIST_CACHE_GENERATION += 1;
  clearDetailCaches();
}

/**
 * Clear issue-detail and comments caches. Called whenever the database may
 * have changed (mutations, watcher-driven refresh, workspace switch).
 */
function clearDetailCaches() {
  ISSUE_DETAIL_CACHE.clear();
  COMMENTS_CACHE.clear();
  DETAIL_CACHE_GENERATION += 1;
}

/**
 * Options for bd commands that must run in the selected workspace, not
 * necessarily the daemon process cwd.
 *
 * @param {{ priority?: 'interactive' | 'background' }} [options]
 */
function selectedWorkspaceBdOptions(options = {}) {
  return {
    cwd: CURRENT_WORKSPACE?.root_dir,
    ...options
  };
}

/**
 * Extract one canonical issue object from `bd update --json` or `bd show`
 * output. Current bd returns update results as a one-item array while older
 * versions may return the object directly.
 *
 * @param {unknown} value
 * @param {string} issue_id
 */
function extractCanonicalIssue(value, issue_id) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return String(/** @type {any} */ (value).id || '') === issue_id
      ? value
      : null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  return (
    value.find(
      (issue) =>
        issue &&
        typeof issue === 'object' &&
        String(/** @type {any} */ (issue).id || '') === issue_id
    ) || null
  );
}

/**
 * @param {string | undefined} stderr
 */
function rejectsJsonFlag(stderr) {
  const message = String(stderr || '');
  return (
    /(?:unknown|unrecognized|unsupported).*(?:flag|option).*--json/i.test(
      message
    ) || /--json.*(?:unknown|unrecognized|unsupported)/i.test(message)
  );
}

/**
 * Run a field update and return its canonical issue while retaining a bounded
 * compatibility path for bd versions that do not support update JSON output.
 *
 * @param {string[]} args
 * @param {string} issue_id
 * @param {{ cwd?: string, priority?: 'interactive' | 'background' }} options
 * @returns {Promise<{ code: number, stdoutJson?: unknown, stderr?: string }>}
 */
async function runCanonicalUpdate(args, issue_id, options) {
  const json_result = await runBdJson([...args, '--json'], options);
  if (json_result.code === 0) {
    const issue = extractCanonicalIssue(json_result.stdoutJson, issue_id);
    if (issue) {
      return { code: 0, stdoutJson: issue };
    }
  } else if (!rejectsJsonFlag(json_result.stderr)) {
    return json_result;
  } else {
    const legacy_result = await runBd(args, options);
    if (legacy_result.code !== 0) {
      return legacy_result;
    }
  }

  const shown = await runBdJson(['show', issue_id, '--json'], options);
  if (shown.code !== 0) {
    return shown;
  }
  const issue = extractCanonicalIssue(shown.stdoutJson, issue_id);
  return issue
    ? { code: 0, stdoutJson: issue }
    : { code: 1, stderr: 'bd returned no canonical issue' };
}

/**
 * @param {string} issue_id
 */
function issueDetailCacheKey(issue_id) {
  const root_dir = CURRENT_WORKSPACE?.root_dir || '';
  const db_path = CURRENT_WORKSPACE?.db_path || '';
  return `${root_dir}\0${db_path}\0${issue_id}`;
}

/**
 * @param {Map<string, unknown>} cache
 * @param {number} limit
 */
function evictOldestCacheEntry(cache, limit) {
  if (cache.size <= limit) {
    return;
  }
  const oldest_key = cache.keys().next().value;
  if (oldest_key !== undefined) {
    cache.delete(oldest_key);
  }
}

/**
 * @param {{ type: string, params?: Record<string, string|number|boolean> }} spec
 * @param {SubscriptionIssue[]} items
 * @param {number} generation
 * @param {boolean} truncated
 */
function populateIssueDetailCache(spec, items, generation, truncated = false) {
  if (generation !== DETAIL_CACHE_GENERATION) {
    return;
  }
  const issue_id = String(spec.params?.id || '').trim();
  if (issue_id.length === 0) {
    return;
  }
  ISSUE_DETAIL_CACHE.set(issueDetailCacheKey(issue_id), {
    items: items.slice(),
    truncated
  });
  evictOldestCacheEntry(ISSUE_DETAIL_CACHE, DETAIL_CACHE_LIMIT);
}

/**
 * Serve an issue-detail snapshot from cache when available, fetching and
 * caching it otherwise.
 *
 * @param {{ type: string, params?: Record<string, string|number|boolean> }} spec
 * @returns {Promise<FetchListResult>}
 */
async function fetchCachedIssueDetail(spec) {
  const issue_id = String(spec.params?.id || '').trim();
  if (issue_id.length === 0) {
    return fetchListForSubscription(spec, {
      cwd: CURRENT_WORKSPACE?.root_dir
    });
  }
  const cached = ISSUE_DETAIL_CACHE.get(issueDetailCacheKey(issue_id));
  if (cached) {
    return {
      ok: true,
      items: cached.items.slice(),
      truncated: cached.truncated
    };
  }
  const generation = DETAIL_CACHE_GENERATION;
  const res = await fetchListForSubscription(spec, {
    cwd: CURRENT_WORKSPACE?.root_dir
  });
  if (res.ok) {
    populateIssueDetailCache(
      spec,
      res.items,
      generation,
      res.truncated === true
    );
  }
  return res;
}

/**
 * @param {{ type: string, params?: Record<string, string|number|boolean> }} spec
 * @param {SubscriptionIssue[]} items
 * @param {number} generation
 * @param {boolean} truncated
 */
function populateBoardListCache(spec, items, generation, truncated = false) {
  if (
    generation !== BOARD_LIST_CACHE_GENERATION ||
    !isCacheableBoardListSpec(spec)
  ) {
    return;
  }
  BOARD_LIST_CACHE.set(boardListCacheKey(spec), {
    items: items.slice(),
    truncated
  });
}

/**
 * @param {FetchListResult} res
 * @returns {FetchListResult}
 */
function cloneListResult(res) {
  if (!res.ok) {
    return res;
  }
  return {
    ok: true,
    items: res.items.slice(),
    truncated: res.truncated === true
  };
}

/**
 * @param {{ type: string, params?: Record<string, string|number|boolean> }} spec
 * @param {{ priority?: 'interactive' | 'background' }} [options]
 * @returns {Promise<FetchListResult>}
 */
async function fetchCachedBoardListSubscription(spec, options = {}) {
  const cache_key = boardListCacheKey(spec);
  const cached = BOARD_LIST_CACHE.get(cache_key);
  if (cached) {
    return {
      ok: true,
      items: cached.items.slice(),
      truncated: cached.truncated
    };
  }
  const inflight = BOARD_LIST_INFLIGHT.get(cache_key);
  if (inflight) {
    return cloneListResult(await inflight);
  }

  const generation = BOARD_LIST_CACHE_GENERATION;
  const pending = fetchListForSubscription(spec, {
    cwd: CURRENT_WORKSPACE?.root_dir,
    priority: options.priority
  }).then((res) => {
    if (!res.ok) {
      return res;
    }
    const items = applyClosedIssuesFilter(spec, res.items).slice();
    const truncated = res.truncated === true;
    populateBoardListCache(spec, items, generation, truncated);
    return /** @type {FetchListResult} */ ({ ok: true, items, truncated });
  });
  BOARD_LIST_INFLIGHT.set(cache_key, pending);
  try {
    return cloneListResult(await pending);
  } finally {
    if (BOARD_LIST_INFLIGHT.get(cache_key) === pending) {
      BOARD_LIST_INFLIGHT.delete(cache_key);
    }
  }
}

/**
 * @param {string} client_id
 * @param {{ type: string, params?: Record<string, string|number|boolean> }} spec
 * @returns {Promise<FetchListResult>}
 */
async function fetchInitialListForSubscription(client_id, spec) {
  if (isBoardListSubscription(client_id, spec)) {
    return fetchCachedBoardListSubscription(spec);
  }
  if (String(spec.type) === 'issue-detail') {
    return fetchCachedIssueDetail(spec);
  }
  return fetchListForSubscription(spec, {
    cwd: CURRENT_WORKSPACE?.root_dir
  });
}

/** Capture all state that makes an initial subscription result current. */
function captureInitialSubscriptionGeneration() {
  return {
    runtime: RUNTIME_GENERATION,
    board_cache: BOARD_LIST_CACHE_GENERATION,
    detail_cache: DETAIL_CACHE_GENERATION,
    root_dir: CURRENT_WORKSPACE?.root_dir || '',
    db_path: CURRENT_WORKSPACE?.db_path || ''
  };
}

/**
 * @param {ReturnType<typeof captureInitialSubscriptionGeneration>} generation
 */
function isInitialSubscriptionIdentityCurrent(generation) {
  return (
    generation.runtime === RUNTIME_GENERATION &&
    generation.root_dir === (CURRENT_WORKSPACE?.root_dir || '') &&
    generation.db_path === (CURRENT_WORKSPACE?.db_path || '')
  );
}

/**
 * Cache invalidation does not invalidate a same-workspace snapshot, but it does
 * require a trailing refresh because the invalidating pass may not have seen
 * the subscription before it attached.
 *
 * @param {{ type: string }} spec
 * @param {ReturnType<typeof captureInitialSubscriptionGeneration>} generation
 */
function didRelevantInitialCacheGenerationChange(spec, generation) {
  return String(spec.type) === 'issue-detail'
    ? generation.detail_cache !== DETAIL_CACHE_GENERATION
    : generation.board_cache !== BOARD_LIST_CACHE_GENERATION;
}

async function prewarmBoardListCache() {
  /** @type {{ priority: 'background' }} */
  const opts = { priority: 'background' };
  await Promise.all([
    fetchCachedBoardListSubscription({ type: 'ready-issues' }, opts),
    fetchCachedBoardListSubscription({ type: 'in-progress-issues' }, opts),
    fetchCachedBoardListSubscription({ type: 'blocked-issues' }, opts)
  ]);
}

function scheduleBoardListPrewarm() {
  if (BOARD_LIST_PREWARM_PROMISE) {
    return BOARD_LIST_PREWARM_PROMISE;
  }
  const pending = prewarmBoardListCache()
    .catch((err) => {
      log('board list prewarm failed: %o', err);
    })
    .finally(() => {
      if (BOARD_LIST_PREWARM_PROMISE === pending) {
        BOARD_LIST_PREWARM_PROMISE = null;
      }
    });
  BOARD_LIST_PREWARM_PROMISE = pending;
  return pending;
}

/** Create a process-unique server event identifier. */
function nextEventId() {
  EVENT_SEQUENCE = (EVENT_SEQUENCE + 1) % Number.MAX_SAFE_INTEGER;
  return `evt-${Date.now()}-${EVENT_SEQUENCE}`;
}

/**
 * Broadcast an event through the currently attached server.
 *
 * @param {MessageType} type
 * @param {unknown} [payload]
 * @param {WebSocket | null} [excluded_ws]
 */
function broadcastToCurrentClients(type, payload, excluded_ws = null) {
  const wss = CURRENT_WSS;
  if (!wss) {
    return;
  }
  const msg = JSON.stringify({
    id: nextEventId(),
    ok: true,
    type,
    payload
  });
  for (const ws of wss.clients) {
    if (ws !== excluded_ws && ws.readyState === ws.OPEN) {
      ws.send(msg);
    }
  }
}

/**
 * Update the selected workspace through the single cache/watcher path.
 *
 * @param {string} new_root_dir
 * @param {WebSocket | null} [initiating_ws]
 */
function applyWorkspaceChange(new_root_dir, initiating_ws = null) {
  const resolved_root = path.resolve(new_root_dir);
  const new_db = resolveWorkspaceDatabase({ cwd: resolved_root });
  const old_path = CURRENT_WORKSPACE?.db_path || '';
  CURRENT_WORKSPACE = {
    root_dir: resolved_root,
    db_path: new_db.path
  };
  const changed = new_db.path !== old_path;
  if (changed) {
    log('workspace changed: %s → %s', old_path, new_db.path);
    DB_WATCHER?.rebind({ root_dir: resolved_root });
    registry.clear();
    clearBoardListCache();
    broadcastToCurrentClients(
      'workspace-changed',
      CURRENT_WORKSPACE,
      initiating_ws
    );
    void scheduleListRefresh();
  }
  return { changed, workspace: CURRENT_WORKSPACE };
}

/**
 * Cancel global work owned by the current WebSocket server. The generation
 * guard keeps in-flight callbacks from mutating a subsequently attached one.
 *
 * @param {WebSocketServer | null} [expected_wss]
 */
function deactivateRuntime(expected_wss = null) {
  if (expected_wss && CURRENT_WSS !== expected_wss) {
    return;
  }
  RUNTIME_GENERATION += 1;
  if (STARTUP_PREWARM_TIMER) {
    clearTimeout(STARTUP_PREWARM_TIMER);
    STARTUP_PREWARM_TIMER = null;
  }
  if (REFRESH_TIMER) {
    clearTimeout(REFRESH_TIMER);
    REFRESH_TIMER = null;
  }
  RESOLVE_REFRESH_CYCLE?.();
  RESOLVE_REFRESH_CYCLE = null;
  REFRESH_CYCLE_PROMISE = null;
  REFRESH_RUNNING_PROMISE = null;
  REFRESH_DIRTY = false;
  if (MUTATION_GATE) {
    clearTimeout(MUTATION_GATE.timer);
    MUTATION_GATE.complete();
    MUTATION_GATE = null;
  }
  registry.clear();
  clearBoardListCache();
  BOARD_LIST_PREWARM_ENABLED = false;
  DB_WATCHER = null;
  CURRENT_WSS = null;
}

/**
 * Attach a WebSocket server to an existing HTTP server.
 *
 * @param {Server} http_server
 * @param {{ path?: string, heartbeat_ms?: number, refresh_debounce_ms?: number, root_dir?: string, watcher?: { rebind: (opts?: { root_dir?: string }) => void, path: string }, prewarm_board_cache?: boolean }} [options]
 * @returns {{ wss: WebSocketServer, broadcast: (type: MessageType, payload?: unknown) => void, scheduleListRefresh: () => Promise<void>, prewarmBoardCache: () => Promise<void>, setWorkspace: (root_dir: string) => { changed: boolean, workspace: { root_dir: string, db_path: string } } }}
 */
export function attachWsServer(http_server, options = {}) {
  deactivateRuntime();
  const ws_path = options.path || '/ws';

  // Initialize workspace state
  const initial_root = options.root_dir || process.cwd();
  const initial_db = resolveWorkspaceDatabase({ cwd: initial_root });
  CURRENT_WORKSPACE = {
    root_dir: initial_root,
    db_path: initial_db.path
  };
  const attached_workspace = CURRENT_WORKSPACE;
  clearBoardListCache();
  BOARD_LIST_PREWARM_ENABLED = options.prewarm_board_cache === true;

  if (options.watcher) {
    DB_WATCHER = options.watcher;
  }
  const heartbeat_ms = options.heartbeat_ms ?? 30000;
  if (typeof options.refresh_debounce_ms === 'number') {
    const n = options.refresh_debounce_ms;
    if (Number.isFinite(n) && n >= 0) {
      REFRESH_DEBOUNCE_MS = n;
    }
  }

  const wss = new WebSocketServer({ server: http_server, path: ws_path });
  CURRENT_WSS = wss;
  const runtime_generation = RUNTIME_GENERATION;

  // Heartbeat: track if client answered the last ping
  wss.on('connection', (ws) => {
    log('client connected');
    // @ts-expect-error add marker property
    ws.isAlive = true;

    // Initialize subscription state for this connection
    ensureSubs(ws);

    ws.on('pong', () => {
      // @ts-expect-error marker
      ws.isAlive = true;
    });

    ws.on('message', (data) => {
      handleMessage(ws, data);
    });

    ws.on('close', () => {
      try {
        const s = ensureSubs(ws);
        for (const client_id of s.pending_subscriptions?.keys() || []) {
          nextSubscribeIntent(ws, client_id);
        }
        s.pending_subscriptions?.clear();
        s.list_subs?.clear();
        registry.onDisconnect(ws);
      } catch {
        // ignore cleanup errors
      }
    });
  });

  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      // @ts-expect-error marker
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      // @ts-expect-error marker
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeat_ms);

  interval.unref?.();

  wss.on('close', () => {
    clearInterval(interval);
    deactivateRuntime(wss);
  });

  if (BOARD_LIST_PREWARM_ENABLED) {
    STARTUP_PREWARM_TIMER = setTimeout(() => {
      STARTUP_PREWARM_TIMER = null;
      if (runtime_generation !== RUNTIME_GENERATION) {
        return;
      }
      void scheduleBoardListPrewarm();
    }, 0);
    STARTUP_PREWARM_TIMER.unref?.();
  }

  /**
   * Broadcast a server-initiated event to all open clients.
   *
   * @param {MessageType} type
   * @param {unknown} [payload]
   */
  function broadcast(type, payload) {
    if (runtime_generation !== RUNTIME_GENERATION || CURRENT_WSS !== wss) {
      return;
    }
    broadcastToCurrentClients(type, payload);
  }

  /**
   * Change the current workspace and rebind the database watcher.
   *
   * @param {string} new_root_dir - Absolute path to the new workspace root.
   * @returns {{ changed: boolean, workspace: { root_dir: string, db_path: string } }}
   */
  function setWorkspace(new_root_dir) {
    if (runtime_generation !== RUNTIME_GENERATION || CURRENT_WSS !== wss) {
      return {
        changed: false,
        workspace: CURRENT_WORKSPACE || attached_workspace
      };
    }
    return applyWorkspaceChange(new_root_dir);
  }

  return {
    wss,
    broadcast,
    scheduleListRefresh: () =>
      runtime_generation === RUNTIME_GENERATION && CURRENT_WSS === wss
        ? scheduleListRefresh()
        : Promise.resolve(),
    prewarmBoardCache: () =>
      runtime_generation === RUNTIME_GENERATION && CURRENT_WSS === wss
        ? scheduleBoardListPrewarm()
        : Promise.resolve(),
    setWorkspace
    // v2: list subscription refresh handles updates
  };
}

/**
 * Handle an incoming message frame and respond to the same socket.
 *
 * @param {WebSocket} ws
 * @param {RawData} data
 */
export async function handleMessage(ws, data) {
  /** @type {unknown} */
  let json;
  try {
    json = JSON.parse(data.toString());
  } catch {
    const reply = {
      id: 'unknown',
      ok: false,
      type: 'bad-json',
      error: { code: 'bad_json', message: 'Invalid JSON' }
    };
    ws.send(JSON.stringify(reply));
    return;
  }

  if (!isRequest(json)) {
    log('invalid request');
    const reply = {
      id: 'unknown',
      ok: false,
      type: 'bad-request',
      error: { code: 'bad_request', message: 'Invalid request envelope' }
    };
    ws.send(JSON.stringify(reply));
    return;
  }

  const req = json;

  // Dispatch known types here as we implement them. For now, only a ping utility.
  if (req.type === /** @type {MessageType} */ ('ping')) {
    ws.send(JSON.stringify(makeOk(req, { ts: Date.now() })));
    return;
  }

  // subscribe-list: payload { id: string, type: string, params?: object }
  if (req.type === 'subscribe-list') {
    const payload_id = /** @type {any} */ (req.payload)?.id || '';
    log('subscribe-list %s', payload_id);
    const validation = validateSubscribeListPayload(
      /** @type {any} */ (req.payload || {})
    );
    if (!validation.ok) {
      ws.send(
        JSON.stringify(makeError(req, validation.code, validation.message))
      );
      return;
    }
    const client_id = validation.id;
    const spec = validation.spec;
    const capabilities = validation.capabilities;
    const key = keyOf(spec);
    const subscribe_intent = beginSubscribeIntent(ws, client_id);

    if (subscribe_intent === null) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'resource_limit',
            `A connection may reserve at most ${MAX_CONNECTION_SUBSCRIPTIONS} subscription ids`
          )
        )
      );
      return;
    }

    /**
     * Reply with an error and avoid attaching the subscription when
     * initialization fails.
     *
     * @param {string} code
     * @param {string} message
     * @param {Record<string, unknown>|undefined} details
     */
    const replyWithError = (code, message, details = undefined) => {
      ws.send(JSON.stringify(makeError(req, code, message, details)));
    };

    try {
      /** @type {FetchListResult} */
      let initial;
      const initial_generation = captureInitialSubscriptionGeneration();
      try {
        initial = await fetchInitialListForSubscription(client_id, spec);
      } catch (err) {
        log('subscribe-list snapshot error for %s: %o', key, err);
        const message =
          (err && /** @type {any} */ (err).message) || 'Failed to load list';
        replyWithError('bd_error', String(message), { key });
        return;
      }

      if (
        !isInitialSubscriptionIdentityCurrent(initial_generation) ||
        !isSubscribeIntentCurrent(ws, client_id, subscribe_intent) ||
        !isSocketOpen(ws)
      ) {
        if (isSocketOpen(ws)) {
          replyWithError(
            isInitialSubscriptionIdentityCurrent(initial_generation)
              ? 'subscription_superseded'
              : 'workspace_changed',
            isInitialSubscriptionIdentityCurrent(initial_generation)
              ? 'Subscription request was superseded'
              : 'Workspace changed while loading the subscription; retry',
            { key }
          );
        }
        return;
      }

      if (!initial.ok) {
        log(
          'initial snapshot failed for %s: %s %o',
          key,
          initial.error.message,
          initial.error
        );
        const details = { ...(initial.error.details || {}), key };
        replyWithError(initial.error.code, initial.error.message, details);
        return;
      }

      const s = ensureSubs(ws);
      const items = applyClosedIssuesFilter(spec, initial.items);
      const truncated = initial.truncated === true;
      let stale = false;
      let needs_refresh = false;

      try {
        await registry.withKeyLock(key, async () => {
          if (
            !isInitialSubscriptionIdentityCurrent(initial_generation) ||
            !isSubscribeIntentCurrent(ws, client_id, subscribe_intent) ||
            !isSocketOpen(ws)
          ) {
            stale = true;
            return;
          }

          const previous = s.list_subs?.get(client_id) || null;
          const previous_revision = currentListRevision(ws, key);
          let previous_removed = false;

          try {
            const snapshot = prepareSubscriptionSnapshot(
              ws,
              client_id,
              key,
              items,
              truncated
            );
            assertPushCapacity(ws, [snapshot]);

            if (previous) {
              previous_removed = detachClientSubscription(
                ws,
                client_id,
                previous.intent
              );
            }

            registry.attach(spec, ws);
            s.list_subs?.set(client_id, {
              key,
              spec,
              capabilities,
              intent: subscribe_intent
            });

            const entry = registry.get(key);
            if (entry && !entry.initialized) {
              registry.applyItems(key, items);
              entry.truncated = truncated;
            } else {
              needs_refresh = true;
            }

            ws.send(snapshot.encoded);
          } catch (err) {
            restoreListRevision(ws, key, previous_revision);
            detachClientSubscription(ws, client_id, subscribe_intent);
            if (previous && previous_removed) {
              registry.attach(previous.spec, ws);
              s.list_subs?.set(client_id, previous);
            }
            throw err;
          }
        });
      } catch (err) {
        log('subscribe-list snapshot error for %s: %o', key, err);
        const error_code =
          err && /** @type {any} */ (err).code === 'resource_limit'
            ? 'resource_limit'
            : 'bd_error';
        const message =
          error_code === 'resource_limit'
            ? String(/** @type {any} */ (err).message)
            : 'Failed to publish snapshot';
        replyWithError(error_code, message, { key });
        return;
      }

      if (stale) {
        if (isSocketOpen(ws)) {
          replyWithError(
            isInitialSubscriptionIdentityCurrent(initial_generation)
              ? 'subscription_superseded'
              : 'workspace_changed',
            isInitialSubscriptionIdentityCurrent(initial_generation)
              ? 'Subscription request was superseded'
              : 'Workspace changed while loading the subscription; retry',
            { key }
          );
        }
        return;
      }

      if (
        needs_refresh ||
        didRelevantInitialCacheGenerationChange(spec, initial_generation)
      ) {
        void scheduleListRefresh();
      }

      if (
        BOARD_LIST_PREWARM_ENABLED &&
        isBoardListSubscription(client_id, spec) &&
        BOARD_SUBSCRIPTION_PREWARM_GENERATION !== BOARD_LIST_CACHE_GENERATION
      ) {
        BOARD_SUBSCRIPTION_PREWARM_GENERATION = BOARD_LIST_CACHE_GENERATION;
        void scheduleBoardListPrewarm();
      }

      ws.send(
        JSON.stringify(makeOk(req, { id: client_id, key, capabilities }))
      );
      return;
    } finally {
      finishSubscribeIntent(ws, client_id, subscribe_intent);
    }
  }

  // unsubscribe-list: payload { id: string }
  if (req.type === 'unsubscribe-list') {
    log('unsubscribe-list %s', /** @type {any} */ (req.payload)?.id || '');
    const { id: client_id } = /** @type {any} */ (req.payload || {});
    if (typeof client_id !== 'string' || client_id.length === 0) {
      ws.send(
        JSON.stringify(
          makeError(req, 'bad_request', 'payload.id must be a non-empty string')
        )
      );
      return;
    }
    const s = ensureSubs(ws);
    nextSubscribeIntent(ws, client_id);
    s.pending_subscriptions?.delete(client_id);
    const removed = detachClientSubscription(ws, client_id);
    ws.send(
      JSON.stringify(
        makeOk(req, {
          id: client_id,
          unsubscribed: removed
        })
      )
    );
    return;
  }

  // Removed: subscribe-updates and subscribe-issues. No-ops in v2.

  // list-issues and epic-status were removed in favor of push-only subscriptions

  // Removed: show-issue. Details flow is push-only via `subscribe-list { type: 'issue-detail' }`.

  // type updates are not exposed via UI; no handler

  // update-assignee
  if (req.type === 'update-assignee') {
    const { id, assignee } = /** @type {any} */ (req.payload || {});
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof assignee !== 'string'
    ) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            'payload requires { id: string, assignee: string }'
          )
        )
      );
      return;
    }
    // Pass empty string to clear assignee when requested
    clearDetailCaches();
    const bd_options = selectedWorkspaceBdOptions();
    const res = await runCanonicalUpdate(
      ['update', id, '--assignee', assignee],
      id,
      bd_options
    );
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, res.stdoutJson)));
    try {
      triggerMutationRefreshOnce();
    } catch {
      // ignore
    }
    return;
  }

  // update-status
  if (req.type === 'update-status') {
    log('update-status');
    const { id, status } = /** @type {any} */ (req.payload);
    const allowed = new Set(['open', 'in_progress', 'closed']);
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof status !== 'string' ||
      !allowed.has(status)
    ) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            "payload requires { id: string, status: 'open'|'in_progress'|'closed' }"
          )
        )
      );
      return;
    }
    clearDetailCaches();
    const bd_options = selectedWorkspaceBdOptions();
    const res = await runCanonicalUpdate(
      ['update', id, '--status', status],
      id,
      bd_options
    );
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, res.stdoutJson)));
    // After mutation, refresh active subscriptions once (watcher or timeout)
    try {
      triggerMutationRefreshOnce();
    } catch {
      // ignore
    }
    return;
  }

  // update-priority
  if (req.type === 'update-priority') {
    log('update-priority');
    const { id, priority } = /** @type {any} */ (req.payload);
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof priority !== 'number' ||
      priority < 0 ||
      priority > 4
    ) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            'payload requires { id: string, priority: 0..4 }'
          )
        )
      );
      return;
    }
    clearDetailCaches();
    const bd_options = selectedWorkspaceBdOptions();
    const res = await runCanonicalUpdate(
      ['update', id, '--priority', String(priority)],
      id,
      bd_options
    );
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, res.stdoutJson)));
    try {
      triggerMutationRefreshOnce();
    } catch {
      // ignore
    }
    return;
  }

  // edit-text
  if (req.type === 'edit-text') {
    log('edit-text');
    const { id, field, value } = /** @type {any} */ (req.payload);
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      (field !== 'title' &&
        field !== 'description' &&
        field !== 'acceptance' &&
        field !== 'notes' &&
        field !== 'design') ||
      typeof value !== 'string'
    ) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            "payload requires { id: string, field: 'title'|'description'|'acceptance'|'notes'|'design', value: string }"
          )
        )
      );
      return;
    }
    // Map UI fields to bd CLI flags
    // title       → --title
    // description → --description
    // acceptance  → --acceptance-criteria
    // notes       → --notes
    // design      → --design
    const flag =
      field === 'title'
        ? '--title'
        : field === 'description'
          ? '--description'
          : field === 'acceptance'
            ? '--acceptance-criteria'
            : field === 'notes'
              ? '--notes'
              : '--design';
    clearDetailCaches();
    const bd_options = selectedWorkspaceBdOptions();
    const res = await runCanonicalUpdate(
      ['update', id, flag, value],
      id,
      bd_options
    );
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, res.stdoutJson)));
    try {
      triggerMutationRefreshOnce();
    } catch {
      // ignore
    }
    return;
  }

  // create-issue
  if (req.type === 'create-issue') {
    log('create-issue');
    const { title, type, priority, description } = /** @type {any} */ (
      req.payload || {}
    );
    if (typeof title !== 'string' || title.length === 0) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            'payload requires { title: string, ... }'
          )
        )
      );
      return;
    }
    const args = ['create', title];
    if (
      typeof type === 'string' &&
      (type === 'bug' ||
        type === 'feature' ||
        type === 'task' ||
        type === 'epic' ||
        type === 'chore')
    ) {
      args.push('-t', type);
    }
    if (typeof priority === 'number' && priority >= 0 && priority <= 4) {
      args.push('-p', String(priority));
    }
    if (typeof description === 'string' && description.length > 0) {
      args.push('-d', description);
    }
    clearDetailCaches();
    const bd_options = selectedWorkspaceBdOptions();
    const res = await runBd(args, bd_options);
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    // Reply with a minimal ack
    ws.send(JSON.stringify(makeOk(req, { created: true })));
    // Refresh active subscriptions once (watcher or timeout)
    try {
      triggerMutationRefreshOnce();
    } catch {
      // ignore
    }
    return;
  }

  // dep-add: payload { a: string, b: string, view_id?: string }
  if (req.type === 'dep-add') {
    const { a, b, view_id } = /** @type {any} */ (req.payload || {});
    if (
      typeof a !== 'string' ||
      a.length === 0 ||
      typeof b !== 'string' ||
      b.length === 0
    ) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            'payload requires { a: string, b: string }'
          )
        )
      );
      return;
    }
    clearDetailCaches();
    const bd_options = selectedWorkspaceBdOptions();
    const res = await runBd(['dep', 'add', a, b], bd_options);
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    const id = typeof view_id === 'string' && view_id.length > 0 ? view_id : a;
    const shown = await runBdJson(['show', id, '--json'], bd_options);
    if (shown.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', shown.stderr || 'bd failed'))
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, shown.stdoutJson)));
    try {
      triggerMutationRefreshOnce();
    } catch {
      // ignore
    }
    return;
  }

  // dep-remove: payload { a: string, b: string, view_id?: string }
  if (req.type === 'dep-remove') {
    const { a, b, view_id } = /** @type {any} */ (req.payload || {});
    if (
      typeof a !== 'string' ||
      a.length === 0 ||
      typeof b !== 'string' ||
      b.length === 0
    ) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            'payload requires { a: string, b: string }'
          )
        )
      );
      return;
    }
    clearDetailCaches();
    const bd_options = selectedWorkspaceBdOptions();
    const res = await runBd(['dep', 'remove', a, b], bd_options);
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    const id = typeof view_id === 'string' && view_id.length > 0 ? view_id : a;
    const shown = await runBdJson(['show', id, '--json'], bd_options);
    if (shown.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', shown.stderr || 'bd failed'))
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, shown.stdoutJson)));
    try {
      triggerMutationRefreshOnce();
    } catch {
      // ignore
    }
    return;
  }

  // label-add: payload { id: string, label: string }
  if (req.type === 'label-add') {
    const { id, label } = /** @type {any} */ (req.payload || {});
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof label !== 'string' ||
      label.trim().length === 0
    ) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            'payload requires { id: string, label: non-empty string }'
          )
        )
      );
      return;
    }
    clearDetailCaches();
    const bd_options = selectedWorkspaceBdOptions();
    const res = await runBd(['label', 'add', id, label.trim()], bd_options);
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    const shown = await runBdJson(['show', id, '--json'], bd_options);
    if (shown.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', shown.stderr || 'bd failed'))
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, shown.stdoutJson)));
    try {
      triggerMutationRefreshOnce();
    } catch {
      // ignore
    }
    return;
  }

  // label-remove: payload { id: string, label: string }
  if (req.type === 'label-remove') {
    const { id, label } = /** @type {any} */ (req.payload || {});
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof label !== 'string' ||
      label.trim().length === 0
    ) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            'payload requires { id: string, label: non-empty string }'
          )
        )
      );
      return;
    }
    clearDetailCaches();
    const bd_options = selectedWorkspaceBdOptions();
    const res = await runBd(['label', 'remove', id, label.trim()], bd_options);
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    const shown = await runBdJson(['show', id, '--json'], bd_options);
    if (shown.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', shown.stderr || 'bd failed'))
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, shown.stdoutJson)));
    try {
      triggerMutationRefreshOnce();
    } catch {
      // ignore
    }
    return;
  }

  // get-comments: payload { id: string }
  if (req.type === 'get-comments') {
    const { id } = /** @type {any} */ (req.payload || {});
    if (typeof id !== 'string' || id.length === 0) {
      ws.send(
        JSON.stringify(
          makeError(req, 'bad_request', 'payload requires { id: string }')
        )
      );
      return;
    }
    const cache_key = issueDetailCacheKey(id);
    const cached = COMMENTS_CACHE.get(cache_key);
    if (cached !== undefined) {
      ws.send(JSON.stringify(makeOk(req, cached)));
      return;
    }
    const generation = DETAIL_CACHE_GENERATION;
    const res = await runBdJson(
      ['comments', id, '--json'],
      selectedWorkspaceBdOptions()
    );
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    const comments = Array.isArray(res.stdoutJson) ? res.stdoutJson : [];
    if (generation === DETAIL_CACHE_GENERATION) {
      COMMENTS_CACHE.set(cache_key, comments);
      evictOldestCacheEntry(COMMENTS_CACHE, DETAIL_CACHE_LIMIT);
    }
    ws.send(JSON.stringify(makeOk(req, comments)));
    return;
  }

  // add-comment: payload { id: string, text: string }
  if (req.type === 'add-comment') {
    const { id, text } = /** @type {any} */ (req.payload || {});
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof text !== 'string' ||
      text.trim().length === 0
    ) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            'payload requires { id: string, text: non-empty string }'
          )
        )
      );
      return;
    }

    clearDetailCaches();
    const bd_options = selectedWorkspaceBdOptions();

    // Get git user name for author attribution
    const author = await getGitUserName(bd_options);
    const args = ['comment', id, text.trim()];
    if (author) {
      args.push('--author', author);
    }

    const res = await runBd(args, bd_options);
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(makeError(req, 'bd_error', res.stderr || 'bd failed'))
      );
      return;
    }
    // Return updated comments list
    const generation = DETAIL_CACHE_GENERATION;
    const comments = await runBdJson(['comments', id, '--json'], bd_options);
    if (comments.code !== 0) {
      ws.send(
        JSON.stringify(
          makeError(req, 'bd_error', comments.stderr || 'bd failed')
        )
      );
      return;
    }
    const comment_list = Array.isArray(comments.stdoutJson)
      ? comments.stdoutJson
      : [];
    if (generation === DETAIL_CACHE_GENERATION) {
      COMMENTS_CACHE.set(issueDetailCacheKey(id), comment_list);
      evictOldestCacheEntry(COMMENTS_CACHE, DETAIL_CACHE_LIMIT);
    }
    ws.send(JSON.stringify(makeOk(req, comment_list)));
    return;
  }

  // delete-issue: payload { id: string }
  if (req.type === 'delete-issue') {
    const { id } = /** @type {any} */ (req.payload || {});
    if (typeof id !== 'string' || id.length === 0) {
      ws.send(
        JSON.stringify(
          makeError(req, 'bad_request', 'payload requires { id: string }')
        )
      );
      return;
    }
    clearDetailCaches();
    const bd_options = selectedWorkspaceBdOptions();
    const res = await runBd(['delete', id, '--force'], bd_options);
    if (res.code !== 0) {
      ws.send(
        JSON.stringify(
          makeError(req, 'bd_error', res.stderr || 'bd delete failed')
        )
      );
      return;
    }
    ws.send(JSON.stringify(makeOk(req, { deleted: true, id })));
    try {
      triggerMutationRefreshOnce();
    } catch {
      // ignore
    }
    return;
  }

  // list-workspaces: returns all available workspaces from the registry
  if (req.type === 'list-workspaces') {
    log('list-workspaces');
    const workspaces = getAvailableWorkspaces();
    ws.send(
      JSON.stringify(
        makeOk(req, {
          workspaces,
          current: CURRENT_WORKSPACE
        })
      )
    );
    return;
  }

  // get-workspace: returns the current workspace
  if (req.type === 'get-workspace') {
    log('get-workspace');
    ws.send(JSON.stringify(makeOk(req, CURRENT_WORKSPACE)));
    return;
  }

  // set-workspace: payload { path: string }
  if (req.type === 'set-workspace') {
    log('set-workspace');
    const { path: workspace_path } = /** @type {any} */ (req.payload || {});
    if (typeof workspace_path !== 'string' || workspace_path.length === 0) {
      ws.send(
        JSON.stringify(
          makeError(
            req,
            'bad_request',
            'payload requires { path: string } (absolute workspace path)'
          )
        )
      );
      return;
    }

    const result = applyWorkspaceChange(
      workspace_path,
      /** @type {WebSocket} */ (ws)
    );

    ws.send(
      JSON.stringify(
        makeOk(req, {
          changed: result.changed,
          workspace: result.workspace
        })
      )
    );
    return;
  }

  // Unknown type
  const err = makeError(
    req,
    'unknown_type',
    `Unknown message type: ${req.type}`
  );
  ws.send(JSON.stringify(err));
}
