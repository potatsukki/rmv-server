import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

import { msUntilNextMinute, scheduleEveryMinute } from './minuteSchedule.js';

// 9:15 AM Manila on Nov 25, 2026 (UTC+8).
const at = (time: string) => new Date(`2026-11-25T${time}+08:00`).getTime();

describe('msUntilNextMinute', () => {
  it.each([
    ['09:15:00.000', 2_000],
    ['09:15:01.000', 1_000],
    ['09:15:02.000', 60_000],
    ['09:15:03.000', 59_000],
    ['09:14:59.500', 2_500],
  ])('from %s waits %i ms (runs at 2 s past the minute)', (time, expected) => {
    expect(msUntilNextMinute(at(time))).toBe(expected);
  });
});

describe('scheduleEveryMinute', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs at 9:15:02 and every minute after, never overlapping a run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at('09:14:30.000'));
    const runs: string[] = [];
    const stop = scheduleEveryMinute(() => {
      runs.push(new Date(Date.now()).toISOString());
    });

    await vi.advanceTimersByTimeAsync(31_999);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual(['2026-11-25T01:15:02.000Z']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toEqual(['2026-11-25T01:15:02.000Z', '2026-11-25T01:16:02.000Z']);

    stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(runs).toHaveLength(2);
  });

  it('keeps running after a failed run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at('09:15:00.000'));
    const failure = new Error('database busy');
    const job = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const onError = vi.fn();
    const stop = scheduleEveryMinute(job, 2_000, onError);

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(job).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(failure);
    stop();
  });
});
