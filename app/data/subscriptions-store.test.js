/**
 * @import { MessageType } from '../protocol.js'
 */
import { describe, expect, test, vi } from 'vitest';
import { createSubscriptionStore } from './subscriptions-store.js';

describe('client subscription store', () => {
  test('does not replay a subscription rejected by the server', async () => {
    const send = vi.fn(async () => {
      throw { code: 'bd_error', message: 'boom', details: { exit_code: 1 } };
    });
    const store = createSubscriptionStore(send);
    const spec = { type: 'all-issues' };

    await expect(store.subscribeList('err-1', spec)).rejects.toMatchObject({
      message: 'boom'
    });

    expect(send).toHaveBeenCalledTimes(1);
    await expect(store.resubscribeAll()).resolves.toEqual([]);
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
      params: { since: 100 },
      capabilities: ['subscription-delta-v1']
    });
  });

  test('advertises immutable delta capability on initial subscribe and replay', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const store = createSubscriptionStore(send);
    const spec = {
      type: 'closed-issues',
      params: { since: 100 },
      capabilities: ['caller-controlled']
    };

    await store.subscribeList('closed', spec);
    spec.capabilities.push('mutated');
    send.mockClear();
    await store.resubscribeAll();

    expect(send).toHaveBeenCalledWith('subscribe-list', {
      id: 'closed',
      type: 'closed-issues',
      params: { since: 100 },
      capabilities: ['subscription-delta-v1']
    });
  });

  test('resubscribes one active subscription from its saved spec', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const store = createSubscriptionStore(send);
    await store.subscribeList('ready', { type: 'ready-issues' });
    send.mockClear();

    const replayed = await store.resubscribeOne('ready');

    expect(replayed).toBe(true);
    expect(send).toHaveBeenCalledWith('subscribe-list', {
      id: 'ready',
      type: 'ready-issues',
      params: undefined,
      capabilities: ['subscription-delta-v1']
    });
    await expect(store.resubscribeOne('missing')).resolves.toBe(false);
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

    const pending_unsubscribe = unsubscribe();

    await expect(store.resubscribeOne('active')).resolves.toBe(false);
    resolve_unsubscribe();
    await pending_unsubscribe;
  });
});
