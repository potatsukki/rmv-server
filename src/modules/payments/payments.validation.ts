import { z } from 'zod';
import { PaymentMethod } from '../../utils/constants.js';

export const createPaymentPlanSchema = z.object({
  projectId: z.string().min(1),
  totalAmount: z.number().positive(),
  stages: z.array(z.object({
    percentage: z.number().positive().max(100),
    qrCodeKey: z.string().optional(),
  })).min(1).max(6).refine(
    (stages) => {
      const sum = stages.reduce((acc, s) => acc + s.percentage, 0);
      return Math.abs(sum - 100) < 0.01;
    },
    { message: 'Stage percentages must sum to 100%' },
  ),
});

export const updatePaymentPlanSchema = z.object({
  totalAmount: z.number().positive().optional(),
  stages: z.array(z.object({
    percentage: z.number().positive().max(100),
    qrCodeKey: z.string().optional(),
  })).min(1).max(6).optional(),
});

export const submitPaymentProofSchema = z.object({
  stageId: z.string().min(1),
  method: z.nativeEnum(PaymentMethod),
  amountPaid: z.number().positive(),
  referenceNumber: z.string().max(100).trim().optional(),
  proofKey: z.string().min(1),
});

export const verifyPaymentSchema = z.object({
  notes: z.string().max(500).trim().optional(),
});

export const declinePaymentSchema = z.object({
  reason: z.string().min(1).max(500).trim(),
});

export type CreatePaymentPlanInput = z.infer<typeof createPaymentPlanSchema>;
export type UpdatePaymentPlanInput = z.infer<typeof updatePaymentPlanSchema>;
export type SubmitPaymentProofInput = z.infer<typeof submitPaymentProofSchema>;
export type DeclinePaymentInput = z.infer<typeof declinePaymentSchema>;
