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
 * Where a visit report is listed: Appointments → Visit Reports ("appointment") until its project
 * goes through Create Project, then Projects → Visit Reports ("project").
 */
export type VisitReportStage = 'appointment' | 'project';

export function normalizeVisitReportStage(value?: unknown): VisitReportStage | undefined {
  return value === 'appointment' || value === 'project' ? value : undefined;
}

/**
 * Filter for one stage. `createdProjectIds` are projects past Create Project (status is not draft);
 * `createdProjectReportIds` are their legacy `visitReportId`s, for reports saved before linkedProjectId.
 */
export function visitReportStageCondition(
  stage: VisitReportStage,
  createdProjectIds: unknown[],
  createdProjectReportIds: unknown[],
) {
  const inCreatedProject = [
    { linkedProjectId: { $in: createdProjectIds } },
    { _id: { $in: createdProjectReportIds } },
  ];
  return stage === 'project' ? { $or: inCreatedProject } : { $nor: inCreatedProject };
}
