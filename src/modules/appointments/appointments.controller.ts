import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as appointmentsService from './appointments.service.js';
import { Role } from '../../utils/constants.js';

/** Map populated appointment to the shape the frontend expects */
function formatAppointment(appt: any) {
  const obj = appt.toObject ? appt.toObject() : { ...appt };
  const cust = obj.customerId && typeof obj.customerId === 'object' ? obj.customerId : null;
  const sales = obj.salesStaffId && typeof obj.salesStaffId === 'object' ? obj.salesStaffId : null;
  const location = obj.customerLocation || (
    typeof obj.latitude === 'number' && typeof obj.longitude === 'number'
      ? { lat: obj.latitude, lng: obj.longitude }
      : undefined
  );
  return {
    ...obj,
    customerId: cust?._id?.toString() || obj.customerId,
    customerName: cust ? `${cust.firstName} ${cust.lastName}` : undefined,
    salesStaffId: sales?._id?.toString() || obj.salesStaffId || undefined,
    salesStaffName: sales ? `${sales.firstName} ${sales.lastName}` : undefined,
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

// ── Get By ID ──
export const getAppointmentById = asyncHandler(async (req: Request, res: Response) => {
  const appointment = await appointmentsService.getAppointmentById(
    (req.params.id as string),
    req.userId!,
    req.userRoles!,
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
