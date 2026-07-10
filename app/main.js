/**
 * @import { MessageType } from './protocol.js'
 */
import { html, render } from 'lit-html';
import { createListSelectors } from './data/list-selectors.js';
import { createDataLayer } from './data/providers.js';
import { createSubscriptionIssueStores } from './data/subscription-issue-stores.js';
import { createSubscriptionStore } from './data/subscriptions-store.js';
import { createHashRouter, parseHash, parseView } from './router.js';
import {
  createStore,
  normalizeStatusFilters,
  normalizeTypeFilters
} from './state.js';
import { createActivityIndicator } from './utils/activity-indicator.js';
import { debug } from './utils/logging.js';
import { showToast } from './utils/toast.js';
import { createBoardView } from './views/board.js';
import { createDetailView } from './views/detail.js';
import { createEpicsView } from './views/epics.js';
import { createFatalErrorDialog } from './views/fatal-error-dialog.js';
import { createIssueDialog } from './views/issue-dialog.js';
import { createListView } from './views/list.js';
import { createTopNav } from './views/nav.js';
import { createNewIssueDialog } from './views/new-issue-dialog.js';
import { createWorkspacePicker } from './views/workspace-picker.js';
import { createWsClient } from './ws.js';

/**
 * Bootstrap the SPA shell with two panels.
 *
 * @param {HTMLElement} root_element - The container element to render into.
 */
export function bootstrap(root_element) {
  const log = debug('main');
  log('bootstrap start');

  // Render route shells (nav is mounted in header)
  const shell = html`
    <section id="issues-root" class="route issues">
      <aside id="list-panel" class="panel"></aside>
    </section>
    <section id="epics-root" class="route epics" hidden></section>
    <section id="board-root" class="route board" hidden></section>
    <section id="detail-panel" class="route detail" hidden></section>
  `;
  render(shell, root_element);

  /** @type {HTMLElement|null} */
  const nav_mount = document.getElementById('top-nav');
  /** @type {HTMLElement|null} */
  const issues_root = document.getElementById('issues-root');
  /** @type {HTMLElement|null} */
  const epics_root = document.getElementById('epics-root');
  /** @type {HTMLElement|null} */
  const board_root = document.getElementById('board-root');

  /** @type {HTMLElement|null} */
  const list_mount = document.getElementById('list-panel');
  /** @type {HTMLElement|null} */
  const detail_mount = document.getElementById('detail-panel');
  if (list_mount && issues_root && epics_root && board_root && detail_mount) {
    /** @type {HTMLElement|null} */
    const header_loading = document.getElementById('header-loading');
    const activity = createActivityIndicator(header_loading);
    const fatal_dialog = createFatalErrorDialog(root_element);

    /**
     * Show a blocking dialog when a backend command fails.
     *
     * @param {unknown} err
     * @param {string} context
     */
    function showFatalFromError(err, context) {
      /** @type {string} */
      let message = 'Request failed';
      /** @type {string} */
      let detail = '';

      if (err && typeof err === 'object') {
        const any = /** @type {{ message?: unknown, details?: unknown }} */ (
          err
        );
        if (typeof any.message === 'string' && any.message.length > 0) {
          message = any.message;
        }
        if (typeof any.details === 'string') {
          detail = any.details;
        } else if (any.details && typeof any.details === 'object') {
          try {
            detail = JSON.stringify(any.details, null, 2);
          } catch {
            detail = '';
          }
        }
      } else if (typeof err === 'string' && err.length > 0) {
        message = err;
      }

      const title =
        context && context.length > 0
          ? `Failed to load ${context}`
          : 'Request failed';

      fatal_dialog.open(title, message, detail);
    }

    /**
     * Return whether a subscription failure is an expected stale-request race.
     *
     * @param {unknown} err
     */
    function isExpectedSubscriptionError(err) {
      if (!err || typeof err !== 'object') {
        return false;
      }
      const code = /** @type {{ code?: unknown }} */ (err).code;
      return (
        code === 'subscription_superseded' ||
        code === 'workspace_changed' ||
        code === 'ws_disconnected' ||
        code === 'ws_connection_failed' ||
        code === 'ws_send_failed'
      );
    }

    const client = createWsClient();
    const tracked_send = activity.wrapSend((type, payload) =>
      client.send(type, payload)
    );
    // Subscriptions: wire client events and expose subscribe/unsubscribe helpers
    const subscriptions = createSubscriptionStore(tracked_send);
    // Per-subscription stores (source of truth)
    const sub_issue_stores = createSubscriptionIssueStores();
    // Route per-subscription push envelopes to the owning store
    client.on('snapshot', (payload) => {
      const p = /** @type {any} */ (payload);
      const id = p && typeof p.id === 'string' ? p.id : '';
      const store = id ? sub_issue_stores.getStore(id) : null;
      if (store && p && p.type === 'snapshot') {
        try {
          store.applyPush(p);
        } catch {
          // ignore
        }
      }
    });
    client.on('upsert', (payload) => {
      const p = /** @type {any} */ (payload);
      const id = p && typeof p.id === 'string' ? p.id : '';
      const store = id ? sub_issue_stores.getStore(id) : null;
      if (store && p && p.type === 'upsert') {
        try {
          store.applyPush(p);
        } catch {
          // ignore
        }
      }
    });
    client.on('delete', (payload) => {
      const p = /** @type {any} */ (payload);
      const id = p && typeof p.id === 'string' ? p.id : '';
      const store = id ? sub_issue_stores.getStore(id) : null;
      if (store && p && p.type === 'delete') {
        try {
          store.applyPush(p);
        } catch {
          // ignore
        }
      }
    });
    // Derived list selectors: render from per-subscription snapshots
    const listSelectors = createListSelectors(sub_issue_stores);
    let workspace_bootstrapped = false;

    // --- Workspace management ---
    /**
     * Clear all subscriptions and stores, then re-establish them.
     * Called when switching workspaces.
     */
    async function clearAndResubscribe() {
      log('clearing all subscriptions for workspace switch');
      subscription_epoch += 1;
      // Unsubscribe from server-side subscriptions first
      if (unsub_issues_tab) {
        void unsub_issues_tab().catch(() => {});
        unsub_issues_tab = null;
      }
      if (unsub_epics_tab) {
        void unsub_epics_tab().catch(() => {});
        unsub_epics_tab = null;
      }
      if (unsub_board_ready) {
        void unsub_board_ready().catch(() => {});
        unsub_board_ready = null;
      }
      if (unsub_board_in_progress) {
        void unsub_board_in_progress().catch(() => {});
        unsub_board_in_progress = null;
      }
      if (unsub_board_closed) {
        void unsub_board_closed().catch(() => {});
        unsub_board_closed = null;
      }
      if (unsub_board_blocked) {
        void unsub_board_blocked().catch(() => {});
        unsub_board_blocked = null;
      }
      // Clear all subscription stores
      const storeIds = [
        'tab:issues',
        'tab:epics',
        'tab:board:ready',
        'tab:board:in-progress',
        'tab:board:closed',
        'tab:board:blocked'
      ];
      for (const id of storeIds) {
        try {
          sub_issue_stores.unregister(id);
        } catch {
          // ignore
        }
      }
      // Also clear any detail stores
      const s = store.getState();
      if (s.selected_id) {
        if (unsub_detail) {
          void unsub_detail().catch(() => {});
          unsub_detail = null;
        }
        active_detail_id = null;
        try {
          sub_issue_stores.unregister(`detail:${s.selected_id}`);
        } catch {
          // ignore
        }
      }
      // Force re-subscribe by resetting last spec key
      last_issues_spec_key = null;
      // Re-establish subscriptions for current view
      ensureTabSubscriptions(store.getState());
      if (s.selected_id) {
        openDetail(s.selected_id);
      }
    }

    /**
     * Handle workspace change request from the picker.
     *
     * @param {string} workspace_path
     * @param {boolean} [initial_restore]
     */
    async function handleWorkspaceChange(
      workspace_path,
      initial_restore = false
    ) {
      log('requesting workspace switch to %s', workspace_path);
      try {
        const result = await client.send('set-workspace', {
          path: workspace_path
        });
        log('workspace switch result: %o', result);
        if (result && result.workspace) {
          // Update state with new workspace
          store.setState({
            workspace: {
              current: {
                path: result.workspace.root_dir,
                database: result.workspace.db_path
              }
            }
          });
          // Persist preference
          window.localStorage.setItem('beads-ui.workspace', workspace_path);
          // Clear and resubscribe if workspace actually changed
          if (result.changed && workspace_bootstrapped) {
            await clearAndResubscribe();
          }
          if (result.changed && !initial_restore) {
            showToast(
              'Switched to ' + getProjectName(workspace_path),
              'success',
              2000
            );
          }
        }
      } catch (err) {
        log('workspace switch failed: %o', err);
        showToast('Failed to switch workspace', 'error', 3000);
        throw err;
      }
    }

    /**
     * Extract project name from path.
     *
     * @param {string} path
     * @returns {string}
     */
    function getProjectName(path) {
      if (!path) return 'Unknown';
      const parts = path.split('/').filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : 'Unknown';
    }

    /**
     * Load available workspaces from server and update state.
     *
     * @param {boolean} [restore_saved]
     */
    async function loadWorkspaces(restore_saved = false) {
      try {
        const result = await client.send('list-workspaces', {});
        log('workspaces loaded: %o', result);
        if (result && Array.isArray(result.workspaces)) {
          const available = result.workspaces.map((/** @type {any} */ ws) => ({
            path: ws.path,
            database: ws.database,
            pid: ws.pid,
            version: ws.version
          }));
          const current = result.current
            ? {
                path: result.current.root_dir,
                database: result.current.db_path
              }
            : null;
          store.setState({ workspace: { current, available } });

          // Check if we have a saved preference that differs from current
          const savedWorkspace =
            window.localStorage.getItem('beads-ui.workspace');
          if (
            restore_saved &&
            savedWorkspace &&
            savedWorkspace !== current?.path
          ) {
            // Check if saved workspace is in available list
            const savedExists = available.some(
              (/** @type {{ path: string }} */ ws) => ws.path === savedWorkspace
            );
            if (savedExists) {
              log('restoring saved workspace preference: %s', savedWorkspace);
              await handleWorkspaceChange(savedWorkspace, true);
            }
          }
        }
      } catch (err) {
        log('failed to load workspaces: %o', err);
      }
    }

    // Handle workspace-changed events from server (e.g., if another client changes workspace)
    client.on('workspace-changed', (payload) => {
      log('workspace-changed event: %o', payload);
      if (payload && payload.root_dir) {
        store.setState({
          workspace: {
            current: {
              path: payload.root_dir,
              database: payload.db_path
            }
          }
        });
        // Reload workspaces to get fresh list
        void loadWorkspaces(false);
        if (workspace_bootstrapped) {
          void clearAndResubscribe();
        }
      }
    });

    // --- End workspace management (mounting happens after store is created) ---

    // Show toasts for WebSocket connectivity changes
    /** @type {boolean} */
    let had_disconnect = false;
    let connection_epoch = 0;
    let reconnect_recovery_epoch = -1;

    /**
     * Replay live subscriptions with bounded retries while the same connection
     * epoch remains active.
     *
     * @param {number} recovery_epoch
     */
    async function recoverSubscriptions(recovery_epoch) {
      sub_issue_stores.resetForReconnect();
      /** @type {unknown} */
      let last_error = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await subscriptions.resubscribeAll();
          if (recovery_epoch === connection_epoch) {
            showToast('Reconnected', 'success', 2200);
          }
          return;
        } catch (err) {
          last_error = err;
          if (recovery_epoch !== connection_epoch) {
            return;
          }
          if (attempt < 2) {
            const delay = 1000 * 2 ** attempt;
            log(
              'subscription replay attempt %d failed; retrying in %dms: %o',
              attempt + 1,
              delay,
              err
            );
            showToast('Restoring live updates…', 'error', delay + 500);
            await new Promise((resolve) => window.setTimeout(resolve, delay));
          }
        }
      }
      const message =
        last_error instanceof Error && last_error.message
          ? `Reconnected, but live updates failed: ${last_error.message}`
          : 'Reconnected, but live updates could not be restored';
      showToast(message, 'error', 5000);
    }

    if (typeof client.onConnection === 'function') {
      /** @type {(s: 'connecting'|'open'|'closed'|'reconnecting') => void} */
      const onConn = (s) => {
        log('ws state %s', s);
        if (s === 'reconnecting' || s === 'closed') {
          if (!had_disconnect) {
            had_disconnect = true;
            connection_epoch += 1;
            showToast('Connection lost. Reconnecting…', 'error', 4000);
          }
        } else if (s === 'open' && had_disconnect) {
          had_disconnect = false;
          const recovery_epoch = connection_epoch;
          reconnect_recovery_epoch = recovery_epoch;
          const recovery = recoverSubscriptions(recovery_epoch).finally(() => {
            if (reconnect_recovery_epoch === recovery_epoch) {
              reconnect_recovery_epoch = -1;
            }
          });
          void recovery;
        }
      };
      client.onConnection(onConn);
    }
    // Load persisted filters (status/search/type) from localStorage
    /** @type {{ status: Array<'open'|'in_progress'|'closed'|'ready'>, search: string, type: string[] }} */
    let persisted_filters = { status: [], search: '', type: [] };
    try {
      const raw = window.localStorage.getItem('beads-ui.filters');
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') {
          persisted_filters = {
            status: normalizeStatusFilters(
              obj.status !== undefined ? obj.status : obj.statuses
            ),
            search: typeof obj.search === 'string' ? obj.search : '',
            type: normalizeTypeFilters(
              Array.isArray(obj.type) ||
                (typeof obj.type === 'string' && obj.type.length > 0)
                ? obj.type
                : obj.types
            )
          };
        }
      }
    } catch (err) {
      log('filters parse error: %o', err);
    }
    // Load last-view from storage
    /** @type {'issues'|'epics'|'board'} */
    let last_view = 'issues';
    try {
      const raw_view = window.localStorage.getItem('beads-ui.view');
      if (
        raw_view === 'issues' ||
        raw_view === 'epics' ||
        raw_view === 'board'
      ) {
        last_view = raw_view;
      }
    } catch (err) {
      log('view parse error: %o', err);
    }
    // Load board preferences
    /** @type {{ closed_filter: 'today'|'3'|'7' }} */
    let persistedBoard = { closed_filter: 'today' };
    try {
      const raw_board = window.localStorage.getItem('beads-ui.board');
      if (raw_board) {
        const obj = JSON.parse(raw_board);
        if (obj && typeof obj === 'object') {
          const cf = String(obj.closed_filter || 'today');
          if (cf === 'today' || cf === '3' || cf === '7') {
            persistedBoard.closed_filter = cf;
          }
        }
      }
    } catch (err) {
      log('board prefs parse error: %o', err);
    }

    const store = createStore({
      filters: persisted_filters,
      view: last_view,
      board: persistedBoard
    });
    let persisted_filters_json = JSON.stringify({
      status: persisted_filters.status,
      search: persisted_filters.search,
      type: persisted_filters.type
    });
    let persisted_board_json = JSON.stringify({
      closed_filter: persistedBoard.closed_filter
    });
    let persisted_view_value = last_view;
    const router = createHashRouter(store);
    router.start();
    /**
     * @param {string} type
     * @param {unknown} payload
     */
    const transport = (type, payload) =>
      tracked_send(/** @type {MessageType} */ (type), payload);
    // Top navigation (optional mount)
    if (nav_mount) {
      createTopNav(nav_mount, store, router);
    }

    // Workspace picker (mount now that store exists)
    const workspace_mount = document.getElementById('workspace-picker');
    if (workspace_mount) {
      createWorkspacePicker(workspace_mount, store, handleWorkspaceChange);
    }
    // Global New Issue dialog (UI-106) mounted at root so it is always visible
    const new_issue_dialog = createNewIssueDialog(
      root_element,
      (type, payload) => tracked_send(type, payload),
      router,
      store
    );
    // Header button
    try {
      const btn_new = /** @type {HTMLButtonElement|null} */ (
        document.getElementById('new-issue-btn')
      );
      if (btn_new) {
        btn_new.addEventListener('click', () => new_issue_dialog.open());
      }
    } catch {
      // ignore missing header
    }

    // Local transport shim: for list-issues, serve from local listSelectors;
    // otherwise forward to ws transport for mutations/show.
    /**
     * @param {MessageType} type
     * @param {unknown} payload
     */
    const listTransport = async (type, payload) => {
      if (type === 'list-issues') {
        try {
          return listSelectors.selectIssuesFor('tab:issues');
        } catch (err) {
          log('list selectors failed: %o', err);
          return [];
        }
      }
      return transport(type, payload);
    };

    const issues_view = createListView(
      list_mount,
      /** @type {any} */ (listTransport),
      (hash) => {
        const id = parseHash(hash);
        if (id) {
          router.gotoIssue(id);
        }
      },
      store,
      subscriptions,
      sub_issue_stores
    );
    // Persist filter changes to localStorage
    store.subscribe((s) => {
      const data = {
        status: s.filters.status,
        search: s.filters.search,
        type: s.filters.type
      };
      const next_json = JSON.stringify(data);
      if (next_json !== persisted_filters_json) {
        window.localStorage.setItem('beads-ui.filters', next_json);
        persisted_filters_json = next_json;
      }
    });
    // Persist board preferences
    store.subscribe((s) => {
      const next_json = JSON.stringify({
        closed_filter: s.board.closed_filter
      });
      if (next_json !== persisted_board_json) {
        window.localStorage.setItem('beads-ui.board', next_json);
        persisted_board_json = next_json;
      }
    });
    void issues_view.load();

    // Dialog for issue details (UI-104)
    const dialog = createIssueDialog(detail_mount, store, () => {
      // Close: clear selection and return to current view
      const s = store.getState();
      store.setState({ selected_id: null });
      try {
        /** @type {'issues'|'epics'|'board'} */
        const v = s.view || 'issues';
        router.gotoView(v);
      } catch {
        // ignore
      }
    });
    const detail_panel = /** @type {HTMLElement} */ (detail_mount);

    /**
     * Detail transport: comments load in the background, so keep them off the
     * global activity indicator that tracked sends drive.
     *
     * @param {string} type
     * @param {unknown} payload
     */
    const detail_transport = async (type, payload) => {
      if (type === 'get-comments') {
        return client.send(/** @type {MessageType} */ (type), payload);
      }
      return transport(type, payload);
    };

    /** @type {ReturnType<typeof createDetailView> | null} */
    let detail = null;
    // Mount details into the dialog body only
    detail = createDetailView(
      dialog.getMount(),
      detail_transport,
      (hash) => {
        const id = parseHash(hash);
        if (id) {
          router.gotoIssue(id);
        } else {
          // No issue ID - navigate to view (closes dialog)
          const view = parseView(hash);
          router.gotoView(view);
        }
      },
      sub_issue_stores
    );

    /** @type {null | (() => Promise<void>)} */
    let unsub_detail = null;
    /** @type {string | null} */
    let active_detail_id = null;
    const DETAIL_SEED_CLIENT_IDS = Object.freeze([
      'tab:issues',
      'tab:epics',
      'tab:board:ready',
      'tab:board:in-progress',
      'tab:board:closed',
      'tab:board:blocked'
    ]);

    /**
     * @param {string} detail_id
     */
    function findIssueForDetailSeed(detail_id) {
      for (const client_id of DETAIL_SEED_CLIENT_IDS) {
        const issues = sub_issue_stores.snapshotFor(client_id);
        const found = issues.find((issue) => String(issue.id) === detail_id);
        if (found) {
          return found;
        }
      }
      return null;
    }

    /**
     * @param {string} client_id
     * @param {string} detail_id
     */
    function seedDetailStore(client_id, detail_id) {
      const source_issue = findIssueForDetailSeed(detail_id);
      if (!source_issue) {
        return;
      }
      const detail_store = sub_issue_stores.getStore(client_id);
      if (detail_store && typeof detail_store.seed === 'function') {
        detail_store.seed([source_issue]);
      }
    }

    /**
     * @param {string} id
     */
    function openDetail(id) {
      const detail_id = String(id);
      if (active_detail_id === detail_id) {
        return;
      }
      const previous_id = active_detail_id;
      const previous_unsub = unsub_detail;
      active_detail_id = detail_id;
      unsub_detail = null;
      detail_panel.hidden = false;
      dialog.open(detail_id);
      if (previous_unsub) {
        void previous_unsub().catch(() => {});
      }
      if (previous_id) {
        try {
          sub_issue_stores.unregister(`detail:${previous_id}`);
        } catch {
          // ignore stale detail store cleanup errors
        }
      }
      const client_id = `detail:${detail_id}`;
      const spec = { type: 'issue-detail', params: { id: detail_id } };
      try {
        sub_issue_stores.register(client_id, spec);
        seedDetailStore(client_id, detail_id);
      } catch (err) {
        log('register detail store failed: %o', err);
      }
      if (detail) {
        void detail.load(detail_id);
      }
      const request_epoch = subscription_epoch;
      void subscriptions
        .subscribeList(client_id, spec)
        .then((unsub) => {
          if (
            request_epoch !== subscription_epoch ||
            active_detail_id !== detail_id
          ) {
            void unsub().catch(() => {});
            return;
          }
          unsub_detail = unsub;
        })
        .catch((err) => {
          log('detail subscribe failed: %o', err);
          if (!isExpectedSubscriptionError(err)) {
            showFatalFromError(err, 'issue details');
          }
        });
    }

    /**
     * Close the active detail dialog and clean up its subscription.
     */
    function closeDetail() {
      if (!active_detail_id && detail_panel.hidden) {
        return;
      }
      const previous_id = active_detail_id;
      active_detail_id = null;
      try {
        dialog.close();
      } catch {
        // ignore
      }
      if (detail) {
        detail.clear();
      }
      detail_panel.hidden = true;
      if (unsub_detail) {
        void unsub_detail().catch(() => {});
        unsub_detail = null;
      }
      if (previous_id) {
        try {
          sub_issue_stores.unregister(`detail:${previous_id}`);
        } catch {
          // ignore stale detail store cleanup errors
        }
      }
    }

    // Open/close dialog based on selected_id (always dialog; no page variant)
    store.subscribe((s) => {
      if (!workspace_bootstrapped) {
        return;
      }
      const id = s.selected_id;
      if (id) {
        openDetail(id);
      } else {
        closeDetail();
      }
    });

    // Removed: issues-changed handling. All views re-render from
    // per-subscription stores which are updated by snapshot/upsert/delete.

    // Toggle route shells on view/detail change and persist
    const data = createDataLayer(transport);
    const epics_view = createEpicsView(
      epics_root,
      data,
      (id) => router.gotoIssue(id),
      subscriptions,
      sub_issue_stores
    );
    const board_view = createBoardView(
      board_root,
      data,
      (id) => router.gotoIssue(id),
      store,
      subscriptions,
      sub_issue_stores,
      transport
    );
    // Preload epics when switching to view
    /**
     * @param {{ selected_id: string | null, view: 'issues'|'epics'|'board', filters: any }} s
     */
    // --- Subscriptions: tab-level management and filter-driven updates ---
    /** @type {null | (() => Promise<void>)} */
    let unsub_issues_tab = null;
    /** @type {null | (() => Promise<void>)} */
    let unsub_epics_tab = null;
    /** @type {null | (() => Promise<void>)} */
    let unsub_board_ready = null;
    /** @type {null | (() => Promise<void>)} */
    let unsub_board_in_progress = null;
    /** @type {null | (() => Promise<void>)} */
    let unsub_board_closed = null;
    /** @type {null | (() => Promise<void>)} */
    let unsub_board_blocked = null;

    // Track in-flight subscriptions to prevent duplicates during rapid view switching
    /** @type {Set<string>} */
    const pending_subscriptions = new Set();
    let subscription_epoch = 0;

    /**
     * Release a pending marker. A workspace change can invalidate a request
     * while retaining the same active view/spec, so reconcile again after the
     * stale request has stopped blocking its replacement.
     *
     * @param {string} pending_key
     * @param {number} request_epoch
     */
    function finishPendingSubscription(pending_key, request_epoch) {
      pending_subscriptions.delete(pending_key);
      if (request_epoch !== subscription_epoch && workspace_bootstrapped) {
        queueMicrotask(() => ensureTabSubscriptions(store.getState()));
      }
    }

    // Expose activity debug info globally for diagnostics
    // @ts-ignore
    window.__bdui_debug = {
      getPendingSubscriptions: () => Array.from(pending_subscriptions),
      getActivityCount: () => activity.getCount(),
      getActiveRequests: () => activity.getActiveRequests()
    };

    /**
     * Compute subscription spec for Issues tab based on filters.
     *
     * @param {{ status?: string | string[] }} filters
     * @returns {{ type: string, params?: Record<string, string|number|boolean> }}
     */
    function computeIssuesSpec(filters) {
      const statuses = normalizeStatusFilters(filters?.status);
      if (statuses.includes('ready')) {
        return { type: 'ready-issues' };
      }
      if (statuses.length > 0) {
        return {
          type: 'status-issues',
          params: { statuses: statuses.join(',') }
        };
      }
      return { type: 'all-issues' };
    }

    /**
     * @param {{ closed_filter?: string }} board
     */
    function computeBoardClosedSince(board) {
      const mode = String(board?.closed_filter || 'today');
      const now = new Date();
      const start = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        0,
        0,
        0,
        0
      );
      const day_start = start.getTime();
      if (mode === '3') {
        return day_start - 3 * 24 * 60 * 60 * 1000;
      }
      if (mode === '7') {
        return day_start - 7 * 24 * 60 * 60 * 1000;
      }
      return day_start;
    }

    /**
     * @param {{ closed_filter?: string }} board
     * @returns {{ type: string, params: { since: number } }}
     */
    function computeBoardClosedSpec(board) {
      return {
        type: 'closed-issues',
        params: { since: computeBoardClosedSince(board) }
      };
    }

    /** @type {string|null} */
    let last_issues_spec_key = null;
    /** @type {string|null} */
    let last_board_closed_spec_key = null;
    /** @type {number | null} */
    let board_midnight_timer = null;

    /**
     * Keep the board's local-day cutoff current for tabs left open overnight.
     *
     * @param {'issues'|'epics'|'board'} view
     */
    function scheduleBoardMidnightRefresh(view) {
      if (board_midnight_timer !== null) {
        window.clearTimeout(board_midnight_timer);
        board_midnight_timer = null;
      }
      if (view !== 'board') {
        return;
      }
      const now = new Date();
      const next_midnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        0,
        0,
        0,
        50
      );
      const delay = Math.max(1000, next_midnight.getTime() - now.getTime());
      board_midnight_timer = window.setTimeout(() => {
        board_midnight_timer = null;
        const current = store.getState();
        if (current.view === 'board') {
          ensureTabSubscriptions(current);
          scheduleBoardMidnightRefresh('board');
        }
      }, delay);
    }
    /**
     * Ensure only the active tab has subscriptions; clean up previous.
     *
     * @param {{ view: 'issues'|'epics'|'board', filters: any, board?: any }} s
     */
    function ensureTabSubscriptions(s) {
      // Issues tab
      if (s.view === 'issues') {
        const spec = computeIssuesSpec(s.filters || {});
        const key = JSON.stringify(spec);
        // Register store first to capture the initial snapshot
        try {
          sub_issue_stores.register('tab:issues', spec);
        } catch (err) {
          log('register issues store failed: %o', err);
        }
        // Only (re)subscribe if not yet subscribed, spec changed, and not already in-flight
        const issues_sub_key = `tab:issues:${key}`;
        if (
          (!unsub_issues_tab || key !== last_issues_spec_key) &&
          !pending_subscriptions.has(issues_sub_key)
        ) {
          pending_subscriptions.add(issues_sub_key);
          const request_epoch = subscription_epoch;
          void subscriptions
            .subscribeList('tab:issues', spec)
            .then((unsub) => {
              const current = store.getState();
              const current_key = JSON.stringify(
                computeIssuesSpec(current.filters || {})
              );
              if (
                request_epoch !== subscription_epoch ||
                current.view !== 'issues' ||
                current_key !== key
              ) {
                void unsub().catch(() => {});
                return;
              }
              unsub_issues_tab = unsub;
              last_issues_spec_key = key;
            })
            .catch((err) => {
              log('subscribe issues failed: %o', err);
              if (!isExpectedSubscriptionError(err)) {
                showFatalFromError(err, 'issues list');
              }
            })
            .finally(() => {
              finishPendingSubscription(issues_sub_key, request_epoch);
            });
        }
      } else if (unsub_issues_tab) {
        void unsub_issues_tab().catch(() => {});
        unsub_issues_tab = null;
        last_issues_spec_key = null;
        try {
          sub_issue_stores.unregister('tab:issues');
        } catch (err) {
          log('unregister issues store failed: %o', err);
        }
      }

      // Epics tab
      if (s.view === 'epics') {
        // Register store first to avoid race with initial snapshot
        try {
          sub_issue_stores.register('tab:epics', { type: 'epics' });
        } catch (err) {
          log('register epics store failed: %o', err);
        }
        // Only subscribe if not already subscribed and not in-flight
        if (!unsub_epics_tab && !pending_subscriptions.has('tab:epics')) {
          pending_subscriptions.add('tab:epics');
          const request_epoch = subscription_epoch;
          void subscriptions
            .subscribeList('tab:epics', { type: 'epics' })
            .then((unsub) => {
              if (
                request_epoch !== subscription_epoch ||
                store.getState().view !== 'epics'
              ) {
                void unsub().catch(() => {});
                return;
              }
              unsub_epics_tab = unsub;
            })
            .catch((err) => {
              log('subscribe epics failed: %o', err);
              if (!isExpectedSubscriptionError(err)) {
                showFatalFromError(err, 'epics');
              }
            })
            .finally(() => {
              finishPendingSubscription('tab:epics', request_epoch);
            });
        }
      } else if (unsub_epics_tab) {
        void unsub_epics_tab().catch(() => {});
        unsub_epics_tab = null;
        try {
          sub_issue_stores.unregister('tab:epics');
        } catch (err) {
          log('unregister epics store failed: %o', err);
        }
      }

      // Board tab subscribes to lists used by columns
      if (s.view === 'board') {
        // Ready column
        if (
          !unsub_board_ready &&
          !pending_subscriptions.has('tab:board:ready')
        ) {
          try {
            sub_issue_stores.register('tab:board:ready', {
              type: 'ready-issues'
            });
          } catch (err) {
            log('register board:ready store failed: %o', err);
          }
          pending_subscriptions.add('tab:board:ready');
          const request_epoch = subscription_epoch;
          void subscriptions
            .subscribeList('tab:board:ready', { type: 'ready-issues' })
            .then((unsub) => {
              if (
                request_epoch !== subscription_epoch ||
                store.getState().view !== 'board'
              ) {
                void unsub().catch(() => {});
                return;
              }
              unsub_board_ready = unsub;
            })
            .catch((err) => {
              log('subscribe board ready failed: %o', err);
              if (!isExpectedSubscriptionError(err)) {
                showFatalFromError(err, 'board (Ready)');
              }
            })
            .finally(() => {
              finishPendingSubscription('tab:board:ready', request_epoch);
            });
        }
        // In Progress column
        if (
          !unsub_board_in_progress &&
          !pending_subscriptions.has('tab:board:in-progress')
        ) {
          try {
            sub_issue_stores.register('tab:board:in-progress', {
              type: 'in-progress-issues'
            });
          } catch (err) {
            log('register board:in-progress store failed: %o', err);
          }
          pending_subscriptions.add('tab:board:in-progress');
          const request_epoch = subscription_epoch;
          void subscriptions
            .subscribeList('tab:board:in-progress', {
              type: 'in-progress-issues'
            })
            .then((unsub) => {
              if (
                request_epoch !== subscription_epoch ||
                store.getState().view !== 'board'
              ) {
                void unsub().catch(() => {});
                return;
              }
              unsub_board_in_progress = unsub;
            })
            .catch((err) => {
              log('subscribe board in-progress failed: %o', err);
              if (!isExpectedSubscriptionError(err)) {
                showFatalFromError(err, 'board (In Progress)');
              }
            })
            .finally(() => {
              finishPendingSubscription('tab:board:in-progress', request_epoch);
            });
        }
        // Closed column
        const closed_spec = computeBoardClosedSpec(s.board || {});
        const closed_key = JSON.stringify(closed_spec);
        const closed_sub_key = `tab:board:closed:${closed_key}`;
        if (
          (!unsub_board_closed || closed_key !== last_board_closed_spec_key) &&
          !pending_subscriptions.has(closed_sub_key)
        ) {
          try {
            sub_issue_stores.register('tab:board:closed', closed_spec);
          } catch (err) {
            log('register board:closed store failed: %o', err);
          }
          const previous_unsub =
            unsub_board_closed && closed_key !== last_board_closed_spec_key
              ? unsub_board_closed
              : null;
          if (previous_unsub) {
            unsub_board_closed = null;
          }
          pending_subscriptions.add(closed_sub_key);
          const request_epoch = subscription_epoch;
          const ready_to_subscribe = previous_unsub
            ? previous_unsub().catch(() => {})
            : Promise.resolve();
          void ready_to_subscribe
            .then(() =>
              subscriptions.subscribeList('tab:board:closed', closed_spec)
            )
            .then((unsub) => {
              const current = store.getState();
              const current_key = JSON.stringify(
                computeBoardClosedSpec(current.board || {})
              );
              if (
                request_epoch !== subscription_epoch ||
                current.view !== 'board' ||
                current_key !== closed_key
              ) {
                void unsub().catch(() => {});
                return;
              }
              unsub_board_closed = unsub;
              last_board_closed_spec_key = closed_key;
            })
            .catch((err) => {
              log('subscribe board closed failed: %o', err);
              if (!isExpectedSubscriptionError(err)) {
                showFatalFromError(err, 'board (Closed)');
              }
            })
            .finally(() => {
              finishPendingSubscription(closed_sub_key, request_epoch);
            });
        }
        // Blocked column
        if (
          !unsub_board_blocked &&
          !pending_subscriptions.has('tab:board:blocked')
        ) {
          try {
            sub_issue_stores.register('tab:board:blocked', {
              type: 'blocked-issues'
            });
          } catch (err) {
            log('register board:blocked store failed: %o', err);
          }
          pending_subscriptions.add('tab:board:blocked');
          const request_epoch = subscription_epoch;
          void subscriptions
            .subscribeList('tab:board:blocked', { type: 'blocked-issues' })
            .then((unsub) => {
              if (
                request_epoch !== subscription_epoch ||
                store.getState().view !== 'board'
              ) {
                void unsub().catch(() => {});
                return;
              }
              unsub_board_blocked = unsub;
            })
            .catch((err) => {
              log('subscribe board blocked failed: %o', err);
              if (!isExpectedSubscriptionError(err)) {
                showFatalFromError(err, 'board (Blocked)');
              }
            })
            .finally(() => {
              finishPendingSubscription('tab:board:blocked', request_epoch);
            });
        }
      } else {
        // Unsubscribe all board lists when leaving the board view
        if (unsub_board_ready) {
          void unsub_board_ready().catch(() => {});
          unsub_board_ready = null;
          try {
            sub_issue_stores.unregister('tab:board:ready');
          } catch (err) {
            log('unregister board:ready failed: %o', err);
          }
        }
        if (unsub_board_in_progress) {
          void unsub_board_in_progress().catch(() => {});
          unsub_board_in_progress = null;
          try {
            sub_issue_stores.unregister('tab:board:in-progress');
          } catch (err) {
            log('unregister board:in-progress failed: %o', err);
          }
        }
        if (unsub_board_closed) {
          void unsub_board_closed().catch(() => {});
          unsub_board_closed = null;
          last_board_closed_spec_key = null;
          try {
            sub_issue_stores.unregister('tab:board:closed');
          } catch (err) {
            log('unregister board:closed failed: %o', err);
          }
        }
        if (unsub_board_blocked) {
          void unsub_board_blocked().catch(() => {});
          unsub_board_blocked = null;
          try {
            sub_issue_stores.unregister('tab:board:blocked');
          } catch (err) {
            log('unregister board:blocked failed: %o', err);
          }
        }
      }
    }

    /**
     * Manage route visibility and list subscriptions per view.
     *
     * @param {{ selected_id: string | null, view: 'issues'|'epics'|'board', filters: any }} s
     */
    const onRouteChange = (s) => {
      if (issues_root && epics_root && board_root && detail_mount) {
        // Underlying route visibility is controlled only by selected view
        issues_root.hidden = s.view !== 'issues';
        epics_root.hidden = s.view !== 'epics';
        board_root.hidden = s.view !== 'board';
        // detail_mount visibility handled in subscription above
      }
      if (workspace_bootstrapped) {
        // Ensure subscriptions for the active tab before loading the view to
        // avoid empty initial renders due to racing list-delta.
        ensureTabSubscriptions(s);
        if (!s.selected_id && s.view === 'epics') {
          void epics_view.load();
        }
        if (!s.selected_id && s.view === 'board') {
          void board_view.load();
        }
        scheduleBoardMidnightRefresh(s.view);
      }
      if (s.view !== persisted_view_value) {
        window.localStorage.setItem('beads-ui.view', s.view);
        persisted_view_value = s.view;
      }
    };
    store.subscribe(onRouteChange);
    // Reflect the route synchronously while workspace discovery gates only
    // backend subscriptions and data loads.
    onRouteChange(store.getState());

    document.addEventListener('visibilitychange', () => {
      const current = store.getState();
      if (
        workspace_bootstrapped &&
        document.visibilityState === 'visible' &&
        current.view === 'board'
      ) {
        ensureTabSubscriptions(current);
        scheduleBoardMidnightRefresh('board');
      }
    });

    /**
     * Discover and restore the selected workspace before any list/detail
     * subscriptions are created.
     */
    async function initializeWorkspaceAndSubscriptions() {
      await loadWorkspaces(true);
      workspace_bootstrapped = true;
      const initial_state = store.getState();
      onRouteChange(initial_state);
      if (initial_state.selected_id) {
        openDetail(initial_state.selected_id);
      }
    }

    void initializeWorkspaceAndSubscriptions();

    // Removed redundant filter-change subscription: handled by ensureTabSubscriptions

    // Keyboard shortcuts: Ctrl/Cmd+N opens new issue; Ctrl/Cmd+Enter submits inside dialog
    window.addEventListener('keydown', (ev) => {
      const is_modifier = ev.ctrlKey || ev.metaKey;
      const key = String(ev.key || '').toLowerCase();
      const target = /** @type {HTMLElement} */ (ev.target);
      const tag =
        target && target.tagName ? String(target.tagName).toLowerCase() : '';
      const is_editable =
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        (target &&
          typeof target.isContentEditable === 'boolean' &&
          target.isContentEditable);
      if (is_modifier && key === 'n') {
        // Do not hijack when typing in inputs; common UX
        if (!is_editable) {
          ev.preventDefault();
          new_issue_dialog.open();
        }
      }
    });
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    // Initialize theme from saved preference or OS preference
    try {
      const saved = window.localStorage.getItem('beads-ui.theme');
      const prefersDark =
        window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches;
      const initial =
        saved === 'dark' || saved === 'light'
          ? saved
          : prefersDark
            ? 'dark'
            : 'light';
      document.documentElement.setAttribute('data-theme', initial);
      const sw = /** @type {HTMLInputElement|null} */ (
        document.getElementById('theme-switch')
      );
      if (sw) {
        sw.checked = initial === 'dark';
      }
    } catch {
      // ignore theme init errors
    }

    // Wire up theme switch in header
    const themeSwitch = /** @type {HTMLInputElement|null} */ (
      document.getElementById('theme-switch')
    );
    if (themeSwitch) {
      themeSwitch.addEventListener('change', () => {
        const mode = themeSwitch.checked ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', mode);
        window.localStorage.setItem('beads-ui.theme', mode);
      });
    }

    /** @type {HTMLElement|null} */
    const app_root = document.getElementById('app');
    if (app_root) {
      bootstrap(app_root);
    }
  });
}
