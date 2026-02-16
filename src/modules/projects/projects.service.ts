import {
  Project, Appointment, User, AuditLog,
} from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import {
  ProjectStatus, AppointmentStatus, Role, AuditAction, NotificationCategory,
} from '../../utils/constants.js';
import { projectStateMachine } from '../../utils/stateMachine.js';
import { createAndSendNotification, notifyRole } from '../notifications/socket.service.js';
import type {
  CreateProjectInput,
  UpdateProjectInput,
  AssignEngineersInput,
  AssignFabricationInput,
  TransitionProjectInput,
} from './projects.validation.js';
import type { Types } from 'mongoose';

// ── Create Project (from completed appointment) ──

export async function createProject(
  input: CreateProjectInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(input.appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.status !== AppointmentStatus.COMPLETED) {
    throw AppError.badRequest('Project can only be created from a completed appointment');
  }

  // Check 1:1 relationship
  const existing = await Project.findOne({ appointmentId: input.appointmentId });
  if (existing) throw AppError.conflict('A project already exists for this appointment', ErrorCode.DUPLICATE_ENTRY);

  const project = await Project.create({
    appointmentId: input.appointmentId,
    customerId: appointment.customerId,
    salesStaffId: appointment.salesStaffId || actorId,
    title: input.title,
    serviceType: input.serviceType,
    description: input.description,
    siteAddress: input.siteAddress,
    measurements: input.measurements,
    materialType: input.materialType,
    finishColor: input.finishColor,
    quantity: input.quantity,
    notes: input.notes,
    status: ProjectStatus.DRAFT,
  });

  await AuditLog.create({
    action: AuditAction.PROJECT_CREATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: { appointmentId: input.appointmentId, title: input.title },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    appointment.customerId,
    NotificationCategory.SYSTEM,
    'Project Created',
    `Your project "${input.title}" has been created.`,
    `/projects/${project._id}`,
  );

  return project;
}

// ── Update Project Details ──

export async function updateProject(
  projectId: string,
  input: UpdateProjectInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  // Only editable in draft/submitted status
  if (![ProjectStatus.DRAFT, ProjectStatus.SUBMITTED].includes(project.status)) {
    throw AppError.badRequest('Project can only be edited in draft or submitted status');
  }

  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      (project as any)[key] = value;
      changes[key] = value;
    }
  }

  await project.save();

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: changes,
    ipAddress: ip,
    userAgent: ua,
  });

  return project;
}

// ── Assign Engineers ──

export async function assignEngineers(
  projectId: string,
  input: AssignEngineersInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  // Verify all are engineers
  const engineers = await User.find({
    _id: { $in: input.engineerIds },
    roles: Role.ENGINEER,
    isActive: true,
  });
  if (engineers.length !== input.engineerIds.length) {
    throw AppError.badRequest('One or more engineer IDs are invalid');
  }

  project.engineerIds = input.engineerIds as unknown as Types.ObjectId[];

  // Auto-transition to BLUEPRINT if project is in SUBMITTED status
  if (project.status === ProjectStatus.SUBMITTED) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.BLUEPRINT);
    project.status = ProjectStatus.BLUEPRINT;
  }

  await project.save();

  await AuditLog.create({
    action: AuditAction.PROJECT_REASSIGNED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: { engineerIds: input.engineerIds },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify engineers
  for (const eng of engineers) {
    await createAndSendNotification(
      eng._id,
      NotificationCategory.SYSTEM,
      'Project Assigned',
      `You have been assigned to project "${project.title}".`,
      `/projects/${project._id}`,
    );
  }

  return project;
}

// ── Assign Fabrication Staff ──

export async function assignFabricationStaff(
  projectId: string,
  input: AssignFabricationInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  // Verify lead is fabrication staff
  const lead = await User.findOne({
    _id: input.fabricationLeadId,
    roles: Role.FABRICATION_STAFF,
    isActive: true,
  });
  if (!lead) throw AppError.badRequest('Invalid fabrication lead');

  // Verify assistants
  if (input.fabricationAssistantIds.length > 0) {
    const assistants = await User.find({
      _id: { $in: input.fabricationAssistantIds },
      roles: Role.FABRICATION_STAFF,
      isActive: true,
    });
    if (assistants.length !== input.fabricationAssistantIds.length) {
      throw AppError.badRequest('One or more assistant IDs are invalid');
    }
  }

  project.fabricationLeadId = input.fabricationLeadId as unknown as Types.ObjectId;
  project.fabricationAssistantIds = input.fabricationAssistantIds as unknown as Types.ObjectId[];
  await project.save();

  await AuditLog.create({
    action: AuditAction.FABRICATION_ASSIGNED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: { fabricationLeadId: input.fabricationLeadId, assistantIds: input.fabricationAssistantIds },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify fabrication staff
  await createAndSendNotification(
    input.fabricationLeadId,
    NotificationCategory.FABRICATION,
    'Fabrication Assignment',
    `You have been assigned as lead for project "${project.title}".`,
    `/projects/${project._id}`,
  );

  return project;
}

// ── Transition Project Status ──

export async function transitionProject(
  projectId: string,
  input: TransitionProjectInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  projectStateMachine.assertTransition(project.status, input.status);

  const oldStatus = project.status;
  project.status = input.status;

  if (input.status === ProjectStatus.CANCELLED && input.cancelReason) {
    project.cancelReason = input.cancelReason;
  }

  await project.save();

  const actionMap: Partial<Record<ProjectStatus, AuditAction>> = {
    [ProjectStatus.CANCELLED]: AuditAction.PROJECT_CANCELLED,
    [ProjectStatus.COMPLETED]: AuditAction.PROJECT_COMPLETED,
  };
  const action = actionMap[input.status] || AuditAction.PROJECT_UPDATED;

  await AuditLog.create({
    action,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: { from: oldStatus, to: input.status, cancelReason: input.cancelReason },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer on key transitions
  const notifyStatuses = [ProjectStatus.BLUEPRINT, ProjectStatus.APPROVED, ProjectStatus.FABRICATION, ProjectStatus.COMPLETED, ProjectStatus.CANCELLED];
  if (notifyStatuses.includes(input.status)) {
    const statusMessages: Record<string, string> = {
      [ProjectStatus.BLUEPRINT]: 'is now in the blueprint phase.',
      [ProjectStatus.APPROVED]: 'blueprint has been approved and is ready for payment.',
      [ProjectStatus.FABRICATION]: 'is now in fabrication.',
      [ProjectStatus.COMPLETED]: 'has been completed!',
      [ProjectStatus.CANCELLED]: `has been cancelled.${input.cancelReason ? ` Reason: ${input.cancelReason}` : ''}`,
    };

    await createAndSendNotification(
      project.customerId,
      NotificationCategory.SYSTEM,
      'Project Update',
      `Your project "${project.title}" ${statusMessages[input.status]}`,
      `/projects/${project._id}`,
    );
  }

  return project;
}

// ── Get Project by ID ──

export async function getProjectById(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
) {
  const project = await Project.findById(projectId)
    .populate('customerId', 'firstName lastName email phone')
    .populate('salesStaffId', 'firstName lastName')
    .populate('engineerIds', 'firstName lastName')
    .populate('fabricationLeadId', 'firstName lastName')
    .populate('fabricationAssistantIds', 'firstName lastName');

  if (!project) throw AppError.notFound('Project not found');

  // Customers can only see their own
  if (
    actorRoles.includes(Role.CUSTOMER) &&
    !actorRoles.some(r => [Role.ADMIN, Role.SALES_STAFF, Role.ENGINEER].includes(r))
  ) {
    if (project.customerId._id?.toString() !== actorId) {
      throw AppError.forbidden('Access denied');
    }
  }

  return project;
}

// ── List Projects ──

export async function listProjects(
  query: {
    status?: string;
    customerId?: string;
    salesStaffId?: string;
    engineerId?: string;
    search?: string;
    page?: string;
    limit?: string;
    sortBy?: string;
    sortOrder?: string;
  },
  actorId: string,
  actorRoles: Role[],
) {
  const page = parseInt(query.page || '1');
  const limit = Math.min(parseInt(query.limit || '20'), 100);
  const filter: Record<string, unknown> = {};

  // Role-based filtering
  if (actorRoles.includes(Role.CUSTOMER) && !actorRoles.some(r => [Role.ADMIN, Role.SALES_STAFF, Role.ENGINEER].includes(r))) {
    filter.customerId = actorId;
  } else if (actorRoles.includes(Role.SALES_STAFF) && !actorRoles.some(r => [Role.ADMIN].includes(r))) {
    filter.salesStaffId = actorId;
  } else if (actorRoles.includes(Role.ENGINEER) && !actorRoles.some(r => [Role.ADMIN, Role.SALES_STAFF].includes(r))) {
    filter.engineerIds = actorId;
  } else if (actorRoles.includes(Role.FABRICATION_STAFF) && !actorRoles.some(r => [Role.ADMIN, Role.ENGINEER].includes(r))) {
    filter.$or = [
      { fabricationLeadId: actorId },
      { fabricationAssistantIds: actorId },
    ];
  }

  if (query.status === 'active') {
    // 'active' = all non-terminal statuses
    filter.status = { $nin: [ProjectStatus.COMPLETED, ProjectStatus.CANCELLED] };
  } else if (query.status) {
    filter.status = query.status;
  }
  if (query.customerId && !filter.customerId) filter.customerId = query.customerId;
  if (query.salesStaffId && !filter.salesStaffId) filter.salesStaffId = query.salesStaffId;
  if (query.engineerId && !filter.engineerIds) filter.engineerIds = query.engineerId;
  if (query.search) {
    const searchOr = [
      { title: { $regex: query.search, $options: 'i' } },
      { serviceType: { $regex: query.search, $options: 'i' } },
      { description: { $regex: query.search, $options: 'i' } },
    ];
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, { $or: searchOr }];
      delete filter.$or;
    } else {
      filter.$or = searchOr;
    }
  }

  const sortField = query.sortBy || 'createdAt';
  const sortOrder = query.sortOrder === 'asc' ? 1 : -1;

  const [projects, total] = await Promise.all([
    Project.find(filter)
      .populate('customerId', 'firstName lastName email')
      .populate('salesStaffId', 'firstName lastName')
      .populate('engineerIds', 'firstName lastName')
      .sort({ [sortField]: sortOrder })
      .skip((page - 1) * limit)
      .limit(limit),
    Project.countDocuments(filter),
  ]);

  return {
    items: projects,
    total,
    hasMore: page * limit < total,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

// ── Add media keys (reference photos) ──

export async function addMediaKeys(
  projectId: string,
  keys: string[],
  actorId: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  project.mediaKeys.push(...keys);
  await project.save();

  return project;
}

// ── Remove media key ──

export async function removeMediaKey(
  projectId: string,
  key: string,
  actorId: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  project.mediaKeys = project.mediaKeys.filter(k => k !== key);
  await project.save();

  return project;
}
