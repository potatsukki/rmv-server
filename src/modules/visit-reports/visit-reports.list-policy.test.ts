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

  it('lists reports of created projects (linked or legacy visitReportId) under project', () => {
    expect(visitReportStageCondition('project', ['p1'], ['r1'])).toEqual({
      $or: [{ linkedProjectId: { $in: ['p1'] } }, { _id: { $in: ['r1'] } }],
    });
  });

  it('lists everything else, including reports of draft projects, under appointment', () => {
    expect(visitReportStageCondition('appointment', ['p1'], ['r1'])).toEqual({
      $nor: [{ linkedProjectId: { $in: ['p1'] } }, { _id: { $in: ['r1'] } }],
    });
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
