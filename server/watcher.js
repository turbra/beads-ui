import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkspaceDatabase } from './db.js';
import { debug } from './logging.js';

/**
 * Watch the resolved workspace database target and invoke a callback after a
 * debounce window.
 *
 * For SQLite workspaces this watches the DB file's parent directory and filters
 * by file name. For non-SQLite backends (for example Dolt), this watches the
 * workspace `.beads` directory.
 *
 * @param {string} root_dir - Project root directory (starting point for resolution).
 * @param {() => void | Promise<void>} onChange - Called when changes are detected.
 * @param {{ debounce_ms?: number, cooldown_ms?: number, explicit_db?: string }} [options]
 * @returns {{ close: () => void, rebind: (opts?: { root_dir?: string, explicit_db?: string }) => void, path: string }}
 */
export function watchDb(root_dir, onChange, options = {}) {
  const debounce_ms = options.debounce_ms ?? 250;
  const cooldown_ms = options.cooldown_ms ?? 1000;
  const log = debug('watcher');

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let debounce_timer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let cooldown_timer;
  /** @type {fs.FSWatcher | undefined} */
  let watcher;
  /** @type {'idle' | 'leading' | 'trailing' | 'followup-wait' | 'followup'} */
  let phase = 'idle';
  let callback_running = false;
  let dirty_during_callback = false;
  let dirty_after_callback = false;
  let generation = 0;
  let closed = false;
  let current_path = '';
  let current_dir = '';
  let current_file = '';

  /**
   * Schedule the debounced onChange callback.
   *
   * @param {number} scheduled_generation
   */
  const schedule = (scheduled_generation) => {
    if (phase !== 'idle' && phase !== 'followup-wait') {
      if (callback_running) {
        dirty_during_callback = true;
      } else {
        dirty_after_callback = true;
      }
      return;
    }
    if (debounce_timer) {
      clearTimeout(debounce_timer);
    }
    debounce_timer = setTimeout(() => {
      debounce_timer = undefined;
      void invokeChange(
        phase === 'followup-wait' ? 'followup' : 'leading',
        scheduled_generation
      );
    }, debounce_ms);
    debounce_timer.unref?.();
  };

  /**
   * Invoke a leading or trailing refresh and suppress its own filesystem
   * writes for a cooldown period. A leading pass may schedule exactly one
   * trailing and one bounded followup pass. During-callback events on the
   * followup are treated as covered by that refresh; post-callback cooldown
   * events start a new burst because they are the best available signal of a
   * late external write.
   *
   * @param {'leading' | 'trailing' | 'followup'} next_phase
   * @param {number} scheduled_generation
   */
  async function invokeChange(next_phase, scheduled_generation) {
    if (closed || scheduled_generation !== generation) {
      return;
    }
    phase = next_phase;
    callback_running = true;
    dirty_during_callback = false;
    dirty_after_callback = false;
    try {
      await onChange();
    } catch (err) {
      log('database change callback failed: %o', err);
    }
    callback_running = false;
    if (closed || scheduled_generation !== generation) {
      return;
    }
    cooldown_timer = setTimeout(() => {
      cooldown_timer = undefined;
      if (closed || scheduled_generation !== generation) {
        return;
      }
      if (
        next_phase === 'leading' &&
        (dirty_during_callback || dirty_after_callback)
      ) {
        void invokeChange('trailing', scheduled_generation);
        return;
      }
      if (
        next_phase === 'trailing' &&
        (dirty_during_callback || dirty_after_callback)
      ) {
        phase = 'followup-wait';
        dirty_during_callback = false;
        dirty_after_callback = false;
        schedule(scheduled_generation);
        return;
      }
      if (next_phase === 'followup' && dirty_after_callback) {
        phase = 'idle';
        dirty_during_callback = false;
        dirty_after_callback = false;
        schedule(scheduled_generation);
        return;
      }
      phase = 'idle';
      dirty_during_callback = false;
      dirty_after_callback = false;
    }, cooldown_ms);
    cooldown_timer.unref?.();
  }

  /** Cancel pending work and invalidate asynchronous continuations. */
  function resetScheduling() {
    generation += 1;
    if (debounce_timer) {
      clearTimeout(debounce_timer);
      debounce_timer = undefined;
    }
    if (cooldown_timer) {
      clearTimeout(cooldown_timer);
      cooldown_timer = undefined;
    }
    phase = 'idle';
    callback_running = false;
    dirty_during_callback = false;
    dirty_after_callback = false;
  }

  /**
   * Attach a watcher to the directory containing the resolved DB path.
   *
   * @param {string} base_dir
   * @param {string | undefined} explicit_db
   */
  const bind = (base_dir, explicit_db) => {
    const bind_generation = generation;
    const resolved = resolveWorkspaceDatabase({ cwd: base_dir, explicit_db });
    current_path = resolved.path;
    if (pathIsDirectory(current_path)) {
      current_dir = current_path;
      current_file = '';
    } else {
      current_dir = path.dirname(current_path);
      current_file = path.basename(current_path);
    }
    if (!resolved.exists) {
      log(
        'resolved workspace database missing: %s – Hint: set --db, export BEADS_DB, or run `bd init` in your workspace.',
        current_path
      );
    }

    // (Re)create watcher
    try {
      watcher = fs.watch(
        current_dir,
        { persistent: true },
        (event_type, filename) => {
          if (closed || bind_generation !== generation) {
            return;
          }
          if (current_file && filename && String(filename) !== current_file) {
            return;
          }
          if (event_type === 'change' || event_type === 'rename') {
            log('fs %s %s', event_type, filename || '');
            schedule(bind_generation);
          }
        }
      );
    } catch (err) {
      log('unable to watch directory %s %o', current_dir, err);
    }
  };

  // initial bind
  bind(root_dir, options.explicit_db);

  return {
    get path() {
      return current_path;
    },
    close() {
      closed = true;
      resetScheduling();
      watcher?.close();
    },
    /**
     * Re-resolve and reattach watcher when root_dir or explicit_db changes.
     *
     * @param {{ root_dir?: string, explicit_db?: string }} [opts]
     */
    rebind(opts = {}) {
      const next_root = opts.root_dir ? String(opts.root_dir) : root_dir;
      const next_explicit = opts.explicit_db ?? options.explicit_db;
      const next_resolved = resolveWorkspaceDatabase({
        cwd: next_root,
        explicit_db: next_explicit
      });
      const next_path = next_resolved.path;
      if (next_path !== current_path) {
        // swap watcher
        watcher?.close();
        resetScheduling();
        bind(next_root, next_explicit);
      }
    }
  };
}

/**
 * @param {string} file_path
 */
function pathIsDirectory(file_path) {
  try {
    return fs.statSync(file_path).isDirectory();
  } catch {
    return false;
  }
}
