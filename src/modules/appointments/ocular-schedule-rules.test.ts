import { describe, expect, it } from 'vitest';
import { assertOcularAfterConsultation } from './ocular-schedule-rules.js';

describe('assertOcularAfterConsultation', () => {
  it('rejects an ocular less than 3 days after the consultation', () => {
    expect(() => assertOcularAfterConsultation('2026-11-12', '2026-11-10'))
      .toThrow('at least 3 days after the consultation on 2026-11-10. Choose 2026-11-13 or later.');
  });

  it('rejects an ocular on or before the consultation date', () => {
    expect(() => assertOcularAfterConsultation('2026-11-10', '2026-11-10')).toThrow('Choose 2026-11-13 or later.');
    expect(() => assertOcularAfterConsultation('2026-11-09', '2026-11-10')).toThrow('Choose 2026-11-13 or later.');
  });

  it('accepts an ocular exactly 3 days after, or later, across month ends', () => {
    expect(() => assertOcularAfterConsultation('2026-11-13', '2026-11-10')).not.toThrow();
    expect(() => assertOcularAfterConsultation('2026-12-03', '2026-11-30')).not.toThrow();
    expect(() => assertOcularAfterConsultation('2026-12-02', '2026-11-30')).toThrow('Choose 2026-12-03 or later.');
  });

  it('skips the check when there is no consultation', () => {
    expect(() => assertOcularAfterConsultation('2026-11-11', undefined)).not.toThrow();
    expect(() => assertOcularAfterConsultation('2026-11-11', null)).not.toThrow();
  });
});
