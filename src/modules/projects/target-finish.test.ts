import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ blueprintFind: vi.fn(), loggerError: vi.fn() }));

vi.mock('../../models/Blueprint.js', () => ({ Blueprint: { find: mocks.blueprintFind } }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), error: mocks.loggerError } }));

import { addWorkingDays, applyTargetFinishDate, getProjectWorkingDays } from './target-finish.js';

function blueprints(value: object[]) {
  mocks.blueprintFind.mockReturnValue({
    select: () => ({ sort: () => ({ lean: vi.fn().mockResolvedValue(value) }) }),
  });
}

// Manila date (YYYY-MM-DD) of a stored target date.
const manilaDate = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(date);

describe('addWorkingDays', () => {
  it('counts Monday to Saturday and skips Sundays', () => {
    // Thursday, Nov 12, 2026 (Manila) + 3 working days → Fri 13, Sat 14, (Sun skipped) Mon 16
    expect(manilaDate(addWorkingDays(new Date('2026-11-12T02:00:00Z'), 3))).toBe('2026-11-16');
    // Saturday + 1 → Monday
    expect(manilaDate(addWorkingDays(new Date('2026-11-14T02:00:00Z'), 1))).toBe('2026-11-16');
    // 10 working days from Monday Nov 9 → Friday Nov 20
    expect(manilaDate(addWorkingDays(new Date('2026-11-09T01:00:00Z'), 10))).toBe('2026-11-20');
  });

  it('uses the Manila calendar day, not UTC', () => {
    // 11:30 PM UTC on Nov 11 is already Thursday Nov 12 in Manila.
    expect(manilaDate(addWorkingDays(new Date('2026-11-11T23:30:00Z'), 1))).toBe('2026-11-13');
  });
});

describe('getProjectWorkingDays', () => {
  beforeEach(() => vi.clearAllMocks());

  it('takes the latest blueprint of each item and the longest item', async () => {
    blueprints([
      { projectItemId: 'item-1', version: 3, quotation: { workingDays: 8 } },
      { projectItemId: 'item-2', version: 2, quotation: { workingDays: 12 } },
      { projectItemId: 'item-1', version: 2, quotation: { workingDays: 20 } },
    ]);

    expect(await getProjectWorkingDays('project-1')).toBe(12);
  });

  it('returns null when no blueprint has working days', async () => {
    blueprints([{ projectItemId: 'item-1', version: 1, quotation: { estimatedDuration: '2-3 Weeks' } }]);
    expect(await getProjectWorkingDays('project-1')).toBeNull();
  });
});

describe('applyTargetFinishDate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets the target finish date from the quoted working days', async () => {
    blueprints([{ projectItemId: 'item-1', version: 1, quotation: { workingDays: 3 } }]);
    const project: { _id: string; estimatedCompletionDate?: Date } = { _id: 'project-1' };

    await applyTargetFinishDate(project, new Date('2026-11-12T02:00:00Z'));

    expect(manilaDate(project.estimatedCompletionDate!)).toBe('2026-11-16');
  });

  it('keeps a date that is already set', async () => {
    const existing = new Date('2026-12-01T09:00:00Z');
    const project = { _id: 'project-1', estimatedCompletionDate: existing };

    await applyTargetFinishDate(project);

    expect(project.estimatedCompletionDate).toBe(existing);
    expect(mocks.blueprintFind).not.toHaveBeenCalled();
  });

  it('leaves the date empty without working days and never throws', async () => {
    blueprints([]);
    const project: { _id: string; estimatedCompletionDate?: Date } = { _id: 'project-1' };
    await applyTargetFinishDate(project);
    expect(project.estimatedCompletionDate).toBeUndefined();

    mocks.blueprintFind.mockImplementation(() => { throw new Error('db down'); });
    await expect(applyTargetFinishDate(project)).resolves.toBeUndefined();
    expect(mocks.loggerError).toHaveBeenCalled();
  });
});
