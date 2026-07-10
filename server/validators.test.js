import { describe, expect, test } from 'vitest';
import { validateSubscribeListPayload } from './validators.js';

describe('validateSubscribeListPayload status-issues', () => {
  test('canonicalizes and deduplicates ordinary statuses', () => {
    const result = validateSubscribeListPayload({
      id: 'issues',
      type: 'status-issues',
      params: { statuses: 'closed,open,closed,in_progress' }
    });

    expect(result).toEqual({
      ok: true,
      id: 'issues',
      capabilities: [],
      spec: {
        type: 'status-issues',
        params: { statuses: 'open,in_progress,closed' }
      }
    });
  });

  test('rejects an empty status selection', () => {
    const result = validateSubscribeListPayload({
      id: 'issues',
      type: 'status-issues',
      params: { statuses: '' }
    });

    expect(result.ok).toBe(false);
  });

  test('rejects unsupported statuses', () => {
    const result = validateSubscribeListPayload({
      id: 'issues',
      type: 'status-issues',
      params: { statuses: 'ready,open' }
    });

    expect(result.ok).toBe(false);
  });
});

describe('validateSubscribeListPayload capability boundary', () => {
  test('selects known capabilities and ignores valid unknown values', () => {
    const result = validateSubscribeListPayload({
      id: 'issues',
      type: 'all-issues',
      capabilities: [
        'subscription-delta-v1',
        'future-capability',
        'subscription-delta-v1'
      ]
    });

    expect(result).toMatchObject({
      ok: true,
      capabilities: ['subscription-delta-v1']
    });
  });

  test('rejects malformed capabilities', () => {
    const result = validateSubscribeListPayload({
      id: 'issues',
      type: 'all-issues',
      capabilities: ['UPPERCASE']
    });

    expect(result.ok).toBe(false);
  });

  test('rejects more than eight capabilities', () => {
    const result = validateSubscribeListPayload({
      id: 'issues',
      type: 'all-issues',
      capabilities: Array.from({ length: 9 }, (_, index) => `cap-${index}`)
    });

    expect(result.ok).toBe(false);
  });

  test('rejects subscription ids larger than 128 UTF-8 bytes', () => {
    const result = validateSubscribeListPayload({
      id: 'é'.repeat(65),
      type: 'all-issues'
    });

    expect(result.ok).toBe(false);
  });

  test('rejects subscription ids containing control characters', () => {
    const result = validateSubscribeListPayload({
      id: 'issues\nother',
      type: 'all-issues'
    });

    expect(result.ok).toBe(false);
  });
});

describe('validateSubscribeListPayload param allowlists', () => {
  test('accepts the Issues-specific Ready type without params', () => {
    const result = validateSubscribeListPayload({
      id: 'issues',
      type: 'issues-ready'
    });

    expect(result).toEqual({
      ok: true,
      id: 'issues',
      capabilities: [],
      spec: { type: 'issues-ready', params: undefined }
    });
  });

  test('rejects client-controlled Issues Ready params', () => {
    const result = validateSubscribeListPayload({
      id: 'issues',
      type: 'issues-ready',
      params: { limit: 5000 }
    });

    expect(result.ok).toBe(false);
  });

  test('rejects extra issue-detail params', () => {
    const result = validateSubscribeListPayload({
      id: 'detail',
      type: 'issue-detail',
      params: { id: 'UI-1', limit: 1000 }
    });

    expect(result.ok).toBe(false);
  });

  test('requires an issue-detail id string', () => {
    const result = validateSubscribeListPayload({
      id: 'detail',
      type: 'issue-detail',
      params: { id: 123 }
    });

    expect(result.ok).toBe(false);
  });

  test('rejects extra closed-issues params', () => {
    const result = validateSubscribeListPayload({
      id: 'closed',
      type: 'closed-issues',
      params: { limit: 1000 }
    });

    expect(result.ok).toBe(false);
  });
});
