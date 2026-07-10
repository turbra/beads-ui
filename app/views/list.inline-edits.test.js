import { describe, expect, test, vi } from 'vitest';
import { createSubscriptionIssueStore } from '../data/subscription-issue-store.js';
import { createListView } from './list.js';

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

function deferred() {
  /** @type {(value: any) => void} */
  let resolve = () => {};
  /** @type {(reason?: any) => void} */
  let reject = () => {};
  const promise = new Promise((resolve_fn, reject_fn) => {
    resolve = resolve_fn;
    reject = reject_fn;
  });
  return { promise, reject, resolve };
}

describe('views/list inline edits', () => {
  test('priority select dispatches update and refreshes row', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));

    const initial = [
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
        issue_type: 'bug'
      }
    ];

    /** @type {{ calls: Array<{ type: string, payload: any }> }} */
    const spy = { calls: [] };
    let current = [...initial];

    /** @type {(type: string, payload?: any) => Promise<any>} */
    const send = vi.fn(async (type, payload) => {
      spy.calls.push({ type, payload });
      // no list-issues requests in push-only mode
      if (type === 'update-priority') {
        const id = payload.id;
        const idx = current.findIndex((x) => x.id === id);
        if (idx >= 0) {
          // simulate server-side update, then push an upsert to the store
          const updated = { ...current[idx], priority: 4 };
          current[idx] = updated;
          issueStores.getStore('tab:issues').applyPush({
            type: 'upsert',
            id: 'tab:issues',
            revision: 2,
            issues: [updated]
          });
        }
        return {};
      }
      throw new Error('Unexpected');
    });
    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues: current
    });

    const view = createListView(
      mount,
      send,
      undefined,
      undefined,
      undefined,
      issueStores
    );
    await view.load();

    const firstRow = /** @type {HTMLElement} */ (
      mount.querySelector('tr.issue-row[data-issue-id="UI-1"]')
    );
    expect(firstRow).toBeTruthy();
    const prio = /** @type {HTMLSelectElement} */ (
      firstRow.querySelector('select.badge--priority')
    );
    expect(prio.value).toBe('1');

    // Change to a different priority; handler should call update-priority.
    prio.value = '4';
    prio.dispatchEvent(new Event('change'));

    await Promise.resolve();

    const types = spy.calls.map((c) => c.type);
    expect(types).toContain('update-priority');

    const prio2 = /** @type {HTMLSelectElement} */ (
      mount.querySelector(
        'tr.issue-row[data-issue-id="UI-1"] select.badge--priority'
      )
    );
    expect(prio2.value).toBe('4');
  });

  test('preserves an optimistic priority across stale pushes', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const request = deferred();
    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues: [{ id: 'UI-PENDING', title: 'Pending', priority: 1 }]
    });
    const view = createListView(
      mount,
      async () => request.promise,
      undefined,
      undefined,
      undefined,
      issueStores
    );
    await view.load();
    const priority = /** @type {HTMLSelectElement} */ (
      mount.querySelector('select.badge--priority')
    );

    priority.value = '4';
    priority.dispatchEvent(new Event('change'));

    expect(
      /** @type {HTMLSelectElement} */ (
        mount.querySelector('select.badge--priority')
      ).value
    ).toBe('4');
    issueStores.getStore('tab:issues').applyPush({
      type: 'upsert',
      id: 'tab:issues',
      revision: 2,
      issue: { id: 'UI-PENDING', title: 'Pending push', priority: 1 }
    });
    await Promise.resolve();
    expect(
      /** @type {HTMLSelectElement} */ (
        mount.querySelector('select.badge--priority')
      ).value
    ).toBe('4');

    request.resolve({ id: 'UI-PENDING', priority: 4 });
    await Promise.resolve();
    await Promise.resolve();
    expect(
      /** @type {HTMLSelectElement} */ (
        mount.querySelector('select.badge--priority')
      ).value
    ).toBe('4');
  });

  test('merges the successful title response before its push arrives', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const request = deferred();
    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues: [{ id: 'UI-TITLE', title: 'Old title', priority: 1 }]
    });
    const view = createListView(
      mount,
      async () => request.promise,
      undefined,
      undefined,
      undefined,
      issueStores
    );
    await view.load();
    /** @type {HTMLElement} */ (
      mount.querySelector('td:nth-child(3) .editable')
    ).click();
    const input = /** @type {HTMLInputElement} */ (
      mount.querySelector('td:nth-child(3) input')
    );
    await Promise.resolve();
    expect(document.activeElement).toBe(input);
    input.value = 'requested title';

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );

    expect(mount.querySelector('td:nth-child(3)')?.textContent).toContain(
      'requested title'
    );
    request.resolve({ id: 'UI-TITLE', title: 'Normalized title' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mount.querySelector('td:nth-child(3)')?.textContent).toContain(
      'Normalized title'
    );
  });

  test('only the current status generation can roll back and toast', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const first_request = deferred();
    const second_request = deferred();
    const requests = [first_request, second_request];
    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues: [{ id: 'UI-STATUS', title: 'Status', status: 'open' }]
    });
    const view = createListView(
      mount,
      async () => /** @type {Promise<any>} */ (requests.shift()?.promise),
      undefined,
      undefined,
      undefined,
      issueStores
    );
    await view.load();
    let status = /** @type {HTMLSelectElement} */ (
      mount.querySelector('select.badge--status')
    );
    status.value = 'in_progress';
    status.dispatchEvent(new Event('change'));
    status = /** @type {HTMLSelectElement} */ (
      mount.querySelector('select.badge--status')
    );
    status.value = 'closed';
    status.dispatchEvent(new Event('change'));

    first_request.reject(new Error('stale failure'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      /** @type {HTMLSelectElement} */ (
        mount.querySelector('select.badge--status')
      ).value
    ).toBe('closed');
    expect(document.querySelector('.toast--error')).toBeNull();

    second_request.reject(new Error('current failure'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      /** @type {HTMLSelectElement} */ (
        mount.querySelector('select.badge--status')
      ).value
    ).toBe('open');
    expect(document.querySelector('.toast--error')?.textContent).toContain(
      'status'
    );
  });

  test('rolls a failed edit back to the prior successful overlay', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const second_request = deferred();
    let request_count = 0;
    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues: [{ id: 'UI-ROLLBACK', title: 'Rollback', status: 'open' }]
    });
    const view = createListView(
      mount,
      async () => {
        request_count += 1;
        return request_count === 1
          ? { id: 'UI-ROLLBACK', status: 'closed' }
          : second_request.promise;
      },
      undefined,
      undefined,
      undefined,
      issueStores
    );
    await view.load();
    let status = /** @type {HTMLSelectElement} */ (
      mount.querySelector('select.badge--status')
    );

    status.value = 'closed';
    status.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();
    status = /** @type {HTMLSelectElement} */ (
      mount.querySelector('select.badge--status')
    );
    expect(status.value).toBe('closed');

    status.value = 'in_progress';
    status.dispatchEvent(new Event('change'));
    second_request.reject(new Error('second edit failed'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      /** @type {HTMLSelectElement} */ (
        mount.querySelector('select.badge--status')
      ).value
    ).toBe('closed');
  });

  test('retains a superseded success when the newer edit fails', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const first_request = deferred();
    const second_request = deferred();
    const requests = [first_request, second_request];
    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues: [{ id: 'UI-SUPERSEDED', title: 'Superseded', status: 'open' }]
    });
    const view = createListView(
      mount,
      async () => /** @type {Promise<any>} */ (requests.shift()?.promise),
      undefined,
      undefined,
      undefined,
      issueStores
    );
    await view.load();
    let status = /** @type {HTMLSelectElement} */ (
      mount.querySelector('select.badge--status')
    );
    status.value = 'closed';
    status.dispatchEvent(new Event('change'));
    status = /** @type {HTMLSelectElement} */ (
      mount.querySelector('select.badge--status')
    );
    status.value = 'in_progress';
    status.dispatchEvent(new Event('change'));

    first_request.resolve({ id: 'UI-SUPERSEDED', status: 'closed' });
    await Promise.resolve();
    await Promise.resolve();
    expect(
      /** @type {HTMLSelectElement} */ (
        mount.querySelector('select.badge--status')
      ).value
    ).toBe('in_progress');

    second_request.reject(new Error('newer edit failed'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      /** @type {HTMLSelectElement} */ (
        mount.querySelector('select.badge--status')
      ).value
    ).toBe('closed');
  });

  test('restores an older success that resolves after a newer failure', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const first_request = deferred();
    const second_request = deferred();
    const requests = [first_request, second_request];
    const issueStores = createTestIssueStores();
    issueStores.getStore('tab:issues').applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues: [{ id: 'UI-REVERSE', title: 'Reverse', status: 'open' }]
    });
    const view = createListView(
      mount,
      async () => /** @type {Promise<any>} */ (requests.shift()?.promise),
      undefined,
      undefined,
      undefined,
      issueStores
    );
    await view.load();
    let status = /** @type {HTMLSelectElement} */ (
      mount.querySelector('select.badge--status')
    );
    status.value = 'closed';
    status.dispatchEvent(new Event('change'));
    status = /** @type {HTMLSelectElement} */ (
      mount.querySelector('select.badge--status')
    );
    status.value = 'in_progress';
    status.dispatchEvent(new Event('change'));

    second_request.reject(new Error('newer edit failed'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      /** @type {HTMLSelectElement} */ (
        mount.querySelector('select.badge--status')
      ).value
    ).toBe('open');

    first_request.resolve({ id: 'UI-REVERSE', status: 'closed' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      /** @type {HTMLSelectElement} */ (
        mount.querySelector('select.badge--status')
      ).value
    ).toBe('closed');
  });
});
