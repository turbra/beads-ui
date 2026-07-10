/**
 * Validation helpers for protocol payloads.
 *
 * Provides schema checks for subscription specs and selected mutations.
 */
import { Buffer } from 'node:buffer';

export const SUBSCRIPTION_DELTA_CAPABILITY = 'subscription-delta-v1';
export const MAX_SUBSCRIPTION_ID_BYTES = 128;
export const MAX_SUBSCRIPTION_CAPABILITIES = 8;
export const MAX_SUBSCRIPTION_CAPABILITY_LENGTH = 64;

const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * @param {string} value
 */
function hasAsciiControl(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

/**
 * Known subscription types supported by the server.
 *
 * @type {Set<string>}
 */
const SUBSCRIPTION_TYPES = new Set([
  'all-issues',
  'epics',
  'blocked-issues',
  'ready-issues',
  'in-progress-issues',
  'status-issues',
  'closed-issues',
  'issue-detail'
]);

/**
 * Validate a subscribe-list payload and normalize to a SubscriptionSpec.
 *
 * @param {unknown} payload
 * @returns {{ ok: true, id: string, capabilities: string[], spec: { type: string, params?: Record<string, string|number|boolean> } } | { ok: false, code: 'bad_request', message: string }}
 */
export function validateSubscribeListPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      code: 'bad_request',
      message: 'payload must be an object'
    };
  }
  const any =
    /** @type {{ id?: unknown, type?: unknown, params?: unknown, capabilities?: unknown }} */ (
      payload
    );

  const id = typeof any.id === 'string' ? any.id : '';
  if (
    id.length === 0 ||
    Buffer.byteLength(id, 'utf8') > MAX_SUBSCRIPTION_ID_BYTES ||
    hasAsciiControl(id)
  ) {
    return {
      ok: false,
      code: 'bad_request',
      message:
        'payload.id must be 1 to 128 UTF-8 bytes without ASCII control characters'
    };
  }

  /** @type {string[]} */
  const capabilities = [];
  if (any.capabilities !== undefined) {
    if (!Array.isArray(any.capabilities)) {
      return {
        ok: false,
        code: 'bad_request',
        message: 'payload.capabilities must be an array when provided'
      };
    }
    if (any.capabilities.length > MAX_SUBSCRIPTION_CAPABILITIES) {
      return {
        ok: false,
        code: 'bad_request',
        message: `payload.capabilities must contain at most ${MAX_SUBSCRIPTION_CAPABILITIES} entries`
      };
    }
    const seen_capabilities = new Set();
    for (const value of any.capabilities) {
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > MAX_SUBSCRIPTION_CAPABILITY_LENGTH ||
        !CAPABILITY_PATTERN.test(value)
      ) {
        return {
          ok: false,
          code: 'bad_request',
          message:
            'payload.capabilities entries must match ^[a-z0-9][a-z0-9._-]{0,63}$'
        };
      }
      if (seen_capabilities.has(value)) {
        continue;
      }
      seen_capabilities.add(value);
      if (value === SUBSCRIPTION_DELTA_CAPABILITY) {
        capabilities.push(value);
      }
    }
  }

  const type = typeof any.type === 'string' ? any.type : '';
  if (type.length === 0 || !SUBSCRIPTION_TYPES.has(type)) {
    return {
      ok: false,
      code: 'bad_request',
      message: `payload.type must be one of: ${Array.from(SUBSCRIPTION_TYPES).join(', ')}`
    };
  }

  /** @type {Record<string, string|number|boolean> | undefined} */
  let params;
  if (any.params !== undefined) {
    if (
      !any.params ||
      typeof any.params !== 'object' ||
      Array.isArray(any.params)
    ) {
      return {
        ok: false,
        code: 'bad_request',
        message: 'payload.params must be an object when provided'
      };
    }
    params = /** @type {Record<string, string|number|boolean>} */ (any.params);
  }

  // Per-type param schemas
  if (type === 'issue-detail') {
    if (
      !params ||
      Object.keys(params).length !== 1 ||
      typeof params.id !== 'string'
    ) {
      return {
        ok: false,
        code: 'bad_request',
        message: 'params must contain exactly one id string'
      };
    }
    const id = params.id.trim();
    if (id.length === 0) {
      return {
        ok: false,
        code: 'bad_request',
        message: 'params.id must be a non-empty string'
      };
    }
    params = { id };
  } else if (type === 'closed-issues') {
    if (params && Object.keys(params).some((key) => key !== 'since')) {
      return {
        ok: false,
        code: 'bad_request',
        message: 'params may contain only since'
      };
    }
    if (params && 'since' in params) {
      const since = params.since;
      const n = typeof since === 'number' ? since : Number.NaN;
      if (!Number.isFinite(n) || n < 0) {
        return {
          ok: false,
          code: 'bad_request',
          message: 'params.since must be a non-negative number (epoch ms)'
        };
      }
      params = { since: n };
    } else {
      params = undefined;
    }
  } else if (type === 'status-issues') {
    if (
      !params ||
      Object.keys(params).length !== 1 ||
      typeof params.statuses !== 'string'
    ) {
      return {
        ok: false,
        code: 'bad_request',
        message: 'params must contain exactly one statuses string'
      };
    }
    const allowed_statuses = ['open', 'in_progress', 'closed'];
    const requested_statuses = new Set(
      params.statuses
        .split(',')
        .map((status) => status.trim())
        .filter((status) => status.length > 0)
    );
    if (
      requested_statuses.size === 0 ||
      [...requested_statuses].some(
        (status) => !allowed_statuses.includes(status)
      )
    ) {
      return {
        ok: false,
        code: 'bad_request',
        message: 'params.statuses must contain open, in_progress, or closed'
      };
    }
    params = {
      statuses: allowed_statuses
        .filter((status) => requested_statuses.has(status))
        .join(',')
    };
  } else {
    // Other types do not accept params
    if (params && Object.keys(params).length > 0) {
      return {
        ok: false,
        code: 'bad_request',
        message: `type ${type} does not accept params`
      };
    }
    params = undefined;
  }

  return { ok: true, id, capabilities, spec: { type, params } };
}
