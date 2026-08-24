import {
  Project, ProjectItem, Appointment, User, AuditLog, VisitReport,
} from '../../models/index.js';
import { PaymentPlan } from '../../models/Payment.js';
import { Blueprint } from '../../models/Blueprint.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import {
  ContractStatus, ProjectStatus, AppointmentStatus, Role, AuditAction, NotificationCategory, StaffAvailabilityStatus, ServiceType,
} from '../../utils/constants.js';
import { VisitReportStatus } from '../../models/VisitReport.js';
import { projectStateMachine } from '../../utils/stateMachine.js';
import { createAndSendNotification, notifyRole } from '../notifications/socket.service.js';
import { generateAndUploadContract, type ContractData } from '../../services/contract.service.js';
import { generateDownloadUrl, verifyFileExists } from '../uploads/upload.service.js';
import { logger } from '../../utils/logger.js';
import type {
  CreateProjectInput,
  UpdateProjectInput,
  AssignEngineersInput,
  ReassignProjectSalesInput,
  AssignFabricationInput,
  TransitionProjectInput,
  SignContractInput,
  SignEngineerContractInput,
  UploadSignedContractInput,
  ReviewInitialDesignInput,
  ResubmitInitialDesignInput,
  BackfillInitialDesignInput,
  SelectPaymentPlanInput,
  SubmitProjectReviewInput,
  SkipProjectReviewInput,
} from './projects.validation.js';
import type { Types } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { PaymentStageStatus } from '../../utils/constants.js';
import { getInstallmentConfig } from '../config/config.service.js';
import { generateProjectNumber } from '../../utils/projectNumber.js';
import { seedFabricationItems } from '../fabrication/fabrication.service.js';
import { activeProjectStatusesForRoles } from './projects.list-policy.js';

function readableServiceTitle(serviceType?: string, custom?: string) {
  if (serviceType === 'custom' && custom?.trim()) return custom.trim();
  return (serviceType || 'Custom')
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSearchValue(value?: string) {
  return (value || '')
    .toLowerCase()
    .replace(/[_\W]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function buildPersonSearchFilter(search: string) {
  const trimmed = search.trim();
  const escaped = escapeRegex(trimmed);
  const tokens = trimmed
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const exactFields = [
    { firstName: { $regex: escaped, $options: 'i' } },
    { lastName: { $regex: escaped, $options: 'i' } },
    { email: { $regex: escaped, $options: 'i' } },
  ];

  if (tokens.length <= 1) return { $or: exactFields };

  return {
    $or: [
      ...exactFields,
      {
        $and: tokens.map((token) => ({
          $or: [
            { firstName: { $regex: escapeRegex(token), $options: 'i' } },
            { lastName: { $regex: escapeRegex(token), $options: 'i' } },
            { email: { $regex: escapeRegex(token), $options: 'i' } },
          ],
        })),
      },
    ],
  };
}

function serviceTypesMatchingSearch(search: string) {
  const normalized = normalizeSearchValue(search);
  if (!normalized) return [];

  return Object.values(ServiceType).filter((serviceType) => {
    const normalizedValue = normalizeSearchValue(serviceType);
    const normalizedLabel = normalizeSearchValue(readableServiceTitle(serviceType));
    return normalizedValue.includes(normalized)
      || normalizedLabel.includes(normalized)
      || normalized.includes(normalizedValue)
      || normalized.includes(normalizedLabel);
  });
}

function appendSearchCondition(
  filter: Record<string, unknown>,
  searchOr: Record<string, unknown>[],
) {
  if (!searchOr.length) return;

  if (filter.$or || filter.$and) {
    const andFilters = Array.isArray(filter.$and)
      ? [...(filter.$and as Record<string, unknown>[])]
      : [];

    if (filter.$or) {
      andFilters.push({ $or: filter.$or as Record<string, unknown>[] });
      delete filter.$or;
    }

    andFilters.push({ $or: searchOr });
    filter.$and = andFilters;
    return;
  }

  filter.$or = searchOr;
}

async function buildProjectSearchConditions(search: string) {
  const trimmed = search.trim();
  const escaped = escapeRegex(trimmed);
  const normalized = normalizeSearchValue(trimmed);
  const normalizedRegex = normalized ? escapeRegex(normalized).replace(/\s+/g, '[_\\W]+') : '';
  const serviceTypeMatches = serviceTypesMatchingSearch(trimmed);

  const [matchingUsers, matchingItems] = await Promise.all([
    User.find(buildPersonSearchFilter(trimmed)).select('_id').lean(),
    ProjectItem.find({
      $or: [
        { title: { $regex: escaped, $options: 'i' } },
        { serviceType: { $regex: escaped, $options: 'i' } },
        { serviceTypeCustom: { $regex: escaped, $options: 'i' } },
        ...(normalizedRegex
          ? [
            { title: { $regex: normalizedRegex, $options: 'i' } },
            { serviceType: { $regex: normalizedRegex, $options: 'i' } },
            { serviceTypeCustom: { $regex: normalizedRegex, $options: 'i' } },
          ]
          : []),
        ...(serviceTypeMatches.length ? [{ serviceType: { $in: serviceTypeMatches } }] : []),
      ],
    }).select('projectId').lean(),
  ]);

  const userIds = matchingUsers.map((user) => user._id);
  const itemProjectIds = matchingItems.map((item) => item.projectId).filter(Boolean);

  return [
    { projectNumber: { $regex: escaped, $options: 'i' } },
    { title: { $regex: escaped, $options: 'i' } },
    { serviceType: { $regex: escaped, $options: 'i' } },
    { description: { $regex: escaped, $options: 'i' } },
    ...(normalizedRegex
      ? [
        { projectNumber: { $regex: normalizedRegex, $options: 'i' } },
        { title: { $regex: normalizedRegex, $options: 'i' } },
        { serviceType: { $regex: normalizedRegex, $options: 'i' } },
        { description: { $regex: normalizedRegex, $options: 'i' } },
      ]
      : []),
    ...(serviceTypeMatches.length ? [{ serviceType: { $in: serviceTypeMatches } }] : []),
    ...(userIds.length
      ? [
        { customerId: { $in: userIds } },
        { salesStaffId: { $in: userIds } },
        { engineerIds: { $in: userIds } },
      ]
      : []),
    ...(itemProjectIds.length ? [{ _id: { $in: itemProjectIds } }] : []),
  ];
}

function buildProjectItemLink(projectId: string, path = '', projectItemId?: string) {
  const basePath = path ? `/projects/${projectId}/${path}` : `/projects/${projectId}`;
  return projectItemId ? `${basePath}?projectItemId=${projectItemId}` : basePath;
}

const SIGNED_CONTRACT_EXTENSIONS = new Set(['pdf', 'jpg', 'jpeg', 'png']);

function getObjectFileName(key: string) {
  return key.split('/').pop() || key;
}

function getObjectFileExtension(key: string) {
  const fileName = getObjectFileName(key);
  const ext = fileName.split('.').pop();
  return ext ? ext.toLowerCase() : '';
}

function inferContractContentType(key: string) {
  switch (getObjectFileExtension(key)) {
    case 'pdf':
      return 'application/pdf';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    default:
      return undefined;
  }
}

function assertSignedContractKey(key: string) {
  if (!key.startsWith('contracts/')) {
    throw AppError.badRequest('Signed contract must be uploaded to the contracts folder');
  }

  const ext = getObjectFileExtension(key);
  if (!SIGNED_CONTRACT_EXTENSIONS.has(ext)) {
    throw AppError.badRequest('Signed contract must be a PDF, JPG, JPEG, or PNG file');
  }
}

async function notifyProjectSubmittedAfterContract(project: any) {
  await createAndSendNotification(
    project.customerId,
    NotificationCategory.PROJECT,
    'Signed Contract Uploaded',
    `The signed contract for "${project.title}" has been uploaded. Your project is now submitted for engineering.`,
    `/projects/${project._id}/contract`,
  );

  await notifyRole(
    Role.ADMIN,
    NotificationCategory.PROJECT,
    'Project Submitted',
    `Project "${project.title}" has a signed contract and is ready for engineer assignment.`,
    `/projects/${project._id}`,
  );

  await notifyRole(
    Role.ENGINEER,
    NotificationCategory.PROJECT,
    'New Project Submitted',
    `Project "${project.title}" has a signed contract and is ready for blueprint work.`,
    `/projects/${project._id}`,
  );
}

function generatedContractFlowDisabled(): void {
  throw new AppError(
    'Generated contracts and e-signatures are disabled. Upload the manually signed contract instead.',
    410,
    ErrorCode.GONE,
  );
}

async function syncProjectItemFromReport(project: any, report: any) {
  const serviceType = report.serviceType || 'custom';
  const title = readableServiceTitle(serviceType, report.serviceTypeCustom);
  const hasInitialDesign = Boolean(report.initialDesignKeys?.length || report.initialDesignNotes?.trim());
  const mediaKeys = [
    ...(report.photoKeys || []),
    ...(report.sketchKeys || []),
    ...(report.referenceImageKeys || []),
  ];

  const item = await ProjectItem.findOneAndUpdate(
    { projectId: project._id, serviceType },
    {
      $set: {
        projectId: project._id,
        appointmentId: project.appointmentId,
        title,
        serviceType,
        serviceTypeCustom: report.serviceTypeCustom,
        measurements: report.measurements || project.measurements,
        measurementUnit: report.measurementUnit,
        lineItems: report.lineItems || [],
        materials: report.materials,
        finishes: report.finishes,
        preferredDesign: report.preferredDesign,
        customerRequirements: report.customerRequirements,
        notes: report.notes,
        selectedDesignTemplateId: report.selectedDesignTemplateId,
        selectedDesignTemplateName: report.selectedDesignTemplateName,
        mediaKeys,
        ...(report.visitType === 'ocular'
          ? { ocularVisitReportId: report._id }
          : { consultationVisitReportId: report._id }),
      },
      $setOnInsert: {
        status: project.status || ProjectStatus.DRAFT,
        initialDesignKeys: report.initialDesignKeys || [],
        initialDesignNotes: report.initialDesignNotes,
        designReviewStatus: hasInitialDesign ? 'pending' : 'not_required',
      },
    },
    { upsert: true, new: true },
  );

  if (!report.projectItemId || report.projectItemId.toString() !== item._id.toString()) {
    report.projectItemId = item._id;
    if (!report.linkedProjectId) report.linkedProjectId = project._id;
    await report.save();
  }

  return item;
}

async function ensureProjectItems(project: any) {
  const reports = await VisitReport.find({
    $or: [
      { linkedProjectId: project._id },
      { appointmentId: project.appointmentId },
    ],
  }).sort({ visitType: 1, createdAt: 1 });

  for (const report of reports) {
    if (report.serviceType) {
      await syncProjectItemFromReport(project, report);
    }
  }

  const existingItems = await ProjectItem.find({ projectId: project._id }).sort({ createdAt: 1 });
  const existingTypes = new Set(existingItems.map((item) => item.serviceType));
  const serviceTypes = (project.serviceTypes?.length ? project.serviceTypes : [project.serviceType])
    .filter((serviceType: string | undefined): serviceType is string => Boolean(serviceType?.trim()));

  for (const serviceType of serviceTypes) {
    if (existingTypes.has(serviceType)) continue;
    await ProjectItem.create({
      projectId: project._id,
      appointmentId: project.appointmentId,
      serviceType,
      title: readableServiceTitle(serviceType),
      status: project.status || ProjectStatus.DRAFT,
      measurements: project.measurements,
      materials: project.materialType,
      finishes: project.finishColor,
      notes: project.notes,
      initialDesignKeys: project.initialDesignKeys || [],
      initialDesignNotes: project.initialDesignNotes,
      designReviewStatus: hasInitialDesignSubmission(project) ? 'pending' : 'not_required',
      mediaKeys: project.mediaKeys || [],
    });
  }

  return ProjectItem.find({ projectId: project._id })
    .populate('consultationVisitReportId')
    .populate('ocularVisitReportId')
    .sort({ createdAt: 1 })
    .lean();
}

async function syncProjectDesignReviewRollup(project: any) {
  const items = await ProjectItem.find({ projectId: project._id }).select('designReviewStatus initialDesignKeys initialDesignNotes').lean();
  const reviewableItems = items.filter((item) => hasInitialDesignSubmission(item));

  if (reviewableItems.length === 0) {
    project.designReviewStatus = hasInitialDesignSubmission(project) ? project.designReviewStatus : 'not_required';
    return;
  }

  if (reviewableItems.some((item) => item.designReviewStatus === 'declined')) {
    project.designReviewStatus = 'declined';
    return;
  }

  if (reviewableItems.every((item) => item.designReviewStatus === 'approved')) {
    project.designReviewStatus = 'approved';
    return;
  }

  project.designReviewStatus = 'pending';
}

async function attachProjectItems(project: any) {
  const projectObject = project.toObject ? project.toObject() : { ...project };
  projectObject.items = await ensureProjectItems(project);
  return projectObject;
}

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

  // Link the latest submitted visit report from this appointment
  const latestReport = await VisitReport.findOne({
    appointmentId: input.appointmentId,
    status: { $in: [VisitReportStatus.SUBMITTED, VisitReportStatus.COMPLETED] },
  }).sort({ createdAt: -1 }).select('_id');

  const projectNumber = await generateProjectNumber();

  const project = await Project.create({
    appointmentId: input.appointmentId,
    projectNumber,
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
    designReviewStatus: 'not_required',
    status: ProjectStatus.DRAFT,
    contractStatus: ContractStatus.MISSING,
    ...(latestReport && { visitReportId: latestReport._id }),
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

  if (
    [ProjectStatus.DRAFT, ProjectStatus.SUBMITTED].includes(project.status)
    && project.contractStatus !== ContractStatus.UPLOADED
  ) {
    throw AppError.badRequest('A signed contract must be uploaded before engineers can claim or be assigned');
  }

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
  await ProjectItem.updateMany(
    {
      projectId: project._id,
      status: { $in: [ProjectStatus.DRAFT, ProjectStatus.SUBMITTED] },
    },
    { $set: { status: ProjectStatus.BLUEPRINT } },
  );

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

  return attachProjectItems(project);
}

export async function reassignProjectSalesStaff(
  projectId: string,
  input: ReassignProjectSalesInput,
  actorId: string,
  actorRoles: Role[],
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  if ([ProjectStatus.CANCELLED, ProjectStatus.COMPLETED].includes(project.status)) {
    throw AppError.badRequest('Sales reassignment is not allowed for completed or cancelled projects');
  }

  const previousSalesStaffId = project.salesStaffId.toString();
  if (previousSalesStaffId === input.salesStaffId) {
    return project;
  }

  const isAdmin = actorRoles.includes(Role.ADMIN);
  const isAssignedSales = actorRoles.includes(Role.SALES_STAFF) && previousSalesStaffId === actorId;
  if (!isAdmin && !isAssignedSales) {
    throw AppError.forbidden('Only admins or the assigned sales staff can reassign this project');
  }

  const nextSalesStaff = await User.findOne({
    _id: input.salesStaffId,
    roles: Role.SALES_STAFF,
    isActive: true,
  }).select('availabilityStatus');
  if (!nextSalesStaff) throw AppError.badRequest('Invalid sales staff ID');

  if (
    nextSalesStaff.availabilityStatus === StaffAvailabilityStatus.UNAVAILABLE
    || nextSalesStaff.availabilityStatus === StaffAvailabilityStatus.ON_LEAVE
  ) {
    throw AppError.badRequest('Selected sales staff is currently unavailable');
  }

  project.salesStaffId = input.salesStaffId as unknown as Types.ObjectId;
  await project.save();

  const [appointmentUpdate, visitReportUpdate] = await Promise.all([
    Appointment.updateOne(
      { _id: project.appointmentId, status: { $nin: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] } },
      { $set: { salesStaffId: nextSalesStaff._id } },
    ),
    VisitReport.updateMany(
      { appointmentId: project.appointmentId, status: VisitReportStatus.DRAFT },
      { $set: { salesStaffId: nextSalesStaff._id } },
    ),
  ]);

  await AuditLog.create({
    action: AuditAction.PROJECT_REASSIGNED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: {
      reassigned: true,
      scope: 'sales_staff',
      previousSalesStaffId,
      salesStaffId: input.salesStaffId,
      reason: input.reason || null,
      appointmentUpdated: appointmentUpdate.modifiedCount,
      draftVisitReportsUpdated: visitReportUpdate.modifiedCount,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  await createAndSendNotification(
    input.salesStaffId,
    NotificationCategory.PROJECT,
    'Project Reassigned',
    `You were assigned to project "${project.title}".`,
    `/projects/${project._id}`,
  );

  await createAndSendNotification(
    previousSalesStaffId,
    NotificationCategory.PROJECT,
    'Project Reassignment',
    `Project "${project.title}" was reassigned to another sales staff member.`,
    `/projects/${project._id}`,
  );

  await createAndSendNotification(
    project.customerId,
    NotificationCategory.PROJECT,
    'Project Team Update',
    `Your project "${project.title}" now has an updated assigned sales staff.`,
    `/projects/${project._id}`,
  );

  return project;
}

function hasInitialDesignSubmission(project: {
  initialDesignKeys?: string[];
  initialDesignNotes?: string;
}) {
  return Boolean(project.initialDesignKeys?.length || project.initialDesignNotes?.trim());
}

function isHistoricalInitialDesignBackfillEligible(projectStatus: ProjectStatus, hasBlueprint: boolean) {
  return hasBlueprint || [
    ProjectStatus.APPROVED,
    ProjectStatus.PAYMENT_PENDING,
    ProjectStatus.FABRICATION,
    ProjectStatus.COMPLETED,
  ].includes(projectStatus);
}

function buildContractData(
  project: any,
  blueprint: any,
  paymentPlan: {
    totalAmount: number;
    isPayInFull: boolean;
    stages: Array<{ label: string; percentage: number; amount: number; description?: string }>;
  },
) {
  const customer = project.customerId as any;
  const engineers = project.engineerIds as any[];

  return {
    projectTitle: project.title,
    projectDescription: project.description,
    siteAddress: project.siteAddress,
    serviceType: project.serviceType,
    customerName: `${customer.firstName} ${customer.lastName}`,
    customerEmail: customer.email,
    customerPhone: customer.phone,
    customerAddress: customer.address,
    engineerNames: engineers.map((e: any) => `${e.firstName} ${e.lastName}`),
    totalAmount: paymentPlan.totalAmount,
    paymentType: paymentPlan.isPayInFull ? 'full' : 'installment',
    stages: paymentPlan.stages.map((stage) => ({
      label: stage.label,
      percentage: stage.percentage,
      amount: stage.amount,
      description: stage.description,
    })),
    estimatedDuration: blueprint.quotation?.estimatedDuration,
    materialType: project.materialType,
    finishColor: project.finishColor,
    quantity: project.quantity,
    customerSignatureKey: customer.signatureKey || null,
    engineerSignatureKey: engineers[0]?.signatureKey || null,
    contractSignedAt: project.contractSignedAt || null,
    quotationLineItems: blueprint.quotation?.lineItems?.map((lineItem: any) => ({
      label: lineItem.label,
      quantity: lineItem.quantity,
      materials: lineItem.materials,
      labor: lineItem.labor,
      amount: lineItem.amount,
    })),
    quotationFees: blueprint.quotation?.fees || blueprint.quotation?.discount,
    quotationValidityDays: blueprint.quotation?.validityDays,
    scopeOfWork: blueprint.quotation?.inclusions || blueprint.quotation?.breakdown,
  } satisfies ContractData;
}

export async function reviewInitialDesign(
  projectId: string,
  input: ReviewInitialDesignInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  const canReview = project.engineerIds.some((id) => id.toString() === actorId);
  const actor = await User.findById(actorId).select('roles firstName lastName');
  const isAdmin = actor?.roles?.includes(Role.ADMIN);

  if (!canReview && !isAdmin) {
    throw AppError.forbidden('Only an assigned engineer or admin can review the initial design');
  }

  const projectItem = input.projectItemId
    ? await ProjectItem.findOne({ _id: input.projectItemId, projectId: project._id })
    : null;

  if (input.projectItemId && !projectItem) {
    throw AppError.notFound('Project item not found');
  }

  const reviewTarget = projectItem || project;
  if (!hasInitialDesignSubmission(reviewTarget)) {
    throw AppError.badRequest('No initial design has been submitted for this item');
  }

  if (reviewTarget.designReviewStatus === 'approved' && input.decision === 'approved') {
    return attachProjectItems(project);
  }
  if (input.decision === 'declined' && !input.notes?.trim()) {
    throw AppError.badRequest('Internal review notes are required when declining the initial design');
  }

  reviewTarget.designReviewStatus = input.decision;
  reviewTarget.designReviewNotes = input.notes;
  reviewTarget.designReviewedBy = actorId as unknown as Types.ObjectId;
  reviewTarget.designReviewedAt = new Date();
  if (projectItem) {
    await projectItem.save();
    await syncProjectDesignReviewRollup(project);
  } else {
    project.designReviewStatus = input.decision;
    project.designReviewNotes = input.notes;
    project.designReviewedBy = actorId as unknown as Types.ObjectId;
    project.designReviewedAt = new Date();
  }
  await project.save();

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: {
      action: 'initial_design_reviewed',
      projectItemId: projectItem?._id || null,
      itemTitle: projectItem?.title || null,
      decision: input.decision,
      notes: input.notes || null,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  await createAndSendNotification(
    project.salesStaffId,
    NotificationCategory.PROJECT,
    input.decision === 'approved' ? 'Initial Design Approved' : 'Initial Design Needs Changes',
    input.decision === 'approved'
      ? `The initial design for "${projectItem?.title || project.title}" has been approved by engineering.`
      : `Engineering declined the initial design for "${projectItem?.title || project.title}".${input.notes ? ` Notes: ${input.notes}` : ''}`,
    `/projects/${project._id}`,
  );

  return attachProjectItems(project);
}

export async function resubmitInitialDesign(
  projectId: string,
  input: ResubmitInitialDesignInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  const actor = await User.findById(actorId).select('roles');
  const isAdmin = actor?.roles?.includes(Role.ADMIN);
  const isAssignedSales = String(project.salesStaffId) === actorId;
  if (!isAdmin && !isAssignedSales) {
    throw AppError.forbidden('Only the assigned sales staff or an admin can update the initial design');
  }

  if (![ProjectStatus.SUBMITTED, ProjectStatus.BLUEPRINT].includes(project.status)) {
    throw AppError.badRequest('Initial design can only be updated before blueprint review begins');
  }

  const existingBlueprint = await Blueprint.findOne({ projectId }).select('_id');
  if (existingBlueprint) {
    throw AppError.badRequest('Initial design can no longer be updated after the blueprint has been uploaded');
  }

  const projectItem = input.projectItemId
    ? await ProjectItem.findOne({ _id: input.projectItemId, projectId: project._id })
    : null;

  if (input.projectItemId && !projectItem) {
    throw AppError.notFound('Project item not found');
  }

  if (projectItem) {
    projectItem.initialDesignKeys = input.initialDesignKeys || [];
    projectItem.initialDesignNotes = input.initialDesignNotes || undefined;
    projectItem.designReviewStatus = 'pending';
    projectItem.designReviewedBy = undefined;
    projectItem.designReviewedAt = undefined;
    projectItem.designReviewNotes = undefined;
    await projectItem.save();
    project.initialDesignKeys = input.initialDesignKeys || [];
    project.initialDesignNotes = input.initialDesignNotes || undefined;
    await syncProjectDesignReviewRollup(project);
  } else {
    project.initialDesignKeys = input.initialDesignKeys || [];
    project.initialDesignNotes = input.initialDesignNotes || undefined;
    project.designReviewStatus = 'pending';
    project.designReviewedBy = undefined;
    project.designReviewedAt = undefined;
    project.designReviewNotes = undefined;
  }
  await project.save();

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: {
      action: 'initial_design_resubmitted',
      projectItemId: projectItem?._id || null,
      itemTitle: projectItem?.title || null,
      initialDesignKeyCount: projectItem ? projectItem.initialDesignKeys.length : project.initialDesignKeys.length,
      hasNotes: projectItem ? !!projectItem.initialDesignNotes : !!project.initialDesignNotes,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  for (const engineerId of project.engineerIds) {
    await createAndSendNotification(
      engineerId,
      NotificationCategory.PROJECT,
      'Initial Design Resubmitted',
      `Sales staff updated the initial design for "${projectItem?.title || project.title}". Please review it again.`,
      `/projects/${project._id}`,
    );
  }

  return attachProjectItems(project);
}

export async function backfillInitialDesign(
  projectId: string,
  input: BackfillInitialDesignInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  const existingBlueprint = await Blueprint.findOne({ projectId }).select('_id');
  if (!isHistoricalInitialDesignBackfillEligible(project.status, Boolean(existingBlueprint))) {
    throw AppError.badRequest('Use the standard initial design workflow before blueprint review begins');
  }

  project.initialDesignKeys = input.initialDesignKeys || [];
  project.initialDesignNotes = input.initialDesignNotes || undefined;
  project.initialDesignBackfill = {
    isSyntheticDemo: true,
    reason: input.backfillReason,
    backfilledAt: new Date(),
    backfilledBy: actorId as unknown as Types.ObjectId,
  };

  if (!hasInitialDesignSubmission(project)) {
    throw AppError.badRequest('Provide at least one design file or a note');
  }

  if (project.designReviewStatus === 'pending' || project.designReviewStatus === 'declined') {
    project.designReviewStatus = 'not_required';
    project.designReviewedBy = undefined;
    project.designReviewedAt = undefined;
    project.designReviewNotes = undefined;
  }

  await project.save();

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: {
      action: 'initial_design_backfilled',
      syntheticDemo: true,
      reason: input.backfillReason,
      initialDesignKeyCount: project.initialDesignKeys.length,
      hasNotes: !!project.initialDesignNotes,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  return project;
}

function itemScopedQuery(projectId: string, projectItemId?: string) {
  return projectItemId
    ? { projectId, projectItemId }
    : { projectId, projectItemId: { $exists: false } };
}

async function hasRequiredInitialFabricationPayment(projectId: string) {
  const items = await ProjectItem.find({ projectId }).select('_id');

  if (!items.length) {
    const plan = await PaymentPlan.findOne(itemScopedQuery(projectId));
    return Boolean(plan?.stages[0]?.status === PaymentStageStatus.VERIFIED);
  }

  const plans = await PaymentPlan.find({
    projectId,
    projectItemId: { $in: items.map((item) => item._id) },
  });

  if (plans.length < items.length) return false;

  return plans.every((plan) => plan.stages[0]?.status === PaymentStageStatus.VERIFIED);
}

type BuiltPaymentStages = Awaited<ReturnType<typeof buildPaymentStages>>;

async function getActiveProjectItems(projectId: string) {
  return ProjectItem.find({ projectId }).sort({ createdAt: 1 });
}

async function buildPaymentStages(projectId: string, paymentType: 'full' | 'installment', projectItemId?: string) {
  const blueprint = await Blueprint.findOne(itemScopedQuery(projectId, projectItemId)).sort({ version: -1 });
  if (!blueprint?.quotation || blueprint.status !== 'approved') {
    throw AppError.badRequest('Customer payment selection is only available after the approved quotation is ready');
  }
  if (blueprint.quotationReviewStatus !== 'sent_to_customer') {
    throw AppError.badRequest('Customer payment selection is available only after the approved quotation is sent to the customer');
  }

  const quotedTotal = Number(blueprint.quotation.total);
  const baseTotal = Number.isFinite(quotedTotal) && quotedTotal > 0 ? quotedTotal : 1;
  const installmentConfig = await getInstallmentConfig();
  const isPayInFull = paymentType === 'full';
  const totalAmount = isPayInFull
    ? baseTotal
    : Math.round(baseTotal * (1 + installmentConfig.surchargePercent / 100) * 100) / 100;

  const stages = isPayInFull
    ? [{
      stageId: uuidv4(),
      label: 'Full Payment',
      description: 'Due before fabrication starts',
      percentage: 100,
      amount: totalAmount,
      status: PaymentStageStatus.PENDING,
      amountPaid: 0,
      creditApplied: 0,
      remainingBalance: totalAmount,
      activatedAt: new Date(),
    }]
    : installmentConfig.split.map((pct, idx) => {
      const amount = Math.round((totalAmount * pct / 100) * 100) / 100;
      const milestone = blueprint.quotation?.paymentMilestones?.[idx];
      return {
        stageId: uuidv4(),
        label: milestone?.label || installmentConfig.stageLabels[idx] || `Stage ${idx + 1}`,
        description: milestone?.description || milestone?.trigger || installmentConfig.stageDescriptions[idx] || '',
        percentage: pct,
        amount,
        status: PaymentStageStatus.PENDING,
        amountPaid: 0,
        creditApplied: 0,
        remainingBalance: amount,
        activatedAt: idx === 0 ? new Date() : null,
      };
    });

  return {
    blueprint,
    totalAmount,
    isPayInFull,
    surchargePercent: isPayInFull ? 0 : installmentConfig.surchargePercent,
    stages,
  };
}

async function buildContractItemBuildsFromPlans(
  projectId: string,
  projectItems: any[],
  plans: any[],
) {
  const itemBuilds = await Promise.all(plans.map(async (plan) => {
    const item = projectItems.find((projectItem) => projectItem._id.toString() === plan.projectItemId?.toString());
    const blueprint = await Blueprint.findOne(itemScopedQuery(projectId, plan.projectItemId?.toString())).sort({ version: -1 });

    return blueprint?.quotation
      ? {
        item,
        built: {
          blueprint,
          totalAmount: plan.totalAmount,
          isPayInFull: plan.isPayInFull,
          surchargePercent: 0,
          stages: plan.stages,
        },
      }
      : null;
  }));

  return itemBuilds.filter(Boolean) as Array<{ item?: any; built: BuiltPaymentStages }>;
}

function buildAggregateContractData(
  project: any,
  itemBuilds: Array<{ item?: any; built: BuiltPaymentStages }>,
  paymentType: 'full' | 'installment',
) {
  const firstBuilt = itemBuilds[0]?.built;
  if (!firstBuilt) {
    throw AppError.badRequest('No approved item quotations are available for contract generation');
  }

  const totalAmount = itemBuilds.reduce((sum, entry) => sum + entry.built.totalAmount, 0);
  const maxStageCount = Math.max(...itemBuilds.map((entry) => entry.built.stages.length));
  const stages = Array.from({ length: maxStageCount }).map((_, index) => {
    const matchingStages = itemBuilds
      .map((entry) => entry.built.stages[index])
      .filter(Boolean);
    const firstStage = matchingStages[0];
    const amount = matchingStages.reduce((sum, stage) => sum + stage.amount, 0);
    const percentage = totalAmount > 0 ? Math.round((amount / totalAmount) * 10000) / 100 : 0;
    return {
      label: paymentType === 'full' ? 'Full Payment' : firstStage?.label || `Stage ${index + 1}`,
      description: firstStage?.description,
      percentage,
      amount,
    };
  });

  const quotationLineItems = itemBuilds.flatMap(({ item, built }) => {
    const itemTitle = item?.title || project.title;
    return (built.blueprint.quotation?.lineItems || []).map((lineItem: any) => ({
      label: `${itemTitle}: ${lineItem.label}`,
      quantity: lineItem.quantity,
      materials: lineItem.materials,
      labor: lineItem.labor,
      amount: lineItem.amount,
    }));
  });

  const lineItems = itemBuilds.flatMap(({ item }) => (
    (item?.lineItems || []).map((lineItem: any) => ({
      label: `${item.title}: ${lineItem.label}`,
      length: lineItem.length,
      width: lineItem.width,
      height: lineItem.height,
      quantity: lineItem.quantity,
      notes: lineItem.notes,
    }))
  ));

  return {
    ...buildContractData(project, firstBuilt.blueprint, {
      totalAmount,
      isPayInFull: paymentType === 'full',
      stages,
    }),
    serviceType: itemBuilds.map(({ item }) => item?.title).filter(Boolean).join(', ') || project.serviceType,
    lineItems,
    quotationLineItems,
    quotationFees: itemBuilds.reduce((sum, entry) => sum + (entry.built.blueprint.quotation?.fees || 0), 0),
    scopeOfWork: itemBuilds
      .map(({ item, built }) => {
        const title = item?.title || project.title;
        const scope = built.blueprint.quotation?.inclusions || built.blueprint.quotation?.breakdown;
        return scope ? `${title}: ${scope}` : null;
      })
      .filter(Boolean)
      .join('\n\n') || firstBuilt.blueprint.quotation?.inclusions || firstBuilt.blueprint.quotation?.breakdown,
  };
}

export async function selectPaymentPlan(
  projectId: string,
  input: SelectPaymentPlanInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId)
    .populate('customerId', 'firstName lastName email phone address signatureKey')
    .populate('engineerIds', 'firstName lastName phone signatureKey');

  if (!project) throw AppError.notFound('Project not found');
  if (String((project.customerId as any)._id ?? project.customerId) !== actorId) {
    throw AppError.forbidden('Only the project customer can select a payment plan');
  }

  const projectItems = await getActiveProjectItems(projectId);
  const hasMultipleItems = projectItems.length > 1;

  if (hasMultipleItems && !input.projectItemId) {
    throw AppError.badRequest('Select a project item before choosing a payment plan');
  }

  const selectedItem = input.projectItemId
    ? projectItems.find((item) => item._id.toString() === input.projectItemId)
    : projectItems[0];

  if (input.projectItemId && !selectedItem) {
    throw AppError.notFound('Project item not found');
  }

  const paymentTargets = selectedItem
    ? [{ item: selectedItem, projectItemId: selectedItem._id.toString() }]
    : [{ item: undefined, projectItemId: input.projectItemId }];

  const selectedItemAllowsPayment = selectedItem
    ? [ProjectStatus.APPROVED, ProjectStatus.PAYMENT_PENDING].includes(selectedItem.status)
    : false;
  const projectAllowsPayment = [ProjectStatus.APPROVED, ProjectStatus.PAYMENT_PENDING].includes(project.status);

  if (!projectAllowsPayment && !selectedItemAllowsPayment) {
    throw AppError.badRequest('Payment plan selection is only available after blueprint approval');
  }

  const itemBuilds = await Promise.all(paymentTargets.map(async (target) => ({
    item: target.item,
    projectItemId: target.projectItemId,
    built: await buildPaymentStages(projectId, input.paymentType, target.projectItemId),
  })));

  const existingPlans = await Promise.all(
    paymentTargets.map((target) => PaymentPlan.findOne(itemScopedQuery(String(project._id), target.projectItemId))),
  );

  if (existingPlans.some(Boolean)) {
    throw AppError.conflict('A payment plan already exists for this item', ErrorCode.DUPLICATE_ENTRY);
  }

  const plans = await PaymentPlan.insertMany(itemBuilds.map(({ projectItemId, built }) => ({
    projectId: project._id,
    projectItemId,
    totalAmount: built.totalAmount,
    isPayInFull: built.isPayInFull,
    stages: built.stages,
    createdBy: actorId,
  })));

  if (project.status === ProjectStatus.APPROVED) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.PAYMENT_PENDING);
    project.status = ProjectStatus.PAYMENT_PENDING;
  }
  await project.save();
  const itemIds = paymentTargets
    .map((target) => target.projectItemId)
    .filter((projectItemId): projectItemId is string => Boolean(projectItemId));
  if (itemIds.length) {
    await ProjectItem.updateMany({ _id: { $in: itemIds } }, { $set: { status: ProjectStatus.PAYMENT_PENDING } });
  }

  if ([ProjectStatus.BLUEPRINT, ProjectStatus.APPROVED].includes(project.status)) {
    const activeItems = await getActiveProjectItems(projectId);
    const paymentReadyStatuses = new Set([
      ProjectStatus.PAYMENT_PENDING,
      ProjectStatus.FABRICATION,
      ProjectStatus.COMPLETED,
    ]);
    const allItemsPaymentReady = activeItems.length > 0
      && activeItems.every((item) => paymentReadyStatuses.has(item.status));

    if (allItemsPaymentReady && project.status !== ProjectStatus.PAYMENT_PENDING) {
      projectStateMachine.assertTransition(project.status, ProjectStatus.PAYMENT_PENDING);
      project.status = ProjectStatus.PAYMENT_PENDING;
      await project.save();
    }
  }

  await AuditLog.create({
    action: AuditAction.PAYMENT_PLAN_CREATED,
    actorId,
    targetType: 'payment_plan',
    targetId: plans[0]?._id || project._id,
    details: {
      projectId,
      paymentType: input.paymentType,
      totalAmount: itemBuilds.reduce((sum, entry) => sum + entry.built.totalAmount, 0),
      surchargePercent: itemBuilds[0]?.built.surchargePercent || 0,
      itemCount: plans.length,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  await createAndSendNotification(
    actorId,
    NotificationCategory.PAYMENT,
    'Payment Plan Created',
    `Your ${input.paymentType === 'full' ? 'full payment' : 'installment'} plan for "${project.title}" is ready. You can now continue to payments.`,
    buildProjectItemLink(project._id.toString(), 'payments', paymentTargets[0]?.projectItemId),
  );

  return { paymentPlan: plans[0], paymentPlans: plans, project };
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

  if (![ProjectStatus.BLUEPRINT, ProjectStatus.APPROVED, ProjectStatus.PAYMENT_PENDING, ProjectStatus.FABRICATION, ProjectStatus.COMPLETED].includes(project.status)) {
    throw AppError.badRequest('Fabrication team can only be assigned after the blueprint has been approved');
  }

  const latestBlueprint = await Blueprint.findOne({ projectId }).sort({ version: -1 }).select('status');
  if (!latestBlueprint) {
    throw AppError.badRequest('Fabrication team cannot be assigned until a blueprint exists');
  }

  if (latestBlueprint.status !== 'approved') {
    throw AppError.badRequest('Fabrication team can only be assigned after the customer approves the blueprint and costing');
  }

  const initialPaymentVerified = await hasRequiredInitialFabricationPayment(projectId);
  if (!initialPaymentVerified) {
    throw AppError.badRequest('Fabrication team can only be assigned after the first payment has been cashier-verified');
  }

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

  if ([ProjectStatus.BLUEPRINT, ProjectStatus.APPROVED].includes(project.status)) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.PAYMENT_PENDING);
    project.status = ProjectStatus.PAYMENT_PENDING;
  }

  if (project.status === ProjectStatus.PAYMENT_PENDING) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.FABRICATION);
    project.status = ProjectStatus.FABRICATION;
  }

  await project.save();

  await ProjectItem.updateMany(
    { projectId: project._id, status: ProjectStatus.PAYMENT_PENDING },
    { $set: { status: ProjectStatus.FABRICATION } },
  );

  try {
    await seedFabricationItems(project._id.toString());
  } catch (err) {
    logger.error(`Failed to seed fabrication items for project ${project._id}`, err);
  }

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

  await createAndSendNotification(
    project.customerId.toString(),
    NotificationCategory.FABRICATION,
    'Fabrication Started',
    `The fabrication team has been assigned for "${project.title}". Fabrication can now begin.`,
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

  if (
    input.status === ProjectStatus.SUBMITTED
    && project.contractStatus !== ContractStatus.UPLOADED
  ) {
    throw AppError.badRequest('Upload the signed contract before submitting this project');
  }

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
    .populate('engineerIds', 'firstName lastName phone')
    .populate('designReviewedBy', 'firstName lastName')
    .populate('customerReview.submittedBy', 'firstName lastName')
    .populate('initialDesignBackfill.backfilledBy', 'firstName lastName')
    .populate('fabricationLeadId', 'firstName lastName')
    .populate('fabricationAssistantIds', 'firstName lastName')
    .populate('visitReportId');

  if (!project) throw AppError.notFound('Project not found');

  // Fallback: if visitReportId was never linked, find the latest submitted report for the appointment
  if (!project.visitReportId && project.appointmentId) {
    const fallbackReport = await VisitReport.findOne({
      appointmentId: project.appointmentId,
      status: { $in: [VisitReportStatus.SUBMITTED, VisitReportStatus.COMPLETED] },
    }).sort({ createdAt: -1 });

    if (fallbackReport) {
      // Persist the link so future queries don't need the fallback
      project.visitReportId = fallbackReport._id;
      await project.save();
      // Re-populate since we just set it as an ObjectId
      await project.populate('visitReportId');
    }
  }

  // Customers can only see their own
  if (
    actorRoles.includes(Role.CUSTOMER) &&
    !actorRoles.some(r => [Role.ADMIN, Role.SALES_STAFF, Role.ENGINEER].includes(r))
  ) {
    if (project.customerId._id?.toString() !== actorId) {
      throw AppError.forbidden('Access denied');
    }
    if (project.status === ProjectStatus.DRAFT && project.contractStatus !== ContractStatus.UPLOADED) {
      throw AppError.notFound('Project not found');
    }
  }

  // Epic 9: Engineer/Fabrication staff masking (AND Admin as requested)
  const isPrivileged = actorRoles.some((r) =>
    [Role.SALES_STAFF, Role.CASHIER].includes(r as Role)
  );

  if (!isPrivileged) {
    // Mask financial data for engineers/fabricators
    const maskedProject = await attachProjectItems(project);
    maskedProject.totalCost = undefined;
    return maskedProject;
  }

  return attachProjectItems(project);
}

// ── List Projects ──

export async function getProjectByVisitReportId(visitReportId: string) {
  // Direct match: project was created from this visit report
  const project = await Project.findOne({ visitReportId }).select('_id title serviceType status contractStatus').lean();
  if (project) return project;
  // Indirect match: ocular visit report linked to the consultation's project
  const report = await VisitReport.findById(visitReportId).select('linkedProjectId').lean();
  if (report?.linkedProjectId) {
    return Project.findById(report.linkedProjectId).select('_id title serviceType status contractStatus').lean();
  }

  return null;
}

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
    filter.$and = [
      {
        $or: [
          { contractStatus: ContractStatus.UPLOADED },
          { contractStatus: { $exists: false }, status: { $ne: ProjectStatus.DRAFT } },
        ],
      },
    ];
  } else if (actorRoles.includes(Role.SALES_STAFF) && !actorRoles.some(r => [Role.ADMIN].includes(r))) {
    filter.salesStaffId = actorId;
  } else if (actorRoles.includes(Role.ENGINEER) && !actorRoles.some(r => [Role.ADMIN, Role.SALES_STAFF].includes(r))) {
    filter.$or = [
      { engineerIds: actorId },
      { status: ProjectStatus.SUBMITTED, engineerIds: { $size: 0 } },
    ];
  } else if (actorRoles.includes(Role.FABRICATION_STAFF) && !actorRoles.some(r => [Role.ADMIN, Role.ENGINEER].includes(r))) {
    // Fabrication staff see all projects currently in the fabrication stage
    filter.status = ProjectStatus.FABRICATION;
  }

  if (query.status === 'active') {
    filter.status = { $in: activeProjectStatusesForRoles(actorRoles) };
  } else if (query.status) {
    filter.status = query.status;
  }
  if (query.customerId && !filter.customerId) filter.customerId = query.customerId;
  if (query.salesStaffId && !filter.salesStaffId) filter.salesStaffId = query.salesStaffId;
  if (query.engineerId && !filter.engineerIds) filter.engineerIds = query.engineerId;
  if (query.search?.trim()) {
    const searchOr = await buildProjectSearchConditions(query.search);
    appendSearchCondition(filter, searchOr);
  }

  const sortField = query.sortBy || 'createdAt';
  const sortOrder = query.sortOrder === 'asc' ? 1 : -1;

  const [projects, total] = await Promise.all([
    Project.find(filter)
      .populate('customerId', 'firstName lastName email')
      .populate('salesStaffId', 'firstName lastName')
      .populate('engineerIds', 'firstName lastName phone')
      .populate('appointmentId', 'date slotCode')
      .sort({ [sortField]: sortOrder })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Project.countDocuments(filter),
  ]);

  return {
    items: await enrichProjectsForList(projects),
    total,
    hasMore: page * limit < total,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

export async function repairMissingProjectNumbers() {
  const projects = await Project.find({
    $or: [
      { projectNumber: { $exists: false } },
      { projectNumber: null },
      { projectNumber: '' },
    ],
  })
    .select('_id')
    .sort({ createdAt: 1 });

  const repaired: Array<{ projectId: string; projectNumber: string }> = [];

  for (const project of projects) {
    const projectNumber = await generateProjectNumber();
    await Project.updateOne(
      { _id: project._id },
      { $set: { projectNumber } },
      { runValidators: false },
    );
    repaired.push({ projectId: project._id.toString(), projectNumber });
  }

  return { repairedCount: repaired.length, repaired };
}

/**
 * Batch-enrich projects for the list view in a single pass.
 * Replaces the previous N+1 pattern (ensureProjectItems per project + enrichWithBlueprintStatus)
 * with 2-4 bulk queries regardless of project count.
 */
async function enrichProjectsForList(projects: any[]) {
  if (!projects.length) return projects;
  const projectIds = projects.map((p) => p._id);

  // 1. Batch-fetch latest blueprint status + existing project items in parallel
  const [latestBlueprints, existingItems] = await Promise.all([
    Blueprint.aggregate([
      { $match: { projectId: { $in: projectIds } } },
      { $sort: { version: -1 } },
      { $group: { _id: '$projectId', status: { $first: '$status' } } },
    ]),
    ProjectItem.find({ projectId: { $in: projectIds } })
      .sort({ createdAt: 1 })
      .lean(),
  ]);

  const bpMap = new Map(latestBlueprints.map((b) => [String(b._id), b.status]));

  // Group existing items by projectId
  const itemMap = new Map<string, any[]>();
  for (const item of existingItems) {
    const key = String(item.projectId);
    const list = itemMap.get(key);
    if (list) list.push(item);
    else itemMap.set(key, [item]);
  }

  // 2. Batch-create missing project items using bulkWrite (only when needed)
  const bulkOps: any[] = [];
  for (const project of projects) {
    const pid = String(project._id);
    const existing = itemMap.get(pid) || [];
    const existingTypes = new Set(existing.map((i: any) => i.serviceType));
    const serviceTypes = (project.serviceTypes?.length ? project.serviceTypes : [project.serviceType])
      .filter((st: string | undefined): st is string => Boolean(st?.trim()));

    for (const serviceType of serviceTypes) {
      if (existingTypes.has(serviceType)) continue;
      bulkOps.push({
        updateOne: {
          filter: { projectId: project._id, serviceType, deletedAt: null },
          update: {
            $setOnInsert: {
              projectId: project._id,
              appointmentId: project.appointmentId,
              serviceType,
              title: readableServiceTitle(serviceType),
              status: project.status || ProjectStatus.DRAFT,
              measurements: project.measurements,
              materials: project.materialType,
              finishes: project.finishColor,
              notes: project.notes,
              initialDesignKeys: project.initialDesignKeys || [],
              initialDesignNotes: project.initialDesignNotes,
              designReviewStatus: hasInitialDesignSubmission(project) ? 'pending' : 'not_required',
              mediaKeys: project.mediaKeys || [],
              deletedAt: null,
            },
          },
          upsert: true,
        },
      });
    }
  }

  if (bulkOps.length > 0) {
    await ProjectItem.bulkWrite(bulkOps, { ordered: false });

    // Re-fetch items for projects that had missing items
    const modifiedIds = [...new Set(bulkOps.map((op) => op.updateOne.filter.projectId))];
    const newItems = await ProjectItem.find({ projectId: { $in: modifiedIds } })
      .sort({ createdAt: 1 })
      .lean();

    // Rebuild item map entries for modified projects
    for (const id of modifiedIds) {
      itemMap.set(String(id), []);
    }
    for (const item of newItems) {
      const key = String(item.projectId);
      itemMap.get(key)!.push(item);
    }
  }

  // 3. Assemble final results
  return projects.map((p) => {
    const obj = { ...p };
    obj.latestBlueprintStatus = bpMap.get(String(obj._id)) || null;
    obj.items = itemMap.get(String(obj._id)) || [];
    return obj;
  });
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

// ── Upload manually signed contract ──

export async function uploadSignedContract(
  projectId: string,
  input: UploadSignedContractInput,
  actorId: string,
  actorRoles: Role[],
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  const isAdmin = actorRoles.includes(Role.ADMIN);
  const isAssignedSales = project.salesStaffId.toString() === actorId;
  if (!isAdmin && !isAssignedSales) {
    throw AppError.forbidden('Only admins or the assigned sales staff can upload the signed contract');
  }

  const engineeringStarted = project.engineerIds.length > 0 || ![ProjectStatus.DRAFT, ProjectStatus.SUBMITTED].includes(project.status);
  if (engineeringStarted) {
    throw AppError.badRequest('Signed contract can only be uploaded or replaced before engineering starts');
  }

  assertSignedContractKey(input.contractFileKey);

  const exists = await verifyFileExists(input.contractFileKey);
  if (!exists) {
    throw AppError.badRequest('Uploaded contract file could not be verified. Please upload the file again.');
  }

  const wasMissing = project.contractStatus !== ContractStatus.UPLOADED;
  const oldStatus = project.status;

  project.contractStatus = ContractStatus.UPLOADED;
  project.contractFileKey = input.contractFileKey;
  project.contractFileName = input.contractFileName || getObjectFileName(input.contractFileKey);
  project.contractContentType = input.contractContentType || inferContractContentType(input.contractFileKey);
  project.contractFileSize = input.contractFileSize;
  project.contractUploadedAt = new Date();
  project.contractUploadedBy = actorId as unknown as Types.ObjectId;

  if (project.status === ProjectStatus.DRAFT) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.SUBMITTED);
    project.status = ProjectStatus.SUBMITTED;
  }

  await project.save();

  if (oldStatus === ProjectStatus.DRAFT && project.status === ProjectStatus.SUBMITTED) {
    await ProjectItem.updateMany(
      { projectId: project._id, status: ProjectStatus.DRAFT },
      { $set: { status: ProjectStatus.SUBMITTED } },
    );
  }

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: {
      action: wasMissing ? 'signed_contract_uploaded' : 'signed_contract_replaced',
      contractFileKey: input.contractFileKey,
      fromStatus: oldStatus,
      toStatus: project.status,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  if (wasMissing) {
    await notifyProjectSubmittedAfterContract(project);
  } else {
    await createAndSendNotification(
      project.customerId,
      NotificationCategory.PROJECT,
      'Signed Contract Updated',
      `The signed contract for "${project.title}" has been replaced.`,
      `/projects/${project._id}/contract`,
    );
  }

  return attachProjectItems(project);
}

// ── Generate Contract PDF ──

export async function generateContract(
  projectId: string,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  generatedContractFlowDisabled();

  const project = await Project.findById(projectId)
    .populate('customerId', 'firstName lastName email phone address signatureKey')
    .populate('engineerIds', 'firstName lastName phone signatureKey');

  if (!project) throw AppError.notFound('Project not found');

  // Must be in APPROVED or later
  const allowedStatuses = [
    ProjectStatus.APPROVED,
    ProjectStatus.PAYMENT_PENDING,
    ProjectStatus.FABRICATION,
    ProjectStatus.COMPLETED,
  ];
  if (!allowedStatuses.includes(project.status)) {
    throw AppError.badRequest('Contract can only be generated after blueprint acceptance');
  }

  const projectItems = await getActiveProjectItems(projectId);
  const plans = await PaymentPlan.find({ projectId });
  const relevantPlans = projectItems.length
    ? plans.filter((plan) => projectItems.some((item) => item._id.toString() === plan.projectItemId?.toString()))
    : plans.filter((plan) => !plan.projectItemId);
  if (!relevantPlans.length) {
    throw AppError.badRequest('No payment plan found for this project');
  }

  const customer = project.customerId as any;
  const itemBuilds = await Promise.all(relevantPlans.map(async (plan) => {
    const item = projectItems.find((projectItem) => projectItem._id.toString() === plan.projectItemId?.toString());
    const blueprint = await Blueprint.findOne(itemScopedQuery(projectId, plan.projectItemId?.toString())).sort({ version: -1 });
    return blueprint?.quotation
      ? {
        item,
        built: {
          blueprint,
          totalAmount: plan.totalAmount,
          isPayInFull: plan.isPayInFull,
          surchargePercent: 0,
          stages: plan.stages,
        },
      }
      : null;
  }));
  const validItemBuilds = itemBuilds.filter(Boolean) as Array<{ item?: any; built: BuiltPaymentStages }>;
  if (!validItemBuilds.length) {
    throw AppError.badRequest('No quotation found for this project');
  }
  const paymentType = relevantPlans.every((plan) => plan.isPayInFull) ? 'full' : 'installment';
  const contractData = buildAggregateContractData(project, validItemBuilds, paymentType);

  const { originalKey, copyKey } = await generateAndUploadContract(contractData);

  // Store the original key on the project
  project.contractKey = originalKey;
  project.contractGeneratedAt = new Date();
  project.originalContractDownloadedAt = undefined as any; // reset one-time download on regeneration
  await project.save();

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: { action: 'contract_generated', originalKey, copyKey },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    customer._id,
    NotificationCategory.SYSTEM,
    'Contract Ready',
    `The contract for your project "${project.title}" has been generated and is ready for download.`,
    `/projects/${project._id}`,
  );

  logger.info(`Contract generated for project ${projectId}: ${originalKey}`);

  return { originalKey, copyKey, project };
}

// ── Sign Contract (Customer) ──

export async function signContract(
  projectId: string,
  input: SignContractInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  generatedContractFlowDisabled();

  const project = await Project.findById(projectId)
    .populate('customerId', 'firstName lastName email phone address signatureKey')
    .populate('engineerIds', 'firstName lastName phone signatureKey');

  if (!project) throw AppError.notFound('Project not found');

  // Only the customer can sign
  if (String(project.customerId._id ?? project.customerId) !== actorId) {
    throw AppError.forbidden('Only the project customer can sign the contract');
  }

  // Must have a contract generated already
  if (!project.contractKey) {
    throw AppError.badRequest('No contract has been generated for this project yet');
  }

  // Must not already be signed
  if (project.contractSignedAt) {
    throw AppError.badRequest('Contract has already been signed');
  }

  // Save signature key on the user record
  await User.findByIdAndUpdate(actorId, { signatureKey: input.signatureKey });

  // Save signature key + signed timestamp on the project
  project.contractSignatureKey = input.signatureKey;
  project.contractSignedAt = new Date();
  await project.save();

  // Re-generate contract PDF with the signature embedded
  try {
    const projectItems = await getActiveProjectItems(projectId);
    const plans = await PaymentPlan.find({ projectId });
    const relevantPlans = projectItems.length
      ? plans.filter((plan) => projectItems.some((item) => item._id.toString() === plan.projectItemId?.toString()))
      : plans.filter((plan) => !plan.projectItemId);

    if (relevantPlans.length) {
      const itemBuilds = await Promise.all(relevantPlans.map(async (plan) => {
        const item = projectItems.find((projectItem) => projectItem._id.toString() === plan.projectItemId?.toString());
        const blueprint = await Blueprint.findOne(itemScopedQuery(projectId, plan.projectItemId?.toString())).sort({ version: -1 });
        return blueprint?.quotation
          ? {
            item,
            built: {
              blueprint,
              totalAmount: plan.totalAmount,
              isPayInFull: plan.isPayInFull,
              surchargePercent: 0,
              stages: plan.stages,
            },
          }
          : null;
      }));
      const validItemBuilds = itemBuilds.filter(Boolean) as Array<{ item?: any; built: BuiltPaymentStages }>;
      const paymentType = relevantPlans.every((plan) => plan.isPayInFull) ? 'full' : 'installment';

      if (validItemBuilds.length) {
        const contractData: ContractData = {
          ...buildAggregateContractData(project, validItemBuilds, paymentType),
          customerSignatureKey: input.signatureKey,
          contractSignedAt: project.contractSignedAt,
        };

        const { originalKey } = await generateAndUploadContract(contractData);
        project.contractKey = originalKey;
        project.contractGeneratedAt = new Date();
        project.originalContractDownloadedAt = undefined as any; // reset one-time download
        await project.save();

        logger.info(`Contract re-generated with signature for project ${projectId}: ${originalKey}`);
      }
    }
  } catch (err) {
    logger.error('Failed to re-generate contract with signature', err);
  }

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: { action: 'contract_signed', signatureKey: input.signatureKey },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify engineer(s) and admin
  const engineerIds = (project.engineerIds as any[]).map((e: any) => e._id ?? e);
  for (const engId of engineerIds) {
    await createAndSendNotification(
      engId,
      NotificationCategory.SYSTEM,
      'Contract Signed',
      `Customer signed the contract for project "${project.title}". Payments can now proceed.`,
      `/projects/${project._id}`,
    );
  }

  await notifyRole(
    Role.ADMIN,
    NotificationCategory.SYSTEM,
    'Contract Signed',
    `Contract for project "${project.title}" has been signed by the customer.`,
    `/projects/${project._id}`,
  );

  return project;
}

export async function signEngineerContract(
  projectId: string,
  input: SignEngineerContractInput,
  actorId: string,
  actorRoles: Role[],
  ip?: string,
  ua?: string,
) {
  generatedContractFlowDisabled();

  const project = await Project.findById(projectId).populate('engineerIds', 'firstName lastName email signatureKey');
  if (!project) throw AppError.notFound('Project not found');

  const isAdmin = actorRoles.includes(Role.ADMIN);
  const isAssignedEngineer = project.engineerIds.some((eng) => String((eng as any)._id ?? eng) === actorId);

  if (!isAdmin && !isAssignedEngineer) {
    throw AppError.forbidden('Only assigned engineers or admins can sign this contract');
  }

  await User.findByIdAndUpdate(actorId, { signatureKey: input.signatureKey });

  project.engineerContractSignatureKey = input.signatureKey;
  project.engineerContractSignedAt = new Date();
  project.engineerContractSignedBy = actorId as unknown as Types.ObjectId;
  await project.save();

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: { action: 'engineer_contract_signed', signatureKey: input.signatureKey },
    ipAddress: ip,
    userAgent: ua,
  });

  await createAndSendNotification(
    project.customerId,
    NotificationCategory.SYSTEM,
    'Engineer Contract Signed',
    `Engineering has signed the contract for project "${project.title}". Design and costing can now be sent for your review.`,
    `/projects/${project._id}`,
  );

  return project;
}

// ── Get Contract Download URL ──

export async function getContractDownloadUrl(
  projectId: string,
  copy: 'original' | 'copy',
  actorId: string,
  actorRoles: Role[],
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  const isInternal = actorRoles.some((role) => [
    Role.ADMIN,
    Role.SALES_STAFF,
    Role.APPOINTMENT_AGENT,
    Role.ENGINEER,
    Role.CASHIER,
    Role.FABRICATION_STAFF,
  ].includes(role));
  const isCustomerOwner = actorRoles.includes(Role.CUSTOMER) && project.customerId.toString() === actorId;
  if (!isInternal && !isCustomerOwner) {
    throw AppError.forbidden('Access denied');
  }

  if (project.contractStatus !== ContractStatus.UPLOADED || !project.contractFileKey) {
    throw AppError.badRequest('No signed contract has been uploaded for this project');
  }

  const url = await generateDownloadUrl(project.contractFileKey);
  return { url, key: project.contractFileKey, originalDownloaded: false };
}

// ── Customer: Submit/Skip Internal Project Review ──

export async function submitProjectReview(
  projectId: string,
  input: SubmitProjectReviewInput,
  actorId: string,
  actorRoles: Role[],
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  const isAdmin = actorRoles.includes(Role.ADMIN);
  const isCustomerOwner = project.customerId.toString() === actorId;
  if (!isAdmin && !isCustomerOwner) {
    throw AppError.forbidden('Only the project customer can submit a review');
  }

  if (project.status !== ProjectStatus.COMPLETED) {
    throw AppError.badRequest('Reviews are only available after project completion');
  }

  if (project.customerReview?.submittedAt) {
    throw AppError.conflict('A review has already been submitted for this project');
  }

  project.customerReview = {
    rating: input.rating,
    comment: input.comment,
    submittedAt: new Date(),
    submittedBy: actorId as unknown as Types.ObjectId,
    skippedAt: undefined,
    skippedReason: undefined,
  };
  await project.save();

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: {
      action: 'customer_review_submitted',
      rating: input.rating,
      hasComment: !!input.comment,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  await createAndSendNotification(
    project.salesStaffId,
    NotificationCategory.PROJECT,
    'Customer Review Submitted',
    `A ${input.rating}-star review was submitted for project "${project.title}".`,
    `/projects/${project._id}`,
  );

  return project;
}

export async function skipProjectReview(
  projectId: string,
  input: SkipProjectReviewInput,
  actorId: string,
  actorRoles: Role[],
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  const isAdmin = actorRoles.includes(Role.ADMIN);
  const isCustomerOwner = project.customerId.toString() === actorId;
  if (!isAdmin && !isCustomerOwner) {
    throw AppError.forbidden('Only the project customer can skip review');
  }

  if (project.status !== ProjectStatus.COMPLETED) {
    throw AppError.badRequest('Review options are only available after project completion');
  }

  if (project.customerReview?.submittedAt) {
    throw AppError.conflict('A review has already been submitted for this project');
  }

  if (project.customerReview?.skippedAt) {
    return project;
  }

  project.customerReview = {
    ...project.customerReview,
    skippedAt: new Date(),
    skippedReason: input.reason,
  };
  await project.save();

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: {
      action: 'customer_review_skipped',
      reason: input.reason || null,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  return project;
}

// ── Customer: Confirm Installation Schedule ──

export async function confirmInstallation(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
  projectItemId?: string,
) {
  const project = await Project.findById(projectId)
    .populate('customerId', 'firstName lastName email')
    .populate('fabricationLeadId', '_id firstName lastName');
  if (!project) throw AppError.notFound('Project not found');

  if (project.status !== ProjectStatus.FABRICATION) {
    throw AppError.badRequest('Project is not currently in the fabrication phase');
  }

  const isAdmin = actorRoles.includes(Role.ADMIN);
  const isCustomer = actorRoles.includes(Role.CUSTOMER) && project.customerId._id?.toString() === actorId;

  if (!isAdmin && !isCustomer) {
    throw AppError.forbidden('Only the project customer or an admin can confirm installation');
  }

  const projectItems = await ProjectItem.find({ projectId: project._id }).sort({ createdAt: 1 });
  const hasMultipleItems = projectItems.length > 1;
  if (hasMultipleItems && !projectItemId) {
    throw AppError.badRequest('Select a project item before confirming installation');
  }

  const selectedItem = projectItemId
    ? projectItems.find((item) => item._id.toString() === projectItemId)
    : projectItems[0];

  if (projectItemId && !selectedItem) {
    throw AppError.notFound('Project item not found');
  }

  if (selectedItem) {
    if ((selectedItem as any).installationConfirmedAt) {
      return attachProjectItems(project);
    }

    (selectedItem as any).installationConfirmedAt = new Date();
    await selectedItem.save();

    const allItemsConfirmed = projectItems.every((item) => (
      item._id.toString() === selectedItem._id.toString()
        ? true
        : Boolean((item as any).installationConfirmedAt)
    ));

    if (allItemsConfirmed) {
      (project as any).installationConfirmedAt = new Date();
      await project.save();
    }
  } else {
    if ((project as any).installationConfirmedAt) {
      return attachProjectItems(project);
    }

    (project as any).installationConfirmedAt = new Date();
    await project.save();
  }

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: selectedItem ? 'project_item' : 'project',
    targetId: selectedItem?._id || project._id,
    details: { installationConfirmed: true, projectId, projectItemId: selectedItem?._id || null },
  });

  // Notify fabrication lead and all admin
  const customerRef = project.customerId as any;
  const customerName = `${customerRef.firstName} ${customerRef.lastName}`;

  if (project.fabricationLeadId) {
    const leadId = (project.fabricationLeadId as any)._id ?? project.fabricationLeadId;
    await createAndSendNotification(
      leadId,
      NotificationCategory.PROJECT,
      'Installation Confirmed',
      `Customer ${customerName} has confirmed the installation schedule for "${selectedItem?.title || project.title}". You may now proceed to mark it as Done.`,
      buildProjectItemLink(project._id.toString(), 'fabrication', selectedItem?._id?.toString()),
    );
  }

  await notifyRole(
    Role.ADMIN,
    NotificationCategory.PROJECT,
    'Installation Confirmed',
    `Customer ${customerName} confirmed installation for "${selectedItem?.title || project.title}".`,
    buildProjectItemLink(project._id.toString(), 'fabrication', selectedItem?._id?.toString()),
  );

  return attachProjectItems(project);
}
