/**
 * @import { MessageType } from './protocol.js'
 */
/**
 * Persistent WebSocket client with reconnect, request/response correlation,
 * and simple event dispatching.
 *
 * Usage:
 *   const ws = createWsClient();
 *   const data = await ws.send('list-issues', { filters: {} });
 *   const off = ws.on('snapshot', (payload) => { <push event> });
 */
import { MESSAGE_TYPES, makeRequest, nextId } from './protocol.js';
import { debug } from './utils/logging.js';

/**
 * @typedef {'connecting'|'open'|'closed'|'reconnecting'} ConnectionState
 */

/**
 * @typedef {{ initialMs?: number, maxMs?: number, factor?: number, jitterRatio?: number }} BackoffOptions
 */

/**
 * @typedef {{ url?: string, backoff?: BackoffOptions }} ClientOptions
 */

/**
 * Create a structured transport error so higher layers can preserve replayable
 * subscription intent without suppressing server-side command failures.
 *
 * @param {'ws_disconnected'|'ws_connection_failed'|'ws_send_failed'|'ws_client_closed'} code
 * @param {string} message
 */
function makeTransportError(code, message) {
  const error = new Error(message);
  Object.assign(error, { code });
  return error;
}

/**
 * Create a WebSocket client with auto-reconnect and message correlation.
 *
 * @param {ClientOptions} [options]
 */
export function createWsClient(options = {}) {
  const log = debug('ws');

  /** @type {BackoffOptions} */
  const backoff = {
    initialMs: options.backoff?.initialMs ?? 1000,
    maxMs: options.backoff?.maxMs ?? 30000,
    factor: options.backoff?.factor ?? 2,
    jitterRatio: options.backoff?.jitterRatio ?? 0.2
  };

  /** @type {() => string} */
  const resolveUrl = () => {
    if (options.url && options.url.length > 0) {
      return options.url;
    }
    if (typeof location !== 'undefined') {
      return (
        (location.protocol === 'https:' ? 'wss://' : 'ws://') +
        location.host +
        '/ws'
      );
    }
    return 'ws://localhost/ws';
  };

  /** @type {WebSocket | null} */
  let ws = null;
  /** @type {ConnectionState} */
  let state = 'closed';
  /** @type {number} */
  let attempts = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let reconnect_timer = null;
  /** @type {boolean} */
  let should_reconnect = true;

  /** @type {number} */
  let generation_counter = 0;
  /** @type {number | null} */
  let active_generation = null;

  /** @type {Map<string, { resolve: (v: any) => void, reject: (e: any) => void, type: string, generation: number | null }>} */
  const pending = new Map();
  /** @type {Array<{ req: ReturnType<typeof makeRequest>, generation: number | null }>} */
  const queue = [];
  /** @type {Map<string, Set<(payload: any) => void>>} */
  const handlers = new Map();
  /** @type {Set<(s: ConnectionState) => void>} */
  const connection_handlers = new Set();

  /**
   * @param {ConnectionState} s
   */
  function notifyConnection(s) {
    for (const fn of Array.from(connection_handlers)) {
      try {
        fn(s);
      } catch {
        // ignore listener errors
      }
    }
  }

  function scheduleReconnect() {
    if (!should_reconnect || reconnect_timer) {
      return;
    }
    state = 'reconnecting';
    log('ws reconnecting…');
    notifyConnection(state);
    const base = Math.min(
      backoff.maxMs || 0,
      (backoff.initialMs || 0) * Math.pow(backoff.factor || 1, attempts)
    );
    const jitter = (backoff.jitterRatio || 0) * base;
    const delay = Math.max(
      0,
      Math.round(base + (Math.random() * 2 - 1) * jitter)
    );
    log('ws retry in %d ms (attempt %d)', delay, attempts + 1);
    reconnect_timer = setTimeout(() => {
      reconnect_timer = null;
      connect();
    }, delay);
  }

  /**
   * @param {WebSocket} socket
   * @param {ReturnType<typeof makeRequest>} req
   */
  function sendRaw(socket, req) {
    try {
      socket.send(JSON.stringify(req));
    } catch (err) {
      log('ws send failed', err);
      const entry = pending.get(req.id);
      if (entry) {
        pending.delete(req.id);
        entry.reject(makeTransportError('ws_send_failed', 'ws send failed'));
      }
    }
  }

  /**
   * Reject requests owned by a failed connection attempt.
   *
   * @param {number} generation
   * @param {Error} error
   */
  function rejectGeneration(generation, error) {
    for (const [id, entry] of pending.entries()) {
      if (entry.generation === generation) {
        pending.delete(id);
        entry.reject(error);
      }
    }
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index].generation === generation) {
        queue.splice(index, 1);
      }
    }
  }

  /** @param {Error} error */
  function rejectAll(error) {
    for (const [id, entry] of pending.entries()) {
      pending.delete(id);
      entry.reject(error);
    }
    queue.length = 0;
  }

  /** @param {number} generation */
  function claimQueuedRequests(generation) {
    for (const queued of queue) {
      if (queued.generation !== null) {
        continue;
      }
      queued.generation = generation;
      const entry = pending.get(queued.req.id);
      if (entry) {
        entry.generation = generation;
      }
    }
  }

  /**
   * @param {WebSocket} socket
   * @param {number} generation
   */
  function onOpen(socket, generation) {
    if (ws !== socket || active_generation !== generation) {
      return;
    }
    state = 'open';
    log('ws open');
    notifyConnection(state);
    attempts = 0;
    // flush queue
    for (let index = 0; index < queue.length; ) {
      const queued = queue[index];
      if (queued.generation !== generation) {
        index += 1;
        continue;
      }
      queue.splice(index, 1);
      if (pending.has(queued.req.id)) {
        sendRaw(socket, queued.req);
      }
    }
  }

  /**
   * @param {WebSocket} socket
   * @param {number} generation
   * @param {MessageEvent} ev
   */
  function onMessage(socket, generation, ev) {
    if (ws !== socket || active_generation !== generation) {
      return;
    }
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      log('ws received non-JSON message');
      return;
    }
    if (!msg || typeof msg.id !== 'string' || typeof msg.type !== 'string') {
      log('ws received invalid envelope');
      return;
    }

    if (pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.ok) {
        entry?.resolve(msg.payload);
      } else {
        entry?.reject(msg.error || new Error('ws error'));
      }
      return;
    }

    // Treat as server-initiated event
    const set = handlers.get(msg.type);
    if (set && set.size > 0) {
      for (const fn of Array.from(set)) {
        try {
          fn(msg.payload);
        } catch (err) {
          log('ws event handler error', err);
        }
      }
    } else {
      log('ws received unhandled message type: %s', msg.type);
    }
  }

  /**
   * @param {WebSocket} socket
   * @param {number} generation
   */
  function onClose(socket, generation) {
    if (ws !== socket || active_generation !== generation) {
      return;
    }
    ws = null;
    active_generation = null;
    state = 'closed';
    log('ws closed');
    notifyConnection(state);
    rejectGeneration(
      generation,
      makeTransportError('ws_disconnected', 'ws disconnected')
    );
    attempts += 1;
    scheduleReconnect();
  }

  function connect() {
    if (!should_reconnect) {
      return;
    }
    const generation = ++generation_counter;
    active_generation = generation;
    state = 'connecting';
    notifyConnection(state);
    claimQueuedRequests(generation);
    const url = resolveUrl();
    try {
      const socket = new WebSocket(url);
      ws = socket;
      log('ws connecting %s', url);
      socket.addEventListener('open', () => onOpen(socket, generation));
      socket.addEventListener('message', (event) =>
        onMessage(socket, generation, event)
      );
      socket.addEventListener('error', () => {
        // let close handler handle reconnect
      });
      socket.addEventListener('close', () => onClose(socket, generation));
    } catch (err) {
      log('ws connect failed %o', err);
      active_generation = null;
      state = 'closed';
      notifyConnection(state);
      rejectGeneration(
        generation,
        makeTransportError('ws_connection_failed', 'ws connection failed')
      );
      attempts += 1;
      scheduleReconnect();
    }
  }

  connect();

  return {
    /**
     * Send a request and await its correlated reply payload.
     *
     * @param {MessageType} type
     * @param {unknown} [payload]
     * @returns {Promise<any>}
     */
    send(type, payload) {
      if (!MESSAGE_TYPES.includes(type)) {
        return Promise.reject(new Error(`unknown message type: ${type}`));
      }
      if (!should_reconnect) {
        return Promise.reject(
          makeTransportError('ws_client_closed', 'ws client closed')
        );
      }
      const id = nextId();
      const req = makeRequest(type, payload, id);
      log('send %s id=%s', type, id);
      return new Promise((resolve, reject) => {
        const generation = active_generation;
        pending.set(id, { resolve, reject, type, generation });
        if (ws && ws.readyState === ws.OPEN) {
          sendRaw(ws, req);
        } else {
          log('queue %s id=%s (state=%s)', type, id, state);
          queue.push({ req, generation });
        }
      });
    },
    /**
     * Register a handler for a server-initiated event type.
     * Returns an unsubscribe function.
     *
     * @param {MessageType} type
     * @param {(payload: any) => void} handler
     * @returns {() => void}
     */
    on(type, handler) {
      if (!handlers.has(type)) {
        handlers.set(type, new Set());
      }
      const set = handlers.get(type);
      set?.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
    /**
     * Subscribe to connection state changes.
     *
     * @param {(state: ConnectionState) => void} handler
     * @returns {() => void}
     */
    onConnection(handler) {
      connection_handlers.add(handler);
      return () => {
        connection_handlers.delete(handler);
      };
    },
    /** Close and stop reconnecting. */
    close() {
      should_reconnect = false;
      if (reconnect_timer) {
        clearTimeout(reconnect_timer);
        reconnect_timer = null;
      }
      rejectAll(makeTransportError('ws_client_closed', 'ws client closed'));
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    },
    /** For diagnostics in tests or UI. */
    getState() {
      return state;
    }
  };
}
