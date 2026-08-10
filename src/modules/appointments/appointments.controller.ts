import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as appointmentsService from './appointments.service.js';
import { AppointmentStatus, Role } from '../../utils/constants.js';

/** Map populated appointment to the shape the frontend expects */
function formatAppointment(appt: any) {
  const obj = appt.toObject ? appt.toObject() : { ...appt };
  const isPopulatedUser = (value: any) => (
    !!value
    && typeof value === 'object'
    && (typeof value.firstName === 'string' || typeof value.lastName === 'string')
  );
  const toIdString = (value: any): string | undefined => {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value._id?.toString === 'function') return value._id.toString();
    if (typeof value.toString === 'function') {
      const str = value.toString();
      return str && str !== '[object Object]' ? str : undefined;
    }
    return undefined;
  };
  const fullName = (value: any): string | undefined => {
    const first = typeof value?.firstName === 'string' ? value.firstName.trim() : '';
    const last = typeof value?.lastName === 'string' ? value.lastName.trim() : '';
    const joined = [first, last].filter(Boolean).join(' ');
    return joined || undefined;
  };

  const cust = isPopulatedUser(obj.customerId) ? obj.customerId : null;
  const sales = isPopulatedUser(obj.salesStaffId) ? obj.salesStaffId : null;
  const location = obj.customerLocation || (
    typeof obj.latitude === 'number' && typeof obj.longitude === 'number'
      ? { lat: obj.latitude, lng: obj.longitude }
      : undefined
  );
  return {
    ...obj,
    customerId: toIdString(obj.customerId) || obj.customerId,
    customerName: obj.customerName || fullName(cust),
    customerPhone: obj.customerPhone || cust?.phone,
    salesStaffId: toIdString(obj.salesStaffId) || obj.salesStaffId || undefined,
    salesStaffName: obj.salesStaffName || fullName(sales),
    address: obj.formattedAddress || obj.customerAddress,
    formattedAddress: obj.formattedAddress || obj.customerAddress,
    latitude: location?.lat,
    longitude: location?.lng,
    location,
    purpose: obj.customerNotes,
  };
}

// ── Get Available Slots ──
export const getAvailableSlots = asyncHandler(async (req: Request, res: Response) => {
  const result = await appointmentsService.getAvailableSlots(req.query as any);
  res.json({ success: true, data: result });
});

// ── Customer: Request Appointment ──
export const requestAppointment = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.requestAppointment(
    req.body,
    req.userId!,
    req.userRoles ?? [],
    req.ip,
    req.get('user-agent'),
  );
  res.status(201).json({ success: true, data: appointment });
});

// ── Agent: Create on behalf of customer ──
export const agentCreateAppointment = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.agentCreateAppointment(
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.status(201).json({ success: true, data: appointment });
});

// ── Confirm ──
export const confirmAppointment = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.confirmAppointment(
    (req.params.id as string),
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

export const reassignAppointmentSales = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.reassignAppointmentSales(
    req.params.id as string,
    req.body,
    req.userId!,
    req.userRoles!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

export const reviewAssignedAppointment = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.reviewAssignedAppointment(
    req.params.id as string,
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ── Complete ──
export const completeAppointment = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.completeAppointment(
    (req.params.id as string),
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ── Update Visit Status (Preparing / On The Way) ──
export const updateVisitStatus = asyncHandler(async (req: Request, res: Response) => {
  const newStatus = req.params.status as
    | AppointmentStatus.PREPARING
    | AppointmentStatus.ON_THE_WAY
    | AppointmentStatus.ARRIVED_AT_SITE
    | AppointmentStatus.IN_PROGRESS;
  const appointment = await appointmentsService.updateVisitStatus(
    req.params.id as string,
    newStatus,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ── No Show ──
export const markNoShow = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.markNoShow(
    (req.params.id as string),
    req.body.internalNotes,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

export const updateConsultationAttendance = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.updateConsultationAttendance(
    req.params.id as string,
    req.body,
    req.userId!,
    req.userRoles!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: formatAppointment(appointment) });
});

// ── Customer: Request Reschedule ──
export const requestReschedule = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.requestReschedule(
    (req.params.id as string),
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ── Agent: Complete Reschedule ──
export const completeReschedule = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.completeReschedule(
    (req.params.id as string),
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

export const rejectReschedule = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.rejectReschedule(
    req.params.id as string,
    req.userId!,
    req.ip,
    req.get('user-agent'),
    req.body.reason,
  );
  res.json({ success: true, data: appointment });
});

// ── Cancel ──
export const cancelAppointment = asyncHandler(async (req: Request, res: Response) => {
  const primaryRole = req.userRoles!.includes(Role.CUSTOMER) ? Role.CUSTOMER : req.userRoles![0];
  const appointment = await appointmentsService.cancelAppointment(
    (req.params.id as string),
    req.body.reason,
    req.userId!,
    primaryRole,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ── Record Ocular Fee ──
export const recordOcularFee = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.recordOcularFee(
    (req.params.id as string),
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ⚠️ TESTING ONLY: Simulate ocular fee payment. Remove for production.
export const simulateOcularFeePayment = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.simulateOcularFeePayment(
    req.params.id as string,
    req.userId!,
  );
  res.json({ success: true, data: { verified: true, appointmentId: appointment._id } });
});
// ⚠️ END TESTING ONLY

// ── Customer: Verify Ocular Fee Checkout via PayMongo API ──
export const verifyOcularFeeCheckout = asyncHandler(async (req: Request, res: Response) => {
  const result = await appointmentsService.verifyOcularFeeCheckout(
    req.params.id as string,
    req.userId!,
  );
  res.json({ success: true, data: { verified: result.verified, appointment: result.appointment } });
});

// ── Customer: Create PayMongo Checkout for Ocular Fee ──
export const createOcularFeeCheckout = asyncHandler(async (req: Request, res: Response) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const clientOrigin = req.headers.origin || req.headers.referer?.replace(/\/$/, '') || origin;
  const result = await appointmentsService.createOcularFeeCheckout(
    (req.params.id as string),
    req.userId!,
    clientOrigin as string,
    req.ip,
    req.get('user-agent'),
  );
  res.json({
    success: true,
    data: {
      checkoutUrl: result.checkoutUrl,
      sessionId: result.sessionId,
    },
  });
});

// ── Customer: Request Ocular Fee Cash Payment ──
export const requestOcularCashPayment = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.requestOcularCashPayment(
    req.params.id as string,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ── Customer: Submit Ocular Fee Proof (manual fallback) ──
export const submitOcularFeeProof = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.submitOcularFeeProof(
    (req.params.id as string),
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ── Cashier: Verify Ocular Fee ──
export const verifyOcularFee = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.verifyOcularFee(
    (req.params.id as string),
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ── Cashier: Decline Ocular Fee ──
export const declineOcularFee = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.declineOcularFee(
    (req.params.id as string),
    req.body.reason,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});

// ── Cashier: List Pending Ocular Fees ──
export const listPendingOcularFees = asyncHandler(async (_req: Request, res: Response) => {
  const appointments = await appointmentsService.listPendingOcularFees();
  res.json({ success: true, data: appointments.map(formatAppointment) });
});


// ── Get By ID ──
export const getAppointmentById = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.getAppointmentById(
    (req.params.id as string),
    req.userId!,
    req.userRoles!,
  );
  res.json({ success: true, data: formatAppointment(appointment) });
});

// ── Customer: Submit Site Details ──
export const submitSiteDetails = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.submitSiteDetails(
    req.params.id as string,
    req.body,
    req.userId!,
  );
  res.json({ success: true, data: formatAppointment(appointment) });
});

// ── Customer: Skip Site Details (ocular only) ──
export const skipSiteDetails = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.skipSiteDetails(
    req.params.id as string,
    req.userId!,
  );
  res.json({ success: true, data: formatAppointment(appointment) });
});

// ── List ──
export const listAppointments = asyncHandler(async (req: Request, res: Response) => {
  const result = await appointmentsService.listAppointments(
    req.query as any,
    req.userId!,
    req.userRoles!,
  );
  res.json({
    success: true,
    data: {
      ...result,
      items: result.items.map(formatAppointment),
    },
  });
});

// ── Appointment Queue ──
export const listAppointmentQueue = asyncHandler(async (req: Request, res: Response) => {
  const result = await appointmentsService.listAppointmentQueue(
    req.query as any,
    req.userId!,
    req.userRoles!,
  );

  res.json({
    success: true,
    data: {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        appointment: formatAppointment(item.appointment),
      })),
    },
  });
});

// ── Agent: Create Ocular (from consultation context) ──
export const agentCreateOcular = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.agentCreateOcular(
    req.body,
    req.userId!,
    req.userRoles ?? [],
    req.ip,
    req.get('user-agent'),
  );
  res.status(201).json({ success: true, data: appointment });
});

// ── Customer: Submit Ocular Location ──
export const customerSubmitOcularLocation = asyncHandler(async (req: Request, res: Response) => {
  const submittedAppointment = await appointmentsService.customerSubmitOcularLocation(
    req.params.id as string,
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );

  // Re-fetch with populated refs so response keeps stable customer/sales display fields.
  const appointment = await appointmentsService.getAppointmentById(
    submittedAppointment._id.toString(),
    req.userId!,
    req.userRoles!,
  );

  res.json({ success: true, data: formatAppointment(appointment) });
});

// ── Agent: Finalize Ocular ──
export const agentFinalizeOcular = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.agentFinalizeOcular(
    req.params.id as string,
    req.body,
    req.userId!,
    req.userRoles ?? [],
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: appointment });
});
