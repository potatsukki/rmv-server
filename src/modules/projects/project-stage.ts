import type { Types } from 'mongoose';
import { ProjectItem } from '../../models/index.js';
import { ProjectStatus } from '../../utils/constants.js';

/** Stages the project lists filter by. "active" means anything not completed or cancelled. */
export const PROJECT_LISTING_STAGES = [
  'active',
  'pending_ocular',
  'review',
  'design',
  'billing',
  'fabrication',
  'completed',
  'cancelled',
] as const;
export type ProjectListingStage = (typeof PROJECT_LISTING_STAGES)[number];
export type ProjectWorkflowStage = Exclude<ProjectListingStage, 'active'>;

export function isProjectListingStage(value: unknown): value is ProjectListingStage {
  return typeof value === 'string' && (PROJECT_LISTING_STAGES as readonly string[]).includes(value);
}

/**
 * The stage a project is listed under, from its status and its items' statuses.
 * Mirrors resolveProjectWorkflowStatus(...).stage in rmv-web for the list view
 * (no blueprint passed). Keep the two in sync so badges, filters and counts agree.
 */
export function resolveProjectStage(status: string | undefined, itemStatuses: string[]): ProjectWorkflowStage {
  if (status === ProjectStatus.CANCELLED) return 'cancelled';
  if (status === ProjectStatus.DRAFT) return 'pending_ocular';

  const allItemsCompleted = itemStatuses.length > 0
    && itemStatuses.every((itemStatus) => itemStatus === ProjectStatus.COMPLETED);
  if (status === ProjectStatus.COMPLETED || allItemsCompleted) return 'completed';

  if (status === ProjectStatus.FABRICATION || itemStatuses.includes(ProjectStatus.FABRICATION)) {
    return 'fabrication';
  }
  if (
    status === ProjectStatus.APPROVED
    || status === ProjectStatus.PAYMENT_PENDING
    || itemStatuses.includes(ProjectStatus.PAYMENT_PENDING)
  ) {
    return 'billing';
  }
  if (status === ProjectStatus.BLUEPRINT) return 'design';
  return 'review';
}

export function matchesListingStage(stage: ProjectWorkflowStage, wanted: ProjectListingStage) {
  return wanted === 'active'
    ? stage !== 'completed' && stage !== 'cancelled'
    : stage === wanted;
}

/** Resolves each project's listing stage, loading the item statuses in one query. */
export async function resolveProjectStages(projects: Array<{ _id: Types.ObjectId | string; status?: string }>) {
  const stages = new Map<string, ProjectWorkflowStage>();
  if (projects.length === 0) return stages;

  const items = await ProjectItem.find({ projectId: { $in: projects.map((project) => project._id) } })
    .select('projectId status')
    .lean()
    .exec();

  const itemStatusesByProject = new Map<string, string[]>();
  for (const item of items) {
    const projectId = String(item.projectId);
    const statuses = itemStatusesByProject.get(projectId);
    if (statuses) statuses.push(String(item.status));
    else itemStatusesByProject.set(projectId, [String(item.status)]);
  }

  for (const project of projects) {
    const projectId = String(project._id);
    stages.set(projectId, resolveProjectStage(project.status, itemStatusesByProject.get(projectId) ?? []));
  }
  return stages;
}
