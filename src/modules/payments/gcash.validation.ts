import { z } from 'zod';

const gcashTargetObject = z.object({
  bookingId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  stageId: z.string().min(1).max(100).optional(),
});
const ONE_TARGET_MESSAGE = 'Choose one booking or payment stage';
export const OCULAR_FEE_ACK_MESSAGE = 'Please confirm that the ocular fee is non-refundable before paying';

export const gcashTargetSchema = gcashTargetObject
  .refine((data) => Boolean(data.bookingId) !== Boolean(data.stageId), ONE_TARGET_MESSAGE);
/** Customer picks cash: an ocular fee (booking) needs the non-refundable acknowledgment. */
export const selectCashSchema = gcashTargetObject
  .extend({ acknowledgeNonRefundable: z.boolean().optional() })
  .refine((data) => Boolean(data.bookingId) !== Boolean(data.stageId), ONE_TARGET_MESSAGE)
  .refine((data) => !data.bookingId || data.acknowledgeNonRefundable === true, {
    message: OCULAR_FEE_ACK_MESSAGE,
    path: ['acknowledgeNonRefundable'],
  });
/** Body for the customer's own ocular fee checkout / cash request. */
export const ocularFeeAckSchema = z.object({
  acknowledgeNonRefundable: z.literal(true, { message: OCULAR_FEE_ACK_MESSAGE }),
});
export const submitGcashSchema = z.object({
  bookingId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  stageId: z.string().min(1).max(100).optional(),
  referenceNumber: z.string().trim().regex(/^\d{13}$/, 'Enter the 13-digit GCash reference number'),
  // amountPaid and paymentDate are not accepted from the client: the amount is the
  // backend-computed amount due and the date is the moment of submission. The GCash
  // reference number is the unique evidence the cashier verifies against.
  proofKey: z.string().min(1).max(300).optional(),
  acknowledgeNonRefundable: z.boolean().optional(),
})
  .refine((data) => Boolean(data.bookingId) !== Boolean(data.stageId), ONE_TARGET_MESSAGE)
  .refine((data) => !data.bookingId || data.acknowledgeNonRefundable === true, {
    message: OCULAR_FEE_ACK_MESSAGE,
    path: ['acknowledgeNonRefundable'],
  });
export const gcashSettingsSchema = z.object({
  accountName: z.string().trim().max(200),
  accountNumber: z.string().trim().regex(/^(09\d{9})?$/, 'Use an 11-digit mobile number starting with 09'),
  qrCodeKey: z.string().max(300).refine((key) => !key || /^gcash-qr\/[\w.-]+\.(png|jpg|jpeg|webp)$/i.test(key), 'Upload a QR image').optional(),
});
export type GcashTarget = z.infer<typeof gcashTargetSchema>;
export type SubmitGcashInput = z.infer<typeof submitGcashSchema>;
