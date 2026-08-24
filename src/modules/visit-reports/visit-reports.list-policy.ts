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
