import { html, render } from 'lit-html';
import { repeat } from 'lit-html/directives/repeat.js';
import { createListSelectors } from '../data/list-selectors.js';
import { cmpClosedDesc } from '../data/sort.js';
import { createIssueIdRenderer } from '../utils/issue-id-renderer.js';
import { debug } from '../utils/logging.js';
import { createPriorityBadge } from '../utils/priority-badge.js';
import { showToast } from '../utils/toast.js';
import { createTypeBadge } from '../utils/type-badge.js';

/**
 * @typedef {{
 *   id: string,
 *   title?: string,
 *   status?: 'open'|'in_progress'|'closed',
 *   priority?: number,
 *   issue_type?: string,
 *   created_at?: number,
 *   updated_at?: number,
 *   closed_at?: number,
 *   blocked_by_count?: number,
 *   blocked_by?: string[]
 * }} IssueLite
 */

/**
 * Map column IDs to their corresponding status values.
 *
 * @type {Record<string, 'open'|'in_progress'|'closed'>}
 */
const COLUMN_STATUS_MAP = {
  'ready-col': 'open',
  'in-progress-col': 'in_progress',
  'closed-col': 'closed'
};

/** @type {Readonly<Record<string, string>>} */
const COLUMN_DESCRIPTIONS = Object.freeze({
  'blocked-col': 'Open issues waiting on unresolved dependencies',
  'ready-col': 'Open issues with no unresolved dependencies',
  'in-progress-col': 'Issues currently being worked',
  'closed-col': 'Recently completed issues'
});

const BOARD_CLIENT_IDS = [
  'tab:board:ready',
  'tab:board:blocked',
  'tab:board:in-progress',
  'tab:board:closed'
];

/**
 * Create the Board view with Blocked, Ready, In progress, Closed.
 * Push-only: derives items from per-subscription stores.
 *
 * Sorting rules:
 * - Ready/Blocked/In progress: priority asc, then created_at asc.
 * - Closed: closed_at desc.
 *
 * @param {HTMLElement} mount_element
 * @param {(id: string) => void} gotoIssue - Navigate to issue detail.
 * @param {{ getState: () => any, setState: (patch: any) => void, subscribe?: (fn: (s:any)=>void)=>()=>void }} [store]
 * @param {{ snapshotFor?: (client_id: string) => any[], subscribe?: (fn: () => void) => () => void }} [issueStores]
 * @param {(type: string, payload: unknown) => Promise<unknown>} [transport] - Transport function for sending updates
 * @returns {{ load: () => Promise<void>, clear: () => void }}
 */
export function createBoardView(
  mount_element,
  gotoIssue,
  store,
  issueStores = undefined,
  transport = undefined
) {
  const log = debug('views:board');
  /** @type {IssueLite[]} */
  let list_ready = [];
  /** @type {IssueLite[]} */
  let list_blocked = [];
  /** @type {IssueLite[]} */
  let list_in_progress = [];
  /** @type {IssueLite[]} */
  let list_closed = [];
  /** @type {IssueLite[]} */
  let list_closed_raw = [];
  // Centralized selection helpers
  const selectors = issueStores ? createListSelectors(issueStores) : null;

  /**
   * Closed column filter mode.
   * 'today' → items with closed_at since local day start
   * '3' → last 3 days; '7' → last 7 days
   *
   * @type {'today'|'3'|'7'}
   */
  let closed_filter_mode = 'today';
  if (store) {
    try {
      const s = store.getState();
      const cf =
        s && s.board ? String(s.board.closed_filter || 'today') : 'today';
      if (cf === 'today' || cf === '3' || cf === '7') {
        closed_filter_mode = /** @type {any} */ (cf);
      }
    } catch {
      // ignore store init errors
    }
  }

  function template() {
    return html`
      <div class="panel__body board-root">
        ${columnTemplate(
          'Blocked by dependencies',
          'blocked-col',
          list_blocked
        )}
        ${columnTemplate('Ready to work', 'ready-col', list_ready)}
        ${columnTemplate('In Progress', 'in-progress-col', list_in_progress)}
        ${columnTemplate('Closed', 'closed-col', list_closed)}
      </div>
    `;
  }

  /**
   * @param {string} title
   * @param {string} id
   * @param {IssueLite[]} items
   */
  function columnTemplate(title, id, items) {
    const item_count = Array.isArray(items) ? items.length : 0;
    const count_label = item_count === 1 ? '1 issue' : `${item_count} issues`;
    return html`
      <section class="board-column" id=${id}>
        <header
          class="board-column__header"
          id=${id + '-header'}
          role="heading"
          aria-level="2"
        >
          <div class="board-column__heading">
            <div class="board-column__title">
              <span class="board-column__title-text">${title}</span>
              <span class="badge board-column__count" aria-label=${count_label}>
                ${item_count}
              </span>
            </div>
            <div class="board-column__description">
              ${COLUMN_DESCRIPTIONS[id] || ''}
            </div>
          </div>
          ${id === 'closed-col'
            ? html`<label class="board-closed-filter">
                <span class="visually-hidden">Filter closed issues</span>
                <select
                  id="closed-filter"
                  aria-label="Filter closed issues"
                  @change=${onClosedFilterChange}
                >
                  <option
                    value="today"
                    ?selected=${closed_filter_mode === 'today'}
                  >
                    Today
                  </option>
                  <option value="3" ?selected=${closed_filter_mode === '3'}>
                    Last 3 days
                  </option>
                  <option value="7" ?selected=${closed_filter_mode === '7'}>
                    Last 7 days
                  </option>
                </select>
              </label>`
            : ''}
        </header>
        <div
          class="board-column__body"
          role="list"
          aria-labelledby=${id + '-header'}
        >
          ${repeat(
            items,
            (it) => it.id,
            (it) => cardTemplate(it, title, id)
          )}
        </div>
      </section>
    `;
  }

  /**
   * @param {IssueLite} it
   * @param {string} column_title
   * @param {string} column_id
   */
  function cardTemplate(it, column_title, column_id) {
    const title = it.title || '(no title)';
    return html`
      <article
        class="board-card"
        data-issue-id=${it.id}
        role="listitem"
        tabindex="-1"
        aria-label=${`Issue ${title} - Column ${column_title}`}
        draggable="true"
        @click=${(/** @type {MouseEvent} */ ev) => onCardClick(ev, it.id)}
        @dragstart=${(/** @type {DragEvent} */ ev) => onDragStart(ev, it.id)}
        @dragend=${onDragEnd}
      >
        <div class="board-card__title text-truncate">${title}</div>
        <div class="board-card__meta">
          ${createTypeBadge(it.issue_type)} ${createPriorityBadge(it.priority)}
          ${createIssueIdRenderer(it.id, { class_name: 'mono' })}
        </div>
        ${column_id === 'blocked-col' ? blockedByTemplate(it) : null}
      </article>
    `;
  }

  /**
   * Render dependency context for an issue returned by `bd blocked`.
   *
   * @param {IssueLite} issue
   */
  function blockedByTemplate(issue) {
    const blocker_ids = Array.isArray(issue.blocked_by)
      ? issue.blocked_by.map(String).filter(Boolean)
      : [];
    const reported_count = Number(issue.blocked_by_count || 0);
    const blocker_count = Math.max(reported_count, blocker_ids.length);
    if (blocker_count === 0) {
      return null;
    }
    return html`<div class="board-card__blocked-by">
      <div class="board-card__blocked-label">
        Blocked by ${blocker_count}
        ${blocker_count === 1 ? 'dependency' : 'dependencies'}
      </div>
      ${blocker_ids.length > 0
        ? html`<div class="board-card__blockers">
            ${blocker_ids.map(
              (blocker_id) =>
                html`<button
                  type="button"
                  class="board-card__blocker-id"
                  aria-label=${`Open blocking issue ${blocker_id}`}
                  @click=${(/** @type {MouseEvent} */ event) => {
                    event.stopPropagation();
                    gotoIssue(blocker_id);
                  }}
                >
                  ${blocker_id}
                </button>`
            )}
          </div>`
        : null}
    </div>`;
  }

  /** @type {string|null} */
  let dragging_id = null;

  /**
   * Handle card click, ignoring clicks during drag operations.
   *
   * @param {MouseEvent} ev
   * @param {string} id
   */
  function onCardClick(ev, id) {
    // Only navigate if this wasn't a drag operation
    if (!dragging_id) {
      gotoIssue(id);
    }
  }

  /**
   * Handle drag start: store issue id in dataTransfer and add dragging class.
   *
   * @param {DragEvent} ev
   * @param {string} id
   */
  function onDragStart(ev, id) {
    dragging_id = id;
    if (ev.dataTransfer) {
      ev.dataTransfer.setData('text/plain', id);
      ev.dataTransfer.effectAllowed = 'move';
    }
    const target = /** @type {HTMLElement} */ (ev.target);
    target.classList.add('board-card--dragging');
    log('dragstart %s', id);
  }

  /**
   * Handle drag end: remove dragging class.
   *
   * @param {DragEvent} ev
   */
  function onDragEnd(ev) {
    const target = /** @type {HTMLElement} */ (ev.target);
    target.classList.remove('board-card--dragging');
    // Clear any highlighted drop target
    clearDropTarget();
    // Clear dragging_id after a short delay to allow click event to check it
    setTimeout(() => {
      dragging_id = null;
    }, 0);
    log('dragend');
  }

  /**
   * Clear the currently highlighted drop target column.
   */
  function clearDropTarget() {
    /** @type {HTMLElement[]} */
    const all_cols = Array.from(
      mount_element.querySelectorAll('.board-column--drag-over')
    );
    for (const c of all_cols) {
      c.classList.remove('board-column--drag-over');
    }
    current_drop_target = null;
  }

  /**
   * Update issue status via WebSocket transport.
   *
   * @param {string} issue_id
   * @param {'open'|'in_progress'|'closed'} new_status
   * @param {string} [success_message]
   */
  async function updateIssueStatus(
    issue_id,
    new_status,
    success_message = 'Status updated'
  ) {
    if (!transport) {
      log('no transport available, status update skipped');
      showToast('Cannot update status: not connected', 'error');
      return;
    }
    try {
      log('update-status %s → %s', issue_id, new_status);
      await transport('update-status', { id: issue_id, status: new_status });
      showToast(success_message, 'success', 2500);
    } catch (err) {
      log('update-status failed: %o', err);
      showToast('Failed to update status', 'error');
    }
  }

  function doRender() {
    render(template(), mount_element);
    postRenderEnhance();
  }

  /**
   * Enhance rendered board with a11y and keyboard navigation.
   * - Roving tabindex per column (first card tabbable).
   * - ArrowUp/ArrowDown within column.
   * - ArrowLeft/ArrowRight to adjacent non-empty column (focus top card).
   * - Enter/Space to open details for focused card.
   */
  function postRenderEnhance() {
    try {
      /** @type {HTMLElement[]} */
      const columns = Array.from(
        mount_element.querySelectorAll('.board-column')
      );
      for (const col of columns) {
        const body = /** @type {HTMLElement|null} */ (
          col.querySelector('.board-column__body')
        );
        if (!body) {
          continue;
        }
        /** @type {HTMLElement[]} */
        const cards = Array.from(body.querySelectorAll('.board-card'));
        for (const card of cards) {
          card.tabIndex = -1;
        }
        if (cards.length > 0) {
          cards[0].tabIndex = 0;
        }
      }
    } catch {
      // non-fatal
    }
  }

  // Delegate keyboard handling from mount_element
  mount_element.addEventListener('keydown', (ev) => {
    const target = ev.target;
    if (!target || !(target instanceof HTMLElement)) {
      return;
    }
    // Do not intercept keys inside editable controls
    const tag = String(target.tagName || '').toLowerCase();
    if (
      tag === 'input' ||
      tag === 'textarea' ||
      tag === 'select' ||
      target.isContentEditable === true
    ) {
      return;
    }
    const card = target.closest('.board-card');
    if (!card) {
      return;
    }
    const key = String(ev.key || '');
    if (key === 'Enter' || key === ' ') {
      ev.preventDefault();
      const id = card.getAttribute('data-issue-id');
      if (id) {
        gotoIssue(id);
      }
      return;
    }
    if (
      key !== 'ArrowUp' &&
      key !== 'ArrowDown' &&
      key !== 'ArrowLeft' &&
      key !== 'ArrowRight'
    ) {
      return;
    }
    ev.preventDefault();
    // Column context
    const col = /** @type {HTMLElement|null} */ (card.closest('.board-column'));
    if (!col) {
      return;
    }
    const body = col.querySelector('.board-column__body');
    if (!body) {
      return;
    }
    /** @type {HTMLElement[]} */
    const cards = Array.from(body.querySelectorAll('.board-card'));
    const idx = cards.indexOf(/** @type {HTMLElement} */ (card));
    if (idx === -1) {
      return;
    }
    if (key === 'ArrowDown' && idx < cards.length - 1) {
      moveFocus(cards[idx], cards[idx + 1]);
      return;
    }
    if (key === 'ArrowUp' && idx > 0) {
      moveFocus(cards[idx], cards[idx - 1]);
      return;
    }
    if (key === 'ArrowRight' || key === 'ArrowLeft') {
      // Find adjacent column with at least one card
      /** @type {HTMLElement[]} */
      const cols = Array.from(mount_element.querySelectorAll('.board-column'));
      const col_idx = cols.indexOf(col);
      if (col_idx === -1) {
        return;
      }
      const dir = key === 'ArrowRight' ? 1 : -1;
      let next_idx = col_idx + dir;
      /** @type {HTMLElement|null} */
      let target_col = null;
      while (next_idx >= 0 && next_idx < cols.length) {
        const candidate = cols[next_idx];
        const c_body = /** @type {HTMLElement|null} */ (
          candidate.querySelector('.board-column__body')
        );
        const c_cards = c_body
          ? Array.from(c_body.querySelectorAll('.board-card'))
          : [];
        if (c_cards.length > 0) {
          target_col = candidate;
          break;
        }
        next_idx += dir;
      }
      if (target_col) {
        const first = /** @type {HTMLElement|null} */ (
          target_col.querySelector('.board-column__body .board-card')
        );
        if (first) {
          moveFocus(/** @type {HTMLElement} */ (card), first);
        }
      }
      return;
    }
  });

  // Track the currently highlighted column to avoid flicker
  /** @type {HTMLElement|null} */
  let current_drop_target = null;

  // Delegate drag and drop handling for columns
  mount_element.addEventListener('dragover', (ev) => {
    const target = /** @type {HTMLElement} */ (ev.target);
    const col = /** @type {HTMLElement|null} */ (
      target.closest('.board-column')
    );
    if (!col || col.id === 'blocked-col') {
      clearDropTarget();
      if (ev.dataTransfer) {
        ev.dataTransfer.dropEffect = 'none';
      }
      return;
    }
    ev.preventDefault();
    if (ev.dataTransfer) {
      ev.dataTransfer.dropEffect = 'move';
    }

    // Only update if we've entered a different column
    if (col && col !== current_drop_target) {
      // Remove highlight from previous column
      if (current_drop_target) {
        current_drop_target.classList.remove('board-column--drag-over');
      }
      // Highlight the new column
      col.classList.add('board-column--drag-over');
      current_drop_target = col;
    }
  });

  mount_element.addEventListener('dragleave', (ev) => {
    const related = /** @type {HTMLElement|null} */ (ev.relatedTarget);
    // Only clear if we're leaving the mount element entirely
    if (!related || !mount_element.contains(related)) {
      if (current_drop_target) {
        current_drop_target.classList.remove('board-column--drag-over');
        current_drop_target = null;
      }
    }
  });

  mount_element.addEventListener('drop', (ev) => {
    ev.preventDefault();
    // Clear the drop target highlight
    if (current_drop_target) {
      current_drop_target.classList.remove('board-column--drag-over');
      current_drop_target = null;
    }

    const target = /** @type {HTMLElement} */ (ev.target);
    const col = target.closest('.board-column');
    if (!col) {
      return;
    }

    const col_id = col.id;
    if (col_id === 'blocked-col') {
      showToast('Blocked state is determined by issue dependencies', 'info');
      return;
    }
    const new_status = COLUMN_STATUS_MAP[col_id];
    if (!new_status) {
      log('drop on unknown column: %s', col_id);
      return;
    }

    const issue_id = ev.dataTransfer?.getData('text/plain');
    if (!issue_id) {
      log('drop without issue id');
      return;
    }

    log('drop %s on %s → %s', issue_id, col_id, new_status);
    const success_message =
      col_id === 'ready-col'
        ? 'Issue reopened; dependencies determine Board placement'
        : 'Status updated';
    void updateIssueStatus(issue_id, new_status, success_message);
  });

  /**
   * @param {HTMLElement} from
   * @param {HTMLElement} to
   */
  function moveFocus(from, to) {
    try {
      from.tabIndex = -1;
      to.tabIndex = 0;
      to.focus();
    } catch {
      // ignore focus errors
    }
  }

  // Sort helpers centralized in app/data/sort.js

  /**
   * Recompute closed list from raw using the current filter and sort.
   */
  function applyClosedFilter() {
    log('applyClosedFilter %s', closed_filter_mode);
    /** @type {IssueLite[]} */
    let items = Array.isArray(list_closed_raw) ? [...list_closed_raw] : [];
    const now = new Date();
    let since_ts = 0;
    if (closed_filter_mode === 'today') {
      const start = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        0,
        0,
        0,
        0
      );
      since_ts = start.getTime();
    } else if (closed_filter_mode === '3') {
      since_ts = now.getTime() - 3 * 24 * 60 * 60 * 1000;
    } else if (closed_filter_mode === '7') {
      since_ts = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    }
    items = items.filter((it) => {
      const s = Number.isFinite(it.closed_at)
        ? /** @type {number} */ (it.closed_at)
        : NaN;
      if (!Number.isFinite(s)) {
        return false;
      }
      return s >= since_ts;
    });
    items.sort(cmpClosedDesc);
    list_closed = items;
  }

  /**
   * @param {Event} ev
   */
  function onClosedFilterChange(ev) {
    try {
      const el = /** @type {HTMLSelectElement} */ (ev.target);
      const v = String(el.value || 'today');
      closed_filter_mode = v === '3' || v === '7' ? v : 'today';
      log('closed filter %s', closed_filter_mode);
      if (store) {
        try {
          store.setState({ board: { closed_filter: closed_filter_mode } });
        } catch {
          // ignore store errors
        }
      }
      applyClosedFilter();
      doRender();
    } catch {
      // ignore
    }
  }

  /**
   * Compose lists from subscriptions + issues store and render.
   */
  function refreshFromStores() {
    try {
      if (selectors) {
        const in_progress = selectors.selectBoardColumn(
          'tab:board:in-progress',
          'in_progress'
        );
        const blocked = selectors.selectBoardColumn(
          'tab:board:blocked',
          'blocked'
        );
        const ready_raw = selectors.selectBoardColumn(
          'tab:board:ready',
          'ready'
        );
        const closed = selectors.selectBoardColumn(
          'tab:board:closed',
          'closed'
        );

        // Ready excludes items that are in progress
        /** @type {Set<string>} */
        const in_prog_ids = new Set(in_progress.map((i) => i.id));
        const ready = ready_raw.filter((i) => !in_prog_ids.has(i.id));

        list_ready = ready;
        list_blocked = blocked;
        list_in_progress = in_progress;
        list_closed_raw = closed;
      }
      applyClosedFilter();
      doRender();
    } catch {
      list_ready = [];
      list_blocked = [];
      list_in_progress = [];
      list_closed = [];
      doRender();
    }
  }

  // Live updates: recompose on issue store envelopes
  if (selectors) {
    selectors.subscribe(() => {
      try {
        refreshFromStores();
      } catch {
        // ignore
      }
    }, BOARD_CLIENT_IDS);
  }

  return {
    async load() {
      log('load');
      refreshFromStores();
    },
    clear() {
      mount_element.replaceChildren();
      list_ready = [];
      list_blocked = [];
      list_in_progress = [];
      list_closed = [];
    }
  };
}
