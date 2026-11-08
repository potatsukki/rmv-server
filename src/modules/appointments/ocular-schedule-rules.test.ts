import { describe, expect, it } from 'vitest';
import { assertOcularAfterConsultation } from './ocular-schedule-rules.js';

// Nov 8, 2026, 10:00 AM in Manila.
const NOV_8 = new Date('2026-11-08T02:00:00Z');

describe('assertOcularAfterConsultation', () => {
  it('counts from today when the consultation was finished before its scheduled date', () => {
    // Scheduled Nov 17 but held (report submitted) on Nov 8, so the ocular opens on Nov 11.
    expect(() => assertOcularAfterConsultation('2026-11-11', '2026-11-17', NOV_8)).not.toThrow();
    expect(() => assertOcularAfterConsultation('2026-11-12', '2026-11-17', NOV_8)).not.toThrow();
    expect(() => assertOcularAfterConsultation('2026-11-10', '2026-11-17', NOV_8))
      .toThrow('at least 3 days after the consultation (2026-11-08). Choose 2026-11-11 or later.');
  });

  it('counts from a past consultation date', () => {
    expect(() => assertOcularAfterConsultation('2026-11-04', '2026-11-01', NOV_8)).not.toThrow();
    expect(() => assertOcularAfterConsultation('2026-11-03', '2026-11-01', NOV_8)).toThrow('Choose 2026-11-04 or later.');
  });

  it('handles month ends', () => {
    const dec1 = new Date('2026-12-01T02:00:00Z');
    expect(() => assertOcularAfterConsultation('2026-12-03', '2026-11-30', dec1)).not.toThrow();
    expect(() => assertOcularAfterConsultation('2026-12-02', '2026-11-30', dec1)).toThrow('Choose 2026-12-03 or later.');
  });

  it('uses the Manila date, not UTC, for today', () => {
    // 11:30 PM UTC on Nov 7 is already Nov 8 in Manila.
    const lateUtc = new Date('2026-11-07T23:30:00Z');
    expect(() => assertOcularAfterConsultation('2026-11-10', '2026-11-17', lateUtc)).toThrow('Choose 2026-11-11 or later.');
  });

  it('skips the check when there is no consultation', () => {
    expect(() => assertOcularAfterConsultation('2026-11-09', undefined, NOV_8)).not.toThrow();
    expect(() => assertOcularAfterConsultation('2026-11-09', null, NOV_8)).not.toThrow();
  });
});
