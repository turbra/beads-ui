import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createSubscriptionIssueStores } from '../data/subscription-issue-stores.js';
import { createListView } from './list.js';

const render_observer = vi.hoisted(() => vi.fn());

vi.mock('lit-html', async (import_original) => {
  const actual = /** @type {typeof import('lit-html')} */ (
    await import_original()
  );
  return {
    ...actual,
    /**
     * @param {unknown} value
     * @param {HTMLElement | DocumentFragment} container
     * @param {import('lit-html').RenderOptions} [options]
     */
    render(value, container, options) {
      render_observer();
      return actual.render(value, container, options);
    }
  };
});

describe('Issues delta rendering', () => {
  beforeEach(() => {
    render_observer.mockClear();
    document.body.innerHTML = '<main id="list"></main>';
  });

  test('renders once for one hundred batched changes', async () => {
    const issue_stores = createSubscriptionIssueStores();
    issue_stores.register('tab:issues', { type: 'all-issues' });
    const issue_store = issue_stores.getStore('tab:issues');
    if (!issue_store) {
      throw new Error('Issues store was not registered');
    }
    issue_store.applyPush({
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      issues: []
    });
    const mount = /** @type {HTMLElement} */ (document.getElementById('list'));
    const view = createListView(
      mount,
      async () => null,
      undefined,
      undefined,
      issue_stores
    );
    await view.load();
    await Promise.resolve();
    render_observer.mockClear();
    const upserts = Array.from({ length: 100 }, (_, index) => ({
      id: `UI-${index + 1}`,
      title: `Issue ${index + 1}`,
      updated_at: index + 1
    }));

    issue_store.applyPush({
      type: 'delta',
      id: 'tab:issues',
      revision: 2,
      upserts,
      deletes: []
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(render_observer).toHaveBeenCalledTimes(1);
    expect(mount.querySelectorAll('tr.issue-row')).toHaveLength(100);
    view.destroy();
  });
});
