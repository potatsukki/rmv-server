import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ projectItemFind: vi.fn() }));

vi.mock('../../models/index.js', () => ({ ProjectItem: { find: mocks.projectItemFind } }));

import {
  isProjectListingStage,
  matchesListingStage,
  resolveProjectStage,
  resolveProjectStages,
} from './project-stage.js';

describe('resolveProjectStage (mirrors the web workflow stage)', () => {
  it.each([
    ['cancelled', [], 'cancelled'],
    ['draft', [], 'pending_ocular'],
    ['submitted', [], 'review'],
    ['ready_for_ocular', [], 'review'],
    ['blueprint', ['blueprint'], 'design'],
    ['approved', [], 'billing'],
    ['payment_pending', [], 'billing'],
    ['fabrication', [], 'fabrication'],
    ['completed', [], 'completed'],
  ])('lists a %s project under %s', (status, items, expected) => {
    expect(resolveProjectStage(status, items)).toBe(expected);
  });

  it('follows item statuses the same way the badge does', () => {
    expect(resolveProjectStage('blueprint', ['payment_pending', 'blueprint'])).toBe('billing');
    expect(resolveProjectStage('payment_pending', ['fabrication', 'payment_pending'])).toBe('fabrication');
    expect(resolveProjectStage('fabrication', ['completed', 'completed'])).toBe('completed');
    // A draft or cancelled project keeps its stage whatever its items say.
    expect(resolveProjectStage('draft', ['completed'])).toBe('pending_ocular');
    expect(resolveProjectStage('cancelled', ['fabrication'])).toBe('cancelled');
  });
});

describe('matchesListingStage', () => {
  it('treats active as anything not completed or cancelled', () => {
    expect(matchesListingStage('pending_ocular', 'active')).toBe(true);
    expect(matchesListingStage('billing', 'active')).toBe(true);
    expect(matchesListingStage('completed', 'active')).toBe(false);
    expect(matchesListingStage('cancelled', 'active')).toBe(false);
    expect(matchesListingStage('design', 'design')).toBe(true);
    expect(matchesListingStage('design', 'billing')).toBe(false);
  });

  it('accepts only known stages', () => {
    expect(isProjectListingStage('review')).toBe(true);
    expect(isProjectListingStage('draft')).toBe(false);
    expect(isProjectListingStage(undefined)).toBe(false);
  });
});

describe('resolveProjectStages', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads every item status in one query', async () => {
    mocks.projectItemFind.mockReturnValue({
      select: () => ({
        lean: () => ({
          exec: vi.fn().mockResolvedValue([
            { projectId: 'p1', status: 'completed' },
            { projectId: 'p1', status: 'completed' },
            { projectId: 'p2', status: 'payment_pending' },
          ]),
        }),
      }),
    });

    const stages = await resolveProjectStages([
      { _id: 'p1', status: 'fabrication' },
      { _id: 'p2', status: 'blueprint' },
      { _id: 'p3', status: 'submitted' },
    ]);

    expect(Object.fromEntries(stages)).toEqual({ p1: 'completed', p2: 'billing', p3: 'review' });
    expect(mocks.projectItemFind).toHaveBeenCalledTimes(1);
    expect(mocks.projectItemFind).toHaveBeenCalledWith({ projectId: { $in: ['p1', 'p2', 'p3'] } });
  });

  it('skips the query when there are no projects', async () => {
    expect((await resolveProjectStages([])).size).toBe(0);
    expect(mocks.projectItemFind).not.toHaveBeenCalled();
  });
});
