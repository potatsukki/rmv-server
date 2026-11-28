import type { Types } from 'mongoose';
import { PaymentPlan } from '../../models/Payment.js';
import { Project, ProjectItem } from '../../models/index.js';
import { NotificationCategory, PaymentStageStatus, ProjectStatus } from '../../utils/constants.js';
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
      [project.customerId, project.fabricationLeadId, ...project.fabricationAssistantIds, ...project.engineerIds],
      NotificationCategory.FABRICATION,
      'Fabrication Updates Unlocked',
      `The required payment for "${project.title}" is verified. The assigned fabrication team can now post work updates.`,
      link,
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
