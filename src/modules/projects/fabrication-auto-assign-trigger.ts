import { logger } from '../../utils/logger.js';

/**
 * Realtime (2026-11-28): runs the fabrication auto-assign right after something may have freed a
 * fabricator (a team saved without them, a project leaving the workshop, a fabricator back to
 * Available), so a waiting paid project gets its lead and the "Auto-assigned as Lead" notice at
 * once instead of at the next minute sweep (still the safety net).
 * Loaded lazily because fabrication-auto-assign imports projects.service. Never throws. Call it
 * after any sales-day locks are released.
 */
export async function triggerFabricationAutoAssign(trigger: string): Promise<void> {
  try {
    const { autoAssignWaitingFabricationProjects } = await import('./fabrication-auto-assign.js');
    await autoAssignWaitingFabricationProjects(trigger);
  } catch (error) {
    logger.error(`Fabrication auto-assign (${trigger}) failed`, error);
  }
}
