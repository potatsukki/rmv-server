import { z } from 'zod';
import { AppointmentType, PaymentMethod, SLOT_CODES } from '../../utils/constants.js';

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

// ── Customer: Request Appointment ──
export const requestAppointmentSchema = z.object({
  type: z.nativeEnum(AppointmentType),
  date: z.string().regex(dateRegex, 'Date must be YYYY-MM-DD'),
  slotCode: z.enum(SLOT_CODES as unknown as [string, ...string[]]),
  purpose: z.string().max(500).trim().optional(),
  // Ocular-specific: address is required, location (lat/lng) optional at booking time
  address: z.string().max(500).trim().optional(),
  customerLocation: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }).optional(),
}).refine(
  (data) => {
    if (data.type === AppointmentType.OCULAR) {
      return !!data.address;
    }
    return true;
  },
  { message: 'Ocular appointments require an address', path: ['address'] },
);

// ── Agent: Create Appointment on behalf of customer ──
export const agentCreateAppointmentSchema = requestAppointmentSchema.extend({
  customerId: z.string().min(1),
});

// ── Agent: Confirm Appointment ──
export const confirmAppointmentSchema = z.object({
  salesStaffId: z.string().min(1),
  internalNotes: z.string().max(1000).trim().optional(),
});

// ── Customer: Request Reschedule ──
export const rescheduleRequestSchema = z.object({
  reason: z.string().min(1).max(500).trim(),
  newDate: z.string().regex(dateRegex, 'Date must be YYYY-MM-DD').optional(),
  newSlotCode: z.enum(SLOT_CODES as unknown as [string, ...string[]]).optional(),
});

// ── Agent: Complete Reschedule (pick new slot) ──
export const rescheduleCompleteSchema = z.object({
  date: z.string().regex(dateRegex, 'Date must be YYYY-MM-DD'),
  slotCode: z.enum(SLOT_CODES as unknown as [string, ...string[]]),
  salesStaffId: z.string().optional(), // Can re-assign sales
});

// ── Cancel ──
export const cancelAppointmentSchema = z.object({
  reason: z.string().max(500).trim().optional(),
});

// ── Mark No-Show ──
export const noShowSchema = z.object({
  internalNotes: z.string().max(1000).trim().optional(),
});

// ── Ocular fee record ──
export const recordOcularFeeSchema = z.object({
  paymentMethod: z.nativeEnum(PaymentMethod),
});

// ── Available Slots Query ──
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
