import { z } from 'zod';
import { AppointmentType, PaymentMethod, SLOT_CODES } from '../../utils/constants.js';

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const requestAppointmentSchema = z.object({
  type: z.nativeEnum(AppointmentType),
  date: z.string().regex(dateRegex, 'Date must be YYYY-MM-DD'),
  slotCode: z.enum(SLOT_CODES as unknown as [string, ...string[]]),
  purpose: z.string().max(500).trim().optional(),
  formattedAddress: z.string().max(500).trim().optional(),
  customerLocation: locationSchema.optional(),
}).refine(
  (data) => data.type !== AppointmentType.OCULAR || !!data.customerLocation,
  {
    message: 'Ocular appointments require a pinned map location',
    path: ['customerLocation'],
  },
);

export const agentCreateAppointmentSchema = requestAppointmentSchema.extend({
  customerId: z.string().min(1),
});

export const confirmAppointmentSchema = z.object({
  salesStaffId: z.string().min(1),
  internalNotes: z.string().max(1000).trim().optional(),
});

export const rescheduleRequestSchema = z.object({
  reason: z.string().min(1).max(500).trim(),
  newDate: z.string().regex(dateRegex, 'Date must be YYYY-MM-DD').optional(),
  newSlotCode: z.enum(SLOT_CODES as unknown as [string, ...string[]]).optional(),
});

export const rescheduleCompleteSchema = z.object({
  date: z.string().regex(dateRegex, 'Date must be YYYY-MM-DD'),
  slotCode: z.enum(SLOT_CODES as unknown as [string, ...string[]]),
  salesStaffId: z.string().optional(),
});

export const cancelAppointmentSchema = z.object({
  reason: z.string().max(500).trim().optional(),
});

export const noShowSchema = z.object({
  internalNotes: z.string().max(1000).trim().optional(),
});

export const recordOcularFeeSchema = z.object({
  paymentMethod: z.nativeEnum(PaymentMethod),
});

export const availableSlotsQuerySchema = z.object({
  date: z.string().regex(dateRegex),
  type: z.nativeEnum(AppointmentType),
});

export type RequestAppointmentInput = z.infer<typeof requestAppointmentSchema>;
export type AgentCreateAppointmentInput = z.infer<typeof agentCreateAppointmentSchema>;
export type ConfirmAppointmentInput = z.infer<typeof confirmAppointmentSchema>;
export type RescheduleRequestInput = z.infer<typeof rescheduleRequestSchema>;
export type RescheduleCompleteInput = z.infer<typeof rescheduleCompleteSchema>;
export type CancelAppointmentInput = z.infer<typeof cancelAppointmentSchema>;
export type RecordOcularFeeInput = z.infer<typeof recordOcularFeeSchema>;
export type AvailableSlotsQuery = z.infer<typeof availableSlotsQuerySchema>;
