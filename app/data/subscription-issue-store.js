/**
 * @import { SubscriptionIssueStore, SubscriptionIssueStoreOptions } from '../../types/subscription-issue-store.js'
 */
import { debug } from '../utils/logging.js';
import { cmpPriorityThenCreated } from './sort.js';

/**
 * @param {object} obj
 * @param {string} key
 */
function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Per-subscription issue store. Holds full Issue objects and exposes a
 * deterministic, read-only snapshot for rendering. Applies snapshot/upsert/
 * delete messages in revision order and preserves object identity per id.
 */

/**
 * Create a SubscriptionIssueStore for a given subscription id.
 *
 * @param {string} id
 * @param {SubscriptionIssueStoreOptions} [options]
 * @returns {SubscriptionIssueStore}
 */
export function createSubscriptionIssueStore(id, options = {}) {
  const log = debug(`issue-store:${id}`);
  /** @type {Map<string, any>} */
  const items_by_id = new Map();
  /** @type {any[]} */
  let ordered = [];
  /** @type {number} */
  let last_revision = 0;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {boolean} */
  let is_disposed = false;
  /** @type {boolean} */
  let emit_scheduled = false;
  /** @type {boolean} */
  let ordered_dirty = false;
  /** @type {boolean} */
  let needs_resync = false;
  /** @type {boolean | null} */
  let truncation = null;
  /** @type {(a:any,b:any)=>number} */
  const sort = options.sort || cmpPriorityThenCreated;

  function flushEmit() {
    emit_scheduled = false;
    if (is_disposed) {
      return;
    }
    ensureOrdered();
    for (const fn of Array.from(listeners)) {
      try {
        fn();
      } catch {
        // ignore listener errors
      }
    }
  }

  function scheduleEmit() {
    if (is_disposed || emit_scheduled) {
      return;
    }
    emit_scheduled = true;
    queueMicrotask(flushEmit);
  }

  function rebuildOrdered() {
    ordered = Array.from(items_by_id.values()).sort(sort);
    ordered_dirty = false;
  }

  function ensureOrdered() {
    if (ordered_dirty) {
      rebuildOrdered();
    }
  }

  /**
   * Preserve enrichment that list/detail snapshots may omit, without allowing a
   * seeded issue to block the server's next real revision.
   *
   * @param {any} next
   * @param {any} existing
   */
  function preserveKnownFields(next, existing) {
    if (!existing || !next) {
      return;
    }
    if (!hasOwn(next, 'comment_count') && hasOwn(existing, 'comment_count')) {
      next.comment_count = existing.comment_count;
    }
    if (!hasOwn(next, 'comments') && hasOwn(existing, 'comments')) {
      next.comments = existing.comments;
    }
  }

  /**
   * Apply one validated issue while preserving existing object identity and
   * client-side comment enrichment.
   *
   * @param {any} issue
   */
  function applyIssue(issue) {
    const existing = items_by_id.get(issue.id);
    if (!existing) {
      items_by_id.set(issue.id, issue);
      return;
    }
    const previous_timestamp = Number.isFinite(existing.updated_at)
      ? /** @type {number} */ (existing.updated_at)
      : 0;
    const next_timestamp = Number.isFinite(issue.updated_at)
      ? /** @type {number} */ (issue.updated_at)
      : 0;
    if (previous_timestamp > next_timestamp) {
      return;
    }
    const preserve_comments =
      !hasOwn(issue, 'comments') && hasOwn(existing, 'comments');
    const previous_comments = preserve_comments ? existing.comments : undefined;
    const preserve_comment_count =
      !hasOwn(issue, 'comment_count') && hasOwn(existing, 'comment_count');
    const previous_comment_count = preserve_comment_count
      ? existing.comment_count
      : undefined;
    for (const key of Object.keys(existing)) {
      if (!(key in issue)) {
        delete existing[key];
      }
    }
    for (const [key, value] of Object.entries(issue)) {
      // @ts-ignore - dynamic assignment
      existing[key] = value;
    }
    if (preserve_comments) {
      existing.comments = previous_comments;
    }
    if (preserve_comment_count) {
      existing.comment_count = previous_comment_count;
    }
  }

  /**
   * Validate the complete delta before any local state changes are made.
   *
   * @param {any} msg
   * @returns {boolean}
   */
  function isValidDelta(msg) {
    if (!Array.isArray(msg.upserts) || !Array.isArray(msg.deletes)) {
      return false;
    }
    if (msg.upserts.length + msg.deletes.length < 2) {
      return false;
    }
    /** @type {Set<string>} */
    const upsert_ids = new Set();
    for (const issue of msg.upserts) {
      if (
        !issue ||
        typeof issue !== 'object' ||
        Array.isArray(issue) ||
        typeof issue.id !== 'string' ||
        issue.id.length === 0 ||
        upsert_ids.has(issue.id)
      ) {
        return false;
      }
      upsert_ids.add(issue.id);
    }
    /** @type {Set<string>} */
    const delete_ids = new Set();
    for (const issue_id of msg.deletes) {
      if (
        typeof issue_id !== 'string' ||
        issue_id.length === 0 ||
        delete_ids.has(issue_id) ||
        upsert_ids.has(issue_id)
      ) {
        return false;
      }
      delete_ids.add(issue_id);
    }
    return true;
  }

  /** @returns {'ignored'|'resync-needed'} */
  function markResyncNeeded() {
    if (needs_resync) {
      return 'ignored';
    }
    needs_resync = true;
    return 'resync-needed';
  }

  /**
   * Apply snapshot/upsert/delete/delta in revision order. Snapshots reset state.
   * - Ignore messages with revision <= last_revision (except snapshot which resets first).
   * - Preserve object identity when updating an existing item by mutating
   *   fields in place rather than replacing the object reference.
   *
   * @param {{ type: 'snapshot'|'upsert'|'delete'|'delta', id: string, revision: number, issues?: any[], issue?: any, issue_id?: string, upserts?: any[], deletes?: string[], truncated?: boolean }} msg
   * @returns {'applied'|'ignored'|'resync-needed'}
   */
  function applyPush(msg) {
    if (is_disposed) {
      return 'ignored';
    }
    if (!msg || msg.id !== id) {
      return 'ignored';
    }
    const rev = msg.revision;
    log('apply %s rev=%d', msg.type, rev);
    if (!Number.isSafeInteger(rev) || rev <= 0) {
      return msg.type === 'delta' ? markResyncNeeded() : 'ignored';
    }
    // Ignore stale messages for all types, including snapshots
    if (rev <= last_revision && msg.type !== 'snapshot') {
      return 'ignored'; // stale or duplicate non-snapshot
    }
    if (msg.type === 'snapshot') {
      if (rev <= last_revision) {
        return 'ignored'; // ignore stale snapshot
      }
      const previous_items = new Map(items_by_id);
      items_by_id.clear();
      const items = Array.isArray(msg.issues) ? msg.issues : [];
      for (const it of items) {
        if (it && typeof it.id === 'string' && it.id.length > 0) {
          preserveKnownFields(it, previous_items.get(it.id));
          items_by_id.set(it.id, it);
        }
      }
      ordered_dirty = true;
      last_revision = rev;
      needs_resync = false;
      truncation = typeof msg.truncated === 'boolean' ? msg.truncated : null;
      scheduleEmit();
      return 'applied';
    }
    if (needs_resync) {
      return 'ignored';
    }
    if (msg.type === 'upsert') {
      const it = msg.issue;
      if (it && typeof it.id === 'string' && it.id.length > 0) {
        applyIssue(it);
        ordered_dirty = true;
      }
      last_revision = rev;
      scheduleEmit();
      return 'applied';
    } else if (msg.type === 'delete') {
      const rid = String(msg.issue_id || '');
      if (rid) {
        ordered_dirty = items_by_id.delete(rid) || ordered_dirty;
      }
      last_revision = rev;
      scheduleEmit();
      return 'applied';
    } else if (msg.type === 'delta') {
      if (!isValidDelta(msg)) {
        return markResyncNeeded();
      }
      for (const issue of msg.upserts || []) {
        applyIssue(issue);
      }
      for (const issue_id of msg.deletes || []) {
        items_by_id.delete(issue_id);
      }
      ordered_dirty = true;
      last_revision = rev;
      scheduleEmit();
      return 'applied';
    }
    return 'ignored';
  }

  /**
   * Seed a store from already-loaded list data before the server snapshot
   * arrives. This does not advance `last_revision`, so the real snapshot still
   * replaces or enriches the seeded issue.
   *
   * @param {any[]} items
   */
  function seed(items) {
    if (is_disposed || !Array.isArray(items)) {
      return;
    }
    let changed = false;
    for (const it of items) {
      if (!it || typeof it.id !== 'string' || it.id.length === 0) {
        continue;
      }
      const existing = items_by_id.get(it.id);
      if (existing) {
        const prev_ts = Number.isFinite(existing.updated_at)
          ? /** @type {number} */ (existing.updated_at)
          : 0;
        const next_ts = Number.isFinite(it.updated_at)
          ? /** @type {number} */ (it.updated_at)
          : 0;
        if (next_ts < prev_ts) {
          continue;
        }
      }
      items_by_id.set(it.id, { ...it });
      changed = true;
    }
    if (changed) {
      ordered_dirty = true;
      scheduleEmit();
    }
  }

  return {
    id,
    /**
     * @param {() => void} fn
     */
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    applyPush,
    requireResync: markResyncNeeded,
    seed,
    snapshot() {
      // Return as read-only view; callers must not mutate
      ensureOrdered();
      return ordered;
    },
    truncation() {
      return truncation;
    },
    size() {
      return items_by_id.size;
    },
    /**
     * @param {string} xid
     */
    getById(xid) {
      return items_by_id.get(xid);
    },
    dispose() {
      is_disposed = true;
      emit_scheduled = false;
      items_by_id.clear();
      ordered = [];
      ordered_dirty = false;
      listeners.clear();
      last_revision = 0;
      needs_resync = false;
      truncation = null;
    }
  };
}
