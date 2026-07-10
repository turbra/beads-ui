/**
 * @import { MessageType } from '../protocol.js'
 */
import { debug } from '../utils/logging.js';

/**
 * Client-side list subscription store.
 *
 * Maintains per-subscription state keyed by client-provided `id`.
 * Applies server `list-delta` events per subscription key and exposes simple
 * selectors for rendering.
 */

/**
 * @typedef {{ type: string, params?: Record<string, string|number|boolean> }} SubscriptionSpec
 */

/**
 * Generate a stable subscription key string from a spec.
 * Mirrors server `keyOf` implementation (sorted params, URLSearchParams).
 *
 * @param {SubscriptionSpec} spec
 * @returns {string}
 */
export function subKeyOf(spec) {
  const type = String(spec.type || '').trim();
  /** @type {Record<string, string>} */
  const flat = {};
  if (spec.params && typeof spec.params === 'object') {
    const keys = Object.keys(spec.params).sort();
    for (const k of keys) {
      const v = spec.params[k];
      flat[k] = String(v);
    }
  }
  const enc = new URLSearchParams(flat).toString();
  return enc.length > 0 ? `${type}?${enc}` : type;
}

/**
 * Create a list subscription store.
 *
 * Wiring:
 * - Use `subscribeList` to register a subscription and send the request.
 *
 * Selectors are synchronous and return derived state by client id.
 *
 * @param {(type: MessageType, payload?: unknown) => Promise<unknown>} send - ws send.
 */
export function createSubscriptionStore(send) {
  const log = debug('subs');
  /** @type {Map<string, { key: string, itemsById: Map<string, true>, spec: Readonly<SubscriptionSpec> }>} */
  const subs_by_id = new Map();
  /** @type {Map<string, Set<string>>} */
  const ids_by_key = new Map();

  /**
   * @param {SubscriptionSpec} spec
   * @returns {Readonly<SubscriptionSpec>}
   */
  function copySpec(spec) {
    const params = spec.params ? Object.freeze({ ...spec.params }) : undefined;
    return Object.freeze({ type: String(spec.type), params });
  }

  /**
   * Return whether a failed subscribe request should remain eligible for
   * automatic replay on the next connection.
   *
   * @param {unknown} err
   */
  function isReplayableTransportError(err) {
    if (!err || typeof err !== 'object') {
      return false;
    }
    const code = /** @type {{ code?: unknown }} */ (err).code;
    return (
      code === 'ws_disconnected' ||
      code === 'ws_connection_failed' ||
      code === 'ws_send_failed'
    );
  }

  /**
   * @param {string} client_id
   * @param {{ key: string, itemsById: Map<string, true>, spec: Readonly<SubscriptionSpec> }} entry
   */
  function removeEntry(client_id, entry) {
    if (subs_by_id.get(client_id) !== entry) {
      return;
    }
    subs_by_id.delete(client_id);
    const subscribers = ids_by_key.get(entry.key);
    if (subscribers) {
      subscribers.delete(client_id);
      if (subscribers.size === 0) {
        ids_by_key.delete(entry.key);
      }
    }
  }

  /**
   * Apply a delta to all client ids mapped to a given key.
   *
   * @param {string} key
   * @param {{ added: string[], updated: string[], removed: string[] }} delta
   */
  function applyDelta(key, delta) {
    log(
      'applyDelta %s +%d ~%d -%d',
      key,
      (delta.added || []).length,
      (delta.updated || []).length,
      (delta.removed || []).length
    );
    const id_set = ids_by_key.get(key);
    if (!id_set || id_set.size === 0) {
      return;
    }
    const added = Array.isArray(delta.added) ? delta.added : [];
    const updated = Array.isArray(delta.updated) ? delta.updated : [];
    const removed = Array.isArray(delta.removed) ? delta.removed : [];

    for (const client_id of Array.from(id_set)) {
      const entry = subs_by_id.get(client_id);
      if (!entry) {
        continue;
      }
      const items = entry.itemsById;
      for (const id of added) {
        if (typeof id === 'string' && id.length > 0) {
          items.set(id, true);
        }
      }
      for (const id of updated) {
        if (typeof id === 'string' && id.length > 0) {
          items.set(id, true);
        }
      }
      for (const id of removed) {
        if (typeof id === 'string' && id.length > 0) {
          items.delete(id);
        }
      }
    }
  }

  /**
   * Subscribe to a list spec with a client-provided id.
   * Returns an unsubscribe function.
   * Creates an empty items store immediately; server will publish deltas.
   *
   * @param {string} client_id
   * @param {SubscriptionSpec} spec
   * @returns {Promise<() => Promise<void>>}
   */
  async function subscribeList(client_id, spec) {
    const saved_spec = copySpec(spec);
    const key = subKeyOf(saved_spec);
    log('subscribe %s key=%s', client_id, key);
    const previous = subs_by_id.get(client_id);
    const items_by_id =
      previous && previous.key === key ? previous.itemsById : new Map();
    if (previous) {
      removeEntry(client_id, previous);
    }
    const entry = { key, itemsById: items_by_id, spec: saved_spec };
    subs_by_id.set(client_id, entry);
    if (!ids_by_key.has(key)) {
      ids_by_key.set(key, new Set());
    }
    const set = ids_by_key.get(key);
    if (set) {
      set.add(client_id);
    }

    const unsubscribe = async () => {
      log('unsubscribe %s key=%s', client_id, key);
      if (subs_by_id.get(client_id) !== entry) {
        return;
      }
      // Remove locally before awaiting the transport so late deltas and stale
      // unsubscribe closures cannot affect a replacement subscription.
      removeEntry(client_id, entry);
      try {
        await send('unsubscribe-list', { id: client_id });
      } catch {
        // ignore transport errors on unsubscribe
      }
    };

    try {
      await send('subscribe-list', {
        id: client_id,
        type: saved_spec.type,
        params: saved_spec.params
      });
    } catch (err) {
      if (isReplayableTransportError(err)) {
        log('retaining %s for reconnect replay after %o', client_id, err);
        return unsubscribe;
      }
      removeEntry(client_id, entry);
      throw err;
    }

    return unsubscribe;
  }

  /**
   * Replay all active subscription specs after a reconnect.
   *
   * @returns {Promise<string[]>}
   */
  async function resubscribeAll() {
    const entries = Array.from(subs_by_id.entries());
    const results = await Promise.allSettled(
      entries.map(([client_id, entry]) =>
        send('subscribe-list', {
          id: client_id,
          type: entry.spec.type,
          params: entry.spec.params
        })
      )
    );
    /** @type {string[]} */
    const successful_ids = [];
    /** @type {string[]} */
    const failed_ids = [];
    for (let index = 0; index < entries.length; index += 1) {
      const client_id = entries[index][0];
      if (results[index].status === 'fulfilled') {
        successful_ids.push(client_id);
      } else {
        failed_ids.push(client_id);
      }
    }
    if (failed_ids.length > 0) {
      throw new Error(`Failed to resubscribe: ${failed_ids.join(', ')}`);
    }
    return successful_ids;
  }

  /**
   * Selectors by client id.
   */
  const selectors = {
    /**
     * Get an array of item ids for a subscription.
     *
     * @param {string} client_id
     * @returns {string[]}
     */
    getIds(client_id) {
      const entry = subs_by_id.get(client_id);
      if (!entry) {
        return [];
      }
      return Array.from(entry.itemsById.keys());
    },
    /**
     * Check if an id exists in a subscription.
     *
     * @param {string} client_id
     * @param {string} id
     * @returns {boolean}
     */
    has(client_id, id) {
      const entry = subs_by_id.get(client_id);
      if (!entry) {
        return false;
      }
      return entry.itemsById.has(id);
    },
    /**
     * Count items for a subscription.
     *
     * @param {string} client_id
     * @returns {number}
     */
    count(client_id) {
      const entry = subs_by_id.get(client_id);
      return entry ? entry.itemsById.size : 0;
    },
    /**
     * Return a shallow object copy `{ [id]: true }` for rendering helpers.
     *
     * @param {string} client_id
     * @returns {Record<string, true>}
     */
    getItemsById(client_id) {
      const entry = subs_by_id.get(client_id);
      /** @type {Record<string, true>} */
      const out = {};
      if (!entry) {
        return out;
      }
      for (const id of entry.itemsById.keys()) {
        out[id] = true;
      }
      return out;
    }
  };

  return {
    subscribeList,
    resubscribeAll,
    // test/diagnostics helpers
    _applyDelta: applyDelta,
    _subKeyOf: subKeyOf,
    selectors
  };
}
