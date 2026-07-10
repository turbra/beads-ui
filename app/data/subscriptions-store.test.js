/**
 * @import { MessageType } from '../protocol.js'
 */
import { describe, expect, test, vi } from 'vitest';
import { createSubscriptionStore } from './subscriptions-store.js';

describe('client subscription store', () => {
  test('applies delta sequences to itemsById', async () => {
    /** @type {(type: any, payload?: any) => Promise<any>} */
    const send = async () => ({ ok: true });
    const store = createSubscriptionStore(send);

    const spec = { type: 'all-issues' };
    const key = store._subKeyOf(spec);
    const unsub = await store.subscribeList('s1', spec);

    // Initial add
    store._applyDelta(key, {
      added: ['UI-1', 'UI-2'],
      updated: [],
      removed: []
    });
    expect(store.selectors.count('s1')).toBe(2);
    expect(store.selectors.has('s1', 'UI-1')).toBe(true);
    expect(store.selectors.has('s1', 'UI-2')).toBe(true);

    // Update should be idempotent presence toggle (exists)
    store._applyDelta(key, { added: [], updated: ['UI-2'], removed: [] });
    expect(store.selectors.count('s1')).toBe(2);

    // Add one, remove one
    store._applyDelta(key, { added: ['UI-3'], updated: [], removed: ['UI-1'] });
    const ids = store.selectors.getIds('s1').sort();
    expect(ids).toEqual(['UI-2', 'UI-3']);

    await unsub();
  });

  test('fans out deltas to multiple subscribers of same key', async () => {
    const send = async () => ({ ok: true });
    const store = createSubscriptionStore(send);
    const spec = { type: 'in-progress-issues' };
    const key = store._subKeyOf(spec);

    const unsub1 = await store.subscribeList('s1', spec);
    const unsub2 = await store.subscribeList('s2', spec);

    store._applyDelta(key, { added: ['UI-10'], updated: [], removed: [] });
    expect(store.selectors.has('s1', 'UI-10')).toBe(true);
    expect(store.selectors.has('s2', 'UI-10')).toBe(true);

    await unsub2();
    store._applyDelta(key, { added: [], updated: [], removed: ['UI-10'] });
    expect(store.selectors.has('s1', 'UI-10')).toBe(false);
    // s2 unsubscribed; its local store is gone
    expect(store.selectors.count('s2')).toBe(0);

    await unsub1();
  });

  test('unsubscribe clears local store and mapping', async () => {
    const send = async () => ({ ok: true });
    const store = createSubscriptionStore(send);
    const spec = { type: 'blocked-issues' };
    const key = store._subKeyOf(spec);

    const unsub = await store.subscribeList('sZ', spec);
    store._applyDelta(key, { added: ['UI-7'], updated: [], removed: [] });
    expect(store.selectors.count('sZ')).toBe(1);

    await unsub();
    expect(store.selectors.count('sZ')).toBe(0);
    expect(store.selectors.getIds('sZ')).toEqual([]);
  });

  test('subscribeList rejects and cleans up on transport error', async () => {
    const send = vi.fn(async () => {
      throw { code: 'bd_error', message: 'boom', details: { exit_code: 1 } };
    });
    const store = createSubscriptionStore(send);
    const spec = { type: 'all-issues' };

    await expect(store.subscribeList('err-1', spec)).rejects.toMatchObject({
      message: 'boom'
    });

    expect(store.selectors.count('err-1')).toBe(0);
    expect(store.selectors.getIds('err-1')).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('retains a disconnected initial subscription for replay', async () => {
    let disconnected = true;
    const send = vi.fn(async () => {
      if (disconnected) {
        throw Object.assign(new Error('ws disconnected'), {
          code: 'ws_disconnected'
        });
      }
      return { ok: true };
    });
    const store = createSubscriptionStore(send);

    const unsubscribe = await store.subscribeList('replay-me', {
      type: 'all-issues'
    });
    disconnected = false;
    const replayed = await store.resubscribeAll();

    expect(replayed).toEqual(['replay-me']);
    expect(send).toHaveBeenCalledTimes(2);
    await unsubscribe();
  });

  test('can cancel a disconnected initial subscription before replay', async () => {
    const send = vi.fn(async (type) => {
      if (type === 'subscribe-list') {
        throw Object.assign(new Error('ws disconnected'), {
          code: 'ws_disconnected'
        });
      }
      return { ok: true };
    });
    const store = createSubscriptionStore(send);
    const unsubscribe = await store.subscribeList('cancel-me', {
      type: 'ready-issues'
    });

    await unsubscribe();
    send.mockClear();
    const replayed = await store.resubscribeAll();

    expect(replayed).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  test('replays immutable subscription specs', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const store = createSubscriptionStore(send);
    const spec = { type: 'closed-issues', params: { since: 100 } };
    await store.subscribeList('closed', spec);
    spec.params.since = 200;
    send.mockClear();

    const ids = await store.resubscribeAll();

    expect(ids).toEqual(['closed']);
    expect(send).toHaveBeenCalledWith('subscribe-list', {
      id: 'closed',
      type: 'closed-issues',
      params: { since: 100 }
    });
  });

  test('attempts every replay and retains failed subscriptions', async () => {
    let fail_blocked = false;
    const send = vi.fn(async (type, payload) => {
      if (
        fail_blocked &&
        type === 'subscribe-list' &&
        payload.id === 'blocked'
      ) {
        throw new Error('offline');
      }
      return { ok: true };
    });
    const store = createSubscriptionStore(send);
    await store.subscribeList('ready', { type: 'ready-issues' });
    await store.subscribeList('blocked', { type: 'blocked-issues' });
    send.mockClear();
    fail_blocked = true;

    await expect(store.resubscribeAll()).rejects.toThrow(
      'Failed to resubscribe: blocked'
    );
    expect(send).toHaveBeenCalledTimes(2);
    fail_blocked = false;
    send.mockClear();

    await expect(store.resubscribeAll()).resolves.toEqual(['ready', 'blocked']);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('ignores stale unsubscribe closures after id replacement', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const store = createSubscriptionStore(send);
    const stale_unsubscribe = await store.subscribeList('same', {
      type: 'all-issues'
    });
    const active_unsubscribe = await store.subscribeList('same', {
      type: 'ready-issues'
    });
    send.mockClear();

    await stale_unsubscribe();

    expect(send).not.toHaveBeenCalled();
    await active_unsubscribe();
    expect(send).toHaveBeenCalledWith('unsubscribe-list', { id: 'same' });
  });

  test('removes active subscriptions before remote unsubscribe resolves', async () => {
    /** @type {() => void} */
    let resolve_unsubscribe = () => {};
    const unsubscribe_gate = new Promise((resolve) => {
      resolve_unsubscribe = () => resolve({ ok: true });
    });
    const send = vi.fn((type) => {
      if (type === 'unsubscribe-list') {
        return unsubscribe_gate;
      }
      return Promise.resolve({ ok: true });
    });
    const store = createSubscriptionStore(send);
    const spec = { type: 'all-issues' };
    const unsubscribe = await store.subscribeList('active', spec);
    const key = store._subKeyOf(spec);
    store._applyDelta(key, {
      added: ['UI-1'],
      updated: [],
      removed: []
    });

    const pending_unsubscribe = unsubscribe();

    expect(store.selectors.count('active')).toBe(0);
    resolve_unsubscribe();
    await pending_unsubscribe;
  });
});
