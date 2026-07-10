# ADR 003: Keep `bd` as the read and mutation boundary

```
Date: 2026-07-10
Status: Accepted
Owner: agent
```

## Context

List refreshes and mutations run through the `bd` CLI. This costs a process
spawn and all commands are serialized because embedded Dolt cannot safely serve
concurrent processes. Two proposed optimizations were evaluated:

1. Read issue tables directly from the workspace database.
2. Return mutation acknowledgements without the canonical issue returned by a
   follow-up `bd show`.

The application supports both SQLite-style workspaces and Dolt workspaces. The
installed `bd` CLI exposes `bd sql`, but its own documentation warns that raw
SQL bypasses the storage layer. Ready and Blocked membership also depend on
Beads semantics rather than status fields alone.

## Decision

- Keep `bd` as the only production read and mutation boundary.
- Reject direct SQLite or Dolt table reads in the server. They would couple the
  UI to backend-specific schemas, bypass Beads compatibility behavior, and make
  Ready and Blocked membership easy to miscompute.
- Retain canonical mutation responses. The client applies optimistic edits, but
  the returned issue is still required to reconcile normalized fields and
  server-side changes.
- Use the canonical JSON emitted by `bd update --json` to remove a redundant
  follow-up `bd show` where supported. Keep a compatibility fallback for older
  CLIs that do not return a usable issue payload.
- Retain the post-mutation subscription refresh for membership correctness.
  Status, dependencies, labels, and closure can add or remove an issue from
  Ready, Blocked, status, and time-bounded subscriptions.
- Do not derive several capped subscription results from one capped combined
  list. A combined 1,000-item result cannot guarantee 1,000 correct members for
  each derived status list.
- Continue using bounded caches, refresh coalescing, command prioritization,
  atomic delta delivery, and optimistic UI as the safe latency controls.

## Reconsideration gates

Reconsider a shared read model or acknowledgement-only mutations only when at
least one of these conditions is met:

- `bd` exposes a supported stable read API with explicit Ready and Blocked
  semantics.
- `bd` exposes stable cursor or offset pagination that preserves membership
  across concurrent updates.
- A versioned Beads schema contract covers every supported backend.
- Other mutation commands return the complete canonical issue directly without
  weakening reconciliation.

Any future proposal must include SQLite and Dolt compatibility tests, bounded
resource behavior, workspace-switch tests, and membership tests for Ready,
Blocked, status, dependency, and closed-time subscriptions.

## Consequences

The server keeps the process-spawn cost of the supported CLI boundary. In
return, it preserves backend portability and exact subscription semantics.
Performance work remains focused on reducing redundant rendering, batching wire
updates, bounding DOM work, and reusing safe results rather than duplicating the
Beads data model.
