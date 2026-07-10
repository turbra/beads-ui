import { describe, expect, test, vi } from 'vitest';
import { createSubscriptionIssueStore } from './subscription-issue-store.js';

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('subscription issue store', () => {
  test('applies snapshot and returns sorted snapshot', () => {
    const store = createSubscriptionIssueStore('s1');
    store.applyPush({
      type: 'snapshot',
      id: 's1',
      revision: 1,
      issues: [
        {
          id: 'B',
          priority: 2,
          created_at: 10_000,
          updated_at: 10_000,
          closed_at: null
        },
        {
          id: 'A',
          priority: 1,
          created_at: 20_000,
          updated_at: 20_000,
          closed_at: null
        }
      ]
    });
    const snap = /** @type {any[]} */ (store.snapshot());
    expect(Array.isArray(snap)).toBe(true);
    expect(snap.map((it) => it.id)).toEqual(['A', 'B']);
    expect(store.size()).toBe(2);
  });

  test('upsert updates in place and preserves identity', () => {
    const store = createSubscriptionIssueStore('s1');
    store.applyPush({
      type: 'snapshot',
      id: 's1',
      revision: 1,
      issues: [
        {
          id: 'X',
          title: 'x',
          created_at: 10_000,
          updated_at: 10_000,
          closed_at: null
        }
      ]
    });
    const before = store.getById('X');
    expect(before?.title).toBe('x');
    store.applyPush({
      type: 'upsert',
      id: 's1',
      revision: 2,
      issue: {
        id: 'X',
        title: 'X!',
        created_at: 10_000,
        updated_at: 10_060,
        closed_at: null
      }
    });
    const after = store.getById('X');
    expect(after?.title).toBe('X!');
    expect(after).toBe(before); // identity preserved
  });

  test('preserves comments when upsert omits comments', () => {
    const store = createSubscriptionIssueStore('s1');
    const comments = [{ id: 1, text: 'Existing comment' }];
    store.applyPush({
      type: 'snapshot',
      id: 's1',
      revision: 1,
      issues: [
        {
          id: 'X',
          title: 'x',
          comments,
          comment_count: 1,
          created_at: 10_000,
          updated_at: 10_000,
          closed_at: null
        }
      ]
    });

    store.applyPush({
      type: 'upsert',
      id: 's1',
      revision: 2,
      issue: {
        id: 'X',
        title: 'X!',
        comment_count: 1,
        created_at: 10_000,
        updated_at: 10_060,
        closed_at: null
      }
    });

    expect(store.getById('X')?.comments).toBe(comments);
    expect(store.getById('X')?.title).toBe('X!');
  });

  test('accepts explicit incoming comments on upsert', () => {
    const store = createSubscriptionIssueStore('s1');
    store.applyPush({
      type: 'snapshot',
      id: 's1',
      revision: 1,
      issues: [
        {
          id: 'X',
          title: 'x',
          comments: [{ id: 1, text: 'Existing comment' }],
          comment_count: 1,
          created_at: 10_000,
          updated_at: 10_000,
          closed_at: null
        }
      ]
    });

    store.applyPush({
      type: 'upsert',
      id: 's1',
      revision: 2,
      issue: {
        id: 'X',
        title: 'X!',
        comments: [],
        comment_count: 0,
        created_at: 10_000,
        updated_at: 10_060,
        closed_at: null
      }
    });

    expect(store.getById('X')?.comments).toEqual([]);
    expect(store.getById('X')?.comment_count).toBe(0);
  });

  test('seed does not advance revision before server snapshot', () => {
    const store = createSubscriptionIssueStore('s1');

    store.seed([
      {
        id: 'X',
        title: 'Seeded title',
        created_at: 10_000,
        updated_at: 10_000,
        closed_at: null
      }
    ]);

    expect(store.getById('X')?.title).toBe('Seeded title');
    store.applyPush({
      type: 'snapshot',
      id: 's1',
      revision: 1,
      issues: [
        {
          id: 'X',
          title: 'Server title',
          created_at: 10_000,
          updated_at: 10_060,
          closed_at: null
        }
      ]
    });

    expect(store.getById('X')?.title).toBe('Server title');
  });

  test('preserves comments metadata when snapshot omits it', () => {
    const store = createSubscriptionIssueStore('s1');
    const comments = [{ id: 1, text: 'Existing comment' }];

    store.seed([
      {
        id: 'X',
        title: 'Seeded title',
        comments,
        comment_count: 1,
        created_at: 10_000,
        updated_at: 10_000,
        closed_at: null
      }
    ]);
    store.applyPush({
      type: 'snapshot',
      id: 's1',
      revision: 1,
      issues: [
        {
          id: 'X',
          title: 'Server title',
          created_at: 10_000,
          updated_at: 10_060,
          closed_at: null
        }
      ]
    });

    expect(store.getById('X')?.comment_count).toBe(1);
    expect(store.getById('X')?.comments).toBe(comments);
  });

  test('ignores stale upsert by revision and timestamp', () => {
    const store = createSubscriptionIssueStore('s1');
    store.applyPush({
      type: 'snapshot',
      id: 's1',
      revision: 5,
      issues: [
        {
          id: 'X',
          title: 'x',
          created_at: 10_000,
          updated_at: 10_600,
          closed_at: null
        }
      ]
    });
    // stale revision
    store.applyPush({
      type: 'upsert',
      id: 's1',
      revision: 4,
      issue: {
        id: 'X',
        title: 'old',
        created_at: 10_000,
        updated_at: 10_540,
        closed_at: null
      }
    });
    expect(store.getById('X')?.title).toBe('x');
    // equal revision is ignored
    store.applyPush({
      type: 'upsert',
      id: 's1',
      revision: 5,
      issue: {
        id: 'X',
        title: 'same',
        created_at: 10_000,
        updated_at: 10_660,
        closed_at: null
      }
    });
    expect(store.getById('X')?.title).toBe('x');
    // higher revision but stale timestamp is ignored
    store.applyPush({
      type: 'upsert',
      id: 's1',
      revision: 6,
      issue: {
        id: 'X',
        title: 'stale',
        created_at: 10_000,
        updated_at: 10_000,
        closed_at: null
      }
    });
    expect(store.getById('X')?.title).toBe('x');
  });

  test('delete removes item', () => {
    const store = createSubscriptionIssueStore('s1');
    store.applyPush({
      type: 'snapshot',
      id: 's1',
      revision: 1,
      issues: [
        { id: 'A', created_at: 10_000, updated_at: 10_000, closed_at: null },
        { id: 'B', created_at: 10_000, updated_at: 10_000, closed_at: null }
      ]
    });
    store.applyPush({ type: 'delete', id: 's1', revision: 2, issue_id: 'A' });
    expect(store.size()).toBe(1);
    expect(store.getById('A')).toBeUndefined();
    const ids = /** @type {any[]} */ (store.snapshot()).map((x) => x.id);
    expect(ids).toEqual(['B']);
  });

  test('subscribe coalesces a synchronous applyPush burst', async () => {
    const store = createSubscriptionIssueStore('s1');
    let count = 0;
    store.subscribe(() => {
      count += 1;
    });
    store.applyPush({
      type: 'snapshot',
      id: 's1',
      revision: 1,
      issues: [
        { id: 'A', created_at: 10_000, updated_at: 10_000, closed_at: null }
      ]
    });
    store.applyPush({
      type: 'upsert',
      id: 's1',
      revision: 2,
      issue: {
        id: 'A',
        title: 't',
        created_at: 10_000,
        updated_at: 10_060,
        closed_at: null
      }
    });
    expect(count).toBe(0);

    await flushMicrotasks();

    expect(count).toBe(1);

    store.applyPush({
      type: 'upsert',
      id: 's1',
      revision: 3,
      issue: {
        id: 'A',
        title: 't2',
        created_at: 10_000,
        updated_at: 10_070,
        closed_at: null
      }
    });

    await flushMicrotasks();

    expect(count).toBe(2);
  });

  test('sorts once for a synchronous push burst', async () => {
    const sort = vi.fn((a, b) => a.id.localeCompare(b.id));
    const store = createSubscriptionIssueStore('s1', { sort });
    store.applyPush({
      type: 'snapshot',
      id: 's1',
      revision: 1,
      issues: [
        { id: 'B', created_at: 10_000, updated_at: 10_000, closed_at: null },
        { id: 'A', created_at: 10_000, updated_at: 10_000, closed_at: null }
      ]
    });
    store.applyPush({
      type: 'upsert',
      id: 's1',
      revision: 2,
      issue: {
        id: 'A',
        title: 'A2',
        created_at: 10_000,
        updated_at: 10_060,
        closed_at: null
      }
    });

    await flushMicrotasks();

    expect(sort).toHaveBeenCalledTimes(1);
    expect(store.snapshot().map((issue) => issue.id)).toEqual(['A', 'B']);
  });

  test('sorts immediately for a synchronous snapshot read', async () => {
    const sort = vi.fn((a, b) => a.id.localeCompare(b.id));
    const store = createSubscriptionIssueStore('s1', { sort });
    store.applyPush({
      type: 'snapshot',
      id: 's1',
      revision: 1,
      issues: [
        { id: 'B', created_at: 10_000, updated_at: 10_000, closed_at: null },
        { id: 'A', created_at: 10_000, updated_at: 10_000, closed_at: null }
      ]
    });

    expect(store.snapshot().map((issue) => issue.id)).toEqual(['A', 'B']);
    expect(sort).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    expect(sort).toHaveBeenCalledTimes(1);
  });

  test('applies a delta atomically with one notification and identity preservation', async () => {
    const sort = vi.fn((a, b) => a.id.localeCompare(b.id));
    const store = createSubscriptionIssueStore('s1', { sort });
    store.applyPush({
      type: 'snapshot',
      id: 's1',
      revision: 1,
      issues: [
        {
          id: 'A',
          title: 'A1',
          comments: [{ text: 'kept' }],
          comment_count: 1,
          updated_at: 100
        },
        { id: 'B', title: 'B1', updated_at: 100 }
      ]
    });
    await flushMicrotasks();
    sort.mockClear();
    const listener = vi.fn();
    store.subscribe(listener);
    const original = store.getById('A');

    const result = store.applyPush({
      type: 'delta',
      id: 's1',
      revision: 2,
      upserts: [
        { id: 'A', title: 'A2', updated_at: 200 },
        { id: 'C', title: 'C1', updated_at: 100 }
      ],
      deletes: ['B']
    });

    expect(result).toBe('applied');
    expect(listener).not.toHaveBeenCalled();
    expect(store.getById('A')).toBe(original);
    expect(store.getById('A')?.comments).toEqual([{ text: 'kept' }]);
    expect(store.getById('A')?.comment_count).toBe(1);
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.snapshot().map((issue) => issue.id)).toEqual(['A', 'C']);
    expect(sort).toHaveBeenCalledTimes(1);
  });

  test.each([
    { upserts: [{ id: 'A' }], deletes: [] },
    { upserts: 'not-an-array', deletes: ['B', 'C'] },
    { upserts: [{ id: 'A' }, { id: 'A' }], deletes: [] },
    { upserts: [{ id: 'A' }], deletes: ['A'] },
    { upserts: [{ id: '' }], deletes: ['B'] },
    { upserts: [{ id: 'A' }], deletes: ['', 'B'] },
    { upserts: [{ id: 'A' }], deletes: ['B', 'B'] }
  ])('rejects malformed delta without partial state: %o', async (delta) => {
    const store = createSubscriptionIssueStore('s1');
    store.applyPush({
      type: 'snapshot',
      id: 's1',
      revision: 1,
      issues: [{ id: 'A', title: 'original', updated_at: 100 }]
    });
    await flushMicrotasks();
    const listener = vi.fn();
    store.subscribe(listener);

    const result = store.applyPush(
      /** @type {any} */ ({
        type: 'delta',
        id: 's1',
        revision: 2,
        ...delta
      })
    );

    expect(result).toBe('resync-needed');
    expect(store.snapshot().map((issue) => issue.id)).toEqual(['A']);
    expect(store.getById('A')?.title).toBe('original');
    await flushMicrotasks();
    expect(listener).not.toHaveBeenCalled();
  });

  test('ignores stale delta without entering resync', () => {
    const store = createSubscriptionIssueStore('s1');
    store.applyPush({
      type: 'snapshot',
      id: 's1',
      revision: 5,
      issues: [{ id: 'A', updated_at: 100 }]
    });

    const stale = store.applyPush({
      type: 'delta',
      id: 's1',
      revision: 4,
      upserts: [],
      deletes: []
    });
    const next = store.applyPush({
      type: 'upsert',
      id: 's1',
      revision: 6,
      issue: { id: 'B', updated_at: 100 }
    });

    expect(stale).toBe('ignored');
    expect(next).toBe('applied');
    expect(store.getById('B')).toBeDefined();
  });

  test('blocks incrementals after invalid delta until a fresh snapshot', () => {
    const store = createSubscriptionIssueStore('s1');
    store.applyPush({
      type: 'snapshot',
      id: 's1',
      revision: 1,
      issues: [{ id: 'A', updated_at: 100 }]
    });

    expect(
      store.applyPush({
        type: 'delta',
        id: 's1',
        revision: 2,
        upserts: [{ id: 'B' }],
        deletes: []
      })
    ).toBe('resync-needed');
    expect(
      store.applyPush({
        type: 'upsert',
        id: 's1',
        revision: 3,
        issue: { id: 'B', updated_at: 100 }
      })
    ).toBe('ignored');
    expect(store.getById('B')).toBeUndefined();

    expect(
      store.applyPush({
        type: 'snapshot',
        id: 's1',
        revision: 4,
        issues: [{ id: 'C', updated_at: 100 }]
      })
    ).toBe('applied');
    expect(
      store.applyPush({
        type: 'upsert',
        id: 's1',
        revision: 5,
        issue: { id: 'D', updated_at: 100 }
      })
    ).toBe('applied');
    expect(store.snapshot().map((issue) => issue.id)).toEqual(['C', 'D']);
  });

  test('dispose clears listeners and state', async () => {
    const store = createSubscriptionIssueStore('s1');
    let hit = 0;
    store.subscribe(() => {
      hit += 1;
    });
    store.dispose();
    store.applyPush({
      type: 'snapshot',
      id: 's1',
      revision: 1,
      issues: [
        { id: 'A', created_at: 10_000, updated_at: 10_000, closed_at: null }
      ]
    });
    await flushMicrotasks();

    expect(hit).toBe(0);
    expect(store.size()).toBe(0);
  });

  test('retains exact snapshot truncation metadata', () => {
    const store = createSubscriptionIssueStore('s1');

    store.applyPush({
      type: 'snapshot',
      id: 's1',
      revision: 1,
      issues: [],
      truncated: true
    });
    expect(store.truncation()).toBe(true);

    store.applyPush({
      type: 'snapshot',
      id: 's1',
      revision: 2,
      issues: [],
      truncated: false
    });
    expect(store.truncation()).toBe(false);

    store.applyPush({
      type: 'snapshot',
      id: 's1',
      revision: 3,
      issues: []
    });
    expect(store.truncation()).toBeNull();
  });
});
