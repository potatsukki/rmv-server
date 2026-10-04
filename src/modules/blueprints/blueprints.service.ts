import {
  Blueprint, BlueprintDraft, Project, ProjectItem, User, AuditLog, PaymentPlan,
} from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import {
  BlueprintStatus, BlueprintComponent, ProjectStatus,
  AuditAction, NotificationCategory, Role, PaymentStageStatus,
} from '../../utils/constants.js';
import { blueprintStateMachine, projectStateMachine } from '../../utils/stateMachine.js';
import { createAndSendNotification, notifyRole } from '../notifications/socket.service.js';
import { sendBlueprintUploadedEmail } from '../notifications/email.service.js';
import { getInstallmentConfig } from '../config/config.service.js';
import { deleteFile } from '../uploads/upload.service.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';
import { isDeepStrictEqual } from 'node:util';
import type { IBlueprint } from '../../models/Blueprint.js';
import type {
  UploadBlueprintInput,
  RevisionUploadInput,
  ApproveBlueprintInput,
  RequestRevisionInput,
  AcceptBlueprintInput,
  UpsertBlueprintDraftInput,
} from './blueprints.validation.js';
import type { Types } from 'mongoose';

const MAX_REVISIONS = 3;

interface BlueprintDraftFileInput {
  key: string;
  name: string;
  type: string;
  size: number;
  uploadedAt: Date;
}

type BlueprintDraftInternalCostsInput = {
  estimatedMaterials?: string;
  fabricationWork?: string;
  finishingPolishing?: string;
  installation?: string;
  deliveryMobilization?: string;
  overheadMisc?: string;
  markupProfit?: string;
};

interface BlueprintDraftQuotationInput {
  internalCosts?: BlueprintDraftInternalCostsInput;
  costPreset?: {
    serviceType?: string;
    complexity?: 'simple' | 'standard' | 'complex';
    suggestedAt?: Date | string;
    suggestedValues?: BlueprintDraftInternalCostsInput;
  };
  discount?: string;
  subtotal?: string;
  total?: string;
  paymentOption?: 'full' | 'milestone';
  systemEstimatedDuration?: string;
  adjustedEstimatedDuration?: string;
  inclusions?: string;
  exclusions?: string;
  lineItems?: Array<{
    label: string;
    quantity: number;
    materials: string;
    labor: string;
  }>;
  fees?: string;
  validityDays?: string;
  breakdown?: string;
  estimatedDuration?: string;
  engineerNotes?: string;
  paymentMilestones?: Array<{
    label: string;
    description?: string;
    percentage?: number;
    amount?: number;
    trigger?: string;
  }>;
}

const INTERNAL_COST_KEYS = [
  'estimatedMaterials',
  'fabricationWork',
  'finishingPolishing',
  'installation',
  'deliveryMobilization',
  'overheadMisc',
  'markupProfit',
] as const;

function asMoney(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeInternalCostStrings(
  values?: Partial<Record<typeof INTERNAL_COST_KEYS[number], string>>,
) {
  if (!values) return undefined;
  return INTERNAL_COST_KEYS.reduce((acc, key) => {
    acc[key] = values[key] ?? '';
    return acc;
  }, {} as Record<typeof INTERNAL_COST_KEYS[number], string>);
}

function buildDefaultPaymentMilestones(total: number, paymentOption: 'full' | 'milestone') {
  if (paymentOption === 'full') {
    return [{
      label: 'Full Payment',
      description: '100% payable once the quotation is approved and selected.',
      percentage: 100,
      amount: total,
      trigger: 'quotation approved / payment plan selected',
    }];
  }

  return [
    {
      label: 'Down Payment',
      description: '30% payable once the quotation is approved and payment plan is selected.',
      percentage: 30,
      amount: Math.round(total * 0.30 * 100) / 100,
      trigger: 'quotation approved / payment plan selected',
    },
    {
      label: 'During Fabrication',
      description: '40% payable when fabrication starts.',
      percentage: 40,
      amount: Math.round(total * 0.40 * 100) / 100,
      trigger: 'fabrication started',
    },
    {
      label: 'Upon Completion',
      description: '30% payable when fabrication is completed.',
      percentage: 30,
      amount: Math.round(total * 0.30 * 100) / 100,
      trigger: 'fabrication completed',
    },
  ];
}

function normalizeDraftFile(
  file?: BlueprintDraftFileInput | null,
): BlueprintDraftFileInput | null | undefined {
  if (file === undefined) return undefined;
  if (file === null) return null;

  return {
    key: file.key,
    name: file.name,
    type: file.type,
    size: file.size,
    uploadedAt: new Date(file.uploadedAt),
  };
}

function normalizeDraftQuotation(
  quotation?: BlueprintDraftQuotationInput,
): BlueprintDraftQuotationInput | undefined {
  if (!quotation) return undefined;

  return {
    internalCosts: normalizeInternalCostStrings(quotation.internalCosts),
    costPreset: quotation.costPreset ? {
      serviceType: quotation.costPreset.serviceType ?? '',
      complexity: quotation.costPreset.complexity ?? 'standard',
      suggestedAt: quotation.costPreset.suggestedAt,
      suggestedValues: normalizeInternalCostStrings(quotation.costPreset.suggestedValues),
    } : undefined,
    discount: quotation.discount ?? '',
    subtotal: quotation.subtotal ?? '',
    total: quotation.total ?? '',
    paymentOption: quotation.paymentOption ?? 'milestone',
    systemEstimatedDuration: quotation.systemEstimatedDuration ?? '',
    adjustedEstimatedDuration: quotation.adjustedEstimatedDuration ?? '',
    inclusions: quotation.inclusions ?? '',
    exclusions: quotation.exclusions ?? '',
    lineItems: quotation.lineItems?.map((lineItem) => ({
      label: lineItem.label,
      quantity: lineItem.quantity,
      materials: lineItem.materials,
      labor: lineItem.labor,
    })),
    fees: quotation.fees ?? '',
    validityDays: quotation.validityDays ?? '30',
    breakdown: quotation.breakdown ?? '',
    estimatedDuration: quotation.estimatedDuration ?? '',
    engineerNotes: quotation.engineerNotes ?? '',
    paymentMilestones: quotation.paymentMilestones?.map((milestone) => ({
      label: milestone.label,
      description: milestone.description ?? '',
      percentage: milestone.percentage,
      amount: milestone.amount,
      trigger: milestone.trigger ?? '',
    })),
  };
}

function getDraftFileKeys(files?: {
  blueprint?: { key: string } | null;
  design?: { key: string } | null;
  costing?: { key: string } | null;
}) {
  return [files?.blueprint?.key, files?.design?.key, files?.costing?.key]
    .filter((value): value is string => Boolean(value));
}

function buildQuotationFromDraft(quotation?: BlueprintDraftQuotationInput) {
  const internalCostValues = normalizeInternalCostStrings(quotation?.internalCosts);
  const hasInternalCostValues = Boolean(internalCostValues)
    && INTERNAL_COST_KEYS.some((key) => asMoney(internalCostValues?.[key]) > 0);

  if (hasInternalCostValues && internalCostValues) {
    const internalCosts = INTERNAL_COST_KEYS.reduce((acc, key) => {
      acc[key] = asMoney(internalCostValues[key]);
      return acc;
    }, {} as Record<typeof INTERNAL_COST_KEYS[number], number>);
    const subtotal = INTERNAL_COST_KEYS.reduce((sum, key) => sum + internalCosts[key], 0);
    const discount = Math.min(asMoney(quotation?.discount), subtotal);
    const total = Math.max(subtotal - discount, subtotal > 0 ? 1 : 0);
    if (subtotal <= 0) return undefined;

    const paymentOption: 'full' | 'milestone' = quotation?.paymentOption === 'full' ? 'full' : 'milestone';
    const paymentMilestones = buildDefaultPaymentMilestones(total, paymentOption);
    const estimatedDuration = quotation?.adjustedEstimatedDuration?.trim()
      || quotation?.estimatedDuration?.trim()
      || quotation?.systemEstimatedDuration?.trim()
      || undefined;

    return {
      internalCosts,
      costPreset: quotation?.costPreset ? {
        serviceType: quotation.costPreset.serviceType?.trim() || undefined,
        complexity: quotation.costPreset.complexity || 'standard',
        suggestedAt: quotation.costPreset.suggestedAt ? new Date(quotation.costPreset.suggestedAt) : undefined,
        suggestedValues: quotation.costPreset.suggestedValues
          ? INTERNAL_COST_KEYS.reduce((acc, key) => {
              acc[key] = asMoney(quotation.costPreset?.suggestedValues?.[key]);
              return acc;
            }, {} as Record<typeof INTERNAL_COST_KEYS[number], number>)
          : undefined,
      } : undefined,
      discount,
      subtotal,
      total,
      paymentOption,
      paymentMilestones,
      validityDays: Number(quotation?.validityDays) || 30,
      systemEstimatedDuration: quotation?.systemEstimatedDuration?.trim() || undefined,
      adjustedEstimatedDuration: quotation?.adjustedEstimatedDuration?.trim() || undefined,
      estimatedDuration,
      inclusions: quotation?.inclusions?.trim() || undefined,
      exclusions: quotation?.exclusions?.trim() || undefined,
      engineerNotes: quotation?.engineerNotes?.trim() || undefined,
    };
  }

  const lineItems = (quotation?.lineItems || [])
    .filter((lineItem) => lineItem.label.trim())
    .map((lineItem) => {
      const materials = Number(lineItem.materials) || 0;
      const labor = Number(lineItem.labor) || 0;
      return {
        label: lineItem.label,
        quantity: lineItem.quantity,
        materials,
        labor,
        amount: (materials + labor) * lineItem.quantity,
      };
    });

  const totalMaterials = lineItems.reduce(
    (sum, lineItem) => sum + lineItem.materials * lineItem.quantity,
    0,
  );
  const totalLabor = lineItems.reduce(
    (sum, lineItem) => sum + lineItem.labor * lineItem.quantity,
    0,
  );
  const fees = Number(quotation?.fees) || 0;
  const computedTotal = totalMaterials + totalLabor + fees;
  const total = computedTotal > 0 ? computedTotal : 1;
  const validMilestones = (quotation?.paymentMilestones || [])
    .filter((milestone) => milestone.label.trim() && (milestone.description?.trim() || milestone.trigger?.trim()));

  if (lineItems.length === 0) {
    return undefined;
  }

  return {
    materials: totalMaterials,
    labor: totalLabor,
    fees,
    subtotal: computedTotal,
    discount: 0,
    total,
    internalCosts: {
      estimatedMaterials: totalMaterials,
      fabricationWork: totalLabor,
      finishingPolishing: 0,
      installation: 0,
      deliveryMobilization: fees,
      overheadMisc: 0,
      markupProfit: 0,
    },
    paymentOption: 'milestone' as const,
    lineItems: lineItems.length > 0 ? lineItems : undefined,
    validityDays: Number(quotation?.validityDays) || 30,
    breakdown: quotation?.breakdown?.trim() || undefined,
    inclusions: quotation?.breakdown?.trim() || undefined,
    estimatedDuration: quotation?.estimatedDuration?.trim() || undefined,
    engineerNotes: quotation?.engineerNotes?.trim() || undefined,
    paymentMilestones: validMilestones.length > 0
      ? validMilestones
      : buildDefaultPaymentMilestones(total, 'milestone'),
  };
}

async function assertAssignedEngineerForProject(projectId: string, actorId: string) {
  const project = await Project.findById(projectId).select('engineerIds status');
  if (!project) throw AppError.notFound('Project not found');

  const isAssignedEngineer = project.engineerIds.some((id) => id.toString() === actorId);
  if (!isAssignedEngineer) {
    throw AppError.forbidden('Only engineers assigned to this project can manage blueprint drafts');
  }

  return project;
}

async function deleteDraftFiles(keys: string[]) {
  await Promise.allSettled(keys.map((key) => deleteFile(key)));
}

function itemScopedQuery(projectId: string, projectItemId?: string) {
  return projectItemId
    ? { projectId, projectItemId }
    : { projectId, projectItemId: { $exists: false } };
}

function buildProjectBlueprintLink(projectId: string, projectItemId?: string | null) {
  if (!projectItemId) return `/projects/${projectId}/blueprint`;

  return `/projects/${projectId}/blueprint?projectItemId=${projectItemId}`;
}

function isDuplicateKeyError(error: unknown) {
  const err = error as { name?: string; code?: number };
  return err.name === 'MongoServerError' && err.code === 11000;
}

function isInitialBlueprintUploadAvailable(projectStatus: ProjectStatus, projectItem?: { status?: ProjectStatus } | null) {
  if ([ProjectStatus.SUBMITTED, ProjectStatus.BLUEPRINT].includes(projectStatus)) return true;

  return projectStatus === ProjectStatus.APPROVED
    && Boolean(projectItem)
    && projectItem?.status !== ProjectStatus.APPROVED;
}

function hasPayableQuotation(blueprint: { quotation?: { total?: number } | null }) {
  return Boolean(blueprint.quotation);
}

function isQuotationSentToCustomer(blueprint: { quotationReviewStatus?: string; quotation?: { total?: number } | null }) {
  return hasPayableQuotation(blueprint) && blueprint.quotationReviewStatus === 'sent_to_customer';
}

function quotationSnapshot(quotation: IBlueprint['quotation']) {
  // Mongoose assigns new subdocument IDs when an unchanged quotation is copied.
  return JSON.parse(JSON.stringify(quotation, (key, value) => key === '_id' ? undefined : value));
}

async function restoreReleasedQuotation<T extends IBlueprint | null>(blueprint: T): Promise<T> {
  if (!blueprint?.quotation || !Number.isFinite(blueprint.quotation.total) || blueprint.quotation.total <= 0
    || blueprint.quotationReviewStatus !== 'draft'
    || blueprint.revisionComponent === 'costing') return blueprint;

  // Older blueprint revisions reset the release status. Recover it only from
  // a recorded release of this exact quotation, following its revision chain.
  let source: IBlueprint = blueprint;
  const quotation = quotationSnapshot(blueprint.quotation);
  for (let hops = 0; hops <= MAX_REVISIONS; hops += 1) {
    const released = await AuditLog.findOne({
      targetType: 'blueprint',
      targetId: source._id,
      action: AuditAction.QUOTATION_SENT_TO_CUSTOMER,
      'details.total': blueprint.quotation.total,
    }).sort({ createdAt: -1 });
    if (released) {
      blueprint.quotationReviewStatus = 'sent_to_customer';
      blueprint.quotationSentAt ??= released.createdAt;
      return blueprint;
    }

    const revision = await AuditLog.findOne({
      targetType: 'blueprint', targetId: source._id,
      action: AuditAction.BLUEPRINT_REVISION_UPLOADED,
    }).sort({ createdAt: -1 });
    const previousId = revision?.details?.previousId;
    if (typeof previousId !== 'string' || hops === MAX_REVISIONS) break;
    const previous = await Blueprint.findById(previousId);
    if (!previous?.quotation
      || previous.projectId.toString() !== blueprint.projectId.toString()
      || previous.projectItemId?.toString() !== blueprint.projectItemId?.toString()
      || previous.version !== source.version - 1
      || previous.revisionComponent === 'costing'
      || !isDeepStrictEqual(quotation, quotationSnapshot(previous.quotation))) break;
    source = previous;
  }
  return blueprint;
}

async function notifyCustomerAndCashierQuotationReady(
  project: { _id: Types.ObjectId; title: string; customerId: Types.ObjectId | string },
  projectItemId?: Types.ObjectId | string | null,
) {
  const link = buildProjectBlueprintLink(project._id.toString(), projectItemId?.toString());

  await createAndSendNotification(
    project.customerId,
    NotificationCategory.BLUEPRINT,
    'Quotation Ready',
    `The quotation for "${project.title}" is ready for review.`,
    link,
  );

  await notifyRole(
    Role.CASHIER,
    NotificationCategory.BLUEPRINT,
    'Quotation Issued',
    `A customer-facing quotation for "${project.title}" has been issued for finance records.`,
    link,
  );
}

async function markProjectItemApprovedAndSaveProject(
  project: any,
  projectItemId?: Types.ObjectId | string | null,
) {
  if (projectItemId) {
    await ProjectItem.findByIdAndUpdate(projectItemId, { $set: { status: ProjectStatus.APPROVED } });

    const hasPendingItems = await ProjectItem.exists({
      projectId: project._id,
      _id: { $ne: projectItemId },
      status: { $ne: ProjectStatus.APPROVED },
      deletedAt: null,
    });

    if (hasPendingItems) {
      await project.save();
      return;
    }
  }

  if (project.status === ProjectStatus.BLUEPRINT) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.APPROVED);
    project.status = ProjectStatus.APPROVED;
  }
  await project.save();
}

async function syncProjectTotalCostFromApprovedBlueprints(project: any, fallbackBlueprint?: any) {
  const itemCount = await ProjectItem.countDocuments({ projectId: project._id });
  const fallbackTotal = fallbackBlueprint?.quotation?.total;

  if (itemCount <= 1) {
    if (typeof fallbackTotal === 'number') project.totalCost = fallbackTotal;
    return;
  }

  const [aggregateTotal] = await Blueprint.aggregate([
    {
      $match: {
        projectId: project._id,
        projectItemId: { $exists: true },
        status: BlueprintStatus.APPROVED,
        'quotation.total': { $type: 'number' },
      },
    },
    { $sort: { projectItemId: 1, version: -1 } },
    { $group: { _id: '$projectItemId', total: { $first: '$quotation.total' } } },
    { $group: { _id: null, total: { $sum: '$total' } } },
  ]);

  project.totalCost = aggregateTotal?.total ?? (typeof fallbackTotal === 'number' ? fallbackTotal : 0);
}

async function resolveProjectItemForBlueprint(project: any, projectItemId?: string) {
  const itemCount = await ProjectItem.countDocuments({ projectId: project._id });

  if (itemCount > 1 && !projectItemId) {
    throw AppError.badRequest('Select a project item before managing its blueprint');
  }

  if (!projectItemId) return null;

  const projectItem = await ProjectItem.findOne({ _id: projectItemId, projectId: project._id });
  if (!projectItem) throw AppError.notFound('Project item not found');

  return projectItem;
}

// ── Engineer: Upload Initial Blueprint ──

export async function uploadBlueprint(
  input: UploadBlueprintInput,
  uploadedBy: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(input.projectId);
  if (!project) throw AppError.notFound('Project not found');

  const projectItem = await resolveProjectItemForBlueprint(project, input.projectItemId);
  const designReviewStatus = projectItem?.designReviewStatus || project.designReviewStatus || 'not_required';
  const hasInitialDesign = Boolean(
    projectItem
      ? projectItem.initialDesignKeys?.length || projectItem.initialDesignNotes?.trim()
      : project.initialDesignKeys?.length || project.initialDesignNotes?.trim(),
  );

  if (hasInitialDesign && !['approved', 'not_required'].includes(designReviewStatus)) {
    throw AppError.badRequest('The sales initial design must be approved by engineering before the first blueprint upload');
  }

  if (!isInitialBlueprintUploadAvailable(project.status, projectItem)) {
    throw AppError.badRequest('Project is not in a valid state for blueprint upload');
  }

  // Check if initial version already exists
  const existing = await Blueprint.findOne({ ...itemScopedQuery(input.projectId, input.projectItemId), version: 1 });
  if (existing) {
    throw AppError.conflict('Initial blueprint already uploaded. Use revision upload.', ErrorCode.DUPLICATE_ENTRY);
  }

  const blueprint = await Blueprint.create({
    projectId: input.projectId,
    projectItemId: input.projectItemId,
    version: 1,
    status: BlueprintStatus.UPLOADED,
    blueprintKey: input.blueprintKey,
    designKey: input.designKey,
    costingKey: input.costingKey,
    uploadedBy,
    quotation: input.quotation,
    quotationReviewStatus: input.quotation ? 'sent_to_customer' : 'draft',
  });

  if ([ProjectStatus.SUBMITTED, ProjectStatus.APPROVED].includes(project.status)) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.BLUEPRINT);
    project.status = ProjectStatus.BLUEPRINT;
    await project.save();
  }
  if (input.projectItemId) {
    await ProjectItem.findByIdAndUpdate(input.projectItemId, { $set: { status: ProjectStatus.BLUEPRINT } });
  }

  await AuditLog.create({
    action: AuditAction.BLUEPRINT_UPLOADED,
    actorId: uploadedBy,
    targetType: 'blueprint',
    targetId: blueprint._id,
    details: { projectId: input.projectId, projectItemId: input.projectItemId || null, version: 1 },
    ipAddress: ip,
    userAgent: ua,
  });

  if (input.quotation) {
    await AuditLog.create({
      action: AuditAction.QUOTATION_SENT_TO_CUSTOMER,
      actorId: uploadedBy,
      targetType: 'blueprint',
      targetId: blueprint._id,
      details: {
        projectId: input.projectId,
        projectItemId: input.projectItemId || null,
        reviewStatus: 'sent_to_customer',
        total: input.quotation.total,
      },
      ipAddress: ip,
      userAgent: ua,
    });
  }

  // Notify customer
  const customer = await User.findById(project.customerId);
  if (customer) {
    await createAndSendNotification(
      project.customerId,
      NotificationCategory.BLUEPRINT,
      'Blueprint Uploaded',
      `A blueprint (Version 1) has been uploaded for your project "${project.title}". Please review and approve.`,
      buildProjectBlueprintLink(project._id.toString(), input.projectItemId),
    );

    await sendBlueprintUploadedEmail(customer.email, {
      version: 1,
      projectTitle: project.title,
      projectId: project._id.toString(),
    });
  }

  if (input.quotation) {
    await notifyCustomerAndCashierQuotationReady(project, blueprint.projectItemId);
  }

  return blueprint;
}

// ── Engineer: Upload Revision ──

export async function uploadRevision(
  blueprintId: string,
  input: RevisionUploadInput,
  uploadedBy: string,
  ip?: string,
  ua?: string,
) {
  const currentBlueprint = await Blueprint.findById(blueprintId);
  if (!currentBlueprint) throw AppError.notFound('Blueprint not found');

  if (currentBlueprint.status !== BlueprintStatus.REVISION_REQUESTED) {
    throw AppError.badRequest('A revision can only be uploaded when revision is requested');
  }

  const newVersion = currentBlueprint.version + 1;

  // Max 3 revisions check (initial + 3 revisions = version 4 max)
  if (newVersion > MAX_REVISIONS + 1) {
    throw AppError.badRequest(`Maximum of ${MAX_REVISIONS} revisions allowed`);
  }

  const project = await Project.findById(currentBlueprint.projectId);
  if (!project) throw AppError.notFound('Project not found');

  const isCostingRevision = currentBlueprint.revisionComponent === 'costing';
  if (!isCostingRevision) await restoreReleasedQuotation(currentBlueprint);
  const quotation = isCostingRevision ? input.quotation ?? currentBlueprint.quotation : currentBlueprint.quotation;
  const hasNewQuotation = isCostingRevision && Boolean(input.quotation);
  const blueprintKey = isCostingRevision ? currentBlueprint.blueprintKey : input.blueprintKey ?? currentBlueprint.blueprintKey;
  const designKey = isCostingRevision ? currentBlueprint.designKey : input.designKey ?? currentBlueprint.designKey;
  if (!blueprintKey || !designKey) {
    throw AppError.badRequest('Blueprint and design files are required before submitting the revision');
  }

  // Mark current as superseded by updating status
  currentBlueprint.status = BlueprintStatus.REVISION_UPLOADED;
  await currentBlueprint.save();

  // Only the requested component changes; retain the other component's review state.
  const blueprint = await Blueprint.create({
    projectId: currentBlueprint.projectId,
    projectItemId: currentBlueprint.projectItemId,
    version: newVersion,
    status: BlueprintStatus.UPLOADED,
    blueprintKey,
    designKey,
    costingKey: isCostingRevision ? input.costingKey ?? currentBlueprint.costingKey : currentBlueprint.costingKey,
    blueprintApproved: isCostingRevision ? currentBlueprint.blueprintApproved : false,
    costingApproved: isCostingRevision ? false : currentBlueprint.costingApproved,
    uploadedBy,
    quotation,
    quotationReviewStatus: hasNewQuotation ? 'sent_to_customer' : currentBlueprint.quotationReviewStatus,
    quotationReviewedBy: isCostingRevision ? undefined : currentBlueprint.quotationReviewedBy,
    quotationReviewedAt: isCostingRevision ? undefined : currentBlueprint.quotationReviewedAt,
    quotationSentAt: hasNewQuotation ? new Date() : currentBlueprint.quotationSentAt,
  });

  await AuditLog.create({
    action: AuditAction.BLUEPRINT_REVISION_UPLOADED,
    actorId: uploadedBy,
    targetType: 'blueprint',
    targetId: blueprint._id,
    details: { projectId: currentBlueprint.projectId.toString(), version: newVersion, previousId: blueprintId },
    ipAddress: ip,
    userAgent: ua,
  });

  if (hasNewQuotation) {
    await AuditLog.create({
      action: AuditAction.QUOTATION_SENT_TO_CUSTOMER,
      actorId: uploadedBy,
      targetType: 'blueprint',
      targetId: blueprint._id,
      details: {
        projectId: currentBlueprint.projectId.toString(),
        previousId: blueprintId,
        reviewStatus: 'sent_to_customer',
        total: quotation!.total,
      },
      ipAddress: ip,
      userAgent: ua,
    });
  }

  // Notify customer
  const customer = await User.findById(project.customerId);
  if (customer) {
    await createAndSendNotification(
      project.customerId,
      NotificationCategory.BLUEPRINT,
      'Blueprint Revision Uploaded',
      `A revised blueprint (Version ${newVersion}) has been uploaded for "${project.title}". Please review.`,
      buildProjectBlueprintLink(project._id.toString(), currentBlueprint.projectItemId?.toString()),
    );

    await sendBlueprintUploadedEmail(customer.email, {
      version: newVersion,
      projectTitle: project.title,
      projectId: project._id.toString(),
    });
  }

  if (hasNewQuotation) {
    await notifyCustomerAndCashierQuotationReady(project, blueprint.projectItemId);
  }

  return blueprint;
}

// ── Customer: Approve Component ──

export async function approveComponent(
  blueprintId: string,
  input: ApproveBlueprintInput,
  customerId: string,
  ip?: string,
  ua?: string,
) {
  const blueprint = await Blueprint.findById(blueprintId);
  if (!blueprint) throw AppError.notFound('Blueprint not found');

  // Verify ownership
  const project = await Project.findById(blueprint.projectId);
  if (!project) throw AppError.notFound('Project not found');
  if (project.customerId.toString() !== customerId) {
    throw AppError.forbidden('Only the project customer can approve blueprints');
  }

  if (blueprint.status !== BlueprintStatus.UPLOADED && blueprint.status !== BlueprintStatus.REVISION_UPLOADED) {
    throw AppError.badRequest('Blueprint is not in a reviewable state');
  }

  if (input.component === BlueprintComponent.COSTING && !hasPayableQuotation(blueprint)) {
    throw AppError.badRequest('Cannot approve billing without a valid quotation total. Please ask engineering to upload costing with pricing.');
  }

  await restoreReleasedQuotation(blueprint);
  if (input.component === BlueprintComponent.COSTING && !isQuotationSentToCustomer(blueprint)) {
    throw AppError.badRequest('Customer billing approval is available only after the quotation has been sent to the customer.');
  }

  if (input.component === BlueprintComponent.BLUEPRINT) {
    blueprint.blueprintApproved = true;
  } else {
    blueprint.costingApproved = true;
  }

  if (blueprint.quotation && Number(blueprint.quotation.total || 0) <= 0) {
    blueprint.quotation.total = 1;
  }

  const fullyApproved = blueprint.blueprintApproved && blueprint.costingApproved;

  // If both approved, mark blueprint as approved
  if (fullyApproved) {
    blueprint.status = BlueprintStatus.APPROVED;
    await blueprint.save();

    await syncProjectTotalCostFromApprovedBlueprints(project, blueprint);
    await markProjectItemApprovedAndSaveProject(project, blueprint.projectItemId);
  } else {
    await blueprint.save();
  }

  await AuditLog.create({
    action: AuditAction.BLUEPRINT_APPROVED,
    actorId: customerId,
    targetType: 'blueprint',
    targetId: blueprint._id,
    details: {
      component: input.component,
      blueprintApproved: blueprint.blueprintApproved,
      costingApproved: blueprint.costingApproved,
      fullyApproved: blueprint.status === BlueprintStatus.APPROVED,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify engineer
  const notifyMessage = blueprint.status === BlueprintStatus.APPROVED
    ? `Blueprint and costing for "${project.title}" have been fully approved.`
    : `Customer approved the ${input.component} for "${project.title}".`;

  await createAndSendNotification(
    blueprint.uploadedBy,
    NotificationCategory.BLUEPRINT,
    blueprint.status === BlueprintStatus.APPROVED ? 'Blueprint Fully Approved' : 'Component Approved',
    notifyMessage,
    buildProjectBlueprintLink(project._id.toString(), blueprint.projectItemId?.toString()),
  );

  return blueprint;
}

// ── Customer: Request Revision ──

export async function requestRevision(
  blueprintId: string,
  input: RequestRevisionInput,
  customerId: string,
  ip?: string,
  ua?: string,
) {
  const blueprint = await Blueprint.findById(blueprintId);
  if (!blueprint) throw AppError.notFound('Blueprint not found');

  const project = await Project.findById(blueprint.projectId);
  if (!project) throw AppError.notFound('Project not found');
  if (project.customerId.toString() !== customerId) {
    throw AppError.forbidden('Only the project customer can request revisions');
  }

  // Check max revisions
  if (blueprint.version >= MAX_REVISIONS + 1) {
    throw AppError.badRequest(`Maximum of ${MAX_REVISIONS} revisions reached`);
  }

  blueprintStateMachine.assertTransition(blueprint.status, BlueprintStatus.REVISION_REQUESTED);

  // If the blueprint was already fully approved, revert the project back to BLUEPRINT stage
  if (blueprint.status === BlueprintStatus.APPROVED && project.status === ProjectStatus.APPROVED) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.BLUEPRINT);
    project.status = ProjectStatus.BLUEPRINT;
    await project.save();
  }

  blueprint.status = BlueprintStatus.REVISION_REQUESTED;
  blueprint.revisionComponent = input.component ?? BlueprintComponent.BLUEPRINT;
  if (blueprint.revisionComponent === BlueprintComponent.COSTING) {
    blueprint.costingApproved = false;
    blueprint.quotationReviewStatus = blueprint.quotation ? 'draft' : blueprint.quotationReviewStatus;
  } else {
    blueprint.blueprintApproved = false;
  }
  blueprint.revisionNotes = input.notes;
  blueprint.revisionRefKeys = input.refKeys;
  await blueprint.save();

  await AuditLog.create({
    action: AuditAction.BLUEPRINT_REVISION_REQUESTED,
    actorId: customerId,
    targetType: 'blueprint',
    targetId: blueprint._id,
    details: { notes: input.notes, version: blueprint.version, component: blueprint.revisionComponent },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify engineer
  await createAndSendNotification(
    blueprint.uploadedBy,
    NotificationCategory.BLUEPRINT,
    'Revision Requested',
    `Customer requested a ${blueprint.revisionComponent} revision for V${blueprint.version} of "${project.title}". Notes: ${input.notes}`,
    buildProjectBlueprintLink(project._id.toString(), blueprint.projectItemId?.toString()),
  );

  return blueprint;
}

// ── Engineer: Draft Autosave ──

export async function getBlueprintDraft(projectId: string, actorId: string, projectItemId?: string) {
  await assertAssignedEngineerForProject(projectId, actorId);

  return BlueprintDraft.findOne(itemScopedQuery(projectId, projectItemId))
    .populate('createdBy', 'firstName lastName phone')
    .populate('lastEditedBy', 'firstName lastName phone');
}

export async function upsertBlueprintDraft(
  projectId: string,
  input: UpsertBlueprintDraftInput,
  actorId: string,
) {
  const project = await assertAssignedEngineerForProject(projectId, actorId);
  const projectItemId = input.projectItemId;
  const projectItem = await resolveProjectItemForBlueprint(project, projectItemId);
  const latestBlueprint = await Blueprint.findOne(itemScopedQuery(projectId, projectItemId))
    .sort({ version: -1 })
    .select('_id status revisionComponent');

  if (input.mode === 'initial') {
    if (latestBlueprint) {
      throw AppError.badRequest('Initial blueprint draft is not available after a blueprint has been uploaded');
    }

    if (!isInitialBlueprintUploadAvailable(project.status, projectItem)) {
      throw AppError.badRequest('Blueprint drafts are not available for this project right now');
    }
  }

  if (input.mode === 'revision') {
    if (!latestBlueprint || latestBlueprint.status !== BlueprintStatus.REVISION_REQUESTED) {
      throw AppError.badRequest('Revision draft is only available when a customer has requested a revision');
    }

    if (input.sourceBlueprintId && input.sourceBlueprintId !== latestBlueprint._id.toString()) {
      throw AppError.badRequest('Revision draft must target the latest revision-requested blueprint');
    }
  }

  const draftQuery = itemScopedQuery(projectId, projectItemId);
  const existingDraft = await BlueprintDraft.findOne(draftQuery);
  const previousFiles = {
    blueprint: existingDraft?.files?.blueprint ?? null,
    design: existingDraft?.files?.design ?? null,
    costing: existingDraft?.files?.costing ?? null,
  };

  const set: Record<string, unknown> = {
    mode: input.mode,
    lastEditedBy: actorId,
  };
  const unset: Record<string, ''> = {};

  if (input.mode === 'revision' && latestBlueprint) {
    set.sourceBlueprintId = latestBlueprint._id;
  } else {
    unset.sourceBlueprintId = '';
  }

  const canEditBlueprint = input.mode === 'initial' || latestBlueprint?.revisionComponent !== 'costing';
  const canEditCosting = input.mode === 'initial' || latestBlueprint?.revisionComponent === 'costing';

  if (canEditBlueprint && input.files && 'blueprint' in input.files) {
    set['files.blueprint'] = normalizeDraftFile(input.files.blueprint ?? null) ?? null;
  }
  if (canEditBlueprint && input.files && 'design' in input.files) {
    set['files.design'] = normalizeDraftFile(input.files.design ?? null) ?? null;
  }
  if (canEditCosting && input.files && 'costing' in input.files) {
    set['files.costing'] = normalizeDraftFile(input.files.costing ?? null) ?? null;
  }
  if (canEditCosting && input.quotation !== undefined) {
    set.quotation = normalizeDraftQuotation(input.quotation);
  }

  const setOnInsert: Record<string, unknown> = {
    projectId,
    createdBy: actorId,
  };
  if (projectItemId) {
    setOnInsert.projectItemId = projectItemId;
  }

  const update: Record<string, unknown> = {
    $set: set,
    $setOnInsert: setOnInsert,
  };
  if (Object.keys(unset).length > 0) {
    update.$unset = unset;
  }

  let draft;
  try {
    draft = await BlueprintDraft.findOneAndUpdate(
      draftQuery,
      update,
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;

    draft = await BlueprintDraft.findOneAndUpdate(
      draftQuery,
      update,
      {
        new: true,
        runValidators: true,
      },
    );
  }

  if (!draft) throw AppError.internal('Failed to save blueprint draft');

  const nextFiles = {
    blueprint: draft.files?.blueprint ?? null,
    design: draft.files?.design ?? null,
    costing: draft.files?.costing ?? null,
  };

  const replacedKeys = [
    previousFiles.blueprint?.key && previousFiles.blueprint.key !== nextFiles.blueprint?.key
      ? previousFiles.blueprint.key
      : null,
    previousFiles.design?.key && previousFiles.design.key !== nextFiles.design?.key
      ? previousFiles.design.key
      : null,
    previousFiles.costing?.key && previousFiles.costing.key !== nextFiles.costing?.key
      ? previousFiles.costing.key
      : null,
  ].filter((value): value is string => Boolean(value));

  if (replacedKeys.length > 0) {
    await deleteDraftFiles(replacedKeys);
  }

  return BlueprintDraft.findById(draft._id)
    .populate('createdBy', 'firstName lastName phone')
    .populate('lastEditedBy', 'firstName lastName phone');
}

export async function finalizeBlueprintDraft(
  projectId: string,
  actorId: string,
  ip?: string,
  ua?: string,
  projectItemId?: string,
) {
  await assertAssignedEngineerForProject(projectId, actorId);

  const draft = await BlueprintDraft.findOne(itemScopedQuery(projectId, projectItemId));
  if (!draft) throw AppError.notFound('Blueprint draft not found');

  const blueprintKey = draft.files?.blueprint?.key;
  const designKey = draft.files?.design?.key;
  const costingKey = draft.files?.costing?.key;

  if (draft.mode === 'initial' && (!blueprintKey || !designKey)) {
    throw AppError.badRequest('Blueprint and design files are required before finalizing the draft');
  }

  const quotation = buildQuotationFromDraft(draft.quotation);

  if (draft.mode === 'revision' && !draft.sourceBlueprintId) {
    throw AppError.badRequest('Revision draft is missing its source blueprint reference');
  }

  const finalizedBlueprint = draft.mode === 'revision'
    ? await uploadRevision(
        draft.sourceBlueprintId!.toString(),
        {
          blueprintKey,
          designKey,
          costingKey,
          quotation,
        },
        actorId,
        ip,
        ua,
      )
    : await uploadBlueprint(
        {
          projectId,
          projectItemId: draft.projectItemId?.toString() || projectItemId,
          blueprintKey: blueprintKey!,
          designKey: designKey!,
          costingKey: costingKey || '',
          quotation,
        },
        actorId,
        ip,
        ua,
      );

  await draft.deleteOne();
  return finalizedBlueprint;
}

export async function deleteBlueprintDraft(projectId: string, actorId: string, projectItemId?: string) {
  await assertAssignedEngineerForProject(projectId, actorId);

  const draft = await BlueprintDraft.findOne(itemScopedQuery(projectId, projectItemId));
  if (!draft) return;

  const keys = getDraftFileKeys(draft.files);
  await draft.deleteOne();

  if (keys.length > 0) {
    await deleteDraftFiles(keys);
  }
}

// ── Get Blueprint by ID ──

async function assertBlueprintProjectAccess(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
): Promise<void> {
  const project = await Project.findById(projectId)
    .select('customerId salesStaffId engineerIds fabricationLeadId fabricationAssistantIds status');
  if (!project) throw AppError.notFound('Project not found');

  if (actorRoles.includes(Role.ADMIN)) return;

  if (actorRoles.includes(Role.CUSTOMER) && project.customerId.toString() === actorId) return;
  if (actorRoles.includes(Role.SALES_STAFF) && project.salesStaffId?.toString() === actorId) return;

  if (actorRoles.includes(Role.ENGINEER)) {
    // Assigned engineer
    if (project.engineerIds.some((id) => id.toString() === actorId)) return;
    // Unassigned submitted projects (engineers can browse these)
    if (project.status === ProjectStatus.SUBMITTED && project.engineerIds.length === 0) return;
  }

  if (
    actorRoles.includes(Role.FABRICATION_STAFF) &&
    (project.fabricationLeadId?.toString() === actorId ||
      project.fabricationAssistantIds.some((id) => id.toString() === actorId))
  ) return;

  throw AppError.forbidden('Access denied');
}

export async function getBlueprintById(
  blueprintId: string,
  actorId: string,
  actorRoles: Role[],
) {
  const blueprint = await Blueprint.findById(blueprintId)
    .populate('uploadedBy', 'firstName lastName phone');
  if (!blueprint) throw AppError.notFound('Blueprint not found');
  await assertBlueprintProjectAccess(blueprint.projectId.toString(), actorId, actorRoles);
  return restoreReleasedQuotation(blueprint);
}

// ── List Blueprints for a Project ──

export async function listBlueprintsByProject(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
  projectItemId?: string,
) {
  await assertBlueprintProjectAccess(projectId, actorId, actorRoles);
  const blueprints = await Blueprint.find(itemScopedQuery(projectId, projectItemId))
    .populate('uploadedBy', 'firstName lastName phone')
    .sort({ version: -1 });
  return Promise.all(blueprints.map((blueprint) => restoreReleasedQuotation(blueprint)));
}

// ── Get Latest Blueprint for a Project ──

export async function getLatestBlueprint(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
  projectItemId?: string,
) {
  await assertBlueprintProjectAccess(projectId, actorId, actorRoles);
  const blueprint = await Blueprint.findOne(itemScopedQuery(projectId, projectItemId))
    .sort({ version: -1 })
    .populate('uploadedBy', 'firstName lastName phone');
  return restoreReleasedQuotation(blueprint);
}

export async function approveAndSendQuotation(
  blueprintId: string,
  adminId: string,
  ip?: string,
  ua?: string,
) {
  const blueprint = await Blueprint.findById(blueprintId);
  if (!blueprint) throw AppError.notFound('Blueprint not found');
  if (!blueprint.quotation || Number(blueprint.quotation.total || 0) <= 0) {
    throw AppError.badRequest('Cannot approve a quotation without a valid final amount.');
  }

  const project = await Project.findById(blueprint.projectId);
  if (!project) throw AppError.notFound('Project not found');

  blueprint.quotationReviewStatus = 'sent_to_customer';
  blueprint.quotationReviewedBy = adminId as any;
  blueprint.quotationReviewedAt = new Date();
  blueprint.quotationSentAt = new Date();
  await blueprint.save();

  await AuditLog.create([
    {
      action: AuditAction.QUOTATION_APPROVED,
      actorId: adminId,
      targetType: 'blueprint',
      targetId: blueprint._id,
      details: {
        projectId: blueprint.projectId.toString(),
        projectItemId: blueprint.projectItemId?.toString() || null,
        reviewStatus: 'approved',
        total: blueprint.quotation.total,
      },
      ipAddress: ip,
      userAgent: ua,
    },
    {
      action: AuditAction.QUOTATION_SENT_TO_CUSTOMER,
      actorId: adminId,
      targetType: 'blueprint',
      targetId: blueprint._id,
      details: {
        projectId: blueprint.projectId.toString(),
        projectItemId: blueprint.projectItemId?.toString() || null,
        reviewStatus: 'sent_to_customer',
        total: blueprint.quotation.total,
      },
      ipAddress: ip,
      userAgent: ua,
    },
  ]);

  await notifyCustomerAndCashierQuotationReady(project, blueprint.projectItemId);

  return blueprint;
}

export async function getQuotationHistory(
  blueprintId: string,
  actorId: string,
  actorRoles: Role[],
) {
  const blueprint = await Blueprint.findById(blueprintId).select('projectId');
  if (!blueprint) throw AppError.notFound('Blueprint not found');
  await assertBlueprintProjectAccess(blueprint.projectId.toString(), actorId, actorRoles);

  return AuditLog.find({
    targetType: 'blueprint',
    targetId: blueprint._id,
    action: {
      $in: [
        AuditAction.QUOTATION_SUBMITTED_FOR_REVIEW,
        AuditAction.QUOTATION_APPROVED,
        AuditAction.QUOTATION_SENT_TO_CUSTOMER,
        AuditAction.QUOTATION_REVISED,
      ],
    },
  })
    .sort({ createdAt: -1 })
    .limit(10)
    .populate('actorId', 'firstName lastName role');
}

// ── Customer: Accept Blueprint (approve both components only) ──

export async function acceptBlueprint(
  blueprintId: string,
  input: AcceptBlueprintInput,
  customerId: string,
  ip?: string,
  ua?: string,
) {
  const blueprint = await Blueprint.findById(blueprintId);
  if (!blueprint) throw AppError.notFound('Blueprint not found');

  const project = await Project.findById(blueprint.projectId);
  if (!project) throw AppError.notFound('Project not found');
  if (project.customerId.toString() !== customerId) {
    throw AppError.forbidden('Only the project customer can accept blueprints');
  }

  if (![BlueprintStatus.UPLOADED, BlueprintStatus.REVISION_UPLOADED, BlueprintStatus.APPROVED].includes(blueprint.status)) {
    throw AppError.badRequest('Blueprint is not in a reviewable state');
  }

  if (!blueprint.quotation) {
    throw AppError.badRequest('Cannot accept a blueprint without a valid quotation. Please ask the engineer to provide pricing.');
  }

  if (!isQuotationSentToCustomer(blueprint)) {
    throw AppError.badRequest('Cannot accept billing until the quotation has been sent to the customer.');
  }

  // Mark both components as approved
  blueprint.blueprintApproved = true;
  blueprint.costingApproved = true;
  blueprint.status = BlueprintStatus.APPROVED;
  if (Number(blueprint.quotation.total || 0) <= 0) {
    blueprint.quotation.total = 1;
  }
  await blueprint.save();

  await syncProjectTotalCostFromApprovedBlueprints(project, blueprint);
  await markProjectItemApprovedAndSaveProject(project, blueprint.projectItemId);

  await AuditLog.create({
    action: AuditAction.BLUEPRINT_APPROVED,
    actorId: customerId,
    targetType: 'blueprint',
    targetId: blueprint._id,
    details: {
      fullyApproved: true,
      paymentTypeSelectionPending: true,
      totalAmount: blueprint.quotation.total,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify engineer
  await createAndSendNotification(
    blueprint.uploadedBy,
    NotificationCategory.BLUEPRINT,
    'Blueprint Accepted',
    `Customer accepted the blueprint for "${project.title}". Payment-plan selection is next.`,
    buildProjectBlueprintLink(project._id.toString(), blueprint.projectItemId?.toString()),
  );

  // Notify customer
  await createAndSendNotification(
    customerId,
    NotificationCategory.BLUEPRINT,
    'Blueprint Accepted',
    `You approved the blueprint for "${project.title}". Select your payment plan to continue to payments.`,
    `/projects/${project._id}`,
  );

  return { blueprint };
}
