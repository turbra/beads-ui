import { runBdJson } from './bd.js';
import { debug } from './logging.js';

const log = debug('list-adapters');

export const BOARD_SUBSCRIPTION_LIST_LIMIT = 1000;
export const ISSUES_SUBSCRIPTION_LIST_LIMIT = 1000;
export const ISSUES_SUBSCRIPTION_LIST_HARD_MAX = 10000;
// Compatibility export for callers that only need the current default.
export const SUBSCRIPTION_LIST_LIMIT = BOARD_SUBSCRIPTION_LIST_LIMIT;
const ISSUES_CLIENT_TYPES = new Set([
  'all-issues',
  'issues-ready',
  'status-issues'
]);

/**
 * Keep Issues and Board policy independent even while both use the evidence-
 * approved 1,000-item tier.
 *
 * @param {{ type: string }} spec
 */
export function subscriptionListLimit(spec) {
  return ISSUES_CLIENT_TYPES.has(String(spec.type))
    ? Math.min(
        ISSUES_SUBSCRIPTION_LIST_LIMIT,
        ISSUES_SUBSCRIPTION_LIST_HARD_MAX
      )
    : BOARD_SUBSCRIPTION_LIST_LIMIT;
}

/**
 * Build concrete `bd` CLI args for a subscription type + params.
 * Always includes `--json` for parseable output.
 *
 * @param {{ type: string, params?: Record<string, string | number | boolean> }} spec
 * @returns {string[]}
 */
export function mapSubscriptionToBdArgs(spec) {
  const t = String(spec.type);
  const fetch_limit = subscriptionListLimit(spec) + 1;
  switch (t) {
    case 'all-issues': {
      return ['list', '--json', '--tree=false', '--limit', String(fetch_limit)];
    }
    case 'epics': {
      return ['epic', 'status', '--json'];
    }
    case 'blocked-issues': {
      return ['blocked', '--json'];
    }
    case 'issues-ready':
    case 'ready-issues': {
      return ['ready', '--limit', String(fetch_limit), '--json'];
    }
    case 'in-progress-issues': {
      return [
        'list',
        '--json',
        '--tree=false',
        '--status',
        'in_progress',
        '--limit',
        String(fetch_limit)
      ];
    }
    case 'status-issues': {
      const statuses = String(spec.params?.statuses || '').trim();
      if (statuses.length === 0) {
        throw badRequest('Missing param: params.statuses');
      }
      return [
        'list',
        '--json',
        '--tree=false',
        '--status',
        statuses,
        '--limit',
        String(fetch_limit)
      ];
    }
    case 'closed-issues': {
      const args = [
        'list',
        '--json',
        '--tree=false',
        '--status',
        'closed',
        '--limit',
        String(fetch_limit)
      ];
      const since =
        typeof spec.params?.since === 'number' ? spec.params.since : 0;
      if (Number.isFinite(since) && since > 0) {
        args.push('--closed-after', new Date(since).toISOString());
      }
      return args;
    }
    case 'issue-detail': {
      const p = spec.params || {};
      const id = String(p.id || '').trim();
      if (id.length === 0) {
        throw badRequest('Missing param: params.id');
      }
      return ['show', id, '--json'];
    }
    default: {
      throw badRequest(`Unknown subscription type: ${t}`);
    }
  }
}

/**
 * Normalize bd list output to minimal Issue shape used by the registry.
 * - Ensures `id` is a string.
 * - Coerces timestamps to numbers.
 * - `closed_at` defaults to null when missing or invalid.
 *
 * @param {unknown} value
 * @returns {Array<{ id: string, created_at: number, updated_at: number, closed_at: number | null } & Record<string, unknown>>}
 */
export function normalizeIssueList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  /** @type {Array<{ id: string, created_at: number, updated_at: number, closed_at: number | null } & Record<string, unknown>>} */
  const out = [];
  for (const it of value) {
    const id = String(it.id ?? '');
    if (id.length === 0) {
      continue;
    }
    const created_at = parseTimestamp(/** @type {any} */ (it).created_at);
    const updated_at = parseTimestamp(it.updated_at);
    const closed_raw = it.closed_at;
    /** @type {number | null} */
    let closed_at = null;
    if (closed_raw !== undefined && closed_raw !== null) {
      const n = parseTimestamp(closed_raw);
      closed_at = Number.isFinite(n) ? n : null;
    }
    out.push({
      ...it,
      id,
      created_at: Number.isFinite(created_at) ? created_at : 0,
      updated_at: Number.isFinite(updated_at) ? updated_at : 0,
      closed_at
    });
  }
  return out;
}

/**
 * @typedef {Object} FetchListResultSuccess
 * @property {true} ok
 * @property {Array<{ id: string, updated_at: number, closed_at: number | null } & Record<string, unknown>>} items
 * @property {boolean} truncated
 */

/**
 * @typedef {Object} FetchListResultFailure
 * @property {false} ok
 * @property {{ code: string, message: string, details?: Record<string, unknown> }} error
 */

/**
 * Execute the mapped `bd` command for a subscription spec and return normalized items.
 * Errors do not throw; they are surfaced as a structured object.
 *
 * @param {{ type: string, params?: Record<string, string | number | boolean> }} spec
 * @param {{ cwd?: string, priority?: 'interactive' | 'background' }} [options] - Optional working directory and queue priority for bd command
 * @returns {Promise<FetchListResultSuccess | FetchListResultFailure>}
 */
export async function fetchListForSubscription(spec, options = {}) {
  /** @type {string[]} */
  let args;
  try {
    args = mapSubscriptionToBdArgs(spec);
  } catch (err) {
    // Surface bad requests (e.g., missing params)
    log('mapSubscriptionToBdArgs failed for %o: %o', spec, err);
    const e = toErrorObject(err);
    return { ok: false, error: e };
  }

  try {
    const res = await runBdJson(args, {
      cwd: options.cwd,
      priority: options.priority
    });
    if (!res || res.code !== 0 || !('stdoutJson' in res)) {
      log(
        'bd failed for %o (args=%o) code=%s stderr=%s',
        spec,
        args,
        res?.code,
        res?.stderr || ''
      );
      return {
        ok: false,
        error: {
          code: 'bd_error',
          message: String(res?.stderr || 'bd failed'),
          details: { exit_code: res?.code ?? -1 }
        }
      };
    }
    // bd show may return a single object; normalize to an array first
    let raw = Array.isArray(res.stdoutJson)
      ? res.stdoutJson
      : res.stdoutJson && typeof res.stdoutJson === 'object'
        ? [res.stdoutJson]
        : [];

    // Special-case mapping for `epics`: current bd output nests the epic under
    // an `epic` key and exposes counters at the top level. Flatten so that
    // each entry has a top-level `id` and core fields expected by the registry.
    if (String(spec.type) === 'epics') {
      raw = raw.map((it) => {
        if (it && typeof it === 'object' && 'epic' in it) {
          const e = /** @type {any} */ (it).epic || {};
          /** @type {Record<string, unknown>} */
          const flat = {
            // Required minimal fields for registry + client rendering
            id: String(e.id ?? ''),
            title: e.title,
            status: e.status,
            issue_type: e.issue_type || 'epic',
            created_at: e.created_at,
            updated_at: e.updated_at,
            closed_at: e.closed_at ?? null,
            deleted_at: e.deleted_at ?? null,
            // Preserve useful counters from bd output
            total_children: /** @type {any} */ (it).total_children,
            closed_children: /** @type {any} */ (it).closed_children,
            eligible_for_close: /** @type {any} */ (it).eligible_for_close
          };
          return flat;
        }
        return it;
      });
      raw = raw.filter((it) => {
        if (!it || typeof it !== 'object') {
          return false;
        }
        const status =
          typeof (/** @type {any} */ (it).status) === 'string'
            ? /** @type {any} */ (it).status
            : '';
        if (status === 'tombstone') {
          return false;
        }
        const deleted_at = /** @type {any} */ (it).deleted_at;
        if (deleted_at !== undefined && deleted_at !== null) {
          return false;
        }
        return true;
      });
    }

    const normalized_items = normalizeIssueList(raw);
    const is_detail = String(spec.type) === 'issue-detail';
    const limit = is_detail ? 1 : subscriptionListLimit(spec);
    const truncated = !is_detail && normalized_items.length > limit;
    const items = normalized_items.slice(0, limit);
    return { ok: true, items, truncated };
  } catch (err) {
    log('bd invocation failed for %o (args=%o): %o', spec, args, err);
    return {
      ok: false,
      error: {
        code: 'bd_error',
        message:
          (err && /** @type {any} */ (err).message) || 'bd invocation failed'
      }
    };
  }
}

/**
 * Create a `bad_request` error object.
 *
 * @param {string} message
 */
function badRequest(message) {
  const e = new Error(message);
  // @ts-expect-error add code
  e.code = 'bad_request';
  return e;
}

/**
 * Normalize arbitrary thrown values to a structured error object.
 *
 * @param {unknown} err
 * @returns {FetchListResultFailure['error']}
 */
function toErrorObject(err) {
  if (err && typeof err === 'object') {
    const any = /** @type {{ code?: unknown, message?: unknown }} */ (err);
    const code = typeof any.code === 'string' ? any.code : 'bad_request';
    const message =
      typeof any.message === 'string' ? any.message : 'Request error';
    return { code, message };
  }
  return { code: 'bad_request', message: 'Request error' };
}

/**
 * Parse a bd timestamp string to epoch ms using Date.parse.
 * Falls back to numeric coercion when parsing fails.
 *
 * @param {unknown} v
 * @returns {number}
 */
function parseTimestamp(v) {
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) {
      return ms;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : 0;
  }
  return 0;
}
