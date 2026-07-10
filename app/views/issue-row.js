import { html } from 'lit-html';
import { ref } from 'lit-html/directives/ref.js';
import { createIssueIdRenderer } from '../utils/issue-id-renderer.js';
import { emojiForPriority } from '../utils/priority-badge.js';
import { priority_levels } from '../utils/priority.js';
import { statusLabel } from '../utils/status.js';
import { showToast } from '../utils/toast.js';
import { createTypeBadge } from '../utils/type-badge.js';

/**
 * @typedef {{ id: string, title?: string, status?: string, priority?: number, issue_type?: string, assignee?: string, dependency_count?: number, dependent_count?: number, updated_at?: string | number }} IssueRowData
 */

/**
 * @typedef {'title'|'assignee'|'status'|'priority'} EditableField
 */

/**
 * @typedef {Object} PendingUpdate
 * @property {number} token
 * @property {string | number} value
 */

/**
 * @typedef {Object} ConfirmedUpdate
 * @property {number} token
 * @property {string | number | undefined} baseline
 * @property {string | number} value
 */

/**
 * Create a reusable issue row renderer used by list and epics views.
 * Handles inline editing for title/assignee and selects for status/priority.
 *
 * @param {{
 *   navigate: (id: string) => void,
 *   onUpdate: (id: string, patch: { title?: string, assignee?: string, status?: 'open'|'in_progress'|'closed', priority?: number }) => Promise<unknown>,
 *   requestRender: () => void,
 *   getSelectedId?: () => string | null,
 *   row_class?: string
 * }} options
 * @returns {(it: IssueRowData) => import('lit-html').TemplateResult<1>}
 */
export function createIssueRowRenderer(options) {
  const navigate = options.navigate;
  const on_update = options.onUpdate;
  const request_render = options.requestRender;
  const get_selected_id = options.getSelectedId || (() => null);
  const row_class = options.row_class || 'issue-row';

  /** @type {Set<string>} */
  const editing = new Set();
  /** @type {Map<string, PendingUpdate>} */
  const pending_updates = new Map();
  /** @type {Map<string, ConfirmedUpdate>} */
  const confirmed_updates = new Map();
  let update_generation = 0;

  /**
   * @param {string} id
   * @param {EditableField} field
   */
  function updateKey(id, field) {
    return `${id}:${field}`;
  }

  /**
   * Return the locally overlaid value while a mutation or its push is pending.
   *
   * @param {IssueRowData} issue
   * @param {EditableField} field
   * @returns {string | number | undefined}
   */
  function displayValue(issue, field) {
    const key = updateKey(issue.id, field);
    const pending = pending_updates.get(key);
    if (pending) {
      return pending.value;
    }
    const confirmed = confirmed_updates.get(key);
    const source_value = issue[field];
    if (!confirmed) {
      return source_value;
    }
    if (
      source_value !== confirmed.baseline ||
      source_value === confirmed.value
    ) {
      confirmed_updates.delete(key);
      return source_value;
    }
    return confirmed.value;
  }

  /**
   * Apply an optimistic field update and reconcile only the latest generation.
   *
   * @param {IssueRowData} issue
   * @param {EditableField} field
   * @param {string | number} value
   */
  async function updateField(issue, field, value) {
    const key = updateKey(issue.id, field);
    const token = ++update_generation;
    const source_baseline = issue[field];
    const had_pending = pending_updates.has(key);
    const rollback_value = had_pending
      ? source_baseline
      : displayValue(issue, field);
    const rollback_confirmed = confirmed_updates.get(key);
    pending_updates.set(key, { token, value });
    confirmed_updates.delete(key);
    request_render();
    try {
      const result = await on_update(issue.id, { [field]: value });
      let confirmed_value = value;
      if (
        result &&
        typeof result === 'object' &&
        Object.prototype.hasOwnProperty.call(result, field)
      ) {
        const response_value = /** @type {Record<string, unknown>} */ (result)[
          field
        ];
        if (
          typeof response_value === 'string' ||
          typeof response_value === 'number'
        ) {
          confirmed_value = response_value;
        }
      }
      const current_pending = pending_updates.get(key);
      if (current_pending?.token !== token) {
        const current_confirmed = confirmed_updates.get(key);
        if (!current_confirmed || current_confirmed.token < token) {
          confirmed_updates.set(key, {
            token,
            baseline: source_baseline,
            value: confirmed_value
          });
          if (!current_pending) {
            request_render();
          }
        }
        return;
      }
      pending_updates.delete(key);
      confirmed_updates.set(key, {
        token,
        baseline: source_baseline,
        value: confirmed_value
      });
      request_render();
    } catch {
      if (pending_updates.get(key)?.token !== token) {
        return;
      }
      pending_updates.delete(key);
      if (confirmed_updates.has(key)) {
        // A superseded request succeeded while this newer request was
        // pending. Keep that accepted value as the rollback target.
      } else if (rollback_confirmed) {
        confirmed_updates.set(key, rollback_confirmed);
      } else if (
        rollback_value !== undefined &&
        rollback_value !== source_baseline
      ) {
        confirmed_updates.set(key, {
          token,
          baseline: source_baseline,
          value: rollback_value
        });
      } else {
        confirmed_updates.delete(key);
      }
      request_render();
      showToast(`Failed to update ${field}`, 'error');
    }
  }

  /**
   * @param {string | number | undefined} value
   */
  function formatUpdatedAt(value) {
    if (value === undefined || value === null || value === '') {
      return '—';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value);
    }
    return date.toLocaleString();
  }

  /**
   * Explicitly focus dynamically rendered inline editors. The HTML autofocus
   * attribute is not consistently honored for nodes inserted after page load.
   *
   * @param {Element | undefined} element
   */
  function focusInlineEditor(element) {
    if (element instanceof HTMLInputElement) {
      queueMicrotask(() => {
        if (element.isConnected) {
          element.focus();
        }
      });
    }
  }

  /**
   * @param {IssueRowData} issue
   * @param {'title'|'assignee'} key
   * @param {string} value
   * @param {string} [placeholder]
   */
  function editableText(issue, key, value, placeholder = '') {
    const id = issue.id;
    const k = `${id}:${key}`;
    const is_edit = editing.has(k);
    if (is_edit) {
      return html`<span>
        <input
          type="text"
          .value=${value}
          class="inline-edit"
          ${ref(focusInlineEditor)}
          @keydown=${
            /** @param {KeyboardEvent} e */ async (e) => {
              if (e.key === 'Escape') {
                editing.delete(k);
                request_render();
              } else if (e.key === 'Enter') {
                const el = /** @type {HTMLInputElement} */ (e.currentTarget);
                const next = el.value || '';
                editing.delete(k);
                request_render();
                if (next !== value) {
                  await updateField(issue, key, next);
                }
              }
            }
          }
          @blur=${
            /** @param {Event} ev */ async (ev) => {
              if (!editing.has(k)) {
                return;
              }
              const el = /** @type {HTMLInputElement} */ (ev.currentTarget);
              const next = el.value || '';
              editing.delete(k);
              request_render();
              if (next !== value) {
                await updateField(issue, key, next);
              }
            }
          }
          autofocus
        />
      </span>`;
    }
    return html`<span
      class="editable text-truncate ${value ? '' : 'muted'}"
      tabindex="0"
      role="button"
      @click=${
        /** @param {MouseEvent} e */ (e) => {
          e.stopPropagation();
          e.preventDefault();
          editing.add(k);
          request_render();
        }
      }
      @keydown=${
        /** @param {KeyboardEvent} e */ (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            editing.add(k);
            request_render();
          }
        }
      }
      >${value || placeholder}</span
    >`;
  }

  /**
   * @param {IssueRowData} issue
   * @param {'priority'|'status'} key
   * @returns {(ev: Event) => Promise<void>}
   */
  function makeSelectChange(issue, key) {
    return async (ev) => {
      const sel = /** @type {HTMLSelectElement} */ (ev.currentTarget);
      const val = sel.value || '';
      await updateField(issue, key, key === 'priority' ? Number(val) : val);
    };
  }

  /**
   * @param {string} id
   * @returns {(ev: Event) => void}
   */
  function makeRowClick(id) {
    return (ev) => {
      const el = /** @type {HTMLElement|null} */ (ev.target);
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) {
        return;
      }
      navigate(id);
    };
  }

  /**
   * @param {IssueRowData} it
   */
  function rowTemplate(it) {
    const cur_title = String(displayValue(it, 'title') || '');
    const cur_assignee = String(displayValue(it, 'assignee') || '');
    const cur_status = String(displayValue(it, 'status') || 'open');
    const cur_prio = String(displayValue(it, 'priority') ?? 2);
    const is_selected = get_selected_id() === it.id;
    return html`<tr
      role="row"
      class="${row_class} ${is_selected ? 'selected' : ''}"
      data-issue-id=${it.id}
      aria-selected=${String(is_selected)}
      @click=${makeRowClick(it.id)}
    >
      <td role="gridcell" class="mono">${createIssueIdRenderer(it.id)}</td>
      <td role="gridcell">${createTypeBadge(it.issue_type)}</td>
      <td role="gridcell">${editableText(it, 'title', cur_title)}</td>
      <td role="gridcell">
        <select
          class="badge-select badge--status is-${cur_status}"
          aria-label=${`Status for ${it.id}`}
          .value=${cur_status}
          @change=${makeSelectChange(it, 'status')}
        >
          ${['open', 'in_progress', 'closed'].map(
            (s) =>
              html`<option value=${s} ?selected=${cur_status === s}>
                ${statusLabel(s)}
              </option>`
          )}
        </select>
      </td>
      <td role="gridcell">
        ${editableText(it, 'assignee', cur_assignee, 'Unassigned')}
      </td>
      <td role="gridcell">
        <select
          class="badge-select badge--priority ${'is-p' + cur_prio}"
          aria-label=${`Priority for ${it.id}`}
          .value=${cur_prio}
          @change=${makeSelectChange(it, 'priority')}
        >
          ${priority_levels.map(
            (p, i) =>
              html`<option
                value=${String(i)}
                ?selected=${cur_prio === String(i)}
              >
                ${emojiForPriority(i)} ${p}
              </option>`
          )}
        </select>
      </td>
      <td role="gridcell" class="updated-col">
        ${formatUpdatedAt(it.updated_at)}
      </td>
      <td role="gridcell" class="deps-col">
        ${(it.dependency_count || 0) > 0 || (it.dependent_count || 0) > 0
          ? html`<span class="deps-indicator"
              >${(it.dependency_count || 0) > 0
                ? html`<span
                    class="dep-count"
                    title="${it.dependency_count} ${(it.dependency_count ||
                      0) === 1
                      ? 'dependency'
                      : 'dependencies'}"
                    >→${it.dependency_count}</span
                  >`
                : ''}${(it.dependent_count || 0) > 0
                ? html`<span
                    class="dependent-count"
                    title="${it.dependent_count} ${(it.dependent_count || 0) ===
                    1
                      ? 'dependent'
                      : 'dependents'}"
                    >←${it.dependent_count}</span
                  >`
                : ''}</span
            >`
          : ''}
      </td>
    </tr>`;
  }

  return rowTemplate;
}
