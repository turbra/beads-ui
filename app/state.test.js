import { describe, expect, test } from 'vitest';
import {
  createStore,
  normalizeStatusFilters,
  normalizeTypeFilters
} from './state.js';

describe('state store', () => {
  test('get/set/subscribe works and dedupes unchanged', () => {
    const store = createStore();
    const seen = [];
    const off = store.subscribe((s) => seen.push(s));

    store.setState({ selected_id: 'UI-1' });
    store.setState({ filters: { status: ['open'] } });
    // no-op (unchanged)
    store.setState({ filters: { status: ['open'] } });
    off();

    expect(seen.length).toBe(2);
    const state = store.getState();
    expect(state.selected_id).toBe('UI-1');
    expect(state.filters.status).toEqual(['open']);
  });

  test('normalizes legacy scalar filters', () => {
    const store = createStore({
      filters: /** @type {any} */ ({ status: 'closed', type: 'bug' })
    });

    const filters = store.getState().filters;

    expect(filters).toEqual({
      status: ['closed'],
      search: '',
      type: ['bug']
    });
  });

  test('keeps Ready mutually exclusive', () => {
    const statuses = normalizeStatusFilters(['open', 'ready', 'closed']);

    expect(statuses).toEqual(['ready']);
  });

  test('orders and deduplicates concrete filters', () => {
    const statuses = normalizeStatusFilters([
      'closed',
      'open',
      'closed',
      'invalid'
    ]);
    const types = normalizeTypeFilters(['chore', 'bug', 'chore', 'invalid']);

    expect(statuses).toEqual(['open', 'closed']);
    expect(types).toEqual(['bug', 'chore']);
  });
});
