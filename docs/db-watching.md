# DB Watching and Resolution

The server watches the active Beads storage target and schedules a refresh of
active subscriptions. SQLite workspaces watch the database file's parent
directory and filter by file name. Dolt and other metadata-backed workspaces
watch the workspace `.beads` directory. Clients receive snapshot, upsert,
delete, or capability-gated delta envelopes for active subscriptions.

## Resolution Order

The DB path is resolved to match beads CLI precedence:

1. `--db <path>` flag (when forced by the server configuration)
2. `BEADS_DB` environment variable
3. Nearest `.beads/*.db` by walking up from the server `root_dir`
4. Nearest `.beads/metadata.json` workspace for a non-SQLite backend
5. `~/.beads/default.db` fallback

All `bd` commands run with the selected workspace as their working directory so
the watcher and CLI resolve the same backend.

## Refresh policy

Filesystem notifications are debounced. A write burst can produce one leading
refresh, one trailing refresh, and one bounded follow-up refresh. Events during
the cooldown are coalesced instead of discarded. Rebinding or closing the
watcher invalidates pending callbacks from the prior workspace.

The watcher cannot reliably label an event as originating from the UI's own `bd`
read or from another process. A finite callback sequence therefore cannot prove
that no external write occurred after its final read. Adding an unbounded quiet
loop would trade this narrow race for polling, self-triggered refresh loops, and
unbounded process work.

The accepted policy is to keep the bounded sequence. A stronger guarantee
requires a backend-provided change token, transaction sequence, or event
provenance that can be compared before and after a refresh. Without such a
signal, further timer-only verification is deferred.

## Behavior When Missing

If no database exists at the resolved path (for example, before `bd init`), the
server will still attempt to bind a watcher on the containing directory and log
a clear warning. Initialize a database with one of:

- `bd --db /path/to/file.db init`
- `export BEADS_DB=/path/to/file.db && bd init`
- `bd init` in a workspace with a `.beads/` directory

After initialization, changes will be detected without restarting the server.
The watcher can rebind when the workspace or configuration changes at runtime.
