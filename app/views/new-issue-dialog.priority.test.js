import { describe, expect, test, vi } from 'vitest';
import { createNewIssueDialog } from './new-issue-dialog.js';

describe('new issue priority options', () => {
  test('uses the shared emoji and P-number labels', () => {
    const mount = document.createElement('main');
    createNewIssueDialog(
      mount,
      vi.fn(async () => null),
      { gotoIssue: vi.fn() }
    );

    const labels = Array.from(
      mount.querySelectorAll('#new-priority option'),
      (option) => option.textContent
    );

    expect(labels).toEqual([
      '🔥 P0 Critical',
      '⚡️ P1 High',
      '🔧 P2 Medium',
      '🪶 P3 Low',
      '💤 P4 Backlog'
    ]);
  });
});
