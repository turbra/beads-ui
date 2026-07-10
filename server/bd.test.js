import { spawn as spawnMock } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getBdBin, getGitUserName, runBd, runBdJson } from './bd.js';

// Mock child_process.spawn before importing the module under test
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

/**
 * @param {string} stdoutText
 * @param {string} stderrText
 * @param {number} code
 */
function makeFakeProc(stdoutText, stderrText, code) {
  const cp = /** @type {any} */ (new EventEmitter());
  const out = new PassThrough();
  const err = new PassThrough();
  cp.stdout = out;
  cp.stderr = err;
  // Simulate async emission
  setTimeout(() => {
    if (stdoutText) {
      out.write(stdoutText);
    }
    out.end();
    if (stderrText) {
      err.write(stderrText);
    }
    err.end();
    cp.emit('close', code);
  }, 0);
  return cp;
}

function makeControlledProc() {
  const cp = /** @type {any} */ (new EventEmitter());
  const out = new PassThrough();
  const err = new PassThrough();
  cp.stdout = out;
  cp.stderr = err;
  return {
    cp,
    close() {
      out.end();
      err.end();
      cp.emit('close', 0);
    }
  };
}

const mockedSpawn = /** @type {import('vitest').Mock} */ (spawnMock);
/** @type {string[]} */
const temp_dirs = [];

function make_temp_dir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdui-bd-'));
  temp_dirs.push(dir);
  return dir;
}

/**
 * @param {unknown[]} list
 * @param {number} length
 */
async function waitForLength(list, length) {
  for (let i = 0; i < 20; i += 1) {
    if (list.length >= length) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for length ${length}`);
}

beforeEach(() => {
  mockedSpawn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of temp_dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

describe('getBdBin', () => {
  test('returns env BD_BIN when set', () => {
    const prev = process.env.BD_BIN;
    process.env.BD_BIN = '/custom/bd';
    expect(getBdBin()).toBe('/custom/bd');
    if (prev) {
      process.env.BD_BIN = prev;
    } else {
      delete process.env.BD_BIN;
    }
  });
});

describe('runBd', () => {
  test('prepends --sandbox by default', async () => {
    mockedSpawn.mockReturnValueOnce(makeFakeProc('ok', '', 0));
    await runBd(['list', '--json']);

    const args = mockedSpawn.mock.calls[0][1];
    expect(args[0]).toBe('--sandbox');
    expect(args.slice(1)).toEqual(['list', '--json']);
  });

  test('does not duplicate --sandbox when caller already provides it', async () => {
    mockedSpawn.mockReturnValueOnce(makeFakeProc('ok', '', 0));
    await runBd(['--sandbox', 'list', '--json']);

    const args = mockedSpawn.mock.calls[0][1];
    expect(args).toEqual(['--sandbox', 'list', '--json']);
  });

  test('allows disabling default sandbox via BDUI_BD_SANDBOX', async () => {
    const prev = process.env.BDUI_BD_SANDBOX;
    process.env.BDUI_BD_SANDBOX = '0';
    mockedSpawn.mockReturnValueOnce(makeFakeProc('ok', '', 0));

    await runBd(['list', '--json']);

    const args = mockedSpawn.mock.calls[0][1];
    expect(args).toEqual(['list', '--json']);

    if (prev === undefined) {
      delete process.env.BDUI_BD_SANDBOX;
    } else {
      process.env.BDUI_BD_SANDBOX = prev;
    }
  });

  test('returns stdout/stderr and exit code', async () => {
    mockedSpawn.mockReturnValueOnce(makeFakeProc('ok', '', 0));
    const res = await runBd(['--version']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('ok');
  });

  test('non-zero exit propagates code and stderr', async () => {
    mockedSpawn.mockReturnValueOnce(makeFakeProc('', 'boom', 1));
    const res = await runBd(['list']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('boom');
  });

  test('sets BEADS_DB for workspace-local SQLite db', async () => {
    const root = make_temp_dir();
    const beads_dir = path.join(root, '.beads');
    fs.mkdirSync(beads_dir, { recursive: true });
    const workspace_db = path.join(beads_dir, 'ui.db');
    fs.writeFileSync(workspace_db, '');

    mockedSpawn.mockReturnValueOnce(makeFakeProc('ok', '', 0));
    await runBd(['list'], { cwd: root, env: {} });

    const options = mockedSpawn.mock.calls[0][2];
    expect(options.env.BEADS_DB).toBe(workspace_db);
  });

  test('does not force BEADS_DB when workspace has no local SQLite db', async () => {
    const root = make_temp_dir();

    mockedSpawn.mockReturnValueOnce(makeFakeProc('ok', '', 0));
    await runBd(['list'], { cwd: root, env: {} });

    const options = mockedSpawn.mock.calls[0][2];
    expect(options.env.BEADS_DB).toBeUndefined();
  });

  test('preserves explicit BEADS_DB from caller env', async () => {
    mockedSpawn.mockReturnValueOnce(makeFakeProc('ok', '', 0));
    await runBd(['list'], { env: { BEADS_DB: '/custom/workspace.db' } });

    const options = mockedSpawn.mock.calls[0][2];
    expect(options.env.BEADS_DB).toBe('/custom/workspace.db');
  });

  test('interactive commands run before queued background commands', async () => {
    /** @type {string[]} */
    const order = [];
    mockedSpawn.mockImplementation((_bin, args) => {
      const cmd_args = /** @type {string[]} */ (args).filter(
        (a) => a !== '--sandbox'
      );
      order.push(cmd_args.join(' '));
      return makeFakeProc('ok', '', 0);
    });

    // First background command starts running immediately; the interactive
    // command must be dequeued before the second background command.
    const first = runBd(['list', 'bg-1'], { priority: 'background' });
    const second = runBd(['list', 'bg-2'], { priority: 'background' });
    const third = runBd(['show', 'int-1']);
    await Promise.all([first, second, third]);

    expect(order).toEqual(['list bg-1', 'show int-1', 'list bg-2']);
  });

  test('background commands run after bounded interactive bursts', async () => {
    /** @type {string[]} */
    const order = [];
    mockedSpawn.mockImplementation((_bin, args) => {
      const cmd_args = /** @type {string[]} */ (args).filter(
        (a) => a !== '--sandbox'
      );
      order.push(cmd_args.join(' '));
      return makeFakeProc('ok', '', 0);
    });

    const first = runBd(['show', 'int-0']);
    const background = runBd(['list', 'bg-1'], { priority: 'background' });
    const interactive = Array.from({ length: 5 }, (_value, index) =>
      runBd(['show', `int-${index + 1}`])
    );
    await Promise.all([first, background, ...interactive]);

    expect(order).toEqual([
      'show int-0',
      'show int-1',
      'show int-2',
      'show int-3',
      'show int-4',
      'list bg-1',
      'show int-5'
    ]);
  });

  test('interactive-only bursts do not give later background work priority', async () => {
    /** @type {string[]} */
    const order = [];
    /** @type {Array<() => void>} */
    const close_spawned = [];
    mockedSpawn.mockImplementation((_bin, args) => {
      const cmd_args = /** @type {string[]} */ (args).filter(
        (a) => a !== '--sandbox'
      );
      order.push(cmd_args.join(' '));
      const proc = makeControlledProc();
      close_spawned.push(proc.close);
      return proc.cp;
    });

    const first = runBd(['show', 'int-0']);
    const initial_interactive = Array.from({ length: 4 }, (_value, index) =>
      runBd(['show', `int-${index + 1}`])
    );
    await waitForLength(order, 1);

    for (let index = 0; index < 4; index += 1) {
      close_spawned[index]();
      await waitForLength(order, index + 2);
    }

    const background = runBd(['list', 'bg-1'], { priority: 'background' });
    const late_interactive = runBd(['show', 'int-5']);
    close_spawned[4]();
    await waitForLength(order, 6);
    close_spawned[5]();
    await waitForLength(order, 7);
    close_spawned[6]();
    await Promise.all([
      first,
      ...initial_interactive,
      background,
      late_interactive
    ]);

    expect(order).toEqual([
      'show int-0',
      'show int-1',
      'show int-2',
      'show int-3',
      'show int-4',
      'show int-5',
      'list bg-1'
    ]);
  });

  test('queue continues after a failing command', async () => {
    mockedSpawn
      .mockReturnValueOnce(makeFakeProc('', 'boom', 1))
      .mockReturnValueOnce(makeFakeProc('ok', '', 0));

    const failed = runBd(['list', 'first'], { priority: 'background' });
    const succeeded = runBd(['show', 'second']);
    const [res_failed, res_ok] = await Promise.all([failed, succeeded]);
    expect(res_failed.code).toBe(1);
    expect(res_ok.code).toBe(0);
  });

  test('times out with code 124 and waits for close before advancing queue', async () => {
    vi.useFakeTimers();
    const first = /** @type {any} */ (new EventEmitter());
    first.stdout = new PassThrough();
    first.stderr = new PassThrough();
    first.kill = vi.fn(() => {
      setTimeout(() => {
        first.stdout.end();
        first.stderr.end();
        first.emit('close', null, 'SIGKILL');
      }, 5);
      return true;
    });
    first.stdout.write('partial');
    const second = /** @type {any} */ (new EventEmitter());
    second.stdout = new PassThrough();
    second.stderr = new PassThrough();
    second.kill = vi.fn();
    mockedSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const timed_out = runBd(['list'], { timeout_ms: 10 });
    const queued = runBd(['show', 'next']);
    await vi.advanceTimersByTimeAsync(10);

    expect(first.kill).toHaveBeenCalledWith('SIGKILL');
    expect(mockedSpawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5);
    expect(mockedSpawn).toHaveBeenCalledTimes(2);
    second.stdout.end('ok');
    second.stderr.end();
    second.emit('close', 0);
    const [timeout_result, queued_result] = await Promise.all([
      timed_out,
      queued
    ]);

    expect(timeout_result).toEqual({
      code: 124,
      stdout: 'partial',
      stderr: 'bd timed out after 10ms'
    });
    expect(queued_result.code).toBe(0);
  });

  test('prefers explicit timeout over the child environment', async () => {
    vi.useFakeTimers();
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => {
      child.emit('close', null, 'SIGKILL');
      return true;
    });
    mockedSpawn.mockReturnValueOnce(child);

    const result = runBd(['list'], {
      timeout_ms: 12,
      env: { BDUI_BD_TIMEOUT_MS: '7' }
    });
    await vi.advanceTimersByTimeAsync(7);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5);

    expect((await result).code).toBe(124);
  });

  test('uses the timeout from the child environment', async () => {
    vi.useFakeTimers();
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => {
      child.emit('close', null, 'SIGKILL');
      return true;
    });
    mockedSpawn.mockReturnValueOnce(child);

    const result = runBd(['list'], { env: { BDUI_BD_TIMEOUT_MS: '8' } });
    await vi.advanceTimersByTimeAsync(8);

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect((await result).code).toBe(124);
  });

  test('falls back to 30 seconds for an invalid explicit timeout', async () => {
    vi.useFakeTimers();
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => {
      child.emit('close', null, 'SIGKILL');
      return true;
    });
    mockedSpawn.mockReturnValueOnce(child);

    const result = runBd(['list'], {
      timeout_ms: -1,
      env: { BDUI_BD_TIMEOUT_MS: '8' }
    });
    await vi.advanceTimersByTimeAsync(29999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect((await result).stderr).toContain('30000ms');
  });

  test('uses a non-zero exit for signal termination without timeout', async () => {
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    mockedSpawn.mockReturnValueOnce(child);

    const result = runBd(['list'], { timeout_ms: 0 });
    child.emit('close', null, 'SIGTERM');

    expect((await result).code).toBe(1);
  });
});

describe('runBdJson', () => {
  test('parses valid JSON output', async () => {
    const json = JSON.stringify([{ id: 'UI-1' }]);
    mockedSpawn.mockReturnValueOnce(makeFakeProc(json, '', 0));
    const res = await runBdJson(['list', '--json']);
    expect(res.code).toBe(0);
    expect(Array.isArray(res.stdoutJson)).toBe(true);
  });

  test('invalid JSON yields stderr message with code 0', async () => {
    mockedSpawn.mockReturnValueOnce(makeFakeProc('not-json', '', 0));
    const res = await runBdJson(['list', '--json']);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('Invalid JSON');
  });

  test('non-zero exit returns code and stderr', async () => {
    mockedSpawn.mockReturnValueOnce(makeFakeProc('', 'oops', 2));
    const res = await runBdJson(['list', '--json']);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('oops');
  });
});

describe('getGitUserName', () => {
  test('returns git user name on success', async () => {
    mockedSpawn.mockReturnValueOnce(makeFakeProc('Alice Smith\n', '', 0));
    const name = await getGitUserName();
    expect(name).toBe('Alice Smith');
  });

  test('returns empty string on failure', async () => {
    mockedSpawn.mockReturnValueOnce(makeFakeProc('', 'error', 1));
    const name = await getGitUserName();
    expect(name).toBe('');
  });
});
