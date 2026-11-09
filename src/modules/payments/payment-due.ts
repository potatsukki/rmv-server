import type { Types } from 'mongoose';
import { Blueprint, Payment, PaymentPlan } from '../../models/index.js';
import { PaymentStageStatus, ProjectStatus } from '../../utils/constants.js';

// Same key as DESIGN_FEE_STAGE_PREFIX in projects/design-fee.service.ts (not imported to keep this module light).
const DESIGN_FEE_STAGE_PREFIX = 'design-fee-';

/** What a customer still has to pay on a project right now. */
export interface ProjectPaymentDue {
  /** Payment stages that are due (activated, pending or declined) with a balance left. */
  dueStages: number;
  /** Design fee still unpaid, with no GCash proof already waiting for cashier review. */
  designFee: boolean;
  /** A blueprint revision fee the cashier has not recorded yet. */
  revisionFee: boolean;
  /** Blueprint approved, but no payment plan chosen yet. */
  needsPlan: boolean;
  needsPayment: boolean;
}

export const NO_PAYMENT_DUE: ProjectPaymentDue = {
  dueStages: 0,
  designFee: false,
  revisionFee: false,
  needsPlan: false,
  needsPayment: false,
};

type PaymentDueProject = {
  _id: Types.ObjectId | string;
  status?: string;
  designFee?: { status?: string } | null;
};

const cents = (value: number | undefined | null) => Math.round(Number(value ?? 0) * 100);

/**
 * Payment items each project needs from the customer now. The same rules drive the customer
 * dashboard "Pending Payments" count and the Payments page "Needs Payment" filter.
 * Cancelled projects owe nothing and are left out of the result.
 */
export async function getProjectPaymentDue(projects: PaymentDueProject[]) {
  const result = new Map<string, ProjectPaymentDue>();
  const openProjects = projects.filter((project) => project.status !== ProjectStatus.CANCELLED);
  if (openProjects.length === 0) return result;

  const projectIds = openProjects.map((project) => project._id);
  const designFeeStageIds = openProjects
    .filter((project) => project.designFee?.status === 'pending')
    .map((project) => `${DESIGN_FEE_STAGE_PREFIX}${String(project._id)}`);

  const [plans, revisionFeeProjectIds, designFeesAwaitingReview] = await Promise.all([
    PaymentPlan.find({ projectId: { $in: projectIds } })
      .select('projectId stages.status stages.activatedAt stages.amount stages.amountPaid stages.creditApplied')
      .lean()
      .exec(),
    Blueprint.distinct('projectId', { projectId: { $in: projectIds }, 'revisionFee.status': 'pending' }).exec(),
    designFeeStageIds.length > 0
      ? Payment.distinct('stageId', { stageId: { $in: designFeeStageIds }, paymentStatus: 'pending_verification' }).exec()
      : Promise.resolve([] as unknown[]),
  ]);

  const projectsWithPlan = new Set<string>();
  const dueStagesByProject = new Map<string, number>();
  for (const plan of plans) {
    const projectId = String(plan.projectId);
    projectsWithPlan.add(projectId);
    for (const stage of plan.stages ?? []) {
      const isDue = Boolean(stage.activatedAt)
        && (stage.status === PaymentStageStatus.PENDING || stage.status === PaymentStageStatus.DECLINED);
      const balanceCents = cents(stage.amount) - cents(stage.amountPaid) - cents(stage.creditApplied);
      if (isDue && balanceCents > 0) {
        dueStagesByProject.set(projectId, (dueStagesByProject.get(projectId) ?? 0) + 1);
      }
    }
  }

  const revisionFeeDue = new Set(revisionFeeProjectIds.map(String));
  const awaitingReview = new Set(designFeesAwaitingReview.map(String));

  for (const project of openProjects) {
    const projectId = String(project._id);
    const dueStages = dueStagesByProject.get(projectId) ?? 0;
    const designFee = project.designFee?.status === 'pending'
      && !awaitingReview.has(`${DESIGN_FEE_STAGE_PREFIX}${projectId}`);
    const revisionFee = revisionFeeDue.has(projectId);
    const needsPlan = project.status === ProjectStatus.APPROVED && !projectsWithPlan.has(projectId);

    result.set(projectId, {
      dueStages,
      designFee,
      revisionFee,
      needsPlan,
      needsPayment: dueStages > 0 || designFee || revisionFee || needsPlan,
    });
  }

  return result;
}
