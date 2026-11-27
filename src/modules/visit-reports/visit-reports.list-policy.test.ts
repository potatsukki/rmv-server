import { describe, expect, it } from 'vitest';

import {
  normalizeVisitReportStage,
  visitReportStageCondition,
  visitReportStatusCondition,
} from './visit-reports.list-policy.js';

describe('visit report stage', () => {
  it('accepts only appointment and project', () => {
    expect(normalizeVisitReportStage('appointment')).toBe('appointment');
    expect(normalizeVisitReportStage('project')).toBe('project');
    expect(normalizeVisitReportStage('draft')).toBeUndefined();
    expect(normalizeVisitReportStage(['project'])).toBeUndefined();
    expect(normalizeVisitReportStage(undefined)).toBeUndefined();
  });

  // User decision 2026-11-27: Appointments lists consultation reports, Projects lists ocular reports.
  it('lists ocular reports under project and consultation reports under appointment', () => {
    expect(visitReportStageCondition('project')).toEqual({ visitType: 'ocular' });
    expect(visitReportStageCondition('appointment')).toEqual({ visitType: 'consultation' });
  });
});

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
