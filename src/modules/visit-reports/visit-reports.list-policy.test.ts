import { describe, expect, it } from 'vitest';

import { visitReportStatusCondition } from './visit-reports.list-policy.js';

describe('visitReportStatusCondition', () => {
  it('maps the pending queue to draft and returned reports', () => {
    expect(visitReportStatusCondition('pending')).toEqual({
      $in: ['draft', 'returned'],
    });
  });

  it('preserves individual status filters', () => {
    expect(visitReportStatusCondition('draft')).toBe('draft');
  });
});
