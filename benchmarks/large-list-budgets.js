export const LARGE_LIST_TIERS = Object.freeze([1000, 5000, 10000]);
export const LARGE_LIST_BASELINE_CEILING = 1000;
export const LARGE_LIST_SEGMENT_SIZE = 200;
export const LARGE_LIST_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * Predeclared absolute budgets. Timing budgets are host-harness guardrails,
 * not CI assertions. A ceiling increase additionally requires representative
 * real-browser and real-bd evidence.
 */
export const LARGE_LIST_BUDGETS = Object.freeze({
  1000: Object.freeze({
    serialize_p95_ms: 75,
    parse_p95_ms: 75,
    store_sort_p95_ms: 75,
    delta_100_p95_ms: 75,
    progressive_render_p95_ms: 1250,
    progressive_heap_delta_mib: 96,
    minimum_render_improvement_percent: 50,
    browser_first_paint_p95_ms: 250,
    browser_filter_sort_p95_ms: 250,
    browser_heap_mib: 128,
    browser_long_task_ms: 50,
    bd_cold_p95_ms: 30000
  }),
  5000: Object.freeze({
    serialize_p95_ms: 250,
    parse_p95_ms: 250,
    store_sort_p95_ms: 250,
    delta_100_p95_ms: 250,
    progressive_render_p95_ms: 1750,
    progressive_heap_delta_mib: 192,
    minimum_render_improvement_percent: 60,
    browser_first_paint_p95_ms: 500,
    browser_filter_sort_p95_ms: 250,
    browser_heap_mib: 256,
    browser_long_task_ms: 50,
    bd_cold_p95_ms: 30000
  }),
  10000: Object.freeze({
    serialize_p95_ms: 500,
    parse_p95_ms: 500,
    store_sort_p95_ms: 500,
    delta_100_p95_ms: 500,
    progressive_render_p95_ms: 2500,
    progressive_heap_delta_mib: 384,
    minimum_render_improvement_percent: 60,
    browser_first_paint_p95_ms: 750,
    browser_filter_sort_p95_ms: 350,
    browser_heap_mib: 512,
    browser_long_task_ms: 50,
    bd_cold_p95_ms: 30000
  })
});

/**
 * Compute a nearest-rank percentile from a non-empty sample.
 *
 * @param {number[]} values
 * @param {number} percentile
 */
export function nearestRankPercentile(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError('values must be a non-empty array');
  }
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
    throw new RangeError('percentile must be greater than 0 and at most 100');
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1);
  return sorted[index];
}

/**
 * Evaluate host evidence and the stronger ceiling eligibility gate.
 *
 * @param {number} tier
 * @param {Record<string, number | boolean | null>} metrics
 * @param {{ browser_proven?: boolean, bd_representative?: boolean }} [evidence]
 */
export function evaluateLargeListTier(tier, metrics, evidence = {}) {
  const budgets = /** @type {any} */ (LARGE_LIST_BUDGETS)[tier];
  if (!budgets) {
    throw new RangeError(`unknown large-list tier: ${tier}`);
  }
  /** @type {Record<string, boolean>} */
  const checks = {
    frame_bytes: Number(metrics.snapshot_bytes) <= LARGE_LIST_MAX_FRAME_BYTES,
    initial_rows: Number(metrics.progressive_rows) <= LARGE_LIST_SEGMENT_SIZE,
    delta_notifications: Number(metrics.delta_notifications) === 1,
    serialize: Number(metrics.serialize_p95_ms) <= budgets.serialize_p95_ms,
    parse: Number(metrics.parse_p95_ms) <= budgets.parse_p95_ms,
    store_sort: Number(metrics.store_sort_p95_ms) <= budgets.store_sort_p95_ms,
    delta_100: Number(metrics.delta_100_p95_ms) <= budgets.delta_100_p95_ms,
    progressive_render:
      Number(metrics.progressive_render_p95_ms) <=
      budgets.progressive_render_p95_ms,
    progressive_heap:
      Number(metrics.progressive_heap_delta_mib) <=
      budgets.progressive_heap_delta_mib,
    render_improvement:
      Number(metrics.render_improvement_percent) >=
      budgets.minimum_render_improvement_percent
  };
  const host_pass = Object.values(checks).every(Boolean);
  const browser_proven = evidence.browser_proven === true;
  const bd_representative = evidence.bd_representative === true;
  return {
    checks,
    host_pass,
    browser_proven,
    bd_representative,
    ceiling_eligible:
      tier === LARGE_LIST_BASELINE_CEILING ||
      (host_pass && browser_proven && bd_representative)
  };
}
