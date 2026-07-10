/**
 * SubscriptionIssueStore interface definitions.
 * File is .ts by design: interfaces only.
 */
import type { Issue } from './subscriptions.js';

/** Stable comparator used by stores for deterministic ordering. */
export type IssueComparator = (a: Issue, b: Issue) => number;

/** Options for creating a subscription-scoped issue store. */
export interface SubscriptionIssueStoreOptions {
  /** Deterministic sort for snapshot(). Defaults to Issues view order. */
  sort?: IssueComparator;
}

/**
 * One subscription == one store.
 * Stores own normalized items for a single subscription id and expose
 * a stable, sorted snapshot for rendering.
 */
export interface SubscriptionIssueStore {
  /** Client-chosen subscription id this store belongs to. */
  readonly id: string;

  /**
   * Subscribe to store changes. Applied changes are coalesced within the same
   * tick, so one listener notification may represent multiple push messages.
   * Returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void;

  /**
   * Apply a push message (snapshot, upsert, delete, or delta). The store must be
   * idempotent and ignore stale updates using `revision` and `updated_at`.
   */
  applyPush(
    msg: SnapshotMsg | UpsertMsg | DeleteMsg | DeltaMsg
  ): PushApplyResult;

  /** Reject incrementals until a fresh snapshot restores synchronization. */
  requireResync(): 'ignored' | 'resync-needed';

  /**
   * Seed with already-loaded list data without advancing the server revision.
   * The next real snapshot may still replace or enrich the seeded issue.
   */
  seed(items: Issue[]): void;

  /** Stable, read-only snapshot of issues for rendering. */
  snapshot(): readonly Issue[];

  /** Exact server truncation state; null means an older server did not report it. */
  truncation(): boolean | null;

  /** Convenience helpers for tests and lookups. */
  size(): number;
  getById(id: string): Issue | undefined;

  /** Release references and listeners when the owning view unmounts. */
  dispose(): void;
}

/** Factory signature for creating subscription stores. */
export interface CreateSubscriptionIssueStore {
  (id: string, options?: SubscriptionIssueStoreOptions): SubscriptionIssueStore;
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

export type PushApplyResult = 'applied' | 'ignored' | 'resync-needed';
