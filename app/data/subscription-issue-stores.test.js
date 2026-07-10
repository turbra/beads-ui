import { describe, expect, test, vi } from 'vitest';
import { createSubscriptionIssueStores } from './subscription-issue-stores.js';

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('subscription issue store registry', () => {
  test('resets revisions while preserving snapshots and comparators', () => {
    const registry = createSubscriptionIssueStores();
    const sort = vi.fn((a, b) => b.id.localeCompare(a.id));
    registry.register('list', { type: 'all-issues' }, { sort });
    const previous = registry.getStore('list');
    previous?.applyPush({
      type: 'snapshot',
      id: 'list',
      revision: 5,
      issues: [
        { id: 'A', created_at: 10_000, updated_at: 10_000, closed_at: null },
        { id: 'B', created_at: 10_000, updated_at: 10_000, closed_at: null }
      ]
    });

    const reset_ids = registry.resetForReconnect();
    const current = registry.getStore('list');

    expect(current?.snapshot().map((issue) => issue.id)).toEqual(['B', 'A']);

    current?.applyPush({
      type: 'snapshot',
      id: 'list',
      revision: 1,
      issues: [
        {
          id: 'A',
          title: 'from reconnect',
          created_at: 10_000,
          updated_at: 10_060,
          closed_at: null
        },
        { id: 'B', created_at: 10_000, updated_at: 10_000, closed_at: null }
      ]
    });

    expect(reset_ids).toEqual(['list']);
    expect(current).not.toBe(previous);
    expect(current?.getById('A')?.title).toBe('from reconnect');
    expect(current?.snapshot().map((issue) => issue.id)).toEqual(['B', 'A']);
    expect(sort).toHaveBeenCalled();
  });

  test('retains registry fanout after reconnect reset', async () => {
    const registry = createSubscriptionIssueStores();
    registry.register('list', { type: 'all-issues' });
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.resetForReconnect();
    registry.getStore('list')?.applyPush({
      type: 'snapshot',
      id: 'list',
      revision: 1,
      issues: []
    });
    await flushMicrotasks();

    expect(listener).toHaveBeenCalledWith('list');
  });
});
