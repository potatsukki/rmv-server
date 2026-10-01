import { ProjectCounter } from '../models/Config.js';

export function formatProjectNumber(year: number, sequence: number): string {
  const seqStr = String(sequence).padStart(5, '0');
  return `PRJ-${year}-${seqStr}`;
}

/**
 * Generates an immutable project number in the format PRJ-YYYY-#####
 * where ##### is a zero-padded counter that resets each year.
 */
export async function generateProjectNumber(): Promise<string> {
  const currentYear = new Date().getFullYear();
  
  // Use findOneAndUpdate with upsert for atomic increment
  const counter = await ProjectCounter.findOneAndUpdate(
    { year: currentYear },
    { $inc: { lastSeq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return formatProjectNumber(currentYear, counter.lastSeq);
}
