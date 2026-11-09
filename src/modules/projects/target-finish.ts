import type { Types } from 'mongoose';
import { Blueprint } from '../../models/Blueprint.js';
import { logger } from '../../utils/logger.js';

const MANILA_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Manila',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The date `days` working days after `start`, counting Monday to Saturday on the Manila
 * calendar (Sundays are skipped; day 1 is the next working day). Returned at 5:00 PM Manila.
 */
export function addWorkingDays(start: Date, days: number): Date {
  const [year, month, day] = MANILA_DATE.format(start).split('-').map(Number) as [number, number, number];
  const cursor = new Date(Date.UTC(year, month - 1, day));
  let counted = 0;
  while (counted < days) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (cursor.getUTCDay() !== 0) counted += 1;
  }
  // 09:00 UTC is 5:00 PM in Manila, so the date reads the same in the Philippines.
  return new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 9));
}

/**
 * The work duration of a project: the engineer's working days on each item's latest
 * blueprint. Items are fabricated together, so the longest one sets the duration.
 */
export async function getProjectWorkingDays(projectId: Types.ObjectId | string): Promise<number | null> {
  const blueprints = await Blueprint.find({ projectId })
    .select('projectItemId version quotation.workingDays')
    .sort({ version: -1 })
    .lean();

  const latestByItem = new Map<string, number | undefined>();
  for (const blueprint of blueprints) {
    const itemKey = String(blueprint.projectItemId ?? 'project');
    if (!latestByItem.has(itemKey)) latestByItem.set(itemKey, blueprint.quotation?.workingDays);
  }

  const days = [...latestByItem.values()].filter((value): value is number => Number(value) > 0);
  return days.length > 0 ? Math.max(...days) : null;
}

/**
 * Sets the target finish date when fabrication starts, from the quoted working days.
 * Keeps a date that is already set, and never blocks fabrication if the lookup fails.
 */
export async function applyTargetFinishDate(
  project: { _id: Types.ObjectId | string; estimatedCompletionDate?: Date | null },
  now = new Date(),
) {
  if (project.estimatedCompletionDate) return;
  try {
    const workingDays = await getProjectWorkingDays(project._id);
    if (workingDays) project.estimatedCompletionDate = addWorkingDays(now, workingDays);
  } catch (error) {
    logger.error('Could not set the project target finish date', error);
  }
}
