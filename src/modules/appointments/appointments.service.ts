import { format, parse, isAfter, isBefore, startOfDay, addMinutes } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import {
  Appointment, SlotLock, User, AuditLog, Holiday, SalesAvailability, Config,
} from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import {
  AppointmentStatus, AppointmentType, Role, AuditAction,
  NotificationCategory, SLOT_CODES, type SlotCode,
} from '../../utils/constants.js';
import { appointmentStateMachine } from '../../utils/stateMachine.js';
import { createAndSendNotification, notifyRole } from '../notifications/socket.service.js';
import { sendAppointmentConfirmedEmail } from '../notifications/email.service.js';
import { autoCreateDraft as autoCreateVisitReport } from '../visit-reports/visit-reports.service.js';
import type {
  RequestAppointmentInput,
  AgentCreateAppointmentInput,
  ConfirmAppointmentInput,
  RescheduleRequestInput,
  RescheduleCompleteInput,
  RecordOcularFeeInput,
  AvailableSlotsQuery,
} from './appointments.validation.js';
import type { Types } from 'mongoose';

const TZ = 'Asia/Manila';

// ── Helpers ──

async function getConfigValue<T>(key: string, defaultVal: T): Promise<T> {
  const config = await Config.findOne({ key });
  return config ? (config.value as T) : defaultVal;
}

function formatSlotTime(slotCode: string): string {
  const hour = parseInt(slotCode.split(':')[0]);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  return `${displayHour}:00 ${ampm}`;
}

async function assertNoActiveAppointment(customerId: string): Promise<void> {
  const active = await Appointment.findOne({
    customerId,
    status: { $in: [AppointmentStatus.REQUESTED, AppointmentStatus.CONFIRMED, AppointmentStatus.RESCHEDULE_REQUESTED] },
  });
  if (active) {
    throw AppError.conflict(
      'You already have an active appointment. Please complete or cancel it first.',
      ErrorCode.DUPLICATE_ENTRY,
    );
  }
}

async function assertDateAvailable(dateStr: string): Promise<void> {
  // Check it's not in the past
  const now = toZonedTime(new Date(), TZ);
  const target = parse(dateStr, 'yyyy-MM-dd', new Date());
  if (isBefore(target, startOfDay(now))) {
    throw AppError.badRequest('Cannot book appointments in the past');
  }

  // Check it's not a weekend (0 = Sun, 6 = Sat)
  const day = target.getDay();
  if (day === 0 || day === 6) {
    throw AppError.badRequest('Appointments are not available on weekends');
  }

  // Check it's not a holiday
  const holiday = await Holiday.findOne({ date: dateStr });
  if (holiday) {
    throw AppError.badRequest(`${dateStr} is a holiday: ${holiday.name}`);
  }
}

async function assertSalesAvailable(salesId: string, dateStr: string): Promise<void> {
  const availability = await SalesAvailability.findOne({ salesStaffId: salesId });
  if (availability?.unavailableDates.includes(dateStr)) {
    throw AppError.badRequest('Selected sales staff is unavailable on this date');
  }
}

// ── Slot Lock with anti-race ──

async function lockSlot(
  dateStr: string,
  slotCode: SlotCode,
  salesId: string,
  lockedBy: string,
): Promise<void> {
  try {
    await SlotLock.create({
      date: dateStr,
      slotCode,
      salesId,
      lockedBy,
      confirmed: false,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 min TTL
    });
  } catch (error: unknown) {
    if ((error as { code?: number }).code === 11000) {
      throw AppError.conflict('This slot is no longer available', ErrorCode.SLOT_LOCKED);
    }
    throw error;
  }
}

async function confirmSlotLock(
  dateStr: string,
  slotCode: SlotCode,
  salesId: string,
  appointmentId: Types.ObjectId,
): Promise<void> {
  await SlotLock.updateOne(
    { date: dateStr, slotCode, salesId },
    { confirmed: true, appointmentId },
  );
}

async function releaseSlotLock(
  dateStr: string,
  slotCode: SlotCode,
  salesId: string,
): Promise<void> {
  await SlotLock.deleteOne({ date: dateStr, slotCode, salesId });
}

// ── Get Available Slots ──

export async function getAvailableSlots(query: AvailableSlotsQuery) {
  const { date, type } = query;
  await assertDateAvailable(date);

  // Both office and ocular use capacity-based availability.
  // Sales staff assignment is handled later by the Appointment Agent at confirmation.
  const capacityKey = type === AppointmentType.OFFICE ? 'office_slot_capacity' : 'ocular_slot_capacity';
  const capacity = await getConfigValue<number>(capacityKey, 3);

  const slots = await Promise.all(
    SLOT_CODES.map(async (slotCode) => {
      const booked = await Appointment.countDocuments({
        date,
        slotCode,
        type,
        status: { $in: [AppointmentStatus.REQUESTED, AppointmentStatus.CONFIRMED] },
      });
      return {
        slotCode,
        time: formatSlotTime(slotCode),
        available: booked < capacity,
        remaining: Math.max(0, capacity - booked),
      };
    }),
  );

  return { date, type, slots };
}

// ── Customer: Request Appointment ──

export async function requestAppointment(
  input: RequestAppointmentInput,
  customerId: string,
  ip?: string,
  ua?: string,
) {
  await assertNoActiveAppointment(customerId);
  await assertDateAvailable(input.date);

  // Customer just requests — no sales staff assignment yet.
  // The Appointment Agent will assign sales staff when confirming.
  const appointment = await Appointment.create({
    customerId,
    type: input.type,
    date: input.date,
    slotCode: input.slotCode,
    status: AppointmentStatus.REQUESTED,
    customerAddress: input.address,
    customerLocation: input.customerLocation,
    customerNotes: input.purpose,
    bookedBy: customerId,
  });

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_CREATED,
    actorId: customerId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { type: input.type, date: input.date, slotCode: input.slotCode },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify appointment agents about the new request
  await notifyRole(
    Role.APPOINTMENT_AGENT,
    NotificationCategory.APPOINTMENT,
    'New Appointment Request',
    `A new ${input.type} appointment has been requested for ${input.date} at ${formatSlotTime(input.slotCode)}`,
    `/appointments/${appointment._id}`,
  );

  return appointment;
}

// ── Agent: Create Appointment on behalf of customer ──

export async function agentCreateAppointment(
  input: AgentCreateAppointmentInput,
  agentId: string,
  ip?: string,
  ua?: string,
) {
  // Verify customer exists
  const customer = await User.findById(input.customerId);
  if (!customer || !customer.roles.includes(Role.CUSTOMER)) {
    throw AppError.notFound('Customer not found');
  }

  await assertNoActiveAppointment(input.customerId);
  await assertDateAvailable(input.date);

  // Agent creates on behalf of customer — no sales staff assignment yet.
  // Sales staff will be assigned when the agent confirms the appointment.
  const appointment = await Appointment.create({
    customerId: input.customerId,
    type: input.type,
    date: input.date,
    slotCode: input.slotCode,
    status: AppointmentStatus.REQUESTED,
    customerAddress: input.address,
    customerLocation: input.customerLocation,
    customerNotes: input.purpose,
    bookedBy: agentId,
  });

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_CREATED,
    actorId: agentId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { type: input.type, date: input.date, slotCode: input.slotCode, customerId: input.customerId, createdByAgent: true },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify the customer
  await createAndSendNotification(
    input.customerId,
    NotificationCategory.APPOINTMENT,
    'Appointment Created',
    `An appointment has been booked for you on ${input.date} at ${formatSlotTime(input.slotCode)}.`,
    `/appointments/${appointment._id}`,
  );

  return appointment;
}

// ── Agent: Confirm Appointment ──

export async function confirmAppointment(
  appointmentId: string,
  input: ConfirmAppointmentInput,
  agentId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.CONFIRMED);

  // Assign or re-assign sales staff
  const salesStaff = await User.findOne({
    _id: input.salesStaffId,
    roles: Role.SALES_STAFF,
    isActive: true,
  });
  if (!salesStaff) throw AppError.notFound('Sales staff not found');
  await assertSalesAvailable(input.salesStaffId, appointment.date);

  // If ocular and sales changed, update slot lock
  if (appointment.type === AppointmentType.OCULAR) {
    if (appointment.salesStaffId && appointment.salesStaffId.toString() !== input.salesStaffId) {
      await releaseSlotLock(appointment.date, appointment.slotCode as SlotCode, appointment.salesStaffId.toString());
    }
    await lockSlot(appointment.date, appointment.slotCode as SlotCode, input.salesStaffId, agentId);
    await confirmSlotLock(appointment.date, appointment.slotCode as SlotCode, input.salesStaffId, appointment._id);
  }

  appointment.status = AppointmentStatus.CONFIRMED;
  appointment.salesStaffId = salesStaff._id;
  appointment.confirmedBy = agentId as unknown as Types.ObjectId;
  if (input.internalNotes) appointment.internalNotes = input.internalNotes;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_CONFIRMED,
    actorId: agentId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { salesStaffId: input.salesStaffId },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  const customer = await User.findById(appointment.customerId);
  if (customer) {
    await createAndSendNotification(
      appointment.customerId,
      NotificationCategory.APPOINTMENT,
      'Appointment Confirmed',
      `Your appointment on ${appointment.date} at ${formatSlotTime(appointment.slotCode)} has been confirmed.`,
      `/appointments/${appointment._id}`,
    );

    await sendAppointmentConfirmedEmail(customer.email, {
      date: appointment.date,
      time: formatSlotTime(appointment.slotCode),
      type: appointment.type === AppointmentType.OCULAR ? 'Ocular Visit' : 'Office Visit',
    });
  }

  // Notify sales staff
  await createAndSendNotification(
    input.salesStaffId,
    NotificationCategory.APPOINTMENT,
    'New Appointment Assigned',
    `You have been assigned an appointment on ${appointment.date} at ${formatSlotTime(appointment.slotCode)}.`,
    `/appointments/${appointment._id}`,
  );

  // ── Auto-create VisitReport (DRAFT) for the assigned sales staff ──
  await autoCreateVisitReport(
    appointment._id,
    appointment.customerId,
    salesStaff._id,
    appointment.type === AppointmentType.OCULAR ? 'ocular' : 'consultation',
  );

  return appointment;
}

// ── Complete Appointment ──

export async function completeAppointment(
  appointmentId: string,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.COMPLETED);

  appointment.status = AppointmentStatus.COMPLETED;
  await appointment.save();

  // Release slot lock for ocular appointments
  if (appointment.type === AppointmentType.OCULAR && appointment.salesStaffId) {
    await releaseSlotLock(appointment.date, appointment.slotCode as SlotCode, appointment.salesStaffId.toString());
  }

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_COMPLETED,
    actorId,
    targetType: 'appointment',
    targetId: appointment._id,
    ipAddress: ip,
    userAgent: ua,
  });

  return appointment;
}

// ── Mark No-Show ──

export async function markNoShow(
  appointmentId: string,
  internalNotes: string | undefined,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.NO_SHOW);

  appointment.status = AppointmentStatus.NO_SHOW;
  if (internalNotes) appointment.internalNotes = internalNotes;
  await appointment.save();

  // Release slot lock for ocular
  if (appointment.type === AppointmentType.OCULAR && appointment.salesStaffId) {
    await releaseSlotLock(appointment.date, appointment.slotCode as SlotCode, appointment.salesStaffId.toString());
  }

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_NO_SHOW,
    actorId,
    targetType: 'appointment',
    targetId: appointment._id,
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    appointment.customerId,
    NotificationCategory.APPOINTMENT,
    'Appointment Marked as No-Show',
    `Your appointment on ${appointment.date} was marked as a no-show.`,
  );

  return appointment;
}

// ── Customer: Request Reschedule ──

export async function requestReschedule(
  appointmentId: string,
  input: RescheduleRequestInput,
  customerId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  // Verify ownership
  if (appointment.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only reschedule your own appointments');
  }

  // Check reschedule limit
  if (appointment.rescheduleCount >= appointment.maxReschedules) {
    throw AppError.badRequest(
      `Maximum reschedule limit (${appointment.maxReschedules}) reached`,
      ErrorCode.BOOKING_LIMIT_REACHED,
    );
  }

  appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.RESCHEDULE_REQUESTED);

  appointment.status = AppointmentStatus.RESCHEDULE_REQUESTED;
  appointment.rescheduleReason = input.reason;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_RESCHEDULE_REQUESTED,
    actorId: customerId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { reason: input.reason, count: appointment.rescheduleCount },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify agents
  await notifyRole(
    Role.APPOINTMENT_AGENT,
    NotificationCategory.APPOINTMENT,
    'Reschedule Requested',
    `Reschedule requested for appointment on ${appointment.date}. Reason: ${input.reason}`,
    `/appointments/${appointment._id}`,
  );

  return appointment;
}

// ── Agent: Complete Reschedule ──

export async function completeReschedule(
  appointmentId: string,
  input: RescheduleCompleteInput,
  agentId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.status !== AppointmentStatus.RESCHEDULE_REQUESTED) {
    throw AppError.badRequest('Appointment is not pending reschedule');
  }

  await assertDateAvailable(input.date);

  const salesId = input.salesStaffId || appointment.salesStaffId?.toString();

  if (appointment.type === AppointmentType.OCULAR) {
    if (!salesId) throw AppError.badRequest('Sales staff required for ocular appointments');

    await assertSalesAvailable(salesId, input.date);

    // Release old slot
    if (appointment.salesStaffId) {
      await releaseSlotLock(appointment.date, appointment.slotCode as SlotCode, appointment.salesStaffId.toString());
    }

    // Lock new slot
    await lockSlot(input.date, input.slotCode as SlotCode, salesId, agentId);
    await confirmSlotLock(input.date, input.slotCode as SlotCode, salesId, appointment._id);
  }

  const oldDate = appointment.date;
  const oldSlot = appointment.slotCode;

  appointment.date = input.date;
  appointment.slotCode = input.slotCode as SlotCode;
  appointment.status = AppointmentStatus.CONFIRMED;
  appointment.rescheduleCount += 1;
  if (salesId) appointment.salesStaffId = salesId as unknown as Types.ObjectId;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_RESCHEDULED,
    actorId: agentId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: {
      oldDate, oldSlot: oldSlot,
      newDate: input.date, newSlot: input.slotCode,
      rescheduleCount: appointment.rescheduleCount,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    appointment.customerId,
    NotificationCategory.APPOINTMENT,
    'Appointment Rescheduled',
    `Your appointment has been rescheduled to ${input.date} at ${formatSlotTime(input.slotCode)}.`,
    `/appointments/${appointment._id}`,
  );

  return appointment;
}

// ── Cancel Appointment ──

export async function cancelAppointment(
  appointmentId: string,
  reason: string | undefined,
  actorId: string,
  actorRole: Role,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  // Customers can only cancel their own
  if (actorRole === Role.CUSTOMER && appointment.customerId.toString() !== actorId) {
    throw AppError.forbidden('You can only cancel your own appointments');
  }

  appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.CANCELLED);

  appointment.status = AppointmentStatus.CANCELLED;
  if (reason) appointment.internalNotes = (appointment.internalNotes || '') + ` [Cancelled: ${reason}]`;
  await appointment.save();

  // Release slot lock for ocular
  if (appointment.type === AppointmentType.OCULAR && appointment.salesStaffId) {
    await releaseSlotLock(appointment.date, appointment.slotCode as SlotCode, appointment.salesStaffId.toString());
  }

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_CANCELLED,
    actorId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { reason, cancelledBy: actorRole },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify involved parties
  if (actorRole !== Role.CUSTOMER) {
    await createAndSendNotification(
      appointment.customerId,
      NotificationCategory.APPOINTMENT,
      'Appointment Cancelled',
      `Your appointment on ${appointment.date} has been cancelled.${reason ? ` Reason: ${reason}` : ''}`,
    );
  }

  if (appointment.salesStaffId && appointment.salesStaffId.toString() !== actorId) {
    await createAndSendNotification(
      appointment.salesStaffId,
      NotificationCategory.APPOINTMENT,
      'Appointment Cancelled',
      `Appointment on ${appointment.date} at ${formatSlotTime(appointment.slotCode)} has been cancelled.`,
    );
  }

  return appointment;
}

// ── Record Ocular Fee Payment ──

export async function recordOcularFee(
  appointmentId: string,
  input: RecordOcularFeeInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.type !== AppointmentType.OCULAR) {
    throw AppError.badRequest('Ocular fee only applies to ocular appointments');
  }

  if (appointment.ocularFeePaid) {
    throw AppError.badRequest('Ocular fee has already been recorded');
  }

  appointment.ocularFeePaymentMethod = input.paymentMethod;
  appointment.ocularFeePaid = true;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_CONFIRMED,
    actorId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { ocularFeePaymentMethod: input.paymentMethod, ocularFee: appointment.ocularFee },
    ipAddress: ip,
    userAgent: ua,
  });

  return appointment;
}

// ── Set Ocular Fee (computed by maps module) ──

export async function setOcularFee(
  appointmentId: string,
  fee: number,
  breakdown: {
    base: number;
    baseKm: number;
    extraKm: number;
    extraRate: number;
    extraFee: number;
    total: number;
    isWithinNCR: boolean;
  },
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  appointment.ocularFee = fee;
  appointment.ocularFeeBreakdown = breakdown;
  await appointment.save();

  return appointment;
}

// ── Get Appointment by ID ──

export async function getAppointmentById(appointmentId: string, actorId: string, actorRoles: Role[]) {
  const appointment = await Appointment.findById(appointmentId)
    .populate('customerId', 'firstName lastName email phone')
    .populate('salesStaffId', 'firstName lastName email phone')
    .populate('bookedBy', 'firstName lastName')
    .populate('confirmedBy', 'firstName lastName');

  if (!appointment) throw AppError.notFound('Appointment not found');

  // Customers can only view their own
  if (
    actorRoles.includes(Role.CUSTOMER) &&
    !actorRoles.some(r => [Role.ADMIN, Role.APPOINTMENT_AGENT, Role.SALES_STAFF].includes(r))
  ) {
    if (appointment.customerId._id?.toString() !== actorId) {
      throw AppError.forbidden('Access denied');
    }
  }

  return appointment;
}

// ── List Appointments ──

export async function listAppointments(query: {
  status?: string;
  type?: string;
  date?: string;
  dateFrom?: string;
  dateTo?: string;
  customerId?: string;
  salesStaffId?: string;
  page?: string;
  limit?: string;
  sortBy?: string;
  sortOrder?: string;
}, actorId: string, actorRoles: Role[]) {
  const page = parseInt(query.page || '1');
  const limit = Math.min(parseInt(query.limit || '20'), 100);
  const filter: Record<string, unknown> = {};

  // Role-based filtering
  if (
    actorRoles.includes(Role.CUSTOMER) &&
    !actorRoles.some(r => [Role.ADMIN, Role.APPOINTMENT_AGENT, Role.SALES_STAFF].includes(r))
  ) {
    filter.customerId = actorId;
  } else if (
    actorRoles.includes(Role.SALES_STAFF) &&
    !actorRoles.some(r => [Role.ADMIN, Role.APPOINTMENT_AGENT].includes(r))
  ) {
    filter.salesStaffId = actorId;
  }

  if (query.status) filter.status = query.status;
  if (query.type) filter.type = query.type;
  if (query.date) filter.date = query.date;
  if (query.customerId && !filter.customerId) filter.customerId = query.customerId;
  if (query.salesStaffId && !filter.salesStaffId) filter.salesStaffId = query.salesStaffId;

  if (query.dateFrom || query.dateTo) {
    filter.date = {};
    if (query.dateFrom) (filter.date as Record<string, string>).$gte = query.dateFrom;
    if (query.dateTo) (filter.date as Record<string, string>).$lte = query.dateTo;
  }

  const sortField = query.sortBy || 'date';
  const sortOrder = query.sortOrder === 'asc' ? 1 : -1;

  const [appointments, total] = await Promise.all([
    Appointment.find(filter)
      .populate('customerId', 'firstName lastName email phone')
      .populate('salesStaffId', 'firstName lastName')
      .sort({ [sortField]: sortOrder })
      .skip((page - 1) * limit)
      .limit(limit),
    Appointment.countDocuments(filter),
  ]);

  return {
    items: appointments,
    total,
    hasMore: page * limit < total,
  };
}

// ── Auto-assign sales staff (round-robin based on least appointments for that date) ──

async function autoAssignSalesStaff(dateStr: string, slotCode: SlotCode): Promise<string> {
  // Get all active sales staff
  const salesStaff = await User.find({ roles: Role.SALES_STAFF, isActive: true });
  if (salesStaff.length === 0) {
    throw AppError.badRequest('No sales staff available');
  }

  // Filter out unavailable sales staff
  const unavail = await SalesAvailability.find({
    salesStaffId: { $in: salesStaff.map(s => s._id) },
    unavailableDates: dateStr,
  });
  const unavailableIds = new Set(unavail.map(u => u.salesStaffId.toString()));
  const available = salesStaff.filter(s => !unavailableIds.has(s._id.toString()));

  if (available.length === 0) {
    throw AppError.badRequest('No sales staff available on this date');
  }

  // Check who has the slot free (no existing lock)
  const locks = await SlotLock.find({
    date: dateStr,
    slotCode,
    salesId: { $in: available.map(s => s._id) },
    $or: [{ confirmed: true }, { expiresAt: { $gt: new Date() } }],
  });
  const lockedIds = new Set(locks.map(l => l.salesId.toString()));
  const freeStaff = available.filter(s => !lockedIds.has(s._id.toString()));

  if (freeStaff.length === 0) {
    throw AppError.conflict('No sales staff available for this slot', ErrorCode.SLOT_UNAVAILABLE);
  }

  // Pick the one with fewest appointments on this date
  const counts = await Promise.all(
    freeStaff.map(async (staff) => {
      const count = await Appointment.countDocuments({
        salesStaffId: staff._id,
        date: dateStr,
        status: { $in: [AppointmentStatus.CONFIRMED, AppointmentStatus.REQUESTED] },
      });
      return { staffId: staff._id.toString(), count };
    }),
  );

  counts.sort((a, b) => a.count - b.count);
  return counts[0].staffId;
}
