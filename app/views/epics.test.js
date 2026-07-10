import { describe, expect, test, vi } from 'vitest';
import { createSubscriptionIssueStore } from '../data/subscription-issue-store.js';
import { createSubscriptionStore } from '../data/subscriptions-store.js';
import { createEpicsView } from './epics.js';

/** Create one expanded epic with a child table for resize tests. */
async function createResizableEpicsHarness() {
  document.body.innerHTML = '<div id="m"></div>';
  const mount = /** @type {HTMLElement} */ (document.getElementById('m'));
  /** @type {Map<string, any>} */
  const stores = new Map();
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @param {string} id */
  function getStore(id) {
    let issue_store = stores.get(id);
    if (!issue_store) {
      issue_store = createSubscriptionIssueStore(id);
      stores.set(id, issue_store);
      issue_store.subscribe(() => {
        for (const listener of listeners) {
          listener();
        }
      });
    }
    return issue_store;
  }
  const issueStores = {
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
  getStore('tab:epics').applyPush({
    type: 'snapshot',
    id: 'tab:epics',
    revision: 1,
    issues: [{ id: 'EPIC-1', title: 'Resizable epic', issue_type: 'epic' }]
  });
  const view = createEpicsView(
    mount,
    { updateIssue: vi.fn() },
    () => {},
    undefined,
    issueStores
  );
  await view.load();
  getStore('detail:EPIC-1').applyPush({
    type: 'snapshot',
    id: 'detail:EPIC-1',
    revision: 1,
    issues: [
      {
        id: 'EPIC-1',
        title: 'Resizable epic',
        issue_type: 'epic',
        dependents: [{ id: 'CHILD-1', title: 'Child issue', status: 'open' }]
      }
    ]
  });
  await view.load();
  return mount;
}

describe('views/epics', () => {
  test('loads groups from store and expands to show non-closed children, navigates on click', async () => {
    document.body.innerHTML = '<div id="m"></div>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('m'));
    const data = {
      updateIssue: vi.fn(),
      getIssue: vi.fn(async (id) => ({ id }))
    };
    /** test issue stores */
    const stores = new Map();
    const listeners = new Set();
    /** @param {string} id */
    const getStore = (id) => {
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
    };
    const issueStores = {
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
    const subscriptions = createSubscriptionStore(async () => {});
    // Seed epics list snapshot
    issueStores.getStore('tab:epics').applyPush({
      type: 'snapshot',
      id: 'tab:epics',
      revision: 1,
      issues: [
        {
          id: 'UI-1',
          title: 'Epic One',
          issue_type: 'epic',
          dependents: [{ id: 'UI-2' }, { id: 'UI-3' }]
        }
      ]
    });
    /** @type {string[]} */
    const navCalls = [];
    const view = createEpicsView(
      mount,
      /** @type {any} */ (data),
      (id) => navCalls.push(id),
      subscriptions,
      /** @type {any} */ (issueStores)
    );
    await view.load();
    // Register epic detail and push snapshot with dependents
    issueStores.getStore('detail:UI-1');
    issueStores.getStore('detail:UI-1').applyPush({
      type: 'snapshot',
      id: 'detail:UI-1',
      revision: 1,
      issues: [
        {
          id: 'UI-1',
          title: 'Epic One',
          issue_type: 'epic',
          dependents: [
            {
              id: 'UI-2',
              title: 'Alpha',
              status: 'open',
              priority: 1,
              issue_type: 'task',
              updated_at: '2025-01-02T00:00:00Z'
            },
            {
              id: 'UI-3',
              title: 'Beta',
              status: 'closed',
              priority: 2,
              issue_type: 'task',
              updated_at: '2025-01-01T00:00:00Z'
            }
          ]
        }
      ]
    });
    await view.load();
    const header = mount.querySelector('.epic-header');
    expect(header).not.toBeNull();
    // After expansion, only non-closed child should be present
    const rows = mount.querySelectorAll('tr.epic-row');
    expect(rows.length).toBe(2);
    expect(mount.querySelector('table')?.getAttribute('aria-colcount')).toBe(
      '8'
    );
    expect(mount.querySelectorAll('thead th')).toHaveLength(8);
    expect(rows[0].querySelector('.updated-col')?.textContent).not.toBe('');
    expect(
      rows[0].querySelector('select.badge--status')?.getAttribute('aria-label')
    ).toBe('Status for UI-2');
    rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(navCalls[0]).toBe('UI-2');
  });

  test('resizes and independently persists Epics child columns', async () => {
    window.localStorage.removeItem('beads-ui.epics.column-widths');
    window.localStorage.setItem(
      'beads-ui.issues.column-widths',
      JSON.stringify({ title: 444 })
    );
    const mount = await createResizableEpicsHarness();
    const handle = /** @type {HTMLElement} */ (
      mount.querySelector('[aria-label="Resize Title column"]')
    );

    handle.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
    );

    expect(mount.querySelectorAll('.column-resizer')).toHaveLength(8);
    expect(
      mount
        .querySelector('col[data-epic-column="title"]')
        ?.getAttribute('style')
    ).toContain('376px');
    expect(
      JSON.parse(
        window.localStorage.getItem('beads-ui.epics.column-widths') || '{}'
      ).title
    ).toBe(376);
    expect(
      JSON.parse(
        window.localStorage.getItem('beads-ui.issues.column-widths') || '{}'
      ).title
    ).toBe(444);
    window.localStorage.removeItem('beads-ui.epics.column-widths');
    window.localStorage.removeItem('beads-ui.issues.column-widths');
  });

  test('restores persisted Epics child column widths', async () => {
    window.localStorage.setItem(
      'beads-ui.epics.column-widths',
      JSON.stringify({ id: 230, title: 510 })
    );

    const mount = await createResizableEpicsHarness();

    expect(
      mount.querySelector('col[data-epic-column="id"]')?.getAttribute('style')
    ).toContain('230px');
    expect(
      mount
        .querySelector('col[data-epic-column="title"]')
        ?.getAttribute('style')
    ).toContain('510px');
    window.localStorage.removeItem('beads-ui.epics.column-widths');
  });

  test('sorts children by priority then created_at asc', async () => {
    document.body.innerHTML = '<div id="m"></div>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('m'));
    const data = {
      updateIssue: vi.fn(),
      getIssue: vi.fn(async (id) => ({ id }))
    };
    const stores2 = new Map();
    const listeners2 = new Set();
    /** @param {string} id */
    const getStore2 = (id) => {
      let s = stores2.get(id);
      if (!s) {
        s = createSubscriptionIssueStore(id);
        stores2.set(id, s);
        s.subscribe(() => {
          for (const fn of Array.from(listeners2)) {
            try {
              fn();
            } catch {
              /* ignore */
            }
          }
        });
      }
      return s;
    };
    const issueStores2 = {
      getStore: getStore2,
      /** @param {string} id */
      snapshotFor(id) {
        return getStore2(id).snapshot().slice();
      },
      /** @param {() => void} fn */
      subscribe(fn) {
        listeners2.add(fn);
        return () => listeners2.delete(fn);
      }
    };
    const subscriptions = createSubscriptionStore(async () => {});
    // seed epics snapshot
    issueStores2.getStore('tab:epics').applyPush({
      type: 'snapshot',
      id: 'tab:epics',
      revision: 1,
      issues: [
        {
          id: 'UI-10',
          title: 'Epic Sort',
          issue_type: 'epic',
          dependents: [{ id: 'UI-11' }, { id: 'UI-12' }, { id: 'UI-13' }]
        }
      ]
    });
    const view = createEpicsView(
      mount,
      /** @type {any} */ (data),
      () => {},
      subscriptions,
      /** @type {any} */ (issueStores2)
    );
    await view.load();
    // Seed epic detail snapshot for UI-10 with out-of-order dependents
    issueStores2.getStore('detail:UI-10');
    issueStores2.getStore('detail:UI-10').applyPush({
      type: 'snapshot',
      id: 'detail:UI-10',
      revision: 1,
      issues: [
        {
          id: 'UI-10',
          title: 'Epic Sort',
          issue_type: 'epic',
          dependents: [
            {
              id: 'UI-11',
              title: 'Low priority, newest within p1',
              status: 'open',
              priority: 1,
              issue_type: 'task',
              created_at: '2025-10-22T10:00:00.000Z',
              updated_at: '2025-10-22T10:00:00.000Z'
            },
            {
              id: 'UI-12',
              title: 'Low priority, older',
              status: 'open',
              priority: 1,
              issue_type: 'task',
              created_at: '2025-10-20T10:00:00.000Z',
              updated_at: '2025-10-20T10:00:00.000Z'
            },
            {
              id: 'UI-13',
              title: 'Higher priority number (lower precedence)',
              status: 'open',
              priority: 2,
              issue_type: 'task',
              created_at: '2025-10-23T10:00:00.000Z',
              updated_at: '2025-10-23T10:00:00.000Z'
            }
          ]
        }
      ]
    });
    await view.load();
    const rows = Array.from(mount.querySelectorAll('tr.epic-row'));
    const ids = rows.map((r) =>
      /** @type {HTMLElement} */ (
        r.querySelector('td.mono')
      )?.textContent?.trim()
    );
    expect(ids).toEqual(['UI-12', 'UI-11', 'UI-13']);

    const updated_button = Array.from(
      mount.querySelectorAll('button.sort-header')
    ).find((button) => button.textContent?.includes('Updated'));
    /** @type {HTMLButtonElement} */ (updated_button).click();
    const updated_ids = Array.from(mount.querySelectorAll('tr.epic-row')).map(
      (row) => row.getAttribute('data-issue-id')
    );
    expect(updated_ids).toEqual(['UI-13', 'UI-11', 'UI-12']);
    expect(
      mount.querySelector('th[aria-sort="descending"]')?.textContent?.trim()
    ).toBe('Updated');
  });

  test('clicking inputs/selects inside a row does not navigate', async () => {
    document.body.innerHTML = '<div id="m"></div>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('m'));
    const data = {
      updateIssue: vi.fn(),
      getIssue: vi.fn(async (id) => ({ id }))
    };
    const stores3 = new Map();
    const listeners3 = new Set();
    /** @param {string} id */
    const getStore3 = (id) => {
      let s = stores3.get(id);
      if (!s) {
        s = createSubscriptionIssueStore(id);
        stores3.set(id, s);
        s.subscribe(() => {
          for (const fn of Array.from(listeners3)) {
            try {
              fn();
            } catch {
              /* ignore */
            }
          }
        });
      }
      return s;
    };
    const issueStores3 = {
      getStore: getStore3,
      /** @param {string} id */
      snapshotFor(id) {
        return getStore3(id).snapshot().slice();
      },
      /** @param {() => void} fn */
      subscribe(fn) {
        listeners3.add(fn);
        return () => listeners3.delete(fn);
      }
    };
    const subscriptions = createSubscriptionStore(async () => {});
    issueStores3.getStore('tab:epics').applyPush({
      type: 'snapshot',
      id: 'tab:epics',
      revision: 1,
      issues: [
        {
          id: 'UI-20',
          title: 'Epic Click Guard',
          issue_type: 'epic',
          dependents: [{ id: 'UI-21' }]
        }
      ]
    });
    /** @type {string[]} */
    const navCalls = [];
    const view = createEpicsView(
      mount,
      /** @type {any} */ (data),
      (id) => navCalls.push(id),
      subscriptions,
      /** @type {any} */ (issueStores3)
    );
    await view.load();
    // Provide detail snapshot so a child row exists
    issueStores3.getStore('detail:UI-20');
    issueStores3.getStore('detail:UI-20').applyPush({
      type: 'snapshot',
      id: 'detail:UI-20',
      revision: 1,
      issues: [
        {
          id: 'UI-20',
          title: 'Epic Click Guard',
          issue_type: 'epic',
          dependents: [
            {
              id: 'UI-21',
              title: 'Row',
              status: 'open',
              priority: 2,
              issue_type: 'task'
            }
          ]
        }
      ]
    });
    await view.load();
    // Click a select inside the row; should not navigate
    const sel = /** @type {HTMLSelectElement|null} */ (
      mount.querySelector('tr.epic-row select')
    );
    sel?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(navCalls.length).toBe(0);
  });

  test('shows Loading… while fetching children on manual expansion (no flicker)', async () => {
    document.body.innerHTML = '<div id="m"></div>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('m'));
    const data = {
      updateIssue: vi.fn(),
      getIssue: vi.fn(async (id) => ({ id }))
    };
    const stores4 = new Map();
    const listeners4 = new Set();
    /** @param {string} id */
    const getStore4 = (id) => {
      let s = stores4.get(id);
      if (!s) {
        s = createSubscriptionIssueStore(id);
        stores4.set(id, s);
        s.subscribe(() => {
          for (const fn of Array.from(listeners4)) {
            try {
              fn();
            } catch {
              /* ignore */
            }
          }
        });
      }
      return s;
    };
    const issueStores4 = {
      getStore: getStore4,
      /** @param {string} id */
      snapshotFor(id) {
        return getStore4(id).snapshot().slice();
      },
      /** @param {() => void} fn */
      subscribe(fn) {
        listeners4.add(fn);
        return () => listeners4.delete(fn);
      }
    };
    const subscriptions = createSubscriptionStore(async () => {});
    issueStores4.getStore('tab:epics').applyPush({
      type: 'snapshot',
      id: 'tab:epics',
      revision: 1,
      issues: [
        {
          id: 'UI-40',
          title: 'Auto Expanded',
          issue_type: 'epic',
          dependents: []
        },
        {
          id: 'UI-41',
          title: 'Manual Expand',
          issue_type: 'epic',
          dependents: [{ id: 'UI-42' }]
        }
      ]
    });
    const view = createEpicsView(
      mount,
      /** @type {any} */ (data),
      () => {},
      subscriptions,
      /** @type {any} */ (issueStores4)
    );
    await view.load();
    // Expand the second group manually
    const groups = Array.from(mount.querySelectorAll('.epic-group'));
    const manual = groups.find(
      (g) => g.getAttribute('data-epic-id') === 'UI-41'
    );
    expect(manual).toBeDefined();
    manual
      ?.querySelector('.epic-header')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // Immediately after click, expect Loading…
    const text = manual?.querySelector('.epic-children')?.textContent || '';
    expect(text.includes('Loading…')).toBe(true);
    // Provide epic detail snapshot (no rendering assertion here)
    issueStores4.getStore('detail:UI-41');
    issueStores4.getStore('detail:UI-41').applyPush({
      type: 'snapshot',
      id: 'detail:UI-41',
      revision: 1,
      issues: [
        {
          id: 'UI-41',
          title: 'Epic Manual',
          issue_type: 'epic',
          dependents: [
            {
              id: 'UI-42',
              title: 'Child',
              status: 'open',
              priority: 2,
              issue_type: 'task'
            }
          ]
        }
      ]
    });
    // Verify mapping via store presence
    const d = issueStores4.snapshotFor('detail:UI-41');
    expect(d.length).toBe(1);
    expect(d[0]?.id).toBe('UI-41');
  });

  test('clicking the editable title does not navigate and enters edit mode', async () => {
    document.body.innerHTML = '<div id="m"></div>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('m'));
    const data = {
      updateIssue: vi.fn(),
      getIssue: vi.fn(async (id) => ({ id }))
    };
    const stores5 = new Map();
    const listeners5 = new Set();
    /** @param {string} id */
    const getStore5 = (id) => {
      let s = stores5.get(id);
      if (!s) {
        s = createSubscriptionIssueStore(id);
        stores5.set(id, s);
        s.subscribe(() => {
          for (const fn of Array.from(listeners5)) {
            try {
              fn();
            } catch {
              /* ignore */
            }
          }
        });
      }
      return s;
    };
    const issueStores5 = {
      getStore: getStore5,
      /** @param {string} id */
      snapshotFor(id) {
        return getStore5(id).snapshot().slice();
      },
      /** @param {() => void} fn */
      subscribe(fn) {
        listeners5.add(fn);
        return () => listeners5.delete(fn);
      }
    };
    const subscriptions2 = createSubscriptionStore(async () => {});
    issueStores5.getStore('tab:epics').applyPush({
      type: 'snapshot',
      id: 'tab:epics',
      revision: 1,
      issues: [
        {
          id: 'UI-30',
          title: 'Epic Title Click',
          issue_type: 'epic',
          dependents: [{ id: 'UI-31' }]
        }
      ]
    });
    /** @type {string[]} */
    const navCalls = [];
    const view = createEpicsView(
      mount,
      /** @type {any} */ (data),
      (id) => navCalls.push(id),
      subscriptions2,
      /** @type {any} */ (issueStores5)
    );
    await view.load();
    issueStores5.getStore('detail:UI-30');
    issueStores5.getStore('detail:UI-30').applyPush({
      type: 'snapshot',
      id: 'detail:UI-30',
      revision: 1,
      issues: [
        {
          id: 'UI-30',
          title: 'Epic Title Click',
          issue_type: 'epic',
          dependents: [
            {
              id: 'UI-31',
              title: 'Clickable Title',
              status: 'open',
              priority: 2,
              issue_type: 'task'
            }
          ]
        }
      ]
    });
    await view.load();
    const titleSpan = /** @type {HTMLElement|null} */ (
      mount.querySelector('tr.epic-row td:nth-child(3) .editable')
    );
    expect(titleSpan).not.toBeNull();
    titleSpan?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Should not have navigated
    expect(navCalls.length).toBe(0);
    // Should render an input for title now
    const input = /** @type {HTMLInputElement|null} */ (
      mount.querySelector('tr.epic-row td:nth-child(3) input[type="text"]')
    );
    expect(input).not.toBeNull();
  });
});
