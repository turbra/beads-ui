/* global document */
// @ts-expect-error jsdom does not publish bundled TypeScript declarations.
import { JSDOM } from 'jsdom';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createSubscriptionIssueStore } from '../app/data/subscription-issue-store.js';
import {
  LARGE_LIST_BASELINE_CEILING,
  LARGE_LIST_BUDGETS,
  LARGE_LIST_TIERS,
  evaluateLargeListTier,
  nearestRankPercentile
} from '../benchmarks/large-list-budgets.js';
import {
  createLargeIssueDataset,
  createLargeIssueDelta
} from '../benchmarks/large-list-dataset.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

/**
 * Parse the intentionally small command-line surface.
 *
 * @param {string[]} args
 */
function parseArgs(args) {
  let repeats = 5;
  let warmups = 1;
  let output = '';
  let bd_workspace = '';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--repeats') {
      repeats = Number(args[index + 1]);
      index += 1;
    } else if (arg === '--warmups') {
      warmups = Number(args[index + 1]);
      index += 1;
    } else if (arg === '--output') {
      output = String(args[index + 1] || '');
      index += 1;
    } else if (arg === '--bd-workspace') {
      bd_workspace = String(args[index + 1] || '');
      index += 1;
    } else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(repeats) || repeats < 1) {
    throw new Error('--repeats must be a positive integer');
  }
  if (!Number.isInteger(warmups) || warmups < 0) {
    throw new Error('--warmups must be a non-negative integer');
  }
  return { repeats, warmups, output, bd_workspace };
}

function printHelp() {
  process.stdout.write(`Usage: npm run benchmark:large-lists -- [options]\n\n`);
  process.stdout.write(
    `  --repeats N          Recorded samples per tier (default: 5)\n`
  );
  process.stdout.write(
    `  --warmups N          Warmup samples per tier (default: 1)\n`
  );
  process.stdout.write(
    `  --output PATH        Also write the JSON receipt to PATH\n`
  );
  process.stdout.write(
    `  --bd-workspace PATH  Optionally time fresh bd list processes\n`
  );
}

/**
 * Install the DOM globals required by the production list view.
 *
 * @param {any} dom
 */
function installDomGlobals(dom) {
  const window = dom.window;
  globalThis.window = window;
  globalThis.document = window.document;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: window.navigator
  });
  globalThis.Node = window.Node;
  globalThis.Element = window.Element;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLInputElement = window.HTMLInputElement;
  globalThis.HTMLSelectElement = window.HTMLSelectElement;
  globalThis.HTMLButtonElement = window.HTMLButtonElement;
  globalThis.HTMLDialogElement = window.HTMLDialogElement;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.KeyboardEvent = window.KeyboardEvent;
}

/**
 * Run warmup and recorded synchronous measurements.
 *
 * @param {() => void} operation
 * @param {number} repeats
 * @param {number} warmups
 */
function measureSync(operation, repeats, warmups) {
  /** @type {number[]} */
  const samples = [];
  for (let index = 0; index < repeats + warmups; index += 1) {
    const started = performance.now();
    operation();
    const elapsed = performance.now() - started;
    if (index >= warmups) {
      samples.push(elapsed);
    }
  }
  return summarize(samples);
}

/**
 * Run warmup and recorded asynchronous measurements.
 *
 * @param {() => Promise<void>} operation
 * @param {number} repeats
 * @param {number} warmups
 */
async function measureAsync(operation, repeats, warmups) {
  /** @type {number[]} */
  const samples = [];
  for (let index = 0; index < repeats + warmups; index += 1) {
    const started = performance.now();
    await operation();
    const elapsed = performance.now() - started;
    if (index >= warmups) {
      samples.push(elapsed);
    }
  }
  return summarize(samples);
}

/**
 * @param {number[]} samples
 */
function summarize(samples) {
  return {
    p50_ms: round(nearestRankPercentile(samples, 50)),
    p95_ms: round(nearestRankPercentile(samples, 95)),
    samples_ms: samples.map(round)
  };
}

/**
 * @param {number} value
 */
function round(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Encourage comparable heap readings when the runner uses --expose-gc.
 */
function collectGarbage() {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
  }
}

/**
 * @param {any[]} issues
 */
function createIssueStores(issues) {
  const identity = {};
  return {
    getStore() {
      return identity;
    },
    snapshotFor() {
      return issues.slice();
    },
    subscribeFor() {
      return () => {};
    }
  };
}

/**
 * Measure one tier through serialization, parsing, store sorting, delta apply,
 * progressive rendering, and a render-all comparison.
 *
 * @param {number} tier
 * @param {{ repeats: number, warmups: number, bd_workspace: string }} options
 * @param {{ createListView: Function, createIssueRowRenderer: Function, html: Function, nothing: symbol, render: Function, repeat: Function }} modules
 */
async function measureTier(tier, options, modules) {
  const issues = createLargeIssueDataset(tier);
  const delta = createLargeIssueDelta(issues);
  const snapshot_message = {
    id: 'evt-benchmark',
    ok: true,
    type: 'snapshot',
    payload: {
      type: 'snapshot',
      id: 'tab:issues',
      revision: 1,
      truncated: false,
      issues
    }
  };
  const serialized = JSON.stringify(snapshot_message);
  const serialization = measureSync(
    () => {
      JSON.stringify(snapshot_message);
    },
    options.repeats,
    options.warmups
  );
  const parsing = measureSync(
    () => {
      JSON.parse(serialized);
    },
    options.repeats,
    options.warmups
  );
  const store_sort = measureSync(
    () => {
      const store = createSubscriptionIssueStore('tab:issues');
      store.applyPush({
        type: 'snapshot',
        id: 'tab:issues',
        revision: 1,
        issues: /** @type {any[]} */ (issues.map((issue) => ({ ...issue })))
      });
      store.snapshot();
      store.dispose();
    },
    options.repeats,
    options.warmups
  );

  let delta_notifications = 0;
  const delta_timing = await measureAsync(
    async () => {
      const store = createSubscriptionIssueStore('tab:issues');
      store.applyPush({
        type: 'snapshot',
        id: 'tab:issues',
        revision: 1,
        issues: /** @type {any[]} */ (issues.map((issue) => ({ ...issue })))
      });
      await Promise.resolve();
      let notifications = 0;
      store.subscribe(() => {
        notifications += 1;
      });
      store.applyPush({
        type: 'delta',
        id: 'tab:issues',
        revision: 2,
        upserts: /** @type {any[]} */ (delta.map((issue) => ({ ...issue }))),
        deletes: []
      });
      await Promise.resolve();
      store.snapshot();
      delta_notifications = notifications;
      store.dispose();
    },
    options.repeats,
    options.warmups
  );

  let progressive_rows = 0;
  let progressive_dom_nodes = 0;
  const progressive = await measureAsync(
    async () => {
      document.body.replaceChildren();
      const mount = document.createElement('main');
      document.body.appendChild(mount);
      const view = modules.createListView(
        mount,
        async () => null,
        undefined,
        undefined,
        createIssueStores(issues)
      );
      await view.load();
      progressive_rows = mount.querySelectorAll('tr.issue-row').length;
      progressive_dom_nodes = mount.querySelectorAll('*').length;
      view.destroy();
      mount.remove();
    },
    options.repeats,
    options.warmups
  );

  const row_renderer = modules.createIssueRowRenderer({
    navigate: () => {},
    onUpdate: async () => null,
    requestRender: () => {},
    getSelectedId: () => null
  });
  let render_all_dom_nodes = 0;
  const render_all = await measureAsync(
    async () => {
      document.body.replaceChildren();
      const mount = document.createElement('main');
      document.body.appendChild(mount);
      modules.render(
        modules.html`<table><tbody>${modules.repeat(
          issues,
          (/** @type {any} */ issue) => issue.id,
          row_renderer
        )}</tbody></table>`,
        mount
      );
      render_all_dom_nodes = mount.querySelectorAll('*').length;
      modules.render(modules.nothing, mount);
      mount.remove();
      await Promise.resolve();
    },
    options.repeats,
    options.warmups
  );

  collectGarbage();
  document.body.replaceChildren();
  const heap_before = process.memoryUsage().heapUsed;
  const heap_mount = document.createElement('main');
  document.body.appendChild(heap_mount);
  const heap_view = modules.createListView(
    heap_mount,
    async () => null,
    undefined,
    undefined,
    createIssueStores(issues)
  );
  await heap_view.load();
  const heap_after = process.memoryUsage().heapUsed;
  heap_view.destroy();
  heap_mount.remove();
  const progressive_heap_delta_mib = Math.max(
    0,
    (heap_after - heap_before) / (1024 * 1024)
  );

  const render_improvement_percent =
    render_all.p95_ms <= 0
      ? 0
      : ((render_all.p95_ms - progressive.p95_ms) / render_all.p95_ms) * 100;
  const bd = options.bd_workspace
    ? measureBdTier(tier, options)
    : {
        measured: false,
        representative: false,
        count: null,
        p50_ms: null,
        p95_ms: null
      };
  const metrics = {
    snapshot_bytes: Buffer.byteLength(serialized, 'utf8'),
    serialize_p50_ms: serialization.p50_ms,
    serialize_p95_ms: serialization.p95_ms,
    parse_p50_ms: parsing.p50_ms,
    parse_p95_ms: parsing.p95_ms,
    store_sort_p50_ms: store_sort.p50_ms,
    store_sort_p95_ms: store_sort.p95_ms,
    delta_100_p50_ms: delta_timing.p50_ms,
    delta_100_p95_ms: delta_timing.p95_ms,
    delta_notifications,
    progressive_render_p50_ms: progressive.p50_ms,
    progressive_render_p95_ms: progressive.p95_ms,
    progressive_rows,
    progressive_dom_nodes,
    progressive_heap_delta_mib: round(progressive_heap_delta_mib),
    render_all_p50_ms: render_all.p50_ms,
    render_all_p95_ms: render_all.p95_ms,
    render_all_dom_nodes,
    render_improvement_percent: round(render_improvement_percent),
    bd_cold_p50_ms: bd.p50_ms,
    bd_cold_p95_ms: bd.p95_ms,
    bd_result_count: bd.count
  };
  const evaluation = evaluateLargeListTier(tier, metrics, {
    browser_proven: false,
    bd_representative: bd.representative
  });
  return { tier, metrics, evaluation };
}

/**
 * Measure fresh bd processes for one tier. The result is representative only
 * when the workspace returns at least the tier's issue count.
 *
 * @param {number} tier
 * @param {{ repeats: number, warmups: number, bd_workspace: string }} options
 */
function measureBdTier(tier, options) {
  let count = 0;
  const timing = measureSync(
    () => {
      const result = spawnSync(
        process.env.BD_BIN || 'bd',
        [
          '--sandbox',
          'list',
          '--json',
          '--tree=false',
          '--limit',
          String(tier + 1)
        ],
        {
          cwd: options.bd_workspace,
          encoding: 'utf8',
          env: process.env
        }
      );
      if (result.status !== 0) {
        throw new Error(result.stderr || 'bd list failed');
      }
      const parsed = JSON.parse(result.stdout || '[]');
      count = Array.isArray(parsed) ? parsed.length : 0;
    },
    options.repeats,
    options.warmups
  );
  return {
    measured: true,
    representative: count >= tier,
    count,
    p50_ms: timing.p50_ms,
    p95_ms: timing.p95_ms
  };
}

/**
 * Return a portable description of the execution environment.
 */
function environmentReceipt() {
  const cpu = os.cpus()[0];
  const package_json = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
  );
  return {
    timestamp: new Date().toISOString(),
    repository: REPO_ROOT,
    package_version: package_json.version,
    node: process.version,
    platform: process.platform,
    release: os.release(),
    architecture: process.arch,
    cpu: cpu ? cpu.model : 'unknown',
    logical_cpus: os.cpus().length,
    total_memory_mib: Math.round(os.totalmem() / (1024 * 1024)),
    dom_runtime: 'jsdom 27.x under Node; not real-browser evidence',
    browser_evidence: false
  };
}

/**
 * Select the highest eligible tier while preserving the established baseline.
 *
 * @param {Array<{ tier: number, evaluation: { ceiling_eligible: boolean } }>} tiers
 */
function recommendedCeiling(tiers) {
  return tiers.reduce(
    (highest, result) =>
      result.evaluation.ceiling_eligible
        ? Math.max(highest, result.tier)
        : highest,
    LARGE_LIST_BASELINE_CEILING
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/'
  });
  installDomGlobals(dom);
  const lit = await import('lit-html');
  const repeat_module = await import('lit-html/directives/repeat.js');
  const list_module = await import('../app/views/list.js');
  const row_module = await import('../app/views/issue-row.js');
  const modules = {
    createListView: list_module.createListView,
    createIssueRowRenderer: row_module.createIssueRowRenderer,
    html: lit.html,
    nothing: lit.nothing,
    render: lit.render,
    repeat: repeat_module.repeat
  };
  /** @type {Array<Awaited<ReturnType<typeof measureTier>>>} */
  const tiers = [];
  for (const tier of LARGE_LIST_TIERS) {
    tiers.push(await measureTier(tier, options, modules));
  }
  dom.window.close();
  const receipt = {
    schema_version: 1,
    methodology: {
      repeats: options.repeats,
      warmups: options.warmups,
      deterministic_seed: '0x5eed1234',
      timing_assertions_in_ci: false,
      structural_ci:
        'app/views/list.progressive.test.js, app/data/subscription-issue-store.test.js, app/views/list.delta-render.test.js',
      browser_evidence_required_above: LARGE_LIST_BASELINE_CEILING,
      bd_workspace: options.bd_workspace || null
    },
    environment: environmentReceipt(),
    budgets: LARGE_LIST_BUDGETS,
    tiers,
    recommendation: {
      ceiling: recommendedCeiling(tiers),
      reason:
        'Tiers above 1000 require both representative real-bd and real-browser evidence; jsdom host evidence alone cannot raise the production ceiling.'
    }
  };
  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  if (options.output) {
    fs.writeFileSync(path.resolve(options.output), json);
  }
  process.stdout.write(json);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
