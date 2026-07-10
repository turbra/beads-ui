# ADR 002 — Per‑Subscription Stores and Full‑Issue Push (Breaking)

```
Date: 2025-10-26
Amended: 2026-07-10
Status: Accepted; subscription-delta-v1 amendment accepted, implementation pending
Owner: agent
```

## Context

The UI currently maintains a central `issues` cache and a separate list
membership model. Push events update the central cache and lists fan out from
it. This split increases cognitive load (two caches, two sets of selectors),
creates subtle ordering/dedup bugs, and complicates tests and routing.

We want a simpler, local model per visible list: one subscription → one store →
one push update stream → one rendered list. Push events must contain complete
issue objects for correctness and to avoid fan‑out to a central cache.

## Decision

- Adopt a per‑subscription issue store (`SubscriptionIssueStore`) keyed by the
  client’s subscription id.
- Server sends per‑subscription full‑issue payloads only; no id‑only deltas.
  Messages are serialized per subscription and revisioned.
- Add `subscription-delta-v1` as an optional delivery capability. Capable
  subscriptions receive one atomic full-issue `delta` for refreshes with two or
  more changes. Missing or unsupported capabilities retain full-issue
  `upsert`/`delete` delivery.
- Bound the additive protocol at the server boundary: 128 UTF-8 bytes per client
  subscription id, 8 capability tokens, 32 active subscriptions per connection,
  a finite server-owned list ceiling, and 8 MiB defaults for maximum encoded
  push frame and socket high-water mark. Pending initial fetches reserve a
  subscription slot. Backpressure closes and resynchronizes the connection
  rather than dropping incremental frames.
- Lists render exclusively from their own store snapshots; the central issue
  cache is removed from the list render path.
- Breaking change: remove legacy id‑only list deltas and any compatibility
  paths/flags. The delta capability does not restore that old protocol; it is an
  additive optimization within the full-issue v2 model.

## Protocol (Server → Client)

Base runtime message shapes are defined in `types/subscriptions.ts`. The
accepted delta target below is normative for `beads-ui-tyx.2` and
`beads-ui-tyx.3`; those implementation tasks add it to the runtime types.
`docs/protocol/issues-push-v2.md` is the complete wire contract.

Push envelopes include a per‑subscription, strictly monotonic `revision` used
for ordering and replay protection. The versioned `subscription-delta-v1`
capability applies only to delivery selection.

- `subscribe-list` reply `{ id: string, key: string, capabilities: string[] }`
- `snapshot`
  `{ id: string, revision: number, issues: Issue[], truncated?: boolean }`
- `upsert` `{ id: string, revision: number, issue: Issue }`
- `delete` `{ id: string, revision: number, issue_id: string }`
- `delta`
  `{ id: string, revision: number, upserts: Issue[], deletes: string[] }`
- `error` `{ id?: string, code: string, message: string, details?: object }`

Notes

- Ordering is guaranteed by a key-scoped counter on one connection and signaled
  via `revision`. Client ids sharing a key may observe gaps or different initial
  values. Each client store MUST apply its observed envelopes in increasing
  order and ignore any envelope whose `revision` is ≤ the last applied.
- Clients MUST treat updates as idempotent and MAY additionally guard on an
  `issue.updated_at` timestamp to ignore stale `upsert`s that race with local
  state. Timestamps are advisory; `revision` is canonical for ordering.
- Initial state arrives as a `snapshot` with a complete list of issues for the
  bounded subscription key. New servers add exact `truncated` metadata; older
  servers omit it.
- A delta is one atomic revision. Upsert and delete ids are unique and disjoint.
  Clients validate the complete delta before mutation, sort and notify once, and
  re-subscribe for a fresh snapshot if validation fails.
- The server selects delta delivery per client subscription id, not per shared
  registry key. Capable and legacy ids may share the same fetched result.

## Client Store API

The UI manages one store per active subscription. Minimal API surface:

```ts
// types only — see types/subscription-issue-store.ts
export interface SubscriptionIssueStore {
  /** Client subscription id this store belongs to. */
  readonly id: string;

  /** Attach a listener that is called after each applied message. */
  subscribe(listener: () => void): () => void;

  /** Apply a push message: snapshot, upsert, delete, or atomic delta. */
  applyPush(msg: SnapshotMsg | UpsertMsg | DeleteMsg | DeltaMsg): void;

  /** Read-only, stable snapshot for rendering (deterministic sort). */
  snapshot(): readonly Issue[];

  /** Lookup helpers used by views/tests. */
  size(): number;
  getById(id: string): Issue | undefined;

  /** Release references and listeners when the view unmounts. */
  dispose(): void;
}

export type SnapshotMsg = {
  type: 'snapshot';
  id: string;
  revision: number;
  issues: Issue[];
  truncated?: boolean;
};

export type UpsertMsg = {
  type: 'upsert';
  id: string;
  revision: number;
  issue: Issue;
};

export type DeleteMsg = {
  type: 'delete';
  id: string;
  revision: number;
  issue_id: string;
};

export type DeltaMsg = {
  type: 'delta';
  id: string;
  revision: number;
  upserts: Issue[];
  deletes: string[];
};
```

### Sorting and identity

- Stores maintain stable item identity across updates (same object ref for the
  same `id` when only fields change) and expose a deterministic sort order
  suitable for the owning view (e.g., Issues: priority asc, then `created_at`
  desc, then id asc).

### Error handling and reconnect

- On disconnect/reconnect, the client creates a fresh store and re‑subscribes.
  The server sends a fresh snapshot; no attempt is made to diff across sessions.
  The store resets revision state because the new connection restarts each
  key-scoped counter.

### Reconcile algorithm (pseudo‑code)

```
state: Map<string, Issue> = new Map()
lastRevision: number = 0

function applyPush(msg) {
  if (msg.revision <= lastRevision) return // stale or duplicate
  if (msg.type === 'delta' && !isCompleteValidDelta(msg)) {
    markDesynchronized()
    resubscribeForSnapshot()
    return
  }

  switch (msg.type) {
    case 'snapshot':
      state.clear()
      for (const it of deterministicallySort(msg.issues)) {
        state.set(it.id, it)
      }
      break
    case 'upsert':
      const existing = state.get(msg.issue.id)
      if (!existing || existing.updated_at <= msg.issue.updated_at) {
        state.set(msg.issue.id, msg.issue)
      }
      break
    case 'delete':
      state.delete(msg.issue_id)
      break
    case 'delta':
      for (const it of msg.upserts) {
        upsertWithIdentityAndTimestampGuard(state, it)
      }
      for (const id of msg.deletes) {
        state.delete(id)
      }
      break
  }
  lastRevision = msg.revision
  sortOnceIfDirty()
  notifyListenersOnce()
}
```

The sort function must be deterministic and view‑specific (e.g., priority asc,
then `created_at` desc, then `id` asc). Stores keep object identity stable for
the same `id` whenever fields change.

## Migration

- Delete list render paths that read via the central issues cache.
- Introduce a factory `createSubscriptionIssueStore(id)` at view mount; wire the
  push client to route `snapshot`/`upsert`/`delete` and accepted `delta`
  messages by `id` to the corresponding store via `applyPush`.
- Update list components to render from `store.snapshot()` and subscribe to
  re‑render on changes.
- Remove legacy central‑store fan‑out and dead selectors.
- Add a bounded top-level `capabilities` array to `subscribe-list`. Keep it out
  of subscription `params` and keys. Re-send the capability on reconnect and
  keep legacy handlers active.

## Consequences

Pros

- One‑to‑one mapping of subscription → store → view simplifies reasoning and
  testing.
- No cache fan‑out; updates apply once per subscription and render once.
- Clearer ownership boundaries; easier disposal on route/tab changes.
- Bulk refreshes collapse many WebSocket tasks, sorts, and renders into one
  atomic delivery for capable subscriptions.

Cons / Risks

- Larger `updated` payloads vs id‑only membership deltas. Mitigated by
  per‑subscription scoping and batching.
- Requires coordinated server/client cutover due to the breaking change.
- The additive delta path permanently retains full-issue `upsert` and `delete`
  fallback within protocol v2. This adds a small compatibility test matrix.

## Alternatives Considered

- Keep the central cache and fan‑out membership to lists. Rejected: duplicates
  ownership, increases complexity and test surface, caused known ordering bugs.
- Maintain id‑only list deltas with separate issue fetches. Rejected: adds
  round‑trips and cross‑store coordination; does not meet simplicity goal.
- Dual old/new data models with gradual cutover. Rejected: id-only deltas,
  notify-then-fetch, and central-cache fan-out remain removed.
- Additive full-issue delta capability. Accepted: it changes only delivery
  granularity, uses the same subscription membership and issue payloads, and
  safely falls back when either peer lacks support.

## Related

- ADR 001 — Push‑Only Lists (v2): establishes push‑only direction and server
  batching; this ADR replaces the central‑store + list‑membership split with a
  per‑subscription store model.
- `docs/protocol/issues-push-v2.md` and
  `docs/data-exchange-subscription-plan.md` for normative protocol and server
  behavior.

## Status & Follow‑ups

- The per-subscription full-issue store decision is implemented and accepted.
- The `subscription-delta-v1` amendment is accepted as the compatibility
  contract. Server implementation is complete in `beads-ui-tyx.2`; client
  implementation is tracked by `beads-ui-tyx.3`, and integration and
  compatibility validation are tracked by `beads-ui-tyx.4`.
- Legacy full-issue `upsert` and `delete` remain supported for protocol v2.
  Removing them requires a new major protocol ADR and migration plan.
