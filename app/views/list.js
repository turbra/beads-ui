import { html, render } from 'lit-html';
import { repeat } from 'lit-html/directives/repeat.js';
import { createListSelectors } from '../data/list-selectors.js';
import { ISSUE_TYPES, typeLabel } from '../utils/issue-type.js';
import { issueHashFor } from '../utils/issue-url.js';
import { debug } from '../utils/logging.js';
import { statusLabel } from '../utils/status.js';
import { createIssueRowRenderer } from './issue-row.js';

// List view implementation; requires a transport send function.

export const ISSUES_SEGMENT_SIZE = 200;

/**
 * @typedef {{ id: string, title?: string, status?: 'closed'|'open'|'in_progress', priority?: number, issue_type?: string, assignee?: string, labels?: string[], dependency_count?: number, dependent_count?: number, updated_at?: string | number }} Issue
 * @typedef {'id'|'type'|'title'|'status'|'assignee'|'priority'|'updated'|'dependencies'} SortKey
 */

/**
 * Create the Issues List view.
 *
 * @param {HTMLElement} mount_element - Element to render into.
 * @param {(type: string, payload?: unknown) => Promise<unknown>} sendFn - RPC transport.
 * @param {(hash: string) => void} [navigate_fn] - Navigation function (defaults to setting location.hash).
 * @param {{ getState: () => any, setState: (patch: any) => void, subscribe: (fn: (s:any)=>void)=>()=>void }} [store] - Optional state store.
 * @param {{ snapshotFor?: (client_id: string) => any[], subscribe?: (fn: () => void) => () => void, getStore?: (client_id: string) => unknown }} [issueStores]
 * @returns {{ load: () => Promise<void>, focusSearch: () => boolean, destroy: () => void }} View API.
 */
/**
 * Create the Issues List view.
 *
 * @param {HTMLElement} mount_element
 * @param {(type: string, payload?: unknown) => Promise<unknown>} sendFn
 * @param {(hash: string) => void} [navigateFn]
 * @param {{ getState: () => any, setState: (patch: any) => void, subscribe: (fn: (s:any)=>void)=>()=>void }} [store]
 * @param {{ snapshotFor?: (client_id: string) => any[], subscribe?: (fn: () => void) => () => void, getStore?: (client_id: string) => unknown }} [issue_stores]
 * @returns {{ load: () => Promise<void>, focusSearch: () => boolean, destroy: () => void }}
 */
export function createListView(
  mount_element,
  sendFn,
  navigateFn,
  store,
  issue_stores = undefined
) {
  const log = debug('views:list');
  /** @type {string[]} */
  let status_filters = [];
  /** @type {string} */
  let search_text = '';
  /** @type {string} */
  let search_draft = '';
  /** @type {Issue[]} */
  let issues_cache = [];
  /** @type {string[]} */
  let type_filters = [];
  /** @type {string | null} */
  let selected_id = store ? store.getState().selected_id : null;
  /** @type {null | (() => void)} */
  let unsubscribe = null;
  let status_dropdown_open = false;
  let type_dropdown_open = false;
  /** @type {SortKey|null} */
  let sort_key = null;
  /** @type {'asc'|'desc'} */
  let sort_direction = 'asc';
  /** @type {ReturnType<typeof setTimeout> | null} */
  let search_timer = null;
  let visible_limit = ISSUES_SEGMENT_SIZE;
  const can_track_subscription_identity =
    typeof issue_stores?.getStore === 'function';
  let subscription_identity = can_track_subscription_identity
    ? issue_stores.getStore?.('tab:issues')
    : undefined;

  function resetVisibleLimit() {
    visible_limit = ISSUES_SEGMENT_SIZE;
  }

  function resetForSubscriptionIdentityChange() {
    if (!can_track_subscription_identity) {
      return;
    }
    const next_identity = issue_stores?.getStore?.('tab:issues');
    if (next_identity !== subscription_identity) {
      subscription_identity = next_identity;
      resetVisibleLimit();
    }
  }

  /** Return exact server truncation metadata without inferring from row count. */
  function isIssueListTruncated() {
    const issue_store = /** @type {any} */ (
      issue_stores?.getStore?.('tab:issues')
    );
    return issue_store?.truncation?.() === true;
  }

  /**
   * Normalize legacy string filter to array format.
   *
   * @param {string | string[] | undefined} val
   * @returns {string[]}
   */
  function normalizeStatusFilter(val) {
    if (Array.isArray(val)) return val;
    if (typeof val === 'string' && val !== '' && val !== 'all') return [val];
    return [];
  }

  /**
   * Normalize legacy string filter to array format.
   *
   * @param {string | string[] | undefined} val
   * @returns {string[]}
   */
  function normalizeTypeFilter(val) {
    if (Array.isArray(val)) return val;
    if (typeof val === 'string' && val !== '') return [val];
    return [];
  }

  // Shared row renderer (used in template below)
  const row_renderer = createIssueRowRenderer({
    navigate: (id) => {
      const nav = navigateFn || ((h) => (window.location.hash = h));
      /** @type {'issues'|'epics'|'board'} */
      const view = store ? store.getState().view : 'issues';
      nav(issueHashFor(view, id));
    },
    onUpdate: updateInline,
    requestRender: doRender,
    getSelectedId: () => selected_id,
    row_class: 'issue-row'
  });

  /**
   * Toggle a status filter chip.
   *
   * @param {string} status
   */
  const toggleStatusFilter = async (status) => {
    if (status_filters.includes(status)) {
      status_filters = status_filters.filter((s) => s !== status);
    } else if (status === 'ready') {
      status_filters = ['ready'];
    } else {
      status_filters = [
        ...status_filters.filter((selected) => selected !== 'ready'),
        status
      ];
    }
    log('status toggle %s -> %o', status, status_filters);
    if (store) {
      store.setState({ filters: { status: status_filters } });
    }
    resetVisibleLimit();
    await load();
  };

  /**
   * Event: search input.
   */
  /**
   * @param {Event} ev
   */
  const onSearchInput = (ev) => {
    const input = /** @type {HTMLInputElement} */ (ev.currentTarget);
    search_draft = input.value;
    log('search input %s', search_draft);
    if (search_timer) {
      clearTimeout(search_timer);
    }
    search_timer = setTimeout(() => {
      search_timer = null;
      search_text = search_draft;
      if (store) {
        store.setState({ filters: { search: search_text } });
      }
      resetVisibleLimit();
      doRender();
    }, 120);
  };

  /**
   * Toggle a type filter chip.
   *
   * @param {string} type
   */
  const toggleTypeFilter = (type) => {
    if (type_filters.includes(type)) {
      type_filters = type_filters.filter((t) => t !== type);
    } else {
      type_filters = [...type_filters, type];
    }
    log('type toggle %s -> %o', type, type_filters);
    if (store) {
      store.setState({ filters: { type: type_filters } });
    }
    resetVisibleLimit();
    doRender();
  };

  /**
   * Toggle status dropdown open/closed.
   *
   * @param {Event} e
   */
  const toggleStatusDropdown = (e) => {
    e.stopPropagation();
    status_dropdown_open = !status_dropdown_open;
    type_dropdown_open = false;
    doRender();
  };

  /**
   * Toggle type dropdown open/closed.
   *
   * @param {Event} e
   */
  const toggleTypeDropdown = (e) => {
    e.stopPropagation();
    type_dropdown_open = !type_dropdown_open;
    status_dropdown_open = false;
    doRender();
  };

  /**
   * Get display text for dropdown trigger.
   *
   * @param {string[]} selected
   * @param {string} label
   * @param {(val: string) => string} formatter
   * @returns {string}
   */
  function getDropdownDisplayText(selected, label, formatter) {
    if (selected.length === 0) return `${label}: Any`;
    if (selected.length === 1) return `${label}: ${formatter(selected[0])}`;
    return `${label} (${selected.length})`;
  }

  // Initialize filters from store on first render so reload applies persisted state
  if (store) {
    const s = store.getState();
    if (s && s.filters && typeof s.filters === 'object') {
      status_filters = normalizeStatusFilter(s.filters.status);
      search_text = s.filters.search || '';
      search_draft = search_text;
      type_filters = normalizeTypeFilter(s.filters.type);
    }
  }
  // Initial values are reflected via bound `.value` in the template
  // Compose helpers: centralize membership + entity selection + sorting
  const selectors = issue_stores ? createListSelectors(issue_stores) : null;

  /**
   * @param {SortKey} key
   */
  function toggleSort(key) {
    if (sort_key === key) {
      sort_direction = sort_direction === 'asc' ? 'desc' : 'asc';
    } else {
      sort_key = key;
      sort_direction = key === 'updated' ? 'desc' : 'asc';
    }
    resetVisibleLimit();
    doRender();
  }

  /**
   * @param {Issue} issue
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

  const STATUS_SORT_ORDER = Object.freeze({
    open: 0,
    in_progress: 1,
    closed: 2
  });

  /**
   * @param {Issue} issue
   * @param {SortKey} key
   * @returns {string | number}
   */
  function sortValue(issue, key) {
    switch (key) {
      case 'id':
        return issue.id.toLocaleLowerCase();
      case 'type':
        return String(issue.issue_type || '').toLocaleLowerCase();
      case 'title':
        return String(issue.title || '').toLocaleLowerCase();
      case 'status':
        return STATUS_SORT_ORDER[issue.status || 'open'];
      case 'assignee':
        return String(issue.assignee || '').toLocaleLowerCase();
      case 'priority':
        return issue.priority ?? 2;
      case 'updated':
        return updatedValue(issue);
      case 'dependencies':
        return (
          Number(issue.dependency_count || 0) +
          Number(issue.dependent_count || 0)
        );
    }
  }

  /**
   * @param {Issue[]} issues
   */
  function sortIssues(issues) {
    const active_sort_key = sort_key;
    if (!active_sort_key) {
      return issues;
    }
    const direction = sort_direction === 'asc' ? 1 : -1;
    return issues.slice().sort((a, b) => {
      const a_value = sortValue(a, active_sort_key);
      const b_value = sortValue(b, active_sort_key);
      if (a_value !== b_value) {
        return (a_value < b_value ? -1 : 1) * direction;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  /**
   * @param {SortKey} key
   * @param {string} label
   */
  function sortHeader(key, label) {
    const active = sort_key === key;
    return html`<th
      role="columnheader"
      aria-sort=${active
        ? sort_direction === 'asc'
          ? 'ascending'
          : 'descending'
        : 'none'}
    >
      <button
        type="button"
        class="sort-header"
        aria-label=${`Sort by ${label}`}
        @click=${() => toggleSort(key)}
      >
        ${label}
      </button>
    </th>`;
  }

  function clearFilters() {
    status_filters = [];
    type_filters = [];
    search_text = '';
    search_draft = '';
    if (search_timer) {
      clearTimeout(search_timer);
      search_timer = null;
    }
    if (store) {
      store.setState({ filters: { status: [], type: [], search: '' } });
    }
    resetVisibleLimit();
    void load();
  }

  /**
   * Reveal one more bounded segment without disturbing the scroll position.
   *
   * @param {Event} event
   */
  function showMore(event) {
    const trigger = /** @type {HTMLElement} */ (event.currentTarget);
    const restore_trigger_focus = trigger === document.activeElement;
    const list_root = /** @type {HTMLElement | null} */ (
      mount_element.querySelector('#list-root')
    );
    const previous_scroll = list_root?.scrollTop ?? 0;
    visible_limit += ISSUES_SEGMENT_SIZE;
    doRender();
    const next_root = /** @type {HTMLElement | null} */ (
      mount_element.querySelector('#list-root')
    );
    if (next_root) {
      next_root.scrollTop = previous_scroll;
    }
    const next_trigger = /** @type {HTMLElement | null} */ (
      mount_element.querySelector('.progressive-list__more')
    );
    if (next_trigger && restore_trigger_focus) {
      next_trigger.focus();
    } else if (restore_trigger_focus) {
      const status = /** @type {HTMLElement | null} */ (
        mount_element.querySelector('.progressive-list__status')
      );
      status?.focus();
    }
  }

  function openCreateIssue() {
    const button = /** @type {HTMLButtonElement | null} */ (
      document.getElementById('new-issue-btn')
    );
    button?.click();
  }

  /**
   * Build lit-html template for the list view.
   */
  function template() {
    let filtered = issues_cache;
    if (status_filters.length > 0 && !status_filters.includes('ready')) {
      filtered = filtered.filter((it) =>
        status_filters.includes(String(it.status || ''))
      );
    }
    if (search_text) {
      const needle = search_text.toLowerCase();
      filtered = filtered.filter((it) => {
        const searchable = [
          it.id,
          it.title || '',
          it.assignee || '',
          ...(Array.isArray(it.labels) ? it.labels : [])
        ];
        return searchable.some((value) =>
          String(value).toLowerCase().includes(needle)
        );
      });
    }
    if (type_filters.length > 0) {
      filtered = filtered.filter((it) =>
        type_filters.includes(String(it.issue_type || ''))
      );
    }
    filtered = sortIssues(filtered);
    const total_count = filtered.length;
    const visible = filtered.slice(0, visible_limit);
    const visible_count = visible.length;
    const has_more = visible_count < total_count;
    const has_active_filters =
      status_filters.length > 0 ||
      type_filters.length > 0 ||
      search_text !== '';

    return html`
      <div class="panel__header">
        <div class="filter-dropdown ${status_dropdown_open ? 'is-open' : ''}">
          <button
            class="filter-dropdown__trigger"
            @click=${toggleStatusDropdown}
            aria-expanded=${String(status_dropdown_open)}
            aria-controls="status-filter-menu"
            aria-haspopup="true"
          >
            ${getDropdownDisplayText(status_filters, 'Status', statusLabel)}
            <span class="filter-dropdown__arrow">▾</span>
          </button>
          <div class="filter-dropdown__menu" id="status-filter-menu">
            ${['ready', 'open', 'in_progress', 'closed'].map(
              (s) => html`
                <label class="filter-dropdown__option">
                  <input
                    type="checkbox"
                    .checked=${status_filters.includes(s)}
                    @change=${() => toggleStatusFilter(s)}
                  />
                  ${s === 'ready' ? 'Ready' : statusLabel(s)}
                </label>
              `
            )}
          </div>
        </div>
        <div class="filter-dropdown ${type_dropdown_open ? 'is-open' : ''}">
          <button
            class="filter-dropdown__trigger"
            @click=${toggleTypeDropdown}
            aria-expanded=${String(type_dropdown_open)}
            aria-controls="type-filter-menu"
            aria-haspopup="true"
          >
            ${getDropdownDisplayText(type_filters, 'Types', typeLabel)}
            <span class="filter-dropdown__arrow">▾</span>
          </button>
          <div class="filter-dropdown__menu" id="type-filter-menu">
            ${ISSUE_TYPES.map(
              (t) => html`
                <label class="filter-dropdown__option">
                  <input
                    type="checkbox"
                    .checked=${type_filters.includes(t)}
                    @change=${() => toggleTypeFilter(t)}
                  />
                  ${typeLabel(t)}
                </label>
              `
            )}
          </div>
        </div>
        <input
          id="issues-search"
          type="search"
          placeholder="Search…"
          aria-label="Search issues by ID, title, assignee, or label"
          aria-keyshortcuts="/"
          @input=${onSearchInput}
          .value=${search_draft}
        />
      </div>
      <div class="panel__body" id="list-root">
        ${isIssueListTruncated()
          ? html`<div class="list-boundary-notice" role="status">
              Showing the first ${issues_cache.length} issues. Search and
              filters apply only to these loaded results.
            </div>`
          : null}
        ${filtered.length === 0
          ? html`<div class="issues-block">
              <div class="list-empty-state">
                <div class="muted">
                  ${has_active_filters ? 'No matching issues' : 'No issues'}
                </div>
                ${has_active_filters
                  ? html`<button type="button" @click=${clearFilters}>
                      Clear filters
                    </button>`
                  : html`<button
                      type="button"
                      class="primary"
                      @click=${openCreateIssue}
                    >
                      Create issue
                    </button>`}
              </div>
            </div>`
          : html`<div class="issues-block">
              <table
                class="table"
                role="grid"
                aria-rowcount=${String(total_count + 1)}
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
                  <tr role="row" aria-rowindex="1">
                    ${sortHeader('id', 'ID')} ${sortHeader('type', 'Type')}
                    ${sortHeader('title', 'Title')}
                    ${sortHeader('status', 'Status')}
                    ${sortHeader('assignee', 'Assignee')}
                    ${sortHeader('priority', 'Priority')}
                    ${sortHeader('updated', 'Updated')}
                    ${sortHeader('dependencies', 'Deps')}
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  ${repeat(visible, (it) => it.id, row_renderer)}
                </tbody>
              </table>
              <div class="progressive-list">
                <div
                  class="progressive-list__status"
                  id="issues-visible-status"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  tabindex="-1"
                >
                  Showing ${visible_count} of ${total_count} issues
                </div>
                ${has_more
                  ? html`<button
                      type="button"
                      class="progressive-list__more"
                      aria-describedby="issues-visible-status"
                      @click=${showMore}
                    >
                      Show
                      ${Math.min(
                        ISSUES_SEGMENT_SIZE,
                        total_count - visible_count
                      )}
                      more
                    </button>`
                  : null}
              </div>
            </div>`}
      </div>
    `;
  }

  /**
   * Render the current issues_cache with filters applied.
   */
  function doRender() {
    render(template(), mount_element);
    const rows = mount_element.querySelectorAll('tbody tr.issue-row');
    rows.forEach((row, index) => {
      row.setAttribute('aria-rowindex', String(index + 2));
    });
  }

  // Initial render (header + body shell with current state)
  doRender();
  // no separate ready checkbox when using select option

  /**
   * Update minimal fields inline via ws mutations and refresh that row's data.
   *
   * @param {string} id
   * @param {{ [k: string]: any }} patch
   */
  async function updateInline(id, patch) {
    log('updateInline %s %o', id, Object.keys(patch));
    let result = null;
    if (typeof patch.title === 'string') {
      result = await sendFn('edit-text', {
        id,
        field: 'title',
        value: patch.title
      });
    }
    if (typeof patch.assignee === 'string') {
      result = await sendFn('update-assignee', {
        id,
        assignee: patch.assignee
      });
    }
    if (typeof patch.status === 'string') {
      result = await sendFn('update-status', { id, status: patch.status });
    }
    if (typeof patch.priority === 'number') {
      result = await sendFn('update-priority', {
        id,
        priority: patch.priority
      });
    }
    return result;
  }

  /**
   * Load issues from local push stores and re-render.
   */
  async function load() {
    log('load');
    resetForSubscriptionIdentityChange();
    // Preserve scroll position to avoid jarring jumps on live refresh
    const beforeEl = /** @type {HTMLElement|null} */ (
      mount_element.querySelector('#list-root')
    );
    const prevScroll = beforeEl ? beforeEl.scrollTop : 0;
    // Compose items from subscriptions membership and issues store entities
    try {
      if (selectors) {
        issues_cache = /** @type {Issue[]} */ (
          selectors.selectIssuesFor('tab:issues')
        );
      } else {
        issues_cache = [];
      }
    } catch (err) {
      log('load failed: %o', err);
      issues_cache = [];
    }
    doRender();
    // Restore scroll position if possible
    try {
      const afterEl = /** @type {HTMLElement|null} */ (
        mount_element.querySelector('#list-root')
      );
      if (afterEl && prevScroll > 0) {
        afterEl.scrollTop = prevScroll;
      }
    } catch {
      // ignore
    }
  }

  // Keyboard navigation
  mount_element.tabIndex = 0;
  mount_element.addEventListener('keydown', (ev) => {
    // Grid cell Up/Down navigation when focus is inside the table and not within
    // an editable control (input/textarea/select). Preserves column position.
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const tgt = /** @type {HTMLElement} */ (ev.target);
      const table =
        tgt && typeof tgt.closest === 'function'
          ? tgt.closest('#list-root table.table')
          : null;
      if (table) {
        // Do not intercept when inside native editable controls
        const in_editable = Boolean(
          tgt &&
          typeof tgt.closest === 'function' &&
          (tgt.closest('input') ||
            tgt.closest('textarea') ||
            tgt.closest('select'))
        );
        if (!in_editable) {
          const cell =
            tgt && typeof tgt.closest === 'function' ? tgt.closest('td') : null;
          if (cell && cell.parentElement) {
            const row = /** @type {HTMLTableRowElement} */ (cell.parentElement);
            const tbody = /** @type {HTMLTableSectionElement|null} */ (
              row.parentElement
            );
            if (tbody && tbody.querySelectorAll) {
              const rows = Array.from(tbody.querySelectorAll('tr'));
              const row_idx = Math.max(0, rows.indexOf(row));
              const col_idx = cell.cellIndex || 0;
              const next_idx =
                ev.key === 'ArrowDown'
                  ? Math.min(row_idx + 1, rows.length - 1)
                  : Math.max(row_idx - 1, 0);
              const next_row = rows[next_idx];
              const next_cell =
                next_row && next_row.cells ? next_row.cells[col_idx] : null;
              if (next_cell) {
                const focusable = /** @type {HTMLElement|null} */ (
                  next_cell.querySelector(
                    'button:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href], select:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled])'
                  )
                );
                if (focusable && typeof focusable.focus === 'function') {
                  ev.preventDefault();
                  focusable.focus();
                  return;
                }
              }
            }
          }
        }
      }
    }

    const tbody = /** @type {HTMLTableSectionElement|null} */ (
      mount_element.querySelector('#list-root tbody')
    );
    const items = tbody ? tbody.querySelectorAll('tr') : [];
    if (items.length === 0) {
      return;
    }
    let idx = 0;
    if (selected_id) {
      const arr = Array.from(items);
      idx = arr.findIndex((el) => {
        const did = el.getAttribute('data-issue-id') || '';
        return did === selected_id;
      });
      if (idx < 0) {
        idx = 0;
      }
    }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      const next = items[Math.min(idx + 1, items.length - 1)];
      const next_id = next ? next.getAttribute('data-issue-id') : '';
      const set = next_id ? next_id : null;
      if (store && set) {
        store.setState({ selected_id: set });
      }
      selected_id = set;
      doRender();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      const prev = items[Math.max(idx - 1, 0)];
      const prev_id = prev ? prev.getAttribute('data-issue-id') : '';
      const set = prev_id ? prev_id : null;
      if (store && set) {
        store.setState({ selected_id: set });
      }
      selected_id = set;
      doRender();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const current = items[idx];
      const id = current ? current.getAttribute('data-issue-id') : '';
      if (id) {
        const nav = navigateFn || ((h) => (window.location.hash = h));
        /** @type {'issues'|'epics'|'board'} */
        const view = store ? store.getState().view : 'issues';
        nav(issueHashFor(view, id));
      }
    }
  });

  // Click outside to close dropdowns
  /** @param {MouseEvent} e */
  const clickOutsideHandler = (e) => {
    const target = /** @type {HTMLElement|null} */ (e.target);
    if (target && !target.closest('.filter-dropdown')) {
      if (status_dropdown_open || type_dropdown_open) {
        status_dropdown_open = false;
        type_dropdown_open = false;
        doRender();
      }
    }
  };
  document.addEventListener('click', clickOutsideHandler);

  // Keep selection in sync with store
  if (store) {
    unsubscribe = store.subscribe((s) => {
      if (s.selected_id !== selected_id) {
        selected_id = s.selected_id;
        log('selected %s', selected_id || '(none)');
        doRender();
      }
      if (s.filters && typeof s.filters === 'object') {
        const next_status = normalizeStatusFilter(s.filters.status);
        const next_search = s.filters.search || '';
        let needs_render = false;
        const status_changed =
          JSON.stringify(next_status) !== JSON.stringify(status_filters);
        if (status_changed) {
          status_filters = next_status;
          resetVisibleLimit();
          // Reload on any status scope change to keep cache correct
          void load();
          return;
        }
        if (next_search !== search_text) {
          search_text = next_search;
          search_draft = next_search;
          resetVisibleLimit();
          needs_render = true;
        }
        const next_type_arr = normalizeTypeFilter(s.filters.type);
        const type_changed =
          JSON.stringify(next_type_arr) !== JSON.stringify(type_filters);
        if (type_changed) {
          type_filters = next_type_arr;
          resetVisibleLimit();
          needs_render = true;
        }
        if (needs_render) {
          doRender();
        }
      }
    });
  }

  // Live updates: recompose and re-render when issue stores change
  /** @type {(() => void) | null} */
  let unsubscribe_selectors = null;
  if (selectors) {
    unsubscribe_selectors = selectors.subscribe(() => {
      try {
        resetForSubscriptionIdentityChange();
        issues_cache = /** @type {Issue[]} */ (
          selectors.selectIssuesFor('tab:issues')
        );
        doRender();
      } catch {
        // ignore
      }
    }, 'tab:issues');
  }

  return {
    load,
    focusSearch() {
      const input = /** @type {HTMLInputElement | null} */ (
        mount_element.querySelector('#issues-search')
      );
      if (!input || input.disabled || !input.isConnected) {
        return false;
      }
      input.focus();
      return document.activeElement === input;
    },
    destroy() {
      mount_element.replaceChildren();
      if (search_timer) {
        clearTimeout(search_timer);
        search_timer = null;
      }
      document.removeEventListener('click', clickOutsideHandler);
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (unsubscribe_selectors) {
        unsubscribe_selectors();
        unsubscribe_selectors = null;
      }
    }
  };
}
