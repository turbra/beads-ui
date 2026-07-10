import { describe, expect, test } from 'vitest';
import { ISSUES_SEGMENT_SIZE, createListView } from './list.js';

/**
 * @param {number} count
 */
function createIssues(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `UI-${String(index + 1).padStart(5, '0')}`,
    title: `Issue ${index + 1}`,
    status: index % 2 === 0 ? 'open' : 'closed',
    priority: index % 5,
    issue_type: index % 2 === 0 ? 'bug' : 'task',
    updated_at: index + 1
  }));
}

/**
 * @param {any[]} initial_issues
 */
function createIssueStores(initial_issues) {
  let issues = initial_issues;
  let identity = {};
  /** @type {Set<(client_id: string) => void>} */
  const listeners = new Set();

  return {
    getStore() {
      return identity;
    },
    snapshotFor() {
      return issues.slice();
    },
    /**
     * @param {string | string[]} _client_ids
     * @param {(client_id: string) => void} fn
     */
    subscribeFor(_client_ids, fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /**
     * @param {any[]} next_issues
     * @param {{ replace_identity?: boolean }} [options]
     */
    replace(next_issues, options = {}) {
      issues = next_issues;
      if (options.replace_identity) {
        identity = {};
      }
      for (const fn of Array.from(listeners)) {
        fn('tab:issues');
      }
    }
  };
}

/**
 * @param {HTMLInputElement} input
 * @param {string} value
 */
async function searchFor(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 130));
}

/**
 * @param {HTMLElement} mount
 * @param {number} dropdown_index
 * @param {string} label_text
 */
function toggleFilter(mount, dropdown_index, label_text) {
  const dropdown = mount.querySelectorAll('.filter-dropdown')[dropdown_index];
  const option = Array.from(
    dropdown.querySelectorAll('.filter-dropdown__option')
  ).find((candidate) => candidate.textContent?.includes(label_text));
  const input = /** @type {HTMLInputElement} */ (
    option?.querySelector('input')
  );
  input.click();
}

describe('views/list progressive rendering', () => {
  test('renders a bounded segment with complete accessible counts', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const issue_stores = createIssueStores(createIssues(5000));
    const view = createListView(
      mount,
      async () => [],
      undefined,
      undefined,
      issue_stores
    );

    await view.load();

    const initial_rows = mount.querySelectorAll('tbody tr.issue-row');
    expect(initial_rows).toHaveLength(ISSUES_SEGMENT_SIZE);
    expect(mount.querySelectorAll('tr')).toHaveLength(ISSUES_SEGMENT_SIZE + 1);
    expect(mount.querySelector('table')?.getAttribute('aria-rowcount')).toBe(
      '5001'
    );
    expect(initial_rows[0].getAttribute('aria-rowindex')).toBe('2');
    expect(initial_rows[199].getAttribute('aria-rowindex')).toBe('201');
    expect(
      mount.querySelector('.progressive-list__status')?.textContent
    ).toContain('Showing 200 of 5000 issues');

    const root = /** @type {HTMLElement} */ (mount.querySelector('#list-root'));
    root.scrollTop = 173;
    const more = /** @type {HTMLButtonElement} */ (
      mount.querySelector('.progressive-list__more')
    );
    expect(more.textContent.replace(/\s+/g, ' ').trim()).toBe('Show 200 more');
    more.focus();
    more.click();

    const expanded_rows = Array.from(
      mount.querySelectorAll('tbody tr.issue-row')
    );
    expect(expanded_rows).toHaveLength(400);
    expect(
      new Set(expanded_rows.map((row) => row.getAttribute('data-issue-id')))
        .size
    ).toBe(400);
    expect(root.scrollTop).toBe(173);
    expect(document.activeElement).toBe(
      mount.querySelector('.progressive-list__more')
    );
  });

  test('filters and sorts all issues before applying the segment', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const issues = createIssues(5000);
    issues[4499].title = 'Needle beyond initial segment';
    const issue_stores = createIssueStores(issues);
    const view = createListView(
      mount,
      async () => [],
      undefined,
      undefined,
      issue_stores
    );
    await view.load();

    const search = /** @type {HTMLInputElement} */ (
      mount.querySelector('input[type="search"]')
    );
    await searchFor(search, 'Needle beyond');

    expect(mount.querySelectorAll('tbody tr.issue-row')).toHaveLength(1);
    expect(
      mount.querySelector('tbody tr.issue-row')?.getAttribute('data-issue-id')
    ).toBe('UI-04500');

    await searchFor(search, 'Issue');
    expect(mount.querySelectorAll('tbody tr.issue-row')).toHaveLength(200);
    /** @type {HTMLButtonElement} */ (
      mount.querySelector('.progressive-list__more')
    ).click();
    expect(mount.querySelectorAll('tbody tr.issue-row')).toHaveLength(400);

    toggleFilter(mount, 1, 'Bug');
    expect(mount.querySelectorAll('tbody tr.issue-row')).toHaveLength(200);
    /** @type {HTMLButtonElement} */ (
      mount.querySelector('.progressive-list__more')
    ).click();
    toggleFilter(mount, 0, 'Open');
    await Promise.resolve();
    expect(mount.querySelectorAll('tbody tr.issue-row')).toHaveLength(200);

    /** @type {HTMLButtonElement} */ (
      mount.querySelector('.progressive-list__more')
    ).click();
    /** @type {HTMLButtonElement} */ (
      mount.querySelector('button[aria-label="Sort by Priority"]')
    ).click();
    expect(mount.querySelectorAll('tbody tr.issue-row')).toHaveLength(200);
  }, 20000);

  test('keeps hidden updates in counts and resets for a new subscription', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const issues = createIssues(500);
    const issue_stores = createIssueStores(issues);
    const view = createListView(
      mount,
      async () => [],
      undefined,
      undefined,
      issue_stores
    );
    await view.load();
    /** @type {HTMLButtonElement} */ (
      mount.querySelector('.progressive-list__more')
    ).click();

    const added = {
      id: 'UI-99999',
      title: 'Hidden addition',
      status: 'open',
      issue_type: 'bug'
    };
    issue_stores.replace([...issues, added]);
    expect(
      mount.querySelector('.progressive-list__status')?.textContent
    ).toContain('Showing 400 of 501 issues');

    issue_stores.replace([
      ...issues.slice(0, 449),
      ...issues.slice(450),
      added
    ]);
    expect(
      mount.querySelector('.progressive-list__status')?.textContent
    ).toContain('Showing 400 of 500 issues');
    /** @type {HTMLButtonElement} */ (
      mount.querySelector('.progressive-list__more')
    ).click();
    const ids = Array.from(mount.querySelectorAll('tbody tr.issue-row')).map(
      (row) => row.getAttribute('data-issue-id')
    );
    expect(ids).toHaveLength(500);
    expect(new Set(ids).size).toBe(500);
    expect(ids).toContain('UI-99999');
    expect(ids).not.toContain('UI-00450');

    issue_stores.replace(createIssues(5000), { replace_identity: true });
    expect(mount.querySelectorAll('tbody tr.issue-row')).toHaveLength(200);
    expect(
      mount.querySelector('.progressive-list__status')?.textContent
    ).toContain('Showing 200 of 5000 issues');
  });

  test('bounds keyboard navigation to rendered rows', async () => {
    document.body.innerHTML = '<aside id="mount" class="panel"></aside>';
    const mount = /** @type {HTMLElement} */ (document.getElementById('mount'));
    const issue_stores = createIssueStores(createIssues(250));
    const view = createListView(
      mount,
      async () => [],
      undefined,
      undefined,
      issue_stores
    );
    await view.load();

    const last_title = /** @type {HTMLElement} */ (
      mount.querySelector(
        'tbody tr.issue-row:nth-child(200) td:nth-child(3) .editable'
      )
    );
    last_title.focus();
    last_title.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    );
    expect(document.activeElement).toBe(last_title);

    /** @type {HTMLButtonElement} */ (
      mount.querySelector('.progressive-list__more')
    ).click();
    last_title.focus();
    last_title.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    );
    const next_title = mount.querySelector(
      'tbody tr.issue-row:nth-child(201) td:nth-child(3) .editable'
    );
    expect(document.activeElement).toBe(next_title);
    expect(next_title?.closest('tr')?.getAttribute('aria-rowindex')).toBe(
      '202'
    );
  });
});
