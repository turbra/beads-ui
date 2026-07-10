/**
 * Minimal app state store with subscription.
 */
import { debug } from './utils/logging.js';

const STATUS_FILTER_ORDER = Object.freeze(['open', 'in_progress', 'closed']);
const TYPE_FILTER_ORDER = Object.freeze([
  'bug',
  'feature',
  'task',
  'epic',
  'chore'
]);

/**
 * @typedef {'open'|'in_progress'|'closed'|'ready'} StatusFilter
 */

/**
 * @typedef {{ status: StatusFilter[], search: string, type: string[] }} Filters
 */

/**
 * @typedef {'issues'|'epics'|'board'} ViewName
 */

/**
 * @typedef {'today'|'3'|'7'} ClosedFilter
 */

/**
 * @typedef {{ closed_filter: ClosedFilter }} BoardState
 */

/**
 * @typedef {Object} WorkspaceInfo
 * @property {string} path - Full path to workspace
 * @property {string} database - Path to the database file
 * @property {number} [pid] - Process ID of the daemon
 * @property {string} [version] - Version of beads
 */

/**
 * @typedef {Object} WorkspaceState
 * @property {WorkspaceInfo | null} current - Currently active workspace
 * @property {WorkspaceInfo[]} available - All available workspaces
 */

/**
 * @typedef {{ selected_id: string | null, view: ViewName, filters: Filters, board: BoardState, workspace: WorkspaceState }} AppState
 */

/**
 * Create a simple store for application state.
 *
 * @param {{ selected_id?: string | null, view?: ViewName, filters?: Partial<Filters>, board?: Partial<BoardState>, workspace?: Partial<WorkspaceState> }} [initial]
 * @returns {{ getState: () => AppState, setState: (patch: { selected_id?: string | null, view?: ViewName, filters?: Partial<Filters>, board?: Partial<BoardState>, workspace?: Partial<WorkspaceState> }) => void, subscribe: (fn: (s: AppState) => void) => () => void }}
 */
export function createStore(initial = {}) {
  const log = debug('state');
  /** @type {AppState} */
  let state = {
    selected_id: initial.selected_id ?? null,
    view: initial.view ?? 'issues',
    filters: {
      status: normalizeStatusFilters(initial.filters?.status),
      search: initial.filters?.search ?? '',
      type: normalizeTypeFilters(initial.filters?.type)
    },
    board: {
      closed_filter:
        initial.board?.closed_filter === '3' ||
        initial.board?.closed_filter === '7' ||
        initial.board?.closed_filter === 'today'
          ? initial.board?.closed_filter
          : 'today'
    },
    workspace: {
      current: initial.workspace?.current ?? null,
      available: initial.workspace?.available ?? []
    }
  };

  /** @type {Set<(s: AppState) => void>} */
  const subs = new Set();

  function emit() {
    for (const fn of Array.from(subs)) {
      try {
        fn(state);
      } catch {
        // ignore
      }
    }
  }

  return {
    getState() {
      return state;
    },
    /**
     * Update state. Nested filters can be partial.
     *
     * @param {{ selected_id?: string | null, filters?: Partial<Filters>, board?: Partial<BoardState>, workspace?: Partial<WorkspaceState> }} patch
     */
    setState(patch) {
      const requested_filters = {
        ...state.filters,
        ...(patch.filters || {})
      };
      /** @type {AppState} */
      const next = {
        ...state,
        ...patch,
        filters: {
          status: normalizeStatusFilters(requested_filters.status),
          search: String(requested_filters.search || ''),
          type: normalizeTypeFilters(requested_filters.type)
        },
        board: { ...state.board, ...(patch.board || {}) },
        workspace: {
          current:
            patch.workspace?.current !== undefined
              ? patch.workspace.current
              : state.workspace.current,
          available:
            patch.workspace?.available !== undefined
              ? patch.workspace.available
              : state.workspace.available
        }
      };
      // Avoid emitting if nothing changed (shallow compare)
      const workspace_changed =
        next.workspace.current?.path !== state.workspace.current?.path ||
        next.workspace.available.length !== state.workspace.available.length;
      if (
        next.selected_id === state.selected_id &&
        next.view === state.view &&
        arraysEqual(next.filters.status, state.filters.status) &&
        next.filters.search === state.filters.search &&
        arraysEqual(next.filters.type, state.filters.type) &&
        next.board.closed_filter === state.board.closed_filter &&
        !workspace_changed
      ) {
        return;
      }
      state = next;
      log('state change %o', {
        selected_id: state.selected_id,
        view: state.view,
        filters: state.filters,
        board: state.board,
        workspace: state.workspace.current?.path
      });
      emit();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    }
  };
}

/**
 * Normalize persisted or view-provided status filters. Ready is a computed
 * server-side view and is therefore mutually exclusive with stored statuses.
 *
 * @param {unknown} value
 * @returns {StatusFilter[]}
 */
export function normalizeStatusFilters(value) {
  const raw = Array.isArray(value) ? value : [value];
  const normalized = raw.map((item) => String(item || '').trim());
  if (normalized.includes('ready')) {
    return ['ready'];
  }
  const selected = new Set(normalized);
  return /** @type {StatusFilter[]} */ (
    STATUS_FILTER_ORDER.filter((status) => selected.has(status))
  );
}

/**
 * Normalize persisted or view-provided issue type filters in UI order.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeTypeFilters(value) {
  const raw = Array.isArray(value) ? value : [value];
  const selected = new Set(raw.map((item) => String(item || '').trim()));
  return TYPE_FILTER_ORDER.filter((type) => selected.has(type));
}

/**
 * @param {string[]} left
 * @param {string[]} right
 */
function arraysEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
