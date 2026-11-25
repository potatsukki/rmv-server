import { z } from 'zod';

const MAX_CASH_AMOUNT = 999_999_999; // disallow billions/trillions

export const recordCashCollectionSchema = z.object({
  appointmentId: z.string().min(1),
  amountCollected: z.number().positive().max(MAX_CASH_AMOUNT),
  notes: z.string().max(500).trim().optional(),
  photoKey: z.string().optional(),
  customerAcknowledgedInPerson: z.boolean().optional(),
});

/** Sales staff records cash the customer handed over during the ocular visit. */
export const onsiteCashSchema = z.object({
  customerAcknowledgedInPerson: z.boolean().optional(),
  notes: z.string().max(500).trim().optional(),
});

export const receiveCashSchema = z.object({
  amountReceived: z.number().min(0).max(MAX_CASH_AMOUNT),
});

export const resolveDiscrepancySchema = z.object({
  resolutionNotes: z.string().min(1).max(1000).trim(),
});

export type RecordCashCollectionInput = z.infer<typeof recordCashCollectionSchema>;
export type OnsiteCashBody = z.infer<typeof onsiteCashSchema>;
export type ReceiveCashInput = z.infer<typeof receiveCashSchema>;
export type ResolveDiscrepancyInput = z.infer<typeof resolveDiscrepancySchema>;
