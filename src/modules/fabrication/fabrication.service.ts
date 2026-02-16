import {
  FabricationUpdate, Project, User, AuditLog,
} from '../../models/index.js';
import { AppError } from '../../utils/appError.js';
import {
  FabricationStatus, ProjectStatus, AuditAction, NotificationCategory, Role,
} from '../../utils/constants.js';
import { fabricationStateMachine, projectStateMachine } from '../../utils/stateMachine.js';
import { createAndSendNotification } from '../notifications/socket.service.js';
import { sendFabricationUpdateEmail } from '../notifications/email.service.js';
import type { CreateFabricationUpdateInput } from './fabrication.validation.js';

// ── Fabrication Staff: Create Update ──

export async function createFabricationUpdate(
  input: CreateFabricationUpdateInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(input.projectId);
  if (!project) throw AppError.notFound('Project not found');

  if (project.status !== ProjectStatus.FABRICATION) {
    throw AppError.badRequest('Project is not in fabrication phase');
  }

  // Only fabrication staff assigned to this project can update
  const isLead = project.fabricationLeadId?.toString() === actorId;
  const isAssistant = project.fabricationAssistantIds.some(id => id.toString() === actorId);
  if (!isLead && !isAssistant) {
    throw AppError.forbidden('You are not assigned to this project fabrication');
  }

  // Get current fabrication status (from latest update or queued)
  const latestUpdate = await FabricationUpdate.findOne({ projectId: input.projectId })
    .sort({ createdAt: -1 });

  const currentStatus = latestUpdate
    ? latestUpdate.status
    : FabricationStatus.QUEUED;

  // Validate status transition (forward-only)
  fabricationStateMachine.assertTransition(currentStatus, input.status);

  const update = await FabricationUpdate.create({
    projectId: input.projectId,
    status: input.status,
    notes: input.notes,
    photoKeys: input.photoKeys,
    updatedBy: actorId,
  });

  await AuditLog.create({
    action: AuditAction.FABRICATION_UPDATED,
    actorId,
    targetType: 'fabrication_update',
    targetId: update._id,
    details: { projectId: input.projectId, from: currentStatus, to: input.status },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  const customer = await User.findById(project.customerId);
  if (customer) {
    const statusLabels: Record<string, string> = {
      [FabricationStatus.MATERIAL_PREP]: 'Material Preparation',
      [FabricationStatus.CUTTING]: 'Cutting',
      [FabricationStatus.WELDING]: 'Welding',
      [FabricationStatus.FINISHING]: 'Finishing',
      [FabricationStatus.QUALITY_CHECK]: 'Quality Check',
      [FabricationStatus.READY_FOR_DELIVERY]: 'Ready for Delivery',
      [FabricationStatus.DONE]: 'Done',
    };

    await createAndSendNotification(
      project.customerId,
      NotificationCategory.FABRICATION,
      'Fabrication Update',
      `Your project "${project.title}" is now in: ${statusLabels[input.status] || input.status}`,
      `/projects/${project._id}/fabrication`,
    );

    await sendFabricationUpdateEmail(customer.email, {
      projectTitle: project.title,
      status: statusLabels[input.status] || input.status,
      notes: input.notes,
    });
  }

  // If fabrication is done, transition project to completed
  if (input.status === FabricationStatus.DONE) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.COMPLETED);
    project.status = ProjectStatus.COMPLETED;
    await project.save();

    await AuditLog.create({
      action: AuditAction.PROJECT_COMPLETED,
      actorId,
      targetType: 'project',
      targetId: project._id,
      ipAddress: ip,
      userAgent: ua,
    });
  }

  return update;
}

// ── List Fabrication Updates for a Project ──

async function assertFabricationProjectAccess(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
): Promise<void> {
  const project = await Project.findById(projectId)
    .select('customerId salesStaffId engineerIds fabricationLeadId fabricationAssistantIds');
  if (!project) throw AppError.notFound('Project not found');

  if (actorRoles.includes(Role.ADMIN)) {
    return;
  }

  if (
    actorRoles.includes(Role.CUSTOMER) &&
    project.customerId.toString() === actorId
  ) {
    return;
  }

  if (
    actorRoles.includes(Role.SALES_STAFF) &&
    project.salesStaffId?.toString() === actorId
  ) {
    return;
  }

  if (
    actorRoles.includes(Role.ENGINEER) &&
    project.engineerIds.some((id) => id.toString() === actorId)
  ) {
    return;
  }

  if (
    actorRoles.includes(Role.FABRICATION_STAFF) &&
    (
      project.fabricationLeadId?.toString() === actorId ||
      project.fabricationAssistantIds.some((id) => id.toString() === actorId)
    )
  ) {
    return;
  }

  throw AppError.forbidden('Access denied');
}

export async function listFabricationUpdates(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
) {
  await assertFabricationProjectAccess(projectId, actorId, actorRoles);
  const updates = await FabricationUpdate.find({ projectId })
    .populate('updatedBy', 'firstName lastName')
    .sort({ createdAt: 1 });
  return updates;
}

// ── Get Latest Fabrication Status ──

export async function getLatestFabricationStatus(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
) {
  await assertFabricationProjectAccess(projectId, actorId, actorRoles);
  const latest = await FabricationUpdate.findOne({ projectId })
    .sort({ createdAt: -1 })
    .populate('updatedBy', 'firstName lastName');

  return {
    currentStatus: latest?.status || FabricationStatus.QUEUED,
    latestUpdate: latest,
    allowedTransitions: fabricationStateMachine.getAllowed(
      latest?.status || FabricationStatus.QUEUED,
    ),
  };
}

// ── Get Fabrication Update by ID ──

export async function getFabricationUpdateById(
  updateId: string,
  actorId: string,
  actorRoles: Role[],
) {
  const update = await FabricationUpdate.findById(updateId)
    .populate('updatedBy', 'firstName lastName');
  if (!update) throw AppError.notFound('Fabrication update not found');
  await assertFabricationProjectAccess(update.projectId.toString(), actorId, actorRoles);
  return update;
}
