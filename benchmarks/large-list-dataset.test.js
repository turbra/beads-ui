import { describe, expect, test } from 'vitest';
import {
  createLargeIssueDataset,
  createLargeIssueDelta
} from './large-list-dataset.js';

describe('large-list dataset generator', () => {
  test('generates deterministic full-shape tiers', () => {
    const first = createLargeIssueDataset(1000);

    const second = createLargeIssueDataset(1000);

    expect(second).toEqual(first);
    expect(first).toHaveLength(1000);
    expect(first[0]).toMatchObject({
      id: 'BENCH-00001',
      created_by: 'benchmark-harness',
      dependency_count: 1,
      dependent_count: 3,
      comment_count: 1
    });
    expect(first[0]).toHaveProperty('description');
    expect(first[0]).toHaveProperty('design');
    expect(first[0]).toHaveProperty('acceptance_criteria');
    expect(first[0]).toHaveProperty('notes');
    expect(first[0]).toHaveProperty('labels');
    expect(first[0]).toHaveProperty('metadata');
    expect(first[0]).toHaveProperty('dependencies');
  });

  test('changes output when the seed changes', () => {
    const first = createLargeIssueDataset(10, { seed: 1 });

    const second = createLargeIssueDataset(10, { seed: 2 });

    expect(second).not.toEqual(first);
  });

  test('derives one hundred deterministic full-issue updates', () => {
    const issues = createLargeIssueDataset(1000);

    const delta = createLargeIssueDelta(issues);

    expect(delta).toHaveLength(100);
    expect(delta[0].id).toBe(issues[0].id);
    expect(delta[0].title).toBe(`${issues[0].title} updated`);
    expect(delta[0].updated_at).toBeGreaterThan(issues[0].updated_at);
    expect(delta[0].dependency_count).toBe(issues[0].dependency_count);
  });
});
