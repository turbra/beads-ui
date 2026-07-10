import { describe, expect, test } from 'vitest';
import {
  LARGE_LIST_BASELINE_CEILING,
  evaluateLargeListTier,
  nearestRankPercentile
} from './large-list-budgets.js';

/**
 * @param {number} tier
 */
function passingMetrics(tier) {
  return {
    snapshot_bytes: 1024,
    progressive_rows: 200,
    delta_notifications: 1,
    serialize_p95_ms: 1,
    parse_p95_ms: 1,
    store_sort_p95_ms: 1,
    delta_100_p95_ms: 1,
    progressive_render_p95_ms: 1,
    progressive_heap_delta_mib: 1,
    render_improvement_percent: tier === 1000 ? 50 : 60
  };
}

describe('large-list benchmark budgets', () => {
  test('computes nearest-rank percentiles', () => {
    const values = [9, 1, 7, 3, 5];

    const p50 = nearestRankPercentile(values, 50);
    const p95 = nearestRankPercentile(values, 95);

    expect(p50).toBe(5);
    expect(p95).toBe(9);
  });

  test('keeps a passing larger tier ineligible without external evidence', () => {
    const result = evaluateLargeListTier(5000, passingMetrics(5000));

    expect(result.host_pass).toBe(true);
    expect(result.ceiling_eligible).toBe(false);
  });

  test('accepts a passing larger tier with browser and bd evidence', () => {
    const result = evaluateLargeListTier(5000, passingMetrics(5000), {
      browser_proven: true,
      bd_representative: true
    });

    expect(result.ceiling_eligible).toBe(true);
  });

  test('retains the baseline ceiling without external evidence', () => {
    const result = evaluateLargeListTier(
      LARGE_LIST_BASELINE_CEILING,
      passingMetrics(LARGE_LIST_BASELINE_CEILING)
    );

    expect(result.ceiling_eligible).toBe(true);
  });

  test('rejects a tier when an absolute host budget fails', () => {
    const metrics = passingMetrics(5000);
    metrics.progressive_rows = 201;

    const result = evaluateLargeListTier(5000, metrics, {
      browser_proven: true,
      bd_representative: true
    });

    expect(result.host_pass).toBe(false);
    expect(result.checks.initial_rows).toBe(false);
    expect(result.ceiling_eligible).toBe(false);
  });
});
