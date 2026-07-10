/**
 * @import { MessageType } from '../protocol.js'
 */
import { SUBSCRIPTION_CAPABILITIES } from '../protocol.js';
import { debug } from '../utils/logging.js';

/**
 * Client-side list subscription store.
 *
 * Maintains replayable subscription intent keyed by client-provided `id`.
 */

/**
 * @typedef {{ type: string, params?: Readonly<Record<string, string|number|boolean>>, capabilities?: readonly string[] }} SubscriptionSpec
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
 * @param {(type: MessageType, payload?: unknown) => Promise<unknown>} send - ws send.
 */
export function createSubscriptionStore(send) {
  const log = debug('subs');
  /** @type {Map<string, { spec: Readonly<SubscriptionSpec> }>} */
  const subs_by_id = new Map();

  /**
   * @param {SubscriptionSpec} spec
   * @returns {Readonly<SubscriptionSpec>}
   */
  function copySpec(spec) {
    const params = spec.params ? Object.freeze({ ...spec.params }) : undefined;
    const capabilities = Object.freeze([...SUBSCRIPTION_CAPABILITIES]);
    return Object.freeze({
      type: String(spec.type),
      params,
      capabilities
    });
  }

  /**
   * @param {string} client_id
   * @param {Readonly<SubscriptionSpec>} spec
   */
  function sendSubscribe(client_id, spec) {
    return send('subscribe-list', {
      id: client_id,
      type: spec.type,
      params: spec.params,
      capabilities: spec.capabilities
    });
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
   * @param {{ spec: Readonly<SubscriptionSpec> }} entry
   */
  function removeEntry(client_id, entry) {
    if (subs_by_id.get(client_id) !== entry) {
      return;
    }
    subs_by_id.delete(client_id);
  }

  /**
   * Subscribe to a list spec with a client-provided id.
   * Returns an unsubscribe function.
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
    if (previous) {
      removeEntry(client_id, previous);
    }
    const entry = { spec: saved_spec };
    subs_by_id.set(client_id, entry);

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
      await sendSubscribe(client_id, saved_spec);
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
      entries.map(([client_id, entry]) => sendSubscribe(client_id, entry.spec))
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
   * Request a fresh snapshot for one active subscription.
   *
   * @param {string} client_id
   */
  async function resubscribeOne(client_id) {
    const entry = subs_by_id.get(client_id);
    if (!entry) {
      return false;
    }
    await sendSubscribe(client_id, entry.spec);
    return true;
  }

  return {
    subscribeList,
    resubscribeOne,
    resubscribeAll
  };
}
