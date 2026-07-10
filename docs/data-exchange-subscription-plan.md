# Data Exchange Model — Subscription‑Based Updates (Full‑Issue)

```
Date: 2025-10-25
Amended: 2026-07-10
Status: base implemented; subscription-delta-v1 accepted, implementation pending
Owner: agent
```

## Goals

- Replace ad-hoc list fetching with subscription-based incremental updates.
- Minimize complexity; send full‑issue payloads in envelopes targeted to a
  specific subscription key.
- Collapse multi-issue refreshes into one atomic delivery for clients that
  advertise `subscription-delta-v1`, while retaining legacy full-issue events.
- Ensure consistent, race-free updates around user-triggered mutations.
- Keep UI models per-subscription to simplify rendering and memory usage.

## Scope

- Server and client for `beads-ui`.
- Uses `bd` CLI for data access; no DB schema changes.

## Subscription Types

- `all-issues`
- `epics` // Removed: `issues-for-epic` (use `issue-detail` for the epic and
  render its `dependents`)
- `blocked-issues`
- `ready-issues`
- `in-progress-issues`
- `status-issues` (one or more ordinary statuses)
- `closed-issues` (special filtering noted below)

## Server Architecture

### Subscription Registry (Issue List Subscriptions)

- Keyed by a canonical `type` plus sorted URL-encoded params.
- Value:
  `{ itemsById: Map<string, { updated_at: string, closed_at: string|null }>, subscribers: Set<WebSocket> }`.
- Each connection separately maps client subscription ids to
  `{ key, normalized spec, accepted capabilities }`. Capability selection does
  not live in the shared registry entry.
- Each subscribe request either attaches to an existing registry entry or
  creates a new one.
- No TTL: registry entries are evicted only by the WebSocket disconnect sweep.
  Unsubscribe first removes the connection-local client id. It detaches the
  WebSocket from the shared key only when no remaining id on that connection
  references the key. This provides the reference counting required when capable
  and legacy ids share one key.

### Mapping to `bd` Commands

- `all-issues` → `bd list --limit <ceiling+1>` (default/open)
- `epics` → `bd epic status --json`, then server-side ceiling/truncation
- `detail:{id}` → `bd show <id> --json` (use `dependents` from the epic detail
  for children)
- `blocked-issues` → `bd blocked --json`, then server-side ceiling/truncation
- `ready-issues` → `bd ready --limit <ceiling+1>`
- `in-progress-issues` → `bd list --status in_progress --limit <ceiling+1>`
- `status-issues` → `bd list --status <canonical CSV> --limit <ceiling+1>`
- `closed-issues` → `bd list --status closed --limit <ceiling+1>` (then filter
  first; see Special Cases)

Notes:

- Exact flags depend on `bd`; create adapters that encapsulate CLI details and
  normalize results.

### Refresh Algorithm (per run)

1. Execute mapped `bd` command to get the full list of `issues` for the spec.
2. If subscription is `closed-issues` with a filter, apply it before step 3.
3. Compare with the registry’s last known items for this subscription key.
4. For each client subscription id, select delivery from its accepted
   capabilities. Legacy clients receive full-issue `upsert` and `delete`
   envelopes. A client with `subscription-delta-v1` receives one atomic `delta`
   when the combined change count is at least 2.
5. A one-change refresh uses the smaller legacy envelope. An empty refresh emits
   nothing.
6. Update the registry’s state for the key.

Capability selection is per client subscription id. It is not part of the
normalized subscription spec or shared registry key, so capable and legacy ids
can reuse one fetch and diff.

### Special Case: Closed Issues Filtering

- Apply `since` filter (epoch milliseconds) before diffing to avoid spurious
  updates when reloading older closed items. Only items with
  `closed_at >= since` are included. Invalid or non-positive `since` values are
  ignored.
- Filters are part of subscription params to keep deterministic diffing.

### Migration

This change replaces request/response list reads and id‑only deltas with
subscription‑based, full‑issue push envelopes.

Client migration steps:

- Replace list fetch calls with `subscribe-list`/`unsubscribe-list` messages.
- Maintain a per‑subscription local store keyed by the client `id`.
- Apply `snapshot`/`upsert`/`delete` envelopes in revision order; clients that
  advertise `subscription-delta-v1` also accept and atomically apply `delta`.
  Render from `store.snapshot()`.
- Remove any legacy polling timers; updates now arrive via server push.
- For closed issue feeds, pass a `params.since` value (epoch ms) that reflects
  the UI’s filter horizon if needed server‑side.

### Watcher Integration (DB Updates)

- A file/DB watcher signals any data change.
- On signal, for each active subscription: re-run its mapped `bd` command → diff
  → push deltas to all subscribers.
- Backpressure: coalesce multiple watcher events into a single run per
  subscription (leading-edge, with trailing-edge within 50–100ms).

### User Mutations (Race Control)

When client requests a change (e.g., update status):

1. Execute the explicit protocol mutation (mapped to a concrete `bd` command
   under the hood; no arbitrary commands allowed).
2. In parallel, attach a once-listener to the watcher that resolves on the next
   change event (no debounce) or a 500ms timeout, whichever occurs first.
3. After the promise resolves, for each affected subscription, run the standard
   refresh/diff/push routine exactly once.
4. During the pending mutation window, suppress watcher-triggered refreshes for
   affected subscriptions to avoid duplicate pushes.

### Error Handling

- Validate subscription params; return structured errors.
- For `bd` failures, include stderr and exit code; do not crash subscriptions.
- If a subscriber disconnects mid-push, drop silently and clean up.

## Client Architecture

### Local Store per Subscription

- Keyed by the client subscription `id`; the server key remains metadata used
  for shared membership and diffing.
- Value: `{ itemsById: Map<string, Issue>, lastAppliedAt: number }`.
- On `snapshot`, `upsert`, `delete`, or a validated atomic `delta`, update
  `itemsById` accordingly and request one view re-render.
- Tabs and epic expansion toggle subscribe/unsubscribe appropriately.

### UI Flow

- Tab switch: unsubscribe previous, subscribe new.
- Epic toggle: subscribe/unsubscribe `detail:{id}` with
  `{ type: 'issue-detail', params: { id } }`.
- Components derive view state from the local store snapshot.

## Wire Protocol (vNext)

### Messages: Client → Server

- `subscribe-list`
  `{ id: string, type: string, params?: object, capabilities?: string[] }`
- `unsubscribe-list` `{ id: string }`
- Explicit mutation messages (enumerated in the protocol; no generic command
  pipe). The set mirrors the main protocol (update-status, edit-text,
  update-priority, update-assignee, create-issue, dep-add/remove,
  label-add/remove).

### Messages: Server → Client (Per‑Subscription)

All envelopes include a client subscription `id` and a revision from the
connection-local counter for its normalized subscription key. The key's first
event starts at 1. Client ids sharing the key observe increasing subsets and may
see gaps or an initial value greater than 1.

- `snapshot` `{ id, revision, issues: Issue[], truncated?: boolean }`
- `upsert` `{ id, revision, issue: Issue }`
- `delete` `{ id, revision, issue_id: string }`
- `delta` `{ id, revision, upserts: Issue[], deletes: string[] }`

Notes

- Initial subscribe triggers a single `snapshot` for the requesting `id` only.
  The snapshot is successfully encoded, size-checked, and enqueued before the
  successful subscribe acknowledgement.
- Subsequent refresh runs emit `upsert`/`delete` events to all subscribers of
  the same subscription key on that connection. Once implemented, capable client
  ids receive one `delta` for two or more changes instead.
- Clients MUST apply envelopes in `revision` order and ignore stale revisions.
- A delta is one revision and must be fully valid before mutation. Upsert and
  delete ids are unique and disjoint. Invalid deltas are not partially applied;
  the affected client subscription re-subscribes for a fresh snapshot.

The normative capability bounds, delta invariants, compatibility matrix, and
reconnect rules are defined in `docs/protocol/issues-push-v2.md`.

## Concurrency & Ordering Guarantees

- Per-subscription ordering: server serializes diff runs per key.
- Envelopes are applied in order on the client; one delta is an atomic change
  set with one sort and one listener notification.
- Mutations provide “eventually up-to-date” guarantee via the once-listener +
  timeout.

## Observability

- Basic development logging only; no telemetry collection for message rates.

## Security

- Only explicit mutation operations are implemented by the protocol; no
  arbitrary commands from clients.
- Reject unknown subscription types; enforce param schemas.
- Validate the top-level capability array independently of subscription params:
  at most 8 entries, 1 to 64 lowercase ASCII token characters each. Ignore
  well-formed unknown capabilities and reject malformed or excessive input.
- Limit client subscription ids to 128 UTF-8 bytes with no ASCII control
  characters and each connection to 32 distinct reservations across active ids
  and pending initial fetches. Reserve before fetching. Same-id supersession
  transfers the reservation to the newest intent; release it only when the id
  has neither an active subscription nor a current pending intent.
- Keep result ceilings server-owned and finite. Do not accept arbitrary client
  limits. New snapshots report exact `truncated` metadata.
- Use 8 MiB defaults for maximum encoded push frame and socket high-water mark.
  Reject an oversized initial snapshot with `resource_limit`; close with code
  1013 and recover by snapshot instead of partially sending or dropping an
  incremental change set under backpressure.

## Testing Strategy

- Unit: diffing, registry, adapter mapping, filter logic, capability bounds,
  delta invariants, stale/duplicate handling, and atomic store application.
- Integration: watcher → refresh → push flow; mutation window once-only
  behavior; capable and legacy client ids sharing one registry key; reconnect
  capability replay.
- E2E: tab switching, epic expansion, status changes while updates stream.

## Release Notes

- Breaking change: Clients must adopt `snapshot`/`upsert`/`delete` envelopes and
  per‑subscription stores. Previous polling and id‑only list deltas are removed.
- Additive extension: `subscription-delta-v1` batches full-issue updates while
  preserving `upsert` and `delete` fallback for protocol v2.

## Implementation Status

- Base full-issue subscription delivery is implemented.
- The `subscription-delta-v1` server delivery, capability negotiation, and
  resource bounds are implemented by `beads-ui-tyx.2`. Client application and
  integration compatibility remain tracked by `beads-ui-tyx.3` and
  `beads-ui-tyx.4`.
