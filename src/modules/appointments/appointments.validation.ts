import { z } from 'zod';
import { AppointmentType, PaymentMethod, OcularFeePaymentChoice, ServiceType, MeasurementUnit, Environment, SLOT_CODES } from '../../utils/constants.js';
import { isSafeLocalCatalogImagePath } from '../../utils/selectedDesign.js';

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const addressStructuredSchema = z.object({
  street: z.string().max(200).trim(),
  barangay: z.string().max(100).trim(),
  city: z.string().max(100).trim(),
  province: z.string().max(100).trim(),
  zip: z.string().max(10).trim(),
});

const selectedDesignImageUrlSchema = z.string()
  .max(1000)
  .trim()
  .refine(
    isSafeLocalCatalogImagePath,
    'Selected design image must use a local catalog path',
  );

const appointmentRequestBaseSchema = z.object({
  type: z.nativeEnum(AppointmentType),
  date: z.string().regex(dateRegex, 'Date must be YYYY-MM-DD'),
  slotCode: z.enum(SLOT_CODES as unknown as [string, ...string[]]),
  purpose: z.string().max(500).trim().optional(),
  serviceTypes: z.array(z.nativeEnum(ServiceType)).optional(),
  serviceTypeCustom: z.string().max(200).trim().optional(),
  formattedAddress: z.string().max(500).trim().optional(),
  customerLocation: locationSchema.optional(),
  addressStructured: addressStructuredSchema.optional(),
  ocularFeePaymentChoice: z.nativeEnum(OcularFeePaymentChoice).optional(),
});

export const requestAppointmentSchema = appointmentRequestBaseSchema.extend({
  selectedDesignTemplateId: z.string().max(100).trim().optional(),
  selectedDesignTemplateName: z.string().max(200).trim().optional(),
  selectedDesignTemplateImageUrl: selectedDesignImageUrlSchema.optional(),
});

export const agentCreateAppointmentSchema = appointmentRequestBaseSchema.extend({
  customerId: z.string().min(1),
  type: z.literal(AppointmentType.OFFICE),
});

export const confirmAppointmentSchema = z.object({
  salesStaffId: z.string().min(1),
  internalNotes: z.string().max(1000).trim().optional(),
});

export const reassignAppointmentSalesSchema = z.object({
  salesStaffId: z.string().min(1),
  reason: z.string().max(500).trim().optional(),
});

export const salesAppointmentDecisionSchema = z.object({
  decision: z.enum(['accept', 'decline']),
  reason: z.string().max(500).trim().optional(),
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

export const consultationAttendanceSchema = z.object({
  action: z.enum(['check_in', 'no_show', 'reschedule', 'customer_declined']),
  actualArrivalAt: z.string().datetime().optional(),
  notes: z.string().max(1000).trim().optional(),
  overrideReason: z.string().max(1000).trim().optional(),
});

export const recordOcularFeeSchema = z.object({
  paymentMethod: z.nativeEnum(PaymentMethod),
});

export const submitOcularFeeProofSchema = z.object({
  referenceNumber: z.string().min(1, 'Reference number is required').max(100).trim(),
  proofKey: z.string().min(1, 'Proof upload is required'),
});

export const declineOcularFeeSchema = z.object({
  reason: z.string().min(1, 'Reason is required').max(500).trim(),
});

export const availableSlotsQuerySchema = z.object({
  date: z.string().regex(dateRegex),
  type: z.nativeEnum(AppointmentType),
});

export const appointmentQueueQuerySchema = z.object({
  status: z.string().max(120).trim().optional(),
  search: z.string().max(120).trim().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(120),
});

export type RequestAppointmentInput = z.infer<typeof requestAppointmentSchema>;
export type AgentCreateAppointmentInput = z.infer<typeof agentCreateAppointmentSchema>;
export type ConfirmAppointmentInput = z.infer<typeof confirmAppointmentSchema>;
export type ReassignAppointmentSalesInput = z.infer<typeof reassignAppointmentSalesSchema>;
export type SalesAppointmentDecisionInput = z.infer<typeof salesAppointmentDecisionSchema>;
export type RescheduleRequestInput = z.infer<typeof rescheduleRequestSchema>;
export type RescheduleCompleteInput = z.infer<typeof rescheduleCompleteSchema>;
export type CancelAppointmentInput = z.infer<typeof cancelAppointmentSchema>;
export type ConsultationAttendanceInput = z.infer<typeof consultationAttendanceSchema>;
export type RecordOcularFeeInput = z.infer<typeof recordOcularFeeSchema>;
export type SubmitOcularFeeProofInput = z.infer<typeof submitOcularFeeProofSchema>;
export type DeclineOcularFeeInput = z.infer<typeof declineOcularFeeSchema>;
export type AvailableSlotsQuery = z.infer<typeof availableSlotsQuerySchema>;
export type AppointmentQueueQuery = z.infer<typeof appointmentQueueQuerySchema>;

// ── Customer Site Details (pre-visit info) ──
const siteDetailsLineItemSchema = z.object({
  label: z.string().min(1).max(200).trim(),
  length: z.number().positive().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  area: z.number().positive().optional(),
  thickness: z.number().positive().optional(),
  quantity: z.number().int().min(1).default(1),
  notes: z.string().max(500).trim().optional(),
});

const siteDetailsSiteConditionsSchema = z.object({
  environment: z.nativeEnum(Environment).default(Environment.INDOOR),
  floorType: z.string().max(200).trim().optional(),
  wallMaterial: z.string().max(200).trim().optional(),
  hasElectrical: z.boolean().optional(),
  hasPlumbing: z.boolean().optional(),
  accessNotes: z.string().max(1000).trim().optional(),
  obstaclesOrConstraints: z.string().max(1000).trim().optional(),
});

export const submitSiteDetailsSchema = z.object({
  serviceTypes: z.array(z.nativeEnum(ServiceType)).optional(),
  serviceTypeCustom: z.string().max(200).trim().optional(),
  measurementUnit: z.nativeEnum(MeasurementUnit).optional(),
  lineItems: z.array(siteDetailsLineItemSchema).max(50).optional(),
  siteConditions: siteDetailsSiteConditionsSchema.optional(),
  materials: z.string().max(1000).trim().optional(),
  finishes: z.string().max(500).trim().optional(),
  preferredDesign: z.string().max(1000).trim().optional(),
  customerRequirements: z.string().max(2000).trim().optional(),
  notes: z.string().max(3000).trim().optional(),
  photoKeys: z.array(z.string()).max(20).optional(),
  videoKeys: z.array(z.string()).max(5).optional(),
  sketchKeys: z.array(z.string()).max(10).optional(),
  referenceImageKeys: z.array(z.string()).max(10).optional(),
});

export type SubmitSiteDetailsInput = z.infer<typeof submitSiteDetailsSchema>;

// ── Agent Create Ocular (from consultation context) ──
export const agentCreateOcularSchema = z.object({
  customerId: z.string().min(1),
  date: z.string().regex(dateRegex, 'Date must be YYYY-MM-DD'),
  slotCode: z.enum(SLOT_CODES as unknown as [string, ...string[]]),
  visitReportId: z.string().optional(),
});

export type AgentCreateOcularInput = z.infer<typeof agentCreateOcularSchema>;

// ── Customer Submit Ocular Location ──
export const submitOcularLocationSchema = z.object({
  customerLocation: locationSchema,
  formattedAddress: z.string().max(500).trim().optional(),
  addressStructured: addressStructuredSchema.optional(),
});

export type SubmitOcularLocationInput = z.infer<typeof submitOcularLocationSchema>;

// ── Agent Finalize Ocular ──
export const agentFinalizeOcularSchema = z.object({
  internalNotes: z.string().max(1000).trim().optional(),
});

export type AgentFinalizeOcularInput = z.infer<typeof agentFinalizeOcularSchema>;
