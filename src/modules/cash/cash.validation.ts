import { z } from 'zod';

export const recordCashCollectionSchema = z.object({
  appointmentId: z.string().min(1),
  amountCollected: z.number().positive(),
  notes: z.string().max(500).trim().optional(),
  photoKey: z.string().optional(),
});

export const receiveCashSchema = z.object({
  amountReceived: z.number().min(0),
});

export const resolveDiscrepancySchema = z.object({
  resolutionNotes: z.string().min(1).max(1000).trim(),
});

export type RecordCashCollectionInput = z.infer<typeof recordCashCollectionSchema>;
export type ReceiveCashInput = z.infer<typeof receiveCashSchema>;
export type ResolveDiscrepancyInput = z.infer<typeof resolveDiscrepancySchema>;
