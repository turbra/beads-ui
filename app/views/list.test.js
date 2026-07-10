import { describe, expect, test, vi } from 'vitest';
import { createSubscriptionIssueStore } from '../data/subscription-issue-store.js';
import { createListView } from './list.js';

/**
 * Helper to toggle a filter option in a dropdown.
 *
 * @param {HTMLElement} mount - The container element
 * @param {number} dropdownIndex - 0 = status, 1 = types
 * @param {string} optionText - Text to match in the option label
 */
function toggleFilter(mount, dropdownIndex, optionText) {
  const dropdowns = mount.querySelectorAll('.filter-dropdown');
  const dropdown = dropdowns[dropdownIndex];
  // Open the dropdown
  const trigger = /** @type {HTMLButtonElement} */ (
    dropdown.querySelector('.filter-dropdown__trigger')
  );
  trigger.click();
  // Find and click the checkbox
  const option = Array.from(
    dropdown.querySelectorAll('.filter-dropdown__option')
  ).find((opt) => opt.textContent?.includes(optionText));
  const checkbox = /** @type {HTMLInputElement} */ (
    option?.querySelector('input[type="checkbox"]')
  );
  checkbox.click();
}

/**
 * Check if a filter option is checked in a dropdown.
 *
 * @param {HTMLElement} mount - The container element
 * @param {number} dropdownIndex - 0 = status, 1 = types
 * @param {string} optionText - Text to match in the option label
 * @returns {boolean}
 */
function isFilterChecked(mount, dropdownIndex, optionText) {
  const dropdowns = mount.querySelectorAll('.filter-dropdown');
  const dropdown = dropdowns[dropdownIndex];
  const option = Array.from(
    dropdown.querySelectorAll('.filter-dropdown__option')
  ).find((opt) => opt.textContent?.includes(optionText));
  const checkbox = /** @type {HTMLInputElement} */ (
    option?.querySelector('input[type="checkbox"]')
  );
  return checkbox?.checked ?? false;
}

/**
 * Apply the debounced search filter.
 *
 * @param {HTMLInputElement} input
 * @param {string} value
 */
async function searchFor(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 130));
}

function createTestIssueStores() {
  /** @type {Map<string, any>} */
  const stores = new Map();
  /** @type {Set<() => void>} */
  const listeners = new Set();

  /**
   * @param {string} id
   * @returns {any}
   */
  function getStore(id) {
    let s = stores.get(id);
    if (!s) {
      s = createSubscriptionIssueStore(id);
      stores.set(id, s);
      s.subscribe(() => {
        for (const fn of Array.from(listeners)) {
          try {
            fn();
          } catch {
            /* ignore */
          }
        }
      });
    }
    return s;
  }

  return {
    getStore,
    /** @param {string} id */
    snapshotFor(id) {
      return getStore(id).snapshot().slice();
    },
    /** @param {() => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}

describe('views/list', () => {
  test('renders issues from push stores and navigates on row click', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const issues = [
      {
        id: 'UI-1',
        title: 'One',
        status: 'open',
        priority: 1,
        issue_type: 'task'
      },
      {
        id: 'UI-2',
        title: 'Two',
        status: 'closed',
        priority: 2,
        issue_type: 'bug'
      }
    ];
    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues
    });

    const view = createListView(
      mount,
      async () => [],
      (hash) => {
        window.location.hash = hash;
      },
      undefined,
      undefined,
      issueStores
    );
    await view.load();
    const rows = mount.querySelectorAll('tr.issue-row');
    expect(rows.length).toBe(2);

    // badge present
    const badges = mount.querySelectorAll('.type-badge');
    expect(badges.length).toBeGreaterThanOrEqual(2);

    const first = /** @type {HTMLElement} */ (rows[0]);
    first.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(window.location.hash).toBe('#/issues?issue=UI-1');
  });

  test('filters by status and search', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const issues = [
      { id: 'UI-1', title: 'Alpha', status: 'open', priority: 1 },
      { id: 'UI-2', title: 'Beta', status: 'in_progress', priority: 2 },
      { id: 'UI-3', title: 'Gamma', status: 'closed', priority: 3 }
    ];
    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues
    });
    const view = createListView(
      mount,
      async () => [],
      undefined,
      undefined,
      undefined,
      issueStores
    );
    await view.load();
    const input = /** @type {HTMLInputElement} */ (
      mount.querySelector('input[type="search"]')
    );

    // Filter by status using dropdown checkbox
    toggleFilter(mount, 0, 'Open');
    await Promise.resolve();
    expect(mount.querySelectorAll('tr.issue-row').length).toBe(1);

    // Clear status filter and search
    toggleFilter(mount, 0, 'Open'); // toggle off to show all
    await Promise.resolve();
    await searchFor(input, 'ga');
    const visible = Array.from(mount.querySelectorAll('tr.issue-row')).map(
      (el) => ({
        id: el.getAttribute('data-issue-id') || '',
        text: el.textContent || ''
      })
    );
    expect(visible.length).toBe(1);
    expect(visible[0].id).toBe('UI-3');
    expect(visible[0].text.toLowerCase()).toContain('gamma');
  });

  test('filters by issue type and combines with search', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const issues = [
      {
        id: 'UI-1',
        title: 'Alpha',
        status: 'open',
        priority: 1,
        issue_type: 'bug'
      },
      {
        id: 'UI-2',
        title: 'Beta',
        status: 'open',
        priority: 2,
        issue_type: 'feature'
      },
      {
        id: 'UI-3',
        title: 'Gamma',
        status: 'open',
        priority: 3,
        issue_type: 'bug'
      },
      {
        id: 'UI-4',
        title: 'Delta',
        status: 'open',
        priority: 2,
        issue_type: 'task'
      }
    ];
    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues
    });
    const view = createListView(
      mount,
      async () => [],
      undefined,
      undefined,
      undefined,
      issueStores
    );
    await view.load();

    // Initially shows all
    expect(mount.querySelectorAll('tr.issue-row').length).toBe(4);

    // Select bug using dropdown
    toggleFilter(mount, 1, 'Bug');
    await Promise.resolve();
    const bug_only = Array.from(mount.querySelectorAll('tr.issue-row')).map(
      (el) => el.getAttribute('data-issue-id') || ''
    );
    expect(bug_only).toEqual(['UI-1', 'UI-3']);

    // Toggle off bug, toggle on feature
    toggleFilter(mount, 1, 'Bug');
    toggleFilter(mount, 1, 'Feature');
    await Promise.resolve();
    const feature_only = Array.from(mount.querySelectorAll('tr.issue-row')).map(
      (el) => el.getAttribute('data-issue-id') || ''
    );
    expect(feature_only).toEqual(['UI-2']);

    // Toggle off feature, toggle on bug, combine with search
    toggleFilter(mount, 1, 'Feature');
    toggleFilter(mount, 1, 'Bug');
    const input = /** @type {HTMLInputElement} */ (
      mount.querySelector('input[type="search"]')
    );
    await searchFor(input, 'ga');
    const filtered = Array.from(mount.querySelectorAll('tr.issue-row')).map(
      (el) => el.getAttribute('data-issue-id') || ''
    );
    expect(filtered).toEqual(['UI-3']);
  });

  test('applies type filters after Ready reload', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));

    const allIssues = [
      {
        id: 'UI-1',
        title: 'One',
        status: 'open',
        priority: 1,
        issue_type: 'task'
      },
      {
        id: 'UI-2',
        title: 'Two',
        status: 'open',
        priority: 2,
        issue_type: 'feature'
      },
      {
        id: 'UI-3',
        title: 'Three',
        status: 'open',
        priority: 2,
        issue_type: 'bug'
      }
    ];
    const readyIssues = [
      {
        id: 'UI-2',
        title: 'Two',
        status: 'open',
        priority: 2,
        issue_type: 'feature'
      },
      {
        id: 'UI-3',
        title: 'Three',
        status: 'open',
        priority: 2,
        issue_type: 'bug'
      }
    ];

    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues: allIssues
    });
    const view = createListView(
      mount,
      async () => [],
      undefined,
      undefined,
      undefined,
      issueStores
    );
    await view.load();
    const statusSelect = /** @type {HTMLSelectElement} */ (
      mount.querySelector('select')
    );
    statusSelect.value = 'ready';
    statusSelect.dispatchEvent(new Event('change'));
    // switch subscription key and apply ready membership
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 2,
      issues: readyIssues
    });
    await view.load();

    // Apply type filter (feature) using dropdown checkbox
    toggleFilter(mount, 1, 'Feature');
    await Promise.resolve();

    const rows = Array.from(mount.querySelectorAll('tr.issue-row')).map(
      (el) => el.getAttribute('data-issue-id') || ''
    );
    expect(rows).toEqual(['UI-2']);

    // No RPC calls expected; derived from stores
  });

  test('initializes type filter from store and reflects in controls', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));

    const issues = [
      {
        id: 'UI-1',
        title: 'Alpha',
        status: 'open',
        priority: 1,
        issue_type: 'bug'
      },
      {
        id: 'UI-2',
        title: 'Beta',
        status: 'open',
        priority: 2,
        issue_type: 'feature'
      },
      {
        id: 'UI-3',
        title: 'Gamma closed',
        status: 'closed',
        priority: 3,
        issue_type: 'bug'
      }
    ];

    /** @type {{ state: any, subs: ((s:any)=>void)[], getState: () => any, setState: (patch:any)=>void, subscribe: (fn:(s:any)=>void)=>()=>void }} */
    const store = {
      state: {
        selected_id: null,
        filters: { status: 'all', search: '', type: 'bug' }
      },
      subs: [],
      getState() {
        return this.state;
      },
      setState(patch) {
        this.state = {
          ...this.state,
          ...(patch || {}),
          filters: { ...this.state.filters, ...(patch.filters || {}) }
        };
        for (const fn of this.subs) {
          fn(this.state);
        }
      },
      subscribe(fn) {
        this.subs.push(fn);
        return () => {
          this.subs = this.subs.filter((f) => f !== fn);
        };
      }
    };

    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues
    });
    const view = createListView(
      mount,
      async () => [],
      undefined,
      store,
      undefined,
      issueStores
    );
    await view.load();

    // Only bug issues visible
    const rows = Array.from(mount.querySelectorAll('tr.issue-row')).map(
      (el) => el.getAttribute('data-issue-id') || ''
    );
    expect(rows).toEqual(['UI-1', 'UI-3']);

    // Bug checkbox should be checked in the types dropdown
    expect(isFilterChecked(mount, 1, 'Bug')).toBe(true);
  });

  test('ready filter via select composes from push membership', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));

    const allIssues = [
      { id: 'UI-1', title: 'One', status: 'open', priority: 1 },
      { id: 'UI-2', title: 'Two', status: 'open', priority: 2 }
    ];
    const readyIssues = [
      { id: 'UI-2', title: 'Two', status: 'open', priority: 2 }
    ];

    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues: allIssues
    });
    const view = createListView(
      mount,
      async () => [],
      undefined,
      undefined,
      undefined,
      issueStores
    );
    await view.load();
    expect(mount.querySelectorAll('tr.issue-row').length).toBe(2);

    const select = /** @type {HTMLSelectElement} */ (
      mount.querySelector('select')
    );
    select.value = 'ready';
    select.dispatchEvent(new Event('change'));
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 2,
      issues: readyIssues
    });
    await view.load();
    expect(mount.querySelectorAll('tr.issue-row').length).toBe(1);
  });

  test('switching ready → all reloads full list', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));

    const allIssues = [
      { id: 'UI-1', title: 'One', status: 'open', priority: 1 },
      { id: 'UI-2', title: 'Two', status: 'closed', priority: 2 }
    ];
    const readyIssues = [
      { id: 'UI-2', title: 'Two', status: 'closed', priority: 2 }
    ];

    // No RPC calls are made in push-only mode

    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues: allIssues
    });
    const view = createListView(
      mount,
      async () => [],
      undefined,
      undefined,
      undefined,
      issueStores
    );
    await view.load();
    expect(mount.querySelectorAll('tr.issue-row').length).toBe(2);

    const select = /** @type {HTMLSelectElement} */ (
      mount.querySelector('select')
    );

    // Switch to ready (subscription now maps to ready-issues)
    select.value = 'ready';
    select.dispatchEvent(new Event('change'));
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 2,
      issues: readyIssues
    });
    await view.load();
    expect(mount.querySelectorAll('tr.issue-row').length).toBe(1);

    // Switch back to all; view should compose from all-issues membership
    select.value = 'all';
    select.dispatchEvent(new Event('change'));
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 3,
      issues: allIssues
    });
    await view.load();
    expect(mount.querySelectorAll('tr.issue-row').length).toBe(2);

    // No RPC calls are expected in push-only model
  });

  test('applies persisted filters from store on initial load', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));

    const issues = [
      { id: 'UI-1', title: 'Alpha', status: 'open', priority: 1 },
      { id: 'UI-2', title: 'Gamma', status: 'open', priority: 2 },
      { id: 'UI-3', title: 'Gamma closed', status: 'closed', priority: 3 }
    ];

    /** @type {{ state: any, subs: ((s:any)=>void)[], getState: () => any, setState: (patch:any)=>void, subscribe: (fn:(s:any)=>void)=>()=>void }} */
    const store = {
      state: { selected_id: null, filters: { status: ['open'], search: 'ga' } },
      subs: [],
      getState() {
        return this.state;
      },
      setState(patch) {
        this.state = {
          ...this.state,
          ...(patch || {}),
          filters: { ...this.state.filters, ...(patch.filters || {}) }
        };
        for (const fn of this.subs) {
          fn(this.state);
        }
      },
      subscribe(fn) {
        this.subs.push(fn);
        return () => {
          this.subs = this.subs.filter((f) => f !== fn);
        };
      }
    };

    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues
    });
    const view = createListView(
      mount,
      async () => [],
      undefined,
      store,
      undefined,
      issueStores
    );
    await view.load();

    // Expect only UI-2 ("Gamma" open) to be visible
    const items = Array.from(mount.querySelectorAll('tr.issue-row')).map(
      (el) => ({
        id: el.getAttribute('data-issue-id') || '',
        text: el.textContent || ''
      })
    );
    expect(items.length).toBe(1);
    expect(items[0].id).toBe('UI-2');

    // Controls reflect persisted filters
    expect(isFilterChecked(mount, 0, 'Open')).toBe(true);
    const input = /** @type {HTMLInputElement} */ (
      mount.querySelector('input[type="search"]')
    );
    expect(input.value).toBe('ga');
  });

  test('filters by multiple statuses with dropdown checkboxes', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const issues = [
      { id: 'UI-1', title: 'Alpha', status: 'open', priority: 1 },
      { id: 'UI-2', title: 'Beta', status: 'in_progress', priority: 2 },
      { id: 'UI-3', title: 'Gamma', status: 'closed', priority: 3 }
    ];
    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues
    });
    const view = createListView(
      mount,
      async () => [],
      undefined,
      undefined,
      undefined,
      issueStores
    );
    await view.load();

    // Click Open checkbox to select it
    toggleFilter(mount, 0, 'Open');
    await Promise.resolve();

    // Should show only open issues
    let rows = Array.from(mount.querySelectorAll('tr.issue-row')).map(
      (el) => el.getAttribute('data-issue-id') || ''
    );
    expect(rows).toEqual(['UI-1']);

    // Click In progress checkbox to add it (multi-select)
    toggleFilter(mount, 0, 'In progress');
    await Promise.resolve();

    // Should show both open and in_progress
    rows = Array.from(mount.querySelectorAll('tr.issue-row')).map(
      (el) => el.getAttribute('data-issue-id') || ''
    );
    expect(rows).toEqual(['UI-1', 'UI-2']);
  });

  test('keeps Ready mutually exclusive with concrete statuses', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const state = {
      selected_id: null,
      view: 'issues',
      filters: { status: [], type: [], search: '' }
    };
    /** @type {Set<(next_state: any) => void>} */
    const listeners = new Set();
    const store = {
      getState() {
        return state;
      },
      /** @param {any} patch */
      setState(patch) {
        Object.assign(state, patch);
        state.filters = { ...state.filters, ...(patch.filters || {}) };
        for (const listener of listeners) {
          listener(state);
        }
      },
      /** @param {(next_state: any) => void} listener */
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    };
    const issueStores = createTestIssueStores();
    const view = createListView(
      mount,
      async () => [],
      undefined,
      store,
      undefined,
      issueStores
    );
    await view.load();

    toggleFilter(mount, 0, 'Open');
    await Promise.resolve();
    toggleFilter(mount, 0, 'Ready');
    await Promise.resolve();

    expect(state.filters.status).toEqual(['ready']);
    expect(isFilterChecked(mount, 0, 'Open')).toBe(false);
    expect(isFilterChecked(mount, 0, 'Ready')).toBe(true);

    toggleFilter(mount, 0, 'Closed');
    await Promise.resolve();

    expect(state.filters.status).toEqual(['closed']);
    expect(isFilterChecked(mount, 0, 'Ready')).toBe(false);
    expect(isFilterChecked(mount, 0, 'Closed')).toBe(true);
  });

  test('debounces search while matching assignees and labels', async () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
      const mount = /** @type {HTMLElement} */ (
        document.getElementById('mount')
      );
      const issueStores = createTestIssueStores();
      issueStores.getStore('tab:issues').applyPush({
        type: 'snapshot',
        id: 'tab:issues',
        revision: 1,
        issues: [
          {
            id: 'UI-SEARCH-1',
            title: 'Alpha',
            assignee: 'alice',
            labels: ['frontend']
          },
          {
            id: 'UI-SEARCH-2',
            title: 'Beta',
            assignee: 'bob',
            labels: ['backend']
          }
        ]
      });
      const view = createListView(
        mount,
        async () => [],
        undefined,
        undefined,
        undefined,
        issueStores
      );
      await view.load();
      const input = /** @type {HTMLInputElement} */ (
        mount.querySelector('input[type="search"]')
      );

      input.value = 'frontend';
      input.dispatchEvent(new Event('input'));

      expect(input.value).toBe('frontend');
      expect(mount.querySelectorAll('tr.issue-row')).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(120);
      expect(
        mount.querySelector('tr.issue-row')?.getAttribute('data-issue-id')
      ).toBe('UI-SEARCH-1');

      input.value = 'bob';
      input.dispatchEvent(new Event('input'));
      await vi.advanceTimersByTimeAsync(120);
      expect(
        mount.querySelector('tr.issue-row')?.getAttribute('data-issue-id')
      ).toBe('UI-SEARCH-2');
    } finally {
      vi.useRealTimers();
    }
  });

  test('sorts Priority and Updated with stable issue ID ties', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues: [
        { id: 'UI-C', title: 'C', priority: 1, updated_at: '2025-01-01' },
        { id: 'UI-B', title: 'B', priority: 2, updated_at: '2025-03-01' },
        { id: 'UI-A', title: 'A', priority: 1, updated_at: '2025-03-01' }
      ]
    });
    const view = createListView(
      mount,
      async () => [],
      undefined,
      undefined,
      undefined,
      issueStores
    );
    await view.load();
    const rowIds = () =>
      Array.from(mount.querySelectorAll('tr.issue-row')).map((row) =>
        row.getAttribute('data-issue-id')
      );

    // With no explicit view sort, preserve the upstream store's order.
    expect(rowIds()).toEqual(['UI-A', 'UI-C', 'UI-B']);
    /** @type {HTMLButtonElement} */ (
      mount.querySelector('button.sort-header')
    ).click();
    expect(rowIds()).toEqual(['UI-A', 'UI-C', 'UI-B']);
    expect(
      mount.querySelector('th[aria-sort="ascending"]')?.textContent?.trim()
    ).toBe('Priority');

    /** @type {HTMLButtonElement} */ (
      mount.querySelector('button.sort-header')
    ).click();
    expect(rowIds()).toEqual(['UI-B', 'UI-A', 'UI-C']);

    const updated_button = Array.from(
      mount.querySelectorAll('button.sort-header')
    ).find((button) => button.textContent?.includes('Updated'));
    /** @type {HTMLButtonElement} */ (updated_button).click();
    expect(rowIds()).toEqual(['UI-A', 'UI-B', 'UI-C']);
    expect(
      mount.querySelector('th[aria-sort="descending"]')?.textContent?.trim()
    ).toBe('Updated');
  });

  test('offers contextual empty-state actions', async () => {
    document.body.innerHTML =
      '<button id="new-issue-btn"></button><aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const create_button = /** @type {HTMLButtonElement} */ (
      document.getElementById('new-issue-btn')
    );
    const on_create = vi.fn();
    create_button.addEventListener('click', on_create);
    const issueStores = createTestIssueStores();
    const view = createListView(
      mount,
      async () => [],
      undefined,
      undefined,
      undefined,
      issueStores
    );
    await view.load();

    expect(mount.textContent).toContain('No issues');
    /** @type {HTMLButtonElement} */ (
      mount.querySelector('.list-empty-state button')
    ).click();
    expect(on_create).toHaveBeenCalledOnce();

    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues: [{ id: 'UI-EMPTY', title: 'Visible issue' }]
    });
    await view.load();
    const input = /** @type {HTMLInputElement} */ (
      mount.querySelector('input[type="search"]')
    );
    await searchFor(input, 'missing');
    expect(mount.textContent).toContain('No matching issues');

    /** @type {HTMLButtonElement} */ (
      mount.querySelector('.list-empty-state button')
    ).click();
    await Promise.resolve();
    expect(mount.querySelectorAll('tr.issue-row')).toHaveLength(1);
  });

  test('labels the eight-column grid and row controls', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues: [{ id: 'UI-A11Y', title: 'Accessible', updated_at: 1 }]
    });
    const view = createListView(
      mount,
      async () => [],
      undefined,
      undefined,
      undefined,
      issueStores
    );
    await view.load();

    expect(mount.querySelector('table')?.getAttribute('aria-colcount')).toBe(
      '8'
    );
    expect(mount.querySelectorAll('thead th')).toHaveLength(8);
    expect(
      mount.querySelector('tr.issue-row')?.getAttribute('aria-selected')
    ).toBe('false');
    expect(
      mount.querySelector('select.badge--status')?.getAttribute('aria-label')
    ).toBe('Status for UI-A11Y');
    expect(
      mount.querySelector('select.badge--priority')?.getAttribute('aria-label')
    ).toBe('Priority for UI-A11Y');
    expect(
      mount.querySelector('input[type="search"]')?.getAttribute('aria-label')
    ).toContain('assignee');
    const filter_trigger = mount.querySelector('.filter-dropdown__trigger');
    expect(filter_trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(filter_trigger?.getAttribute('aria-controls')).toBe(
      'status-filter-menu'
    );
    expect(filter_trigger?.getAttribute('aria-haspopup')).toBe('true');
  });

  test('warns when the list reaches its explicit result boundary', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues: Array.from({ length: 1000 }, (_, index) => ({
        id: `UI-${index}`,
        title: `Issue ${index}`
      }))
    });
    const store = {
      getState() {
        return {
          selected_id: null,
          view: 'issues',
          filters: { status: [], type: [], search: 'no-match' }
        };
      },
      setState() {},
      subscribe() {
        return () => {};
      }
    };
    const view = createListView(
      mount,
      async () => [],
      undefined,
      store,
      undefined,
      issueStores
    );

    await view.load();

    expect(mount.querySelector('.list-boundary-notice')?.textContent).toContain(
      'Showing up to 1000 issues'
    );
  });

  test('filters by multiple types with dropdown checkboxes', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const issues = [
      { id: 'UI-1', title: 'A', status: 'open', issue_type: 'bug' },
      { id: 'UI-2', title: 'B', status: 'open', issue_type: 'feature' },
      { id: 'UI-3', title: 'C', status: 'open', issue_type: 'task' },
      { id: 'UI-4', title: 'D', status: 'open', issue_type: 'epic' }
    ];
    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues
    });
    const view = createListView(
      mount,
      async () => [],
      undefined,
      undefined,
      undefined,
      issueStores
    );
    await view.load();

    // Click Bug checkbox
    toggleFilter(mount, 1, 'Bug');
    await Promise.resolve();

    let rows = Array.from(mount.querySelectorAll('tr.issue-row')).map(
      (el) => el.getAttribute('data-issue-id') || ''
    );
    expect(rows).toEqual(['UI-1']);

    // Click Feature checkbox to add it
    toggleFilter(mount, 1, 'Feature');
    await Promise.resolve();

    rows = Array.from(mount.querySelectorAll('tr.issue-row')).map(
      (el) => el.getAttribute('data-issue-id') || ''
    );
    expect(rows).toEqual(['UI-1', 'UI-2']);
  });

  test('deselecting all checkboxes shows all issues', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const issues = [
      { id: 'UI-1', title: 'A', status: 'open' },
      { id: 'UI-2', title: 'B', status: 'closed' }
    ];
    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues
    });
    const view = createListView(
      mount,
      async () => [],
      undefined,
      undefined,
      undefined,
      issueStores
    );
    await view.load();

    // Initially all shown
    expect(mount.querySelectorAll('tr.issue-row').length).toBe(2);

    // Click Open checkbox to filter
    toggleFilter(mount, 0, 'Open');
    await Promise.resolve();
    expect(mount.querySelectorAll('tr.issue-row').length).toBe(1);

    // Click Open checkbox again to deselect - should show all
    toggleFilter(mount, 0, 'Open');
    await Promise.resolve();
    expect(mount.querySelectorAll('tr.issue-row').length).toBe(2);
  });
});
