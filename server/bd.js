import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolveDbPath } from './db.js';
import { debug } from './logging.js';

const log = debug('bd');
const BD_INTERACTIVE_BURST_LIMIT = 4;
const DEFAULT_BD_TIMEOUT_MS = 30000;
const GIT_USER_NAME_CACHE_LIMIT = 32;
const GIT_USER_NAME_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * @typedef {'interactive' | 'background'} BdPriority
 * @typedef {{ operation: () => Promise<any>, resolve: (v: any) => void, reject: (err: unknown) => void }} BdQueueTask
 */

/** @type {BdQueueTask[]} */
const bd_queue_interactive = [];
/** @type {BdQueueTask[]} */
const bd_queue_background = [];
let bd_queue_running = false;
let bd_queue_interactive_burst = 0;
/** @type {Map<string, { expires_at: number, promise: Promise<string> }>} */
const git_user_name_cache = new Map();

/**
 * Read the git user name from git config.
 *
 * @param {string} cwd
 */
function readGitUserName(cwd) {
  return new Promise((resolve) => {
    const child = spawn('git', ['config', 'user.name'], {
      cwd,
      shell: false,
      windowsHide: true
    });

    /** @type {string[]} */
    const chunks = [];

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => chunks.push(String(chunk)));
    }

    child.on('error', () => resolve(''));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve('');
        return;
      }
      resolve(chunks.join('').trim());
    });
  });
}

/**
 * Get the git user name from a bounded, workspace-scoped cache. The in-flight
 * promise is cached so concurrent comment posts share one git process.
 *
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<string>}
 */
export function getGitUserName(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const now = Date.now();
  const cached = git_user_name_cache.get(cwd);
  if (cached && cached.expires_at > now) {
    git_user_name_cache.delete(cwd);
    git_user_name_cache.set(cwd, cached);
    return cached.promise;
  }
  if (cached) {
    git_user_name_cache.delete(cwd);
  }
  const promise = readGitUserName(cwd);
  git_user_name_cache.set(cwd, {
    expires_at: now + GIT_USER_NAME_CACHE_TTL_MS,
    promise
  });
  while (git_user_name_cache.size > GIT_USER_NAME_CACHE_LIMIT) {
    const oldest_key = git_user_name_cache.keys().next().value;
    if (oldest_key === undefined) {
      break;
    }
    git_user_name_cache.delete(oldest_key);
  }
  return promise;
}

/** Clear cached Git identities after configuration changes or in tests. */
export function clearGitUserNameCache() {
  git_user_name_cache.clear();
}

/**
 * Resolve the bd executable path.
 *
 * @returns {string}
 */
export function getBdBin() {
  const env_value = process.env.BD_BIN;
  if (env_value && env_value.length > 0) {
    return env_value;
  }
  return 'bd';
}

/**
 * Run the `bd` CLI with provided arguments.
 * Shell is not used to avoid injection; args must be pre-split.
 *
 * @param {string[]} args - Arguments to pass (e.g., ["list", "--json"]).
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, timeout_ms?: number, priority?: BdPriority }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runBd(args, options = {}) {
  return withBdRunQueue(
    async () => runBdUnlocked(args, options),
    options.priority
  );
}

/**
 * Run the `bd` CLI with provided arguments without queueing.
 *
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, timeout_ms?: number }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runBdUnlocked(args, options = {}) {
  const bin = getBdBin();

  // Set BEADS_DB only when the workspace has a local SQLite DB.
  // Do not force BEADS_DB from global fallback paths; this can override
  // backend autodetection in non-SQLite workspaces (for example Dolt).
  const db_path = resolveDbPath({
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env
  });
  const env_with_db = { ...(options.env || process.env) };
  if (db_path.source === 'nearest' && db_path.exists) {
    env_with_db.BEADS_DB = db_path.path;
  }

  const spawn_opts = {
    cwd: options.cwd || process.cwd(),
    env: env_with_db,
    shell: false,
    windowsHide: true
  };

  /** @type {string[]} */
  const final_args = buildBdArgs(args);
  const timeout_ms = resolveBdTimeout(options.timeout_ms, env_with_db);

  return new Promise((resolve) => {
    const child = spawn(bin, final_args, spawn_opts);

    /** @type {string[]} */
    const out_chunks = [];
    /** @type {string[]} */
    const err_chunks = [];

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        out_chunks.push(String(chunk));
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        err_chunks.push(String(chunk));
      });
    }

    let settled = false;
    let timed_out = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    if (timeout_ms > 0) {
      timer = setTimeout(() => {
        timed_out = true;
        try {
          child.kill('SIGKILL');
        } catch (err) {
          log('failed to kill timed out bd process: %o', err);
        }
      }, timeout_ms);
      timer.unref?.();
    }

    /**
     * @param {number | string | null} code
     */
    const finish = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      const stderr = err_chunks.join('');
      const timeout_message = `bd timed out after ${timeout_ms}ms`;
      resolve({
        code: timed_out ? 124 : typeof code === 'number' ? code : 1,
        stdout: out_chunks.join(''),
        stderr: timed_out
          ? `${stderr}${stderr.endsWith('\n') || stderr.length === 0 ? '' : '\n'}${timeout_message}`
          : stderr
      });
    };

    child.on('error', (err) => {
      // Treat spawn error as an immediate non-zero exit; log for diagnostics.
      log('spawn error running %s %o', bin, err);
      finish(127);
    });
    child.on('close', (code) => {
      finish(code);
    });
  });
}

/**
 * Resolve the bd deadline. An explicit option wins over the child environment;
 * zero disables the deadline. Invalid and negative values use the default.
 *
 * @param {number | undefined} explicit_timeout_ms
 * @param {Record<string, string | undefined>} env
 */
function resolveBdTimeout(explicit_timeout_ms, env) {
  if (explicit_timeout_ms !== undefined) {
    return Number.isFinite(explicit_timeout_ms) && explicit_timeout_ms >= 0
      ? explicit_timeout_ms
      : DEFAULT_BD_TIMEOUT_MS;
  }
  const raw_timeout = env.BDUI_BD_TIMEOUT_MS;
  if (raw_timeout === undefined || raw_timeout.trim().length === 0) {
    return DEFAULT_BD_TIMEOUT_MS;
  }
  const env_timeout_ms = Number(raw_timeout);
  return Number.isFinite(env_timeout_ms) && env_timeout_ms >= 0
    ? env_timeout_ms
    : DEFAULT_BD_TIMEOUT_MS;
}

/**
 * Build final bd CLI arguments.
 * bdui defaults to sandbox mode to avoid sync/autopush overhead on interactive
 * UI requests. Set `BDUI_BD_SANDBOX=0` (or "false") to opt out.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
function buildBdArgs(args) {
  const arg_set = new Set(args);
  const raw_sandbox = String(process.env.BDUI_BD_SANDBOX || '').toLowerCase();
  const sandbox_disabled = raw_sandbox === '0' || raw_sandbox === 'false';
  const should_prepend_sandbox = !sandbox_disabled && !arg_set.has('--sandbox');

  if (!should_prepend_sandbox) {
    return args.slice();
  }

  return ['--sandbox', ...args];
}

/**
 * Serialize `bd` invocations.
 * Dolt embedded mode can crash when multiple `bd` processes run concurrently
 * against the same workspace.
 *
 * Two priority levels keep the UI responsive: interactive work (detail show,
 * comments, mutations) is dequeued before background work (watcher-driven
 * list refresh, board cache prewarm).
 *
 * @template T
 * @param {() => Promise<T>} operation
 * @param {BdPriority} [priority]
 * @returns {Promise<T>}
 */
function withBdRunQueue(operation, priority = 'interactive') {
  return new Promise((resolve, reject) => {
    const queue =
      priority === 'background' ? bd_queue_background : bd_queue_interactive;
    queue.push({ operation, resolve, reject });
    void pumpBdQueue();
  });
}

/**
 * Drain queued bd operations one at a time, interactive first.
 */
async function pumpBdQueue() {
  if (bd_queue_running) {
    return;
  }
  bd_queue_running = true;
  try {
    for (;;) {
      const task = nextBdQueueTask();
      if (!task) {
        break;
      }
      try {
        task.resolve(await task.operation());
      } catch (err) {
        task.reject(err);
      }
    }
  } finally {
    bd_queue_running = false;
  }
}

/**
 * Choose the next queued task while preventing background starvation.
 *
 * @returns {BdQueueTask | undefined}
 */
function nextBdQueueTask() {
  if (bd_queue_interactive.length === 0) {
    bd_queue_interactive_burst = 0;
    return bd_queue_background.shift();
  }
  if (bd_queue_background.length === 0) {
    bd_queue_interactive_burst = 0;
    return bd_queue_interactive.shift();
  }
  if (bd_queue_interactive_burst >= BD_INTERACTIVE_BURST_LIMIT) {
    bd_queue_interactive_burst = 0;
    return bd_queue_background.shift();
  }
  bd_queue_interactive_burst += 1;
  return bd_queue_interactive.shift();
}

/**
 * Run `bd` and parse JSON from stdout if exit code is 0.
 *
 * @param {string[]} args - Must include flags that cause JSON to be printed (e.g., `--json`).
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, timeout_ms?: number, priority?: BdPriority }} [options]
 * @returns {Promise<{ code: number, stdoutJson?: unknown, stderr?: string }>}
 */
export async function runBdJson(args, options = {}) {
  const result = await runBd(args, options);
  if (result.code !== 0) {
    log(
      'bd exited with code %d (args=%o) stderr=%s',
      result.code,
      args,
      result.stderr
    );
    return { code: result.code, stderr: result.stderr };
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(result.stdout || 'null');
  } catch (err) {
    log('bd returned invalid JSON (args=%o): %o', args, err);
    return { code: 0, stderr: 'Invalid JSON from bd' };
  }
  return { code: 0, stdoutJson: parsed };
}
