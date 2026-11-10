import { describe, expect, it } from 'vitest';
import { assertOcularAfterConsultation, earliestOcularDate } from './ocular-schedule-rules.js';

describe('assertOcularAfterConsultation', () => {
  it('counts from the booked consultation date, even when it was completed early', () => {
    // PRJ-2026-00094: consultation booked Nov 13 (completed early on Nov 10); ocular on Nov 13 must fail.
    expect(() => assertOcularAfterConsultation('2026-11-13', '2026-11-13'))
      .toThrow('at least 3 days after the consultation on Nov 13, 2026. Choose Nov 16, 2026 or later.');
    expect(() => assertOcularAfterConsultation('2026-11-15', '2026-11-13')).toThrow('Choose Nov 16, 2026 or later.');
    expect(() => assertOcularAfterConsultation('2026-11-16', '2026-11-13')).not.toThrow();
  });

  it('counts from a past consultation date', () => {
    expect(() => assertOcularAfterConsultation('2026-11-04', '2026-11-01')).not.toThrow();
    expect(() => assertOcularAfterConsultation('2026-11-03', '2026-11-01')).toThrow('Choose Nov 4, 2026 or later.');
  });

  it('handles month ends', () => {
    expect(() => assertOcularAfterConsultation('2026-12-03', '2026-11-30')).not.toThrow();
    expect(() => assertOcularAfterConsultation('2026-12-02', '2026-11-30')).toThrow('Choose Dec 3, 2026 or later.');
  });

  it('reads timestamps as Asia/Manila days', () => {
    // 4:00 PM UTC on Nov 12 is already Nov 13 in Manila.
    expect(earliestOcularDate('2026-11-12T16:00:00Z')).toBe('2026-11-16');
    expect(earliestOcularDate(new Date('2026-11-12T16:00:00Z'))).toBe('2026-11-16');
    expect(() => assertOcularAfterConsultation('2026-11-15', new Date('2026-11-12T16:00:00Z'))).toThrow('Choose Nov 16, 2026 or later.');
  });

  it('skips the check when there is no consultation', () => {
    expect(() => assertOcularAfterConsultation('2026-11-09', undefined)).not.toThrow();
    expect(() => assertOcularAfterConsultation('2026-11-09', null)).not.toThrow();
  });
});
