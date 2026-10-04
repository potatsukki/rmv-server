import { z } from 'zod';
import { BlueprintComponent } from '../../utils/constants.js';

const internalCostsSchema = z.object({
  estimatedMaterials: z.number().min(0).optional().default(0),
  fabricationWork: z.number().min(0).optional().default(0),
  finishingPolishing: z.number().min(0).optional().default(0),
  installation: z.number().min(0).optional().default(0),
  deliveryMobilization: z.number().min(0).optional().default(0),
  overheadMisc: z.number().min(0).optional().default(0),
  markupProfit: z.number().min(0).optional().default(0),
});

const paymentMilestoneSchema = z.object({
  label: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  percentage: z.number().min(0).max(100).optional(),
  amount: z.number().min(0).optional(),
  trigger: z.string().max(500).optional(),
});

const quotationSchema = z.object({
  total: z.number().min(0),
  internalCosts: internalCostsSchema.optional(),
  costPreset: z.object({
    serviceType: z.string().max(100).optional(),
    complexity: z.enum(['simple', 'standard', 'complex']).optional(),
    suggestedAt: z.coerce.date().optional(),
    suggestedValues: internalCostsSchema.partial().optional(),
  }).optional(),
  discount: z.number().min(0).optional(),
  subtotal: z.number().min(0).optional(),
  paymentOption: z.enum(['full', 'milestone']).optional(),
  paymentMilestones: z.array(paymentMilestoneSchema).max(6).optional(),
  validityDays: z.number().min(1).max(365).optional(),
  systemEstimatedDuration: z.string().max(200).optional(),
  adjustedEstimatedDuration: z.string().max(200).optional(),
  estimatedDuration: z.string().max(200).optional(),
  inclusions: z.string().max(5000).optional(),
  exclusions: z.string().max(5000).optional(),
  engineerNotes: z.string().max(3000).optional(),
  materials: z.number().min(0).optional(),
  labor: z.number().min(0).optional(),
  fees: z.number().min(0).optional(),
  lineItems: z.array(z.object({
    label: z.string().min(1).max(200),
    quantity: z.number().min(1),
    materials: z.number().min(0),
    labor: z.number().min(0),
    amount: z.number().min(0),
  })).optional(),
  breakdown: z.string().max(5000).optional(),
});

export const uploadBlueprintSchema = z.object({
  projectId: z.string().min(1),
  projectItemId: z.string().min(1).optional(),
  blueprintKey: z.string().min(1),
  designKey: z.string().min(1),
  costingKey: z.string().optional().default(''),
  quotation: quotationSchema.optional(),
});

export const revisionUploadSchema = z.object({
  blueprintKey: z.string().min(1).optional(),
  designKey: z.string().min(1).optional(),
  costingKey: z.string().optional(),
  quotation: quotationSchema.optional(),
});

export const approveBlueprintSchema = z.object({
  component: z.nativeEnum(BlueprintComponent),
});

export const requestRevisionSchema = z.object({
  component: z.nativeEnum(BlueprintComponent).default(BlueprintComponent.BLUEPRINT),
  notes: z.string().min(1).max(2000).trim(),
  refKeys: z.array(z.string()).max(5).default([]),
});

export const acceptBlueprintSchema = z.object({
  paymentType: z.enum(['full', 'installment']),
});

const draftFileSchema = z.object({
  key: z.string().min(1).max(500),
  name: z.string().min(1).max(255),
  type: z.string().min(1).max(255),
  size: z.number().min(0),
  uploadedAt: z.coerce.date(),
});

const draftInternalCostsSchema = z.object({
  estimatedMaterials: z.string().max(100).optional(),
  fabricationWork: z.string().max(100).optional(),
  finishingPolishing: z.string().max(100).optional(),
  installation: z.string().max(100).optional(),
  deliveryMobilization: z.string().max(100).optional(),
  overheadMisc: z.string().max(100).optional(),
  markupProfit: z.string().max(100).optional(),
});

const draftQuotationSchema = z.object({
  internalCosts: draftInternalCostsSchema.optional(),
  costPreset: z.object({
    serviceType: z.string().max(100).optional(),
    complexity: z.enum(['simple', 'standard', 'complex']).optional(),
    suggestedAt: z.coerce.date().optional(),
    suggestedValues: draftInternalCostsSchema.optional(),
  }).optional(),
  discount: z.string().max(100).optional(),
  subtotal: z.string().max(100).optional(),
  total: z.string().max(100).optional(),
  paymentOption: z.enum(['full', 'milestone']).optional(),
  systemEstimatedDuration: z.string().max(200).optional(),
  adjustedEstimatedDuration: z.string().max(200).optional(),
  inclusions: z.string().max(5000).optional(),
  exclusions: z.string().max(5000).optional(),
  lineItems: z.array(z.object({
    label: z.string().max(200),
    quantity: z.number().min(1),
    materials: z.string().max(100),
    labor: z.string().max(100),
  })).max(100).optional(),
  fees: z.string().max(100).optional(),
  validityDays: z.string().max(10).optional(),
  breakdown: z.string().max(5000).optional(),
  estimatedDuration: z.string().max(200).optional(),
  engineerNotes: z.string().max(3000).optional(),
  paymentMilestones: z.array(z.object({
    label: z.string().max(200),
    description: z.string().max(500).optional(),
    percentage: z.number().min(0).max(100).optional(),
    amount: z.number().min(0).optional(),
    trigger: z.string().max(500).optional(),
  })).max(6).optional(),
}).optional();

export const upsertBlueprintDraftSchema = z.object({
  projectItemId: z.string().min(1).optional(),
  mode: z.enum(['initial', 'revision']),
  sourceBlueprintId: z.string().min(1).optional(),
  files: z.object({
    blueprint: draftFileSchema.nullable().optional(),
    design: draftFileSchema.nullable().optional(),
    costing: draftFileSchema.nullable().optional(),
  }).optional(),
  quotation: draftQuotationSchema,
});

export type UploadBlueprintInput = z.infer<typeof uploadBlueprintSchema>;
export type RevisionUploadInput = z.infer<typeof revisionUploadSchema>;
export type ApproveBlueprintInput = z.infer<typeof approveBlueprintSchema>;
export type RequestRevisionInput = z.infer<typeof requestRevisionSchema>;
export type AcceptBlueprintInput = z.infer<typeof acceptBlueprintSchema>;
export type UpsertBlueprintDraftInput = z.infer<typeof upsertBlueprintDraftSchema>;
