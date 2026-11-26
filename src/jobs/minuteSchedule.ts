import { logger } from '../utils/logger.js';

/**
 * Every-minute jobs that follow the clock: they run `offsetMs` after each whole minute instead of
 * "60 s after the server started". The automatic No Show for a 9:00 AM consultation therefore runs
 * at 9:15:02, not anywhere up to 9:16.
 */
export const MINUTE_MS = 60_000;

/** Milliseconds until `offsetMs` past the next whole minute (9:15:02 when it is 9:15:01). */
export function msUntilNextMinute(now = Date.now(), offsetMs = 2_000): number {
  const wait = MINUTE_MS - (now % MINUTE_MS) + offsetMs;
  return wait > MINUTE_MS ? wait - MINUTE_MS : wait;
}

/**
 * Runs `job` at `offsetMs` past every minute. A run that takes longer than a minute is never
 * overlapped: the next one is planned after it ends, also after a failed run. Returns a function
 * that stops the schedule.
 */
export function scheduleEveryMinute(
  job: () => Promise<void> | void,
  offsetMs = 2_000,
  onError: (error: unknown) => void = (error) => logger.error('Every-minute job failed:', error),
): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const planNext = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await job();
      } catch (error) {
        onError(error);
      } finally {
        planNext();
      }
    }, msUntilNextMinute(Date.now(), offsetMs));
  };

  planNext();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
