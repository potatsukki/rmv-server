import { AuditLog, Project, User } from '../../models/index.js';
import { AuditAction } from '../../utils/constants.js';
import { ACTIVE_FABRICATION_STATUSES, fabricationTrackProgress } from './fabrication-scheduling.js';

// Read-only checks for the fabrication team rules (QA 2026-11-28: "walang overlap, walang double
// assign"). Used by `scripts/diagnoseFabricationOverlap.ts` on live data and by the overlap tests.

export interface WorkshopOverlap {
  staffId: string;
  name: string;
  /** Two or more projects still in the workshop (not every part at Quality Check yet). */
  projects: Array<{ projectId: string; projectNumber?: string; role: 'Lead' | 'Assistant' }>;
}

export interface FabricationTeamProblems {
  /** One fabricator leading / assisting two or more workshop projects. */
  overlaps: WorkshopOverlap[];
  /** One person twice on one team (lead also an assistant, or an assistant listed twice). */
  doubleOnTeam: Array<{ projectId: string; projectNumber?: string; problem: 'lead_is_assistant' | 'duplicate_assistant' }>;
  /** A project the system assigned more than once. */
  repeatedAutoAssign: Array<{ projectId: string; projectNumber?: string; count: number }>;
}

export async function findFabricationTeamProblems(): Promise<FabricationTeamProblems> {
  const active = await Project.find({ status: { $in: ACTIVE_FABRICATION_STATUSES } })
    .select('projectNumber title status deliveryType fabricationLeadId fabricationAssistantIds')
    .lean();
  const progress = await fabricationTrackProgress(active);

  const doubleOnTeam: FabricationTeamProblems['doubleOnTeam'] = [];
  const workshopLoad = new Map<string, WorkshopOverlap['projects']>();
  for (const project of active) {
    const lead = project.fabricationLeadId ? String(project.fabricationLeadId) : null;
    const assistants = (project.fabricationAssistantIds || []).map(String);
    const projectId = String(project._id);
    if (lead && assistants.includes(lead)) doubleOnTeam.push({ projectId, projectNumber: project.projectNumber, problem: 'lead_is_assistant' });
    if (new Set(assistants).size !== assistants.length) {
      doubleOnTeam.push({ projectId, projectNumber: project.projectNumber, problem: 'duplicate_assistant' });
    }
    if (progress.get(projectId)?.nearCompletion) continue; // its team may already take the next project

    const members: Array<[string, 'Lead' | 'Assistant']> = [
      ...(lead ? [[lead, 'Lead'] as [string, 'Lead']] : []),
      ...[...new Set(assistants)].filter((id) => id !== lead).map((id) => [id, 'Assistant'] as [string, 'Assistant']),
    ];
    for (const [staffId, role] of members) {
      workshopLoad.set(staffId, [...(workshopLoad.get(staffId) || []), { projectId, projectNumber: project.projectNumber, role }]);
    }
  }

  const overlapping = [...workshopLoad].filter(([, projects]) => projects.length > 1);
  const users = overlapping.length
    ? await User.find({ _id: { $in: overlapping.map(([staffId]) => staffId) } }).select('firstName lastName').lean()
    : [];
  const names = new Map(users.map((user) => [String(user._id), `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()]));
  const overlaps = overlapping.map(([staffId, projects]) => ({ staffId, name: names.get(staffId) || 'A fabricator', projects }));

  const repeated = await AuditLog.aggregate<{ _id: unknown; count: number }>([
    { $match: { action: AuditAction.FABRICATION_ASSIGNED, 'details.automatic': true } },
    { $group: { _id: '$targetId', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  const repeatedProjects = repeated.length
    ? await Project.find({ _id: { $in: repeated.map((row) => String(row._id)) } }).select('projectNumber').lean()
    : [];
  const numbers = new Map(repeatedProjects.map((project) => [String(project._id), project.projectNumber]));
  const repeatedAutoAssign = repeated.map((row) => ({
    projectId: String(row._id),
    projectNumber: numbers.get(String(row._id)),
    count: row.count,
  }));

  return { overlaps, doubleOnTeam, repeatedAutoAssign };
}
