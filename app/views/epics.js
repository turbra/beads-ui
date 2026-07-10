import { html, render } from 'lit-html';
import { createListSelectors } from '../data/list-selectors.js';
import { createIssueIdRenderer } from '../utils/issue-id-renderer.js';
import { createIssueRowRenderer } from './issue-row.js';

/**
 * @typedef {{ id: string, title?: string, status?: string, priority?: number, issue_type?: string, assignee?: string, created_at?: string | number, updated_at?: string | number }} IssueLite
 */

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
                  : html`<table
                      class="table"
                      role="grid"
                      aria-rowcount=${String(list.length)}
                      aria-colcount="8"
                    >
                      <colgroup>
                        <col style="width: 100px" />
                        <col style="width: 120px" />
                        <col />
                        <col style="width: 120px" />
                        <col style="width: 160px" />
                        <col style="width: 130px" />
                        <col style="width: 180px" />
                        <col style="width: 80px" />
                      </colgroup>
                      <thead>
                        <tr role="row">
                          <th role="columnheader">ID</th>
                          <th role="columnheader">Type</th>
                          <th role="columnheader">Title</th>
                          <th role="columnheader">Status</th>
                          <th role="columnheader">Assignee</th>
                          <th
                            role="columnheader"
                            aria-sort=${sort_key === 'priority'
                              ? sort_direction === 'asc'
                                ? 'ascending'
                                : 'descending'
                              : 'none'}
                          >
                            <button
                              type="button"
                              class="sort-header"
                              @click=${() => toggleSort('priority')}
                            >
                              Priority
                            </button>
                          </th>
                          <th
                            role="columnheader"
                            aria-sort=${sort_key === 'updated'
                              ? sort_direction === 'asc'
                                ? 'ascending'
                                : 'descending'
                              : 'none'}
                          >
                            <button
                              type="button"
                              class="sort-header"
                              @click=${() => toggleSort('updated')}
                            >
                              Updated
                            </button>
                          </th>
                          <th role="columnheader">Deps</th>
                        </tr>
                      </thead>
                      <tbody role="rowgroup">
                        ${list.map((it) => renderRow(it))}
                      </tbody>
                    </table>`}
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
