import { render } from 'lit-html';
import { describe, expect, test, vi } from 'vitest';
import { createIssueRowRenderer } from './issue-row.js';

/**
 * @param {{ dependency_count?: number, dependent_count?: number }} counts
 */
function renderRow(counts) {
  const mount = document.createElement('table');
  const render_row = createIssueRowRenderer({
    navigate: vi.fn(),
    onUpdate: vi.fn(async () => ({})),
    requestRender: vi.fn()
  });

  render(render_row({ id: 'UI-1', title: 'Counts', ...counts }), mount);

  return mount;
}

describe('issue row dependency counts', () => {
  test('renders dependency-only count with an accessible label', () => {
    const mount = renderRow({ dependency_count: 2, dependent_count: 0 });

    const count = mount.querySelector('.dep-count');

    expect(count?.textContent).toBe('→2');
    expect(count?.getAttribute('aria-label')).toBe('2 dependencies');
    expect(mount.querySelector('.dependent-count')).toBeNull();
  });

  test('renders dependent-only count with an accessible label', () => {
    const mount = renderRow({ dependency_count: 0, dependent_count: 1 });

    const count = mount.querySelector('.dependent-count');

    expect(count?.textContent).toBe('←1');
    expect(count?.getAttribute('aria-label')).toBe('1 dependent');
    expect(mount.querySelector('.dep-count')).toBeNull();
  });

  test('renders both dependency directions', () => {
    const mount = renderRow({ dependency_count: 1, dependent_count: 3 });

    const dependency_count = mount.querySelector('.dep-count');
    const dependent_count = mount.querySelector('.dependent-count');

    expect(dependency_count?.getAttribute('aria-label')).toBe('1 dependency');
    expect(dependent_count?.getAttribute('aria-label')).toBe('3 dependents');
  });

  test('leaves the count cell empty when both counts are zero', () => {
    const mount = renderRow({ dependency_count: 0, dependent_count: 0 });

    const count_indicator = mount.querySelector('.deps-indicator');

    expect(count_indicator).toBeNull();
  });
});
