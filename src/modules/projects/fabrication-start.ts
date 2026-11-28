import type { Types } from 'mongoose';
import { PaymentPlan } from '../../models/Payment.js';
import { Project, ProjectItem } from '../../models/index.js';
import { DeliveryType, NotificationCategory, PaymentStageStatus, ProjectStatus } from '../../utils/constants.js';
import { logger } from '../../utils/logger.js';
import { projectStateMachine } from '../../utils/stateMachine.js';
import { createAndSendNotification, emitUserEvent, notifyUsers } from '../notifications/socket.service.js';
import { emitFabricationTeamChanged } from './fabrication-realtime.js';
import { applyTargetFinishDate } from './target-finish.js';

export async function hasRequiredInitialFabricationPayment(projectId: string | Types.ObjectId) {
  // A project-level plan covers the entire project, including combined plans for multiple items.
  const projectPlan = await PaymentPlan.findOne({ projectId, projectItemId: { $exists: false } });
  if (projectPlan) return projectPlan.stages[0]?.status === PaymentStageStatus.VERIFIED;

  const items = await ProjectItem.find({ projectId }).select('_id');
  if (!items.length) return false;

  const plans = await PaymentPlan.find({ projectId, projectItemId: { $in: items.map((item) => item._id) } });
  const verifiedItemIds = new Set(plans
    .filter((plan) => plan.stages[0]?.status === PaymentStageStatus.VERIFIED)
    .map((plan) => String(plan.projectItemId)));
  return plans.length === items.length && items.every((item) => verifiedItemIds.has(String(item._id)));
}

export async function enterPaymentPending(project: { _id: Types.ObjectId; status: ProjectStatus }) {
  if (project.status === ProjectStatus.PAYMENT_PENDING) return;
  projectStateMachine.assertTransition(project.status, ProjectStatus.PAYMENT_PENDING);
  await Project.updateOne(
    { _id: project._id, status: project.status },
    { $set: { status: ProjectStatus.PAYMENT_PENDING } },
  );
}

export async function reconcileFabricationStart(projectId: string | Types.ObjectId) {
  let project = await Project.findById(projectId);
  if (!project || ![ProjectStatus.PAYMENT_PENDING, ProjectStatus.FABRICATION].includes(project.status)) {
    return { project, paymentReady: false, activated: false };
  }

  const paymentReady = await hasRequiredInitialFabricationPayment(projectId);
  if (!paymentReady || !project.fabricationLeadId) return { project, paymentReady, activated: false };

  let activated = false;
  if (project.status === ProjectStatus.PAYMENT_PENDING) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.FABRICATION);
    const finishDateWasSet = Boolean(project.estimatedCompletionDate);
    await applyTargetFinishDate(project);
    const updated = await Project.findOneAndUpdate(
      { _id: projectId, status: ProjectStatus.PAYMENT_PENDING, fabricationLeadId: { $ne: null } },
      { $set: {
        status: ProjectStatus.FABRICATION,
        ...(!finishDateWasSet && project.estimatedCompletionDate ? { estimatedCompletionDate: project.estimatedCompletionDate } : {}),
      } },
      { returnDocument: 'after' },
    );
    activated = Boolean(updated);
    project = updated ?? await Project.findById(projectId);
  }

  if (project?.status === ProjectStatus.FABRICATION) {
    // Repeatable if a prior attempt saved the project phase but did not finish updating its items.
    await ProjectItem.updateMany(
      { projectId, status: ProjectStatus.PAYMENT_PENDING },
      { $set: { status: ProjectStatus.FABRICATION } },
    );
    if (activated) {
      const viewers = [project.customerId, project.fabricationLeadId, ...project.fabricationAssistantIds, ...project.engineerIds];
      for (const userId of new Set(viewers.filter(Boolean).map(String))) {
        emitUserEvent(userId, 'fabrication:update', { projectId: String(project._id) });
      }
      // Payment Pending → Fabrication changes the "waiting for payment" line in every picker.
      emitFabricationTeamChanged(project);
    }
  }
  return { project, paymentReady, activated };
}

export async function handleInitialFabricationPaymentVerified(
  projectId: Types.ObjectId,
  plan: { stages: ReadonlyArray<{ status: PaymentStageStatus }> },
) {
  const { project, paymentReady, activated } = await reconcileFabricationStart(projectId);
  if (!project) return project;

  const link = `/projects/${project._id}`;
  if (activated) {
    await notifyUsers(
      [project.customerId, ...project.engineerIds],
      NotificationCategory.FABRICATION,
      'Fabrication Updates Unlocked',
      `The required payment for "${project.title}" is verified. The assigned fabrication team can now post work updates.`,
      link,
    );
    // The fabrication team's own notice is a payment notice (2026-11-28): it shows under Payments.
    const fullPayment = plan.stages.length === 1;
    await notifyUsers(
      fabricationTeamOf(project),
      NotificationCategory.PAYMENT,
      fullPayment ? 'Full Payment Verified' : '1st Payment Verified',
      fullPayment
        ? `The full payment for "${project.title}" is verified. You can start the fabrication updates; no stage will wait for payment.`
        : `The required downpayment for "${project.title}" is verified. You can start the fabrication updates.`,
      `${link}/fabrication`,
    );
  } else if (project.status === ProjectStatus.PAYMENT_PENDING && plan.stages[0]?.status === PaymentStageStatus.VERIFIED) {
    if (paymentReady && !project.fabricationLeadId) {
      // Paid and waiting for a team: the system assigns the next free fabricator, or the one whose
      // project reached Quality Check (panel note 2026-11-27). The assignment sends its own notices.
      // Loaded lazily because projects.service imports this file.
      try {
        const { autoAssignWaitingFabricationProjects } = await import('./fabrication-auto-assign.js');
        await autoAssignWaitingFabricationProjects('payment_verified');
      } catch (error) {
        logger.error(`Fabrication auto-assign after payment failed for project ${project._id}`, error);
      }
      const latest = await Project.findById(project._id);
      if (latest?.fabricationLeadId) return latest;
    }
    await createAndSendNotification(
      project.customerId,
      NotificationCategory.SYSTEM,
      paymentReady ? 'Fabrication Team Assignment Pending' : 'Item Payment Verified',
      paymentReady
        ? `The required payment for "${project.title}" is verified. Your project is next in line for a fabricator, who is assigned as soon as one is available.`
        : `Payment for one item in "${project.title}" has been verified. Other items still need their required first payment.`,
      link,
    );
    if (paymentReady && !project.fabricationLeadId) {
      await notifyUsers(
        project.engineerIds,
        NotificationCategory.FABRICATION,
        'Waiting for a Fabricator',
        `The required payment for "${project.title}" is verified, but no fabricator is free yet. The system assigns a lead automatically when a fabricator is free or their project reaches Quality Check. You can also assign the team now.`,
        link,
      );
    }
  }

  return project;
}

function fabricationTeamOf(project: { fabricationLeadId?: unknown; fabricationAssistantIds?: unknown[] }) {
  return [project.fabricationLeadId, ...(project.fabricationAssistantIds || [])] as Array<string | Types.ObjectId | null | undefined>;
}

/**
 * Payments (2026-11-28): the fabrication team hears, the moment the cashier verifies it, that a later
 * payment opened the next part of the lifecycle: the 2nd payment (Installation, or Ready for
 * Delivery for shop work) and the last one (Done). Same counting as the fabrication payment gate.
 * The downpayment has its own notice above. Shows under Payments.
 */
export async function notifyFabricationTeamPaymentVerified(
  projectId: string | Types.ObjectId,
  plan: {
    projectItemId?: unknown;
    stages: ReadonlyArray<{ stageId: string; label: string; status: PaymentStageStatus }>;
  },
  stageId: string | undefined,
) {
  const index = plan.stages.findIndex((stage) => stage.stageId === stageId);
  const stage = plan.stages[index];
  // Not a later payment, or only partly paid: nothing opened yet.
  if (index < 1 || !stage || stage.status !== PaymentStageStatus.VERIFIED) return;
  const total = plan.stages.length;
  const paid = plan.stages.filter((entry) => entry.status === PaymentStageStatus.VERIFIED).length;
  if (paid < Math.min(total, 2)) return;

  const project = await Project.findById(projectId).select('title deliveryType fabricationLeadId fabricationAssistantIds');
  if (!project?.fabricationLeadId) return;
  const item = plan.projectItemId ? await ProjectItem.findById(plan.projectItemId).select('title') : null;
  const what = `"${project.title}"${item?.title ? ` (${item.title})` : ''}`;
  const allPaid = paid === total;
  const nextStage = project.deliveryType === DeliveryType.ON_SITE_INSTALLATION ? 'Installation' : 'Ready for Delivery';
  await notifyUsers(
    fabricationTeamOf(project),
    NotificationCategory.PAYMENT,
    allPaid ? 'All Payments Verified' : '2nd Payment Verified',
    allPaid
      ? `All payments for ${what} are verified. No stage waits for payment any more, so you can continue up to Done.`
      : `The 2nd payment (${stage.label}) for ${what} is verified. You can continue to ${nextStage}.`,
    `/projects/${String(project._id)}/fabrication${plan.projectItemId ? `?projectItemId=${String(plan.projectItemId)}` : ''}`,
  );
}
