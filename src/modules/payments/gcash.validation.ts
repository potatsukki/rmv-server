import { z } from 'zod';

const money = z.number().positive().max(999_999_999).refine(
  (value) => Math.round(value * 100) === value * 100 || Math.abs(Math.round(value * 100) - value * 100) < 1e-6,
  'Use no more than two decimal places',
);
export const gcashTargetSchema = z.object({
  bookingId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  stageId: z.string().min(1).max(100).optional(),
}).refine((data) => Boolean(data.bookingId) !== Boolean(data.stageId), 'Choose one booking or payment stage');
export const submitGcashSchema = z.object({
  bookingId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  stageId: z.string().min(1).max(100).optional(),
  referenceNumber: z.string().trim().regex(/^\d{13}$/, 'Enter the 13-digit GCash reference number'),
  amountPaid: money,
  paymentDate: z.string().datetime({ offset: true }).refine(
    (value) => Date.parse(value) <= Date.now(), 'Payment date cannot be in the future',
  ),
  proofKey: z.string().min(1).max(300).optional(),
}).refine((data) => Boolean(data.bookingId) !== Boolean(data.stageId), 'Choose one booking or payment stage');
export const gcashSettingsSchema = z.object({
  accountName: z.string().trim().max(200),
  accountNumber: z.string().trim().regex(/^(09\d{9})?$/, 'Use an 11-digit mobile number starting with 09'),
  qrCodeKey: z.string().max(300).refine((key) => !key || /^gcash-qr\/[\w.-]+\.(png|jpg|jpeg|webp)$/i.test(key), 'Upload a QR image').optional(),
});
export type GcashTarget = z.infer<typeof gcashTargetSchema>;
export type SubmitGcashInput = z.infer<typeof submitGcashSchema>;
