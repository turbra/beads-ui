const STATUS_VALUES = Object.freeze(['open', 'in_progress', 'closed']);
const ISSUE_TYPES = Object.freeze(['bug', 'feature', 'task', 'epic', 'chore']);
const ASSIGNEES = Object.freeze([
  '',
  'agent',
  'alex',
  'casey',
  'jordan',
  'morgan'
]);
const LABELS = Object.freeze([
  'backend',
  'frontend',
  'performance',
  'reliability',
  'ux',
  'validation'
]);

/**
 * Return a deterministic pseudo-random generator for representative variation.
 *
 * @param {number} seed
 */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * Select one deterministic array entry.
 *
 * @template T
 * @param {readonly T[]} values
 * @param {() => number} random
 */
function choose(values, random) {
  return values[Math.floor(random() * values.length)];
}

/**
 * Build a realistic bounded text field without depending on external fixtures.
 *
 * @param {string} prefix
 * @param {number} index
 * @param {number} repetitions
 */
function issueText(prefix, index, repetitions) {
  const sentence = `${prefix} for generated issue ${index}. `;
  return sentence.repeat(repetitions).trim();
}

/**
 * Generate full-shape deterministic issue objects for large-list validation.
 * The objects intentionally include fields used by list and detail consumers,
 * while keeping individual payloads bounded and portable.
 *
 * @param {number} count
 * @param {{ seed?: number }} [options]
 */
export function createLargeIssueDataset(count, options = {}) {
  if (!Number.isInteger(count) || count < 0) {
    throw new TypeError('count must be a non-negative integer');
  }
  const seed = Number.isInteger(options.seed)
    ? Number(options.seed)
    : 0x5eed1234;
  const random = createRandom(seed);
  const base_time = Date.UTC(2025, 0, 1);
  return Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    const id = `BENCH-${String(index).padStart(5, '0')}`;
    const status = choose(STATUS_VALUES, random);
    const issue_type = choose(ISSUE_TYPES, random);
    const assignee = choose(ASSIGNEES, random);
    const created_at = base_time + index * 60000;
    const updated_at = created_at + Math.floor(random() * 86400000);
    const dependency_count = index % 4;
    const dependent_count = (index * 3) % 5;
    const label_a = choose(LABELS, random);
    const label_b = choose(LABELS, random);
    const labels = label_a === label_b ? [label_a] : [label_a, label_b];
    const dependencies = Array.from(
      { length: Math.min(dependency_count, 2) },
      (_, dependency_offset) => {
        const dependency_id = `BENCH-${String(
          Math.max(1, index - dependency_offset - 1)
        ).padStart(5, '0')}`;
        return {
          id: dependency_id,
          title: `Generated dependency ${dependency_id}`,
          status: 'open',
          priority: dependency_offset % 5,
          issue_type: 'task',
          created_at: created_at - (dependency_offset + 1) * 60000,
          updated_at: updated_at - (dependency_offset + 1) * 1000,
          closed_at: null
        };
      }
    );
    return {
      id,
      title: `Generated ${issue_type} ${index}: deterministic scale coverage`,
      description: issueText('Description', index, 5),
      design: issueText('Design notes', index, 3),
      acceptance_criteria: issueText('Acceptance criteria', index, 3),
      notes: issueText('Implementation notes', index, 2),
      status,
      priority: index % 5,
      issue_type,
      assignee,
      owner: `owner-${index % 8}@example.test`,
      created_by: 'benchmark-harness',
      created_at,
      updated_at,
      closed_at: status === 'closed' ? updated_at + 60000 : null,
      labels,
      metadata: {
        lane: `lane-${index % 12}`,
        source: 'generated-large-list-harness'
      },
      dependencies,
      dependency_count,
      dependent_count,
      comment_count: index % 7,
      parent:
        index % 11 === 0 ? `BENCH-${String(index - 1).padStart(5, '0')}` : null
    };
  });
}

/**
 * Return a deterministic 100-change delta derived from a dataset.
 *
 * @param {Array<Record<string, any>>} issues
 * @param {number} [count]
 */
export function createLargeIssueDelta(issues, count = 100) {
  if (!Array.isArray(issues)) {
    throw new TypeError('issues must be an array');
  }
  if (!Number.isInteger(count) || count < 0 || count > issues.length) {
    throw new RangeError('count must be within the dataset bounds');
  }
  return issues.slice(0, count).map((issue, index) => ({
    ...issue,
    title: `${issue.title} updated`,
    updated_at: Number(issue.updated_at) + index + 1
  }));
}
