import { html, render } from 'lit-html';
import { createListSelectors } from '../data/list-selectors.js';
import { createIssueIdRenderer } from '../utils/issue-id-renderer.js';
import { createIssueRowRenderer } from './issue-row.js';

const EPICS_COLUMN_WIDTHS_STORAGE_KEY = 'beads-ui.epics.column-widths';
const EPICS_COLUMN_MAX_WIDTH = 1200;

/** @type {readonly EpicColumn[]} */
const EPIC_COLUMNS = Object.freeze([
  { key: 'id', label: 'ID', default_width: 150, min_width: 100 },
  { key: 'type', label: 'Type', default_width: 120, min_width: 90 },
  { key: 'title', label: 'Title', default_width: 360, min_width: 180 },
  { key: 'status', label: 'Status', default_width: 130, min_width: 110 },
  { key: 'assignee', label: 'Assignee', default_width: 180, min_width: 120 },
  { key: 'priority', label: 'Priority', default_width: 145, min_width: 120 },
  { key: 'updated', label: 'Updated', default_width: 180, min_width: 140 },
  {
    key: 'dependencies',
    label: 'Deps',
    default_width: 90,
    min_width: 70
  }
]);

/**
 * @typedef {{ id: string, title?: string, status?: string, priority?: number, issue_type?: string, assignee?: string, created_at?: string | number, updated_at?: string | number }} IssueLite
 * @typedef {'id'|'type'|'title'|'status'|'assignee'|'priority'|'updated'|'dependencies'} EpicColumnKey
 * @typedef {{ key: EpicColumnKey, label: string, default_width: number, min_width: number }} EpicColumn
 * @typedef {{ key: EpicColumnKey, start_x: number, start_width: number }} ActiveResize
 */

/**
 * Load validated Epics column widths from browser-local storage.
 *
 * @returns {Record<EpicColumnKey, number>}
 */
function loadEpicColumnWidths() {
  /** @type {Record<string, unknown>} */
  let stored_widths = {};
  try {
    const stored_value = window.localStorage.getItem(
      EPICS_COLUMN_WIDTHS_STORAGE_KEY
    );
    const parsed_value = stored_value ? JSON.parse(stored_value) : {};
    if (parsed_value && typeof parsed_value === 'object') {
      stored_widths = parsed_value;
    }
  } catch {
    // Storage can be unavailable or contain malformed data.
  }

  /** @type {Record<EpicColumnKey, number>} */
  const widths = /** @type {Record<EpicColumnKey, number>} */ ({});
  for (const column of EPIC_COLUMNS) {
    const stored_width = stored_widths[column.key];
    widths[column.key] =
      typeof stored_width === 'number' &&
      Number.isFinite(stored_width) &&
      stored_width >= column.min_width &&
      stored_width <= EPICS_COLUMN_MAX_WIDTH
        ? Math.round(stored_width)
        : column.default_width;
  }
  return widths;
}

/**
 * Epics view (push-only):
 * - Derives epic groups from the local issues store (no RPC reads).
 * - Subscribes to `tab:epics` for top-level membership.
 * - On expand, subscribes to `detail:{id}` (issue-detail) for the epic.
 * - Renders children from the epic detail's `dependents` list.
 * - Provides inline edits via mutations; UI re-renders on push.
 *
 * @param {HTMLElement} mount_element
 * @param {{ updateIssue: (input: any) => Promise<any> }} data
 * @param {(id: string) => void} goto_issue - Navigate to issue detail.
 * @param {{ subscribeList: (client_id: string, spec: { type: string, params?: Record<string, string|number|boolean> }) => Promise<() => Promise<void>> }} [subscriptions]
 * @param {{ snapshotFor?: (client_id: string) => any[], subscribe?: (fn: (client_id?: string) => void) => () => void }} [issue_stores]
 */
export function createEpicsView(
  mount_element,
  data,
  goto_issue,
  subscriptions = undefined,
  issue_stores = undefined
) {
  /** @type {any[]} */
  let groups = [];
  /** @type {Set<string>} */
  const expanded = new Set();
  /** @type {Set<string>} */
  const loading = new Set();
  /** @type {Map<string, () => Promise<void>>} */
  const epic_unsubs = new Map();
  /** @type {'priority'|'updated'|null} */
  let sort_key = null;
  /** @type {'asc'|'desc'} */
  let sort_direction = 'asc';
  const column_widths = loadEpicColumnWidths();
  /** @type {ActiveResize | null} */
  let active_resize = null;
  // Centralized selection helpers
  const selectors = issue_stores ? createListSelectors(issue_stores) : null;

  /**
   * @param {string | undefined} client_id
   */
  function shouldRefreshForClient(client_id) {
    if (!client_id || client_id === 'tab:epics') {
      return true;
    }
    if (!client_id.startsWith('detail:')) {
      return false;
    }
    return expanded.has(client_id.slice('detail:'.length));
  }

  // Live re-render on pushes: recompute groups when stores change
  if (selectors) {
    selectors.subscribe((client_id) => {
      if (!shouldRefreshForClient(client_id)) {
        return;
      }
      const had_none = groups.length === 0;
      groups = buildGroupsFromSnapshot();
      doRender();
      // Auto-expand first epic when transitioning from empty to non-empty
      if (had_none && groups.length > 0) {
        const first_id = String(groups[0].epic?.id || '');
        if (first_id && !expanded.has(first_id)) {
          void toggle(first_id);
        }
      }
    });
  }

  // Shared row renderer used for children rows
  const renderRow = createIssueRowRenderer({
    navigate: (id) => goto_issue(id),
    onUpdate: updateInline,
    requestRender: doRender,
    getSelectedId: () => null,
    row_class: 'epic-row'
  });

  function doRender() {
    render(template(), mount_element);
  }

  /**
   * @param {'priority'|'updated'} key
   */
  function toggleSort(key) {
    if (sort_key === key) {
      sort_direction = sort_direction === 'asc' ? 'desc' : 'asc';
    } else {
      sort_key = key;
      sort_direction = key === 'priority' ? 'asc' : 'desc';
    }
    doRender();
  }

  /**
   * @param {IssueLite} issue
   */
  function updatedValue(issue) {
    if (issue.updated_at === undefined || issue.updated_at === null) {
      return 0;
    }
    if (typeof issue.updated_at === 'number') {
      return issue.updated_at;
    }
    const parsed = Date.parse(issue.updated_at);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  /**
   * @param {IssueLite[]} issues
   */
  function sortChildren(issues) {
    if (!sort_key) {
      return issues;
    }
    const direction = sort_direction === 'asc' ? 1 : -1;
    return issues.slice().sort((a, b) => {
      const a_value =
        sort_key === 'priority' ? (a.priority ?? 2) : updatedValue(a);
      const b_value =
        sort_key === 'priority' ? (b.priority ?? 2) : updatedValue(b);
      if (a_value !== b_value) {
        return (a_value < b_value ? -1 : 1) * direction;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  /** Persist the current Epics column widths when storage is available. */
  function persistColumnWidths() {
    try {
      window.localStorage.setItem(
        EPICS_COLUMN_WIDTHS_STORAGE_KEY,
        JSON.stringify(column_widths)
      );
    } catch {
      // Resizing still works for the current view when storage is unavailable.
    }
  }

  /** @returns {number} */
  function tableWidth() {
    return EPIC_COLUMNS.reduce(
      (total, column) => total + column_widths[column.key],
      0
    );
  }

  /**
   * Apply one width to the matching column in every expanded epic table.
   *
   * @param {EpicColumn} column
   * @param {number} requested_width
   */
  function applyColumnWidth(column, requested_width) {
    const next_width = Math.min(
      EPICS_COLUMN_MAX_WIDTH,
      Math.max(column.min_width, Math.round(requested_width))
    );
    column_widths[column.key] = next_width;
    const cols = mount_element.querySelectorAll(
      `col[data-epic-column="${column.key}"]`
    );
    cols.forEach((col) => {
      /** @type {HTMLTableColElement} */ (col).style.width = `${next_width}px`;
    });
    const tables = mount_element.querySelectorAll('table.epics-children-table');
    tables.forEach((table) => {
      /** @type {HTMLTableElement} */ (table).style.width = `${tableWidth()}px`;
    });
    const handles = mount_element.querySelectorAll(
      `.column-resizer[data-epic-column="${column.key}"]`
    );
    handles.forEach((handle) => {
      handle.setAttribute('aria-valuenow', String(next_width));
    });
  }

  /** @param {PointerEvent} event */
  function resizeColumn(event) {
    if (!active_resize) {
      return;
    }
    const column = EPIC_COLUMNS.find(
      (candidate) => candidate.key === active_resize?.key
    );
    if (!column) {
      return;
    }
    applyColumnWidth(
      column,
      active_resize.start_width + event.clientX - active_resize.start_x
    );
  }

  /** Finish the active pointer resize and save its width. */
  function finishColumnResize() {
    if (!active_resize) {
      return;
    }
    active_resize = null;
    window.removeEventListener('pointermove', resizeColumn);
    window.removeEventListener('pointerup', finishColumnResize);
    window.removeEventListener('pointercancel', finishColumnResize);
    document.body.classList.remove('is-resizing-column');
    persistColumnWidths();
  }

  /**
   * @param {PointerEvent} event
   * @param {EpicColumn} column
   */
  function startColumnResize(event, column) {
    event.preventDefault();
    event.stopPropagation();
    finishColumnResize();
    active_resize = {
      key: column.key,
      start_x: event.clientX,
      start_width: column_widths[column.key]
    };
    window.addEventListener('pointermove', resizeColumn);
    window.addEventListener('pointerup', finishColumnResize);
    window.addEventListener('pointercancel', finishColumnResize);
    document.body.classList.add('is-resizing-column');
  }

  /**
   * @param {KeyboardEvent} event
   * @param {EpicColumn} column
   */
  function resizeColumnByKeyboard(event, column) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 40 : 16;
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    applyColumnWidth(column, column_widths[column.key] + step * direction);
    persistColumnWidths();
  }

  /**
   * Render a resizable Epics child-table header.
   *
   * @param {EpicColumn} column
   */
  function columnHeader(column) {
    const is_sortable = column.key === 'priority' || column.key === 'updated';
    const is_active_sort = is_sortable && sort_key === column.key;
    return html`<th
      class="resizable-header"
      role="columnheader"
      aria-sort=${is_sortable
        ? is_active_sort
          ? sort_direction === 'asc'
            ? 'ascending'
            : 'descending'
          : 'none'
        : undefined}
    >
      ${is_sortable
        ? html`<button
            type="button"
            class="sort-header"
            @click=${() =>
              toggleSort(/** @type {'priority'|'updated'} */ (column.key))}
          >
            ${column.label}
          </button>`
        : column.label}
      <span
        class="column-resizer"
        data-epic-column=${column.key}
        role="separator"
        aria-label=${`Resize ${column.label} column`}
        aria-orientation="vertical"
        aria-valuemin=${String(column.min_width)}
        aria-valuemax=${String(EPICS_COLUMN_MAX_WIDTH)}
        aria-valuenow=${String(column_widths[column.key])}
        tabindex="0"
        @pointerdown=${
          /** @param {PointerEvent} event */ (event) =>
            startColumnResize(event, column)
        }
        @keydown=${
          /** @param {KeyboardEvent} event */ (event) =>
            resizeColumnByKeyboard(event, column)
        }
      ></span>
    </th>`;
  }

  function template() {
    if (!groups.length) {
      return html`<div class="panel__header muted">No epics found.</div>`;
    }
    return html`${groups.map((g) => groupTemplate(g))}`;
  }

  /**
   * @param {any} g
   */
  function groupTemplate(g) {
    const epic = g.epic || {};
    const id = String(epic.id || '');
    const is_open = expanded.has(id);
    // Compose children via selectors
    const list = sortChildren(
      selectors ? selectors.selectEpicChildren(id) : []
    );
    const is_loading = loading.has(id);
    return html`
      <div class="epic-group" data-epic-id=${id}>
        <div
          class="epic-header"
          @click=${() => toggle(id)}
          role="button"
          tabindex="0"
          aria-expanded=${is_open}
        >
          ${createIssueIdRenderer(id, { class_name: 'mono' })}
          <span class="text-truncate" style="margin-left:8px"
            >${epic.title || '(no title)'}</span
          >
          <span
            class="epic-progress"
            style="margin-left:auto; display:flex; align-items:center; gap:8px;"
          >
            <progress
              value=${Number(g.closed_children || 0)}
              max=${Math.max(1, Number(g.total_children || 0))}
            ></progress>
            <span class="muted mono"
              >${g.closed_children}/${g.total_children}</span
            >
          </span>
        </div>
        ${is_open
          ? html`<div class="epic-children">
              ${is_loading
                ? html`<div class="muted">Loading…</div>`
                : list.length === 0
                  ? html`<div class="muted">No issues found</div>`
                  : html`<div class="issues-table-scroll">
                      <table
                        class="table epics-children-table"
                        style=${`width: ${tableWidth()}px`}
                        role="grid"
                        aria-rowcount=${String(list.length)}
                        aria-colcount="8"
                      >
                        <colgroup>
                          ${EPIC_COLUMNS.map(
                            (column) =>
                              html`<col
                                data-epic-column=${column.key}
                                style=${`width: ${column_widths[column.key]}px`}
                              />`
                          )}
                        </colgroup>
                        <thead>
                          <tr role="row">
                            ${EPIC_COLUMNS.map(columnHeader)}
                          </tr>
                        </thead>
                        <tbody role="rowgroup">
                          ${list.map((it) => renderRow(it))}
                        </tbody>
                      </table>
                    </div>`}
            </div>`
          : null}
      </div>
    `;
  }

  /**
   * @param {string} id
   * @param {{ [k: string]: any }} patch
   */
  async function updateInline(id, patch) {
    return data.updateIssue({ id, ...patch });
  }

  /**
   * @param {string} epic_id
   */
  async function toggle(epic_id) {
    if (!expanded.has(epic_id)) {
      expanded.add(epic_id);
      loading.add(epic_id);
      doRender();
      // Subscribe to epic detail; children are rendered from `dependents`
      if (subscriptions && typeof subscriptions.subscribeList === 'function') {
        try {
          // Register store first to avoid dropping the initial snapshot
          try {
            if (issue_stores && /** @type {any} */ (issue_stores).register) {
              /** @type {any} */ (issue_stores).register(`detail:${epic_id}`, {
                type: 'issue-detail',
                params: { id: epic_id }
              });
            }
          } catch {
            // ignore
          }
          const u = await subscriptions.subscribeList(`detail:${epic_id}`, {
            type: 'issue-detail',
            params: { id: epic_id }
          });
          epic_unsubs.set(epic_id, u);
        } catch {
          // ignore subscription failures
        }
      }
      // Mark as not loading after subscribe attempt; membership will stream in
      loading.delete(epic_id);
    } else {
      expanded.delete(epic_id);
      // Unsubscribe when collapsing
      if (epic_unsubs.has(epic_id)) {
        try {
          const u = epic_unsubs.get(epic_id);
          if (u) {
            await u();
          }
        } catch {
          // ignore
        }
        epic_unsubs.delete(epic_id);
        try {
          if (issue_stores && /** @type {any} */ (issue_stores).unregister) {
            /** @type {any} */ (issue_stores).unregister(`detail:${epic_id}`);
          }
        } catch {
          // ignore
        }
      }
    }
    doRender();
  }

  /** Build groups from the current `tab:epics` snapshot. */
  function buildGroupsFromSnapshot() {
    /** @type {IssueLite[]} */
    const epic_entities =
      issue_stores && issue_stores.snapshotFor
        ? /** @type {IssueLite[]} */ (
            issue_stores.snapshotFor('tab:epics') || []
          )
        : [];
    const next_groups = [];
    for (const epic of epic_entities) {
      const dependents = Array.isArray(/** @type {any} */ (epic).dependents)
        ? /** @type {any[]} */ (/** @type {any} */ (epic).dependents)
        : [];
      // Prefer explicit counters when provided by server; otherwise derive
      const has_total = Number.isFinite(
        /** @type {any} */ (epic).total_children
      );
      const has_closed = Number.isFinite(
        /** @type {any} */ (epic).closed_children
      );
      const total = has_total
        ? Number(/** @type {any} */ (epic).total_children) || 0
        : dependents.length;
      let closed = has_closed
        ? Number(/** @type {any} */ (epic).closed_children) || 0
        : 0;
      if (!has_closed) {
        for (const d of dependents) {
          if (String(d.status || '') === 'closed') {
            closed++;
          }
        }
      }
      next_groups.push({
        epic,
        total_children: total,
        closed_children: closed
      });
    }
    return next_groups;
  }

  return {
    async load() {
      groups = buildGroupsFromSnapshot();
      doRender();
      // Auto-expand first epic on screen
      try {
        if (groups.length > 0) {
          const first_id = String(groups[0].epic?.id || '');
          if (first_id && !expanded.has(first_id)) {
            // This will render and load children lazily
            await toggle(first_id);
          }
        }
      } catch {
        // ignore auto-expand failures
      }
    }
  };
}
