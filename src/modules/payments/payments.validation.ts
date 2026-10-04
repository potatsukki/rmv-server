import { z } from 'zod';
import { PaymentMethod } from '../../utils/constants.js';

const MAX_PAYMENT_AMOUNT = 999_999_999; // disallow billions/trillions

export const createPaymentPlanSchema = z.object({
  projectId: z.string().min(1),
  projectItemId: z.string().min(1).optional(),
  totalAmount: z.number().positive().max(MAX_PAYMENT_AMOUNT),
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
  totalAmount: z.number().positive().max(MAX_PAYMENT_AMOUNT).optional(),
  stages: z.array(z.object({
    percentage: z.number().positive().max(100),
    qrCodeKey: z.string().optional(),
  })).min(1).max(6).optional(),
});

export const submitPaymentProofSchema = z.object({
  stageId: z.string().min(1),
  method: z.nativeEnum(PaymentMethod),
  amountPaid: z.number().positive().max(MAX_PAYMENT_AMOUNT),
  referenceNumber: z.string().max(100).trim().optional(),
  proofKey: z.string().min(1).optional(),
  paymentDate: z.string().datetime({ offset: true }),
});

export const verifyPaymentSchema = z.object({
  signatureKey: z.string().min(1, 'Cashier signature is required'),
  notes: z.string().max(500).trim().optional(),
});

export const declinePaymentSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

export const recordCashPaymentSchema = z.object({
  stageId: z.string().min(1),
  amountPaid: z.number().positive().max(MAX_PAYMENT_AMOUNT).refine(
    (amount) => Number(amount.toFixed(2)) === amount,
    { message: 'Use no more than two decimal places' },
  ),
});

export type CreatePaymentPlanInput = z.infer<typeof createPaymentPlanSchema>;
export type UpdatePaymentPlanInput = z.infer<typeof updatePaymentPlanSchema>;
export type SubmitPaymentProofInput = z.infer<typeof submitPaymentProofSchema>;
export type VerifyPaymentInput = z.infer<typeof verifyPaymentSchema>;
export type DeclinePaymentInput = z.infer<typeof declinePaymentSchema>;
