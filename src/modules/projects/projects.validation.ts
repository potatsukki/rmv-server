import { z } from 'zod';
import { DeliveryType, ProjectStatus } from '../../utils/constants.js';
import { updateVisitReportSchema } from '../visit-reports/visit-reports.validation.js';

const projectDetailsSchema = updateVisitReportSchema.pick({
  serviceTypeCustom: true,
  measurementUnit: true,
  lineItems: true,
  specifications: true,
  preferredDesign: true,
  customerRequirements: true,
  initialDesignKeys: true,
  initialDesignNotes: true,
  selectedDesignTemplateId: true,
  selectedDesignTemplateName: true,
  selectedDesignTemplateImageUrl: true,
  photoKeys: true,
  videoKeys: true,
  sketchKeys: true,
  referenceImageKeys: true,
});

const signedContractFileKeySchema = z.string()
  .min(1, 'Contract file is required')
  .refine((key) => key.startsWith('contracts/'), 'Contract file must be uploaded to the contracts folder')
  .refine(
    (key) => /\.(pdf|jpe?g|png)$/i.test(key),
    'Signed contract must be a PDF, JPG, JPEG, or PNG file',
  );

export const createProjectSchema = z.object({
  ...projectDetailsSchema.shape,
  customerId: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid customer ID').optional(),
  appointmentId: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid appointment ID').optional(),
  title: z.string().trim().min(1).max(100),
  serviceType: z.string().trim().min(1).max(100),
  deliveryType: z.nativeEnum(DeliveryType).optional(),
  description: z.string().trim().min(1).max(2000),
  siteAddress: z.string().trim().min(1).max(500),
  measurements: z.object({
    length: z.number().positive().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    area: z.number().positive().optional(),
    thickness: z.number().positive().optional(),
    unit: z.string().default('cm'),
  }).optional(),
  materialType: z.string().max(1000).optional(),
  finishColor: z.string().max(500).optional(),
  quantity: z.number().int().min(1).default(1),
  notes: z.string().max(2000).trim().optional(),
  contractFileKey: signedContractFileKeySchema,
  contractFileName: z.string().max(255).trim().optional(),
  contractContentType: z.string().max(100).trim().optional(),
  contractFileSize: z.number().int().positive().optional(),
}).refine((input) => Boolean(input.customerId || input.appointmentId), {
  message: 'Select a customer for the project',
  path: ['customerId'],
});

export const updateProjectSchema = z.object({
  title: z.string().min(1).max(100).trim().optional(),
  serviceType: z.string().min(1).max(100).trim().optional(),
  deliveryType: z.nativeEnum(DeliveryType).optional(),
  description: z.string().min(1).max(2000).trim().optional(),
  siteAddress: z.string().min(1).max(500).trim().optional(),
  measurements: z.object({
    length: z.number().positive().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    area: z.number().positive().optional(),
    thickness: z.number().positive().optional(),
    unit: z.string().default('cm'),
  }).optional(),
  materialType: z.string().max(100).optional(),
  finishColor: z.string().max(50).optional(),
  quantity: z.number().int().min(1).optional(),
  notes: z.string().max(2000).trim().optional(),
  estimatedCompletionDate: z.string().datetime().optional(),
});

export const assignEngineersSchema = z.object({
  engineerIds: z.array(z.string().min(1)).min(1),
});

export const reassignProjectSalesSchema = z.object({
  salesStaffId: z.string().min(1),
  reason: z.string().max(500).trim().optional(),
});

export const assignFabricationSchema = z.object({
  fabricationLeadId: z.string().min(1),
  fabricationAssistantIds: z.array(z.string().min(1)).default([]),
});

export const transitionProjectSchema = z.object({
  status: z.nativeEnum(ProjectStatus),
  cancelReason: z.string().max(500).trim().optional(),
});

export const signContractSchema = z.object({
  signatureKey: z.string().min(1, 'Signature is required'),
});

export const signEngineerContractSchema = z.object({
  signatureKey: z.string().min(1, 'Engineer signature is required'),
});

export const uploadSignedContractSchema = z.object({
  contractFileKey: signedContractFileKeySchema,
  contractFileName: z.string().max(255).trim().optional(),
  contractContentType: z.string().max(100).trim().optional(),
  contractFileSize: z.number().int().positive().optional(),
});

export const reviewInitialDesignSchema = z.object({
  decision: z.enum(['approved', 'declined']),
  notes: z.string().max(2000).trim().optional(),
  projectItemId: z.string().min(1).optional(),
}).refine(
  (data) => data.decision !== 'declined' || Boolean(data.notes?.trim()),
  {
    message: 'Internal review notes are required when declining',
    path: ['notes'],
  },
);

export const resubmitInitialDesignSchema = z.object({
  initialDesignKeys: z.array(z.string()).max(10).optional(),
  initialDesignNotes: z.string().max(2000).trim().optional(),
  projectItemId: z.string().min(1).optional(),
}).refine(
  (data) => (data.initialDesignKeys?.length || 0) > 0 || !!data.initialDesignNotes,
  {
    message: 'Provide at least one design file or a note',
    path: ['initialDesignKeys'],
  },
);

export const backfillInitialDesignSchema = z.object({
  initialDesignKeys: z.array(z.string()).max(10).optional(),
  initialDesignNotes: z.string().max(2000).trim().optional(),
  backfillReason: z.string().min(10).max(2000).trim(),
}).refine(
  (data) => (data.initialDesignKeys?.length || 0) > 0 || !!data.initialDesignNotes,
  {
    message: 'Provide at least one design file or a note',
    path: ['initialDesignKeys'],
  },
);

export const selectPaymentPlanSchema = z.object({
  paymentType: z.enum(['full', 'installment']),
  projectItemId: z.string().min(1).optional(),
});

export const submitProjectReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1200).trim().optional(),
});

export const skipProjectReviewSchema = z.object({
  reason: z.string().max(400).trim().optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type AssignEngineersInput = z.infer<typeof assignEngineersSchema>;
export type ReassignProjectSalesInput = z.infer<typeof reassignProjectSalesSchema>;
export type AssignFabricationInput = z.infer<typeof assignFabricationSchema>;
export type TransitionProjectInput = z.infer<typeof transitionProjectSchema>;
export type SignContractInput = z.infer<typeof signContractSchema>;
export type SignEngineerContractInput = z.infer<typeof signEngineerContractSchema>;
export type UploadSignedContractInput = z.infer<typeof uploadSignedContractSchema>;
export type ReviewInitialDesignInput = z.infer<typeof reviewInitialDesignSchema>;
export type ResubmitInitialDesignInput = z.infer<typeof resubmitInitialDesignSchema>;
export type BackfillInitialDesignInput = z.infer<typeof backfillInitialDesignSchema>;
export type SelectPaymentPlanInput = z.infer<typeof selectPaymentPlanSchema>;
export type SubmitProjectReviewInput = z.infer<typeof submitProjectReviewSchema>;
export type SkipProjectReviewInput = z.infer<typeof skipProjectReviewSchema>;
