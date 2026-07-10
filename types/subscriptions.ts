/**
 * Subscription protocol type definitions (interfaces only).
 * File is .ts by design: interface definitions only.
 */

export interface IssueRef {
  id: string;
  created_at?: number; // epoch ms
  updated_at?: number; // epoch ms
  closed_at?: number | null; // epoch ms or null
}

export interface Issue extends IssueRef {
  // Additional fields are server-defined; keep minimal here to guide clients.
  title?: string;
  status?: string;
  close_reason?: string | null;
  epic_id?: string | null;
  priority?: number;
  issue_type?: string;
  assignee?: string | null;
  labels?: string[];
  dependency_count?: number;
  dependent_count?: number;
  comment_count?: number;
  comments?: Array<Record<string, unknown>>;
  // Relationship fields for detail payloads
  dependencies?: DependencyRef[];
  dependents?: DependencyRef[];
}

export interface DependencyRef {
  id: string;
  title?: string;
  status?: string;
  priority?: number;
  issue_type?: string;
  created_at?: number;
  updated_at?: number;
  closed_at?: number | null;
}

export type SubscriptionType =
  | 'all-issues'
  | 'epics'
  | 'blocked-issues'
  | 'issues-ready'
  | 'ready-issues'
  | 'in-progress-issues'
  | 'status-issues'
  | 'closed-issues'
  | 'issue-detail';

export interface SubscribeParamsBase {
  /** Client-chosen subscription id (unique per connection). */
  id: string;
  /** Type of list to subscribe to. */
  type: SubscriptionType;
  /** Optional parameters for the list, e.g., epic_id or filters. */
  params?: Record<string, unknown>;
  /** Optional connection-local delivery capabilities. */
  capabilities?: readonly string[];
}

export interface SubscribeMessage extends SubscribeParamsBase {
  kind: 'subscribe';
}

export interface UnsubscribeMessage {
  kind: 'unsubscribe';
  id: string;
}

// Mutation messages are explicit and defined elsewhere in the protocol.
// There is no generic "mutate" command pipe from clients.

export type ClientMessage = SubscribeMessage | UnsubscribeMessage;

export interface SnapshotMessage {
  type: 'snapshot';
  id: string; // client subscription id
  revision: number; // strictly increasing per subscription
  issues: Issue[];
  truncated?: boolean;
}

export interface UpsertMessage {
  type: 'upsert';
  id: string;
  revision: number;
  issue: Issue;
}

export interface DeleteMessage {
  type: 'delete';
  id: string;
  revision: number;
  issue_id: string;
}

export interface DeltaMessage {
  type: 'delta';
  id: string;
  revision: number;
  upserts: Issue[];
  deletes: string[];
}

export interface ErrorMessage {
  type: 'error';
  id?: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ServerMessage =
  | SnapshotMessage
  | UpsertMessage
  | DeleteMessage
  | DeltaMessage
  | ErrorMessage;

export interface SubscriptionRegistryEntry {
  /** Deterministic key: type + serialized params */
  key: string;
  /** Fast-lookup map for diffing */
  itemsById: Map<string, IssueRef>;
  /** Active subscribers (connection-local ids) */
  subscribers: Set<string>;
  /** For metrics and observability (not used for TTL/GC) */
  lastRunAt?: number;
}
