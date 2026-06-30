import { priority_levels } from './priority.js';

/**
 * Create a colored badge for a priority value (0..4).
 *
 * @param {number | null | undefined} priority
 * @returns {HTMLSpanElement}
 */
export function createPriorityBadge(priority) {
  const p = typeof priority === 'number' ? priority : 2;
  const el = document.createElement('span');
  el.className = 'priority-badge';
  el.classList.add(`is-p${Math.max(0, Math.min(4, p))}`);
  el.setAttribute('role', 'img');
  const label = labelForPriority(p);
  el.setAttribute('title', label);
  el.setAttribute('aria-label', `Priority: ${label}`);
  el.textContent = priorityPrefix(p) + ' ' + label;
  return el;
}

/**
 * @param {number} p
 */
function labelForPriority(p) {
  const i = Math.max(0, Math.min(4, p));
  return priority_levels[i] || 'Medium';
}

/**
 * @param {number} p
 */
export function emojiForPriority(p) {
  return priorityPrefix(p);
}

/**
 * @param {number} p
 */
function priorityPrefix(p) {
  switch (p) {
    case 0:
      return 'P0';
    case 1:
      return 'P1';
    case 2:
      return 'P2';
    case 3:
      return 'P3';
    case 4:
      return 'P4';
    default:
      return 'P2';
  }
}
