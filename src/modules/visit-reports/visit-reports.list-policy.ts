export const PENDING_VISIT_REPORT_STATUSES = [
  'draft',
  'returned',
] as const;

export function visitReportStatusCondition(status?: string) {
  if (status === 'pending') {
    return { $in: [...PENDING_VISIT_REPORT_STATUSES] };
  }

  return status || undefined;
}

/**
 * Where a visit report is listed (user decision 2026-11-27): Appointments → Visit Reports
 * ("appointment") shows consultation reports, Projects → Visit Reports ("project") shows ocular
 * reports. A consultation report that moves on to its ocular visit becomes visitType ocular.
 */
export type VisitReportStage = 'appointment' | 'project';

export function normalizeVisitReportStage(value?: unknown): VisitReportStage | undefined {
  return value === 'appointment' || value === 'project' ? value : undefined;
}

export function visitReportStageCondition(stage: VisitReportStage) {
  return { visitType: stage === 'project' ? 'ocular' : 'consultation' };
}
