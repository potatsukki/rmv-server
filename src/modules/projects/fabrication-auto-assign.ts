import type { Types } from 'mongoose';
import { Payment, PaymentPlan, Project } from '../../models/index.js';
import { PaymentStageStatus, ProjectStatus } from '../../utils/constants.js';
import { logger } from '../../utils/logger.js';
import { hasRequiredInitialFabricationPayment } from './fabrication-start.js';
import {
  autoAssignFabricationLead,
  listFabricationStaffWorkload,
  type FabricationAutoAssignReason,
} from './projects.service.js';

// Panel note 2026-11-27: "Project assigned to fabricator nearest the completion", automatically.
// A paid project with no team gets a lead: someone free first, otherwise the fabricator whose
// project reached Quality Check first. The lead adds assistants; the engineer / admin can change it.

type WorkloadMember = Awaited<ReturnType<typeof listFabricationStaffWorkload>>[number];

/**
 * The next lead from the workload list (already sorted free → nearest completion → busy → away):
 * the first person not on leave / unavailable whose team projects all reached Quality Check.
 */
export function pickAutoAssignLead(staff: WorkloadMember[]): { member: WorkloadMember; reason: FabricationAutoAssignReason } | null {
  const member = staff.find((candidate) => candidate.workloadStatus !== 'on_leave'
    && candidate.workloadStatus !== 'unavailable'
    && candidate.teamStatus !== 'busy');
  if (!member) return null;
  if (member.teamStatus === 'free') return { member, reason: { kind: 'free' } };

  const from = member.activeProjects
    .filter((project) => project.nearCompletion && project.roles.some((role) => role !== 'delivery_crew'))
    .sort((a, b) => b.progressPercent - a.progressPercent)[0];
  return {
    member,
    reason: {
      kind: 'nearest_completion',
      fromProject: { _id: from?._id ?? '', projectNumber: from?.projectNumber, title: from?.title, stage: from?.currentStage ?? null },
    },
  };
}

/**
 * When each project became ready: the latest verification among the payments of its required
 * first stage(s), else when its payment plan was created, else the project itself.
 */
async function readyTimes(projects: Array<{ _id: Types.ObjectId; createdAt?: Date }>) {
  const ids = projects.map((project) => project._id);
  const plans = await PaymentPlan.find({ projectId: { $in: ids } }).select('projectId stages.stageId createdAt').lean();
  const projectByStage = new Map<string, string>();
  const planCreated = new Map<string, number>();
  for (const plan of plans) {
    const projectId = String(plan.projectId);
    const firstStageId = plan.stages?.[0]?.stageId;
    if (firstStageId) projectByStage.set(firstStageId, projectId);
    const created = plan.createdAt ? new Date(plan.createdAt).getTime() : 0;
    planCreated.set(projectId, Math.max(planCreated.get(projectId) ?? 0, created));
  }

  const payments = projectByStage.size
    ? await Payment.find({ stageId: { $in: [...projectByStage.keys()] }, status: PaymentStageStatus.VERIFIED })
      .select('stageId verifiedAt').lean()
    : [];
  const verified = new Map<string, number>();
  for (const payment of payments) {
    const projectId = projectByStage.get(payment.stageId);
    if (!projectId || !payment.verifiedAt) continue;
    verified.set(projectId, Math.max(verified.get(projectId) ?? 0, new Date(payment.verifiedAt).getTime()));
  }

  return new Map(projects.map((project) => {
    const id = String(project._id);
    return [id, verified.get(id) || planCreated.get(id) || (project.createdAt ? new Date(project.createdAt).getTime() : 0)];
  }));
}

/** Paid projects without a lead, the one that became ready first at the front (first in, first out). */
export async function listProjectsWaitingForFabricator() {
  const candidates = await Project.find({ status: ProjectStatus.PAYMENT_PENDING, fabricationLeadId: null })
    .select('_id projectNumber title createdAt')
    .lean();
  const paid = [];
  for (const project of candidates) {
    if (await hasRequiredInitialFabricationPayment(project._id)) paid.push(project);
  }
  if (paid.length < 2) return paid;

  const readyAt = await readyTimes(paid);
  return paid
    .map((project, index) => ({ project, index, at: readyAt.get(String(project._id)) ?? 0 }))
    .sort((a, b) => (a.at - b.at) || (a.index - b.index))
    .map(({ project }) => project);
}

/**
 * Gives every waiting paid project a lead while someone qualifies. Safe to call any time and from
 * several places at once (each assignment re-checks under the fabricator's lock and only fills an
 * empty lead). Never throws: a failed auto-assign must not undo the payment or update that ran it.
 */
export async function autoAssignWaitingFabricationProjects(trigger: string): Promise<number> {
  let assigned = 0;
  try {
    const waiting = await listProjectsWaitingForFabricator();
    for (const project of waiting) {
      // Fresh each time: the previous pick is now busy with the project it just got.
      const pick = pickAutoAssignLead(await listFabricationStaffWorkload());
      if (!pick) break; // Nobody free or finishing: the rest wait for the next trigger.
      try {
        const result = await autoAssignFabricationLead(String(project._id), pick.member._id, pick.reason);
        if (result) {
          assigned += 1;
          logger.info(`Auto-assigned ${pick.member._id} as lead of ${project.projectNumber || project._id} (${trigger}, ${pick.reason.kind})`);
        }
      } catch (error) {
        logger.warn(`Auto-assign skipped ${project.projectNumber || project._id} (${trigger})`, error);
      }
    }
  } catch (error) {
    logger.error(`Fabrication auto-assign failed (${trigger}):`, error);
  }
  return assigned;
}
