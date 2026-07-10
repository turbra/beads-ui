import { describe, expect, test } from 'vitest';
import { createPriorityBadge, emojiForPriority } from './priority-badge.js';

describe('priority badges', () => {
  test('maps priorities to emoji and P-number prefixes', () => {
    const prefixes = Array.from({ length: 5 }, (_, priority) =>
      emojiForPriority(priority)
    );

    expect(prefixes).toEqual(['🔥 P0', '⚡️ P1', '🔧 P2', '🪶 P3', '💤 P4']);
  });

  test('renders the complete accessible priority badge label', () => {
    const badge = createPriorityBadge(0);

    expect(badge.textContent).toBe('🔥 P0 Critical');
    expect(badge.classList.contains('is-p0')).toBe(true);
    expect(badge.getAttribute('aria-label')).toBe('Priority: Critical');
  });
});
