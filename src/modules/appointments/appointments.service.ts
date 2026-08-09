import { format, parse, isAfter, isBefore, startOfDay, addMinutes, addDays } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import {
  Appointment, SlotLock, User, AuditLog, Holiday, SalesAvailability, Config, BlockedSlot,
  VisitReport, VisitReportStatus, Project,
} from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import {
  AppointmentStatus, AppointmentType, AppointmentAttendanceStatus, Role, AuditAction,
  NotificationCategory, PaymentMethod, OcularFeePaymentChoice, ProjectStatus, SLOT_CODES, StaffAvailabilityStatus, type SlotCode,
} from '../../utils/constants.js';
import { appointmentStateMachine } from '../../utils/stateMachine.js';
import { createAndSendNotification, notifyRole } from '../notifications/socket.service.js';
import { sendAppointmentConfirmedEmail } from '../notifications/email.service.js';
import { autoCreateDraft as autoCreateVisitReport } from '../visit-reports/visit-reports.service.js';
import { computeOcularFee, reverseGeocode } from '../maps/maps.service.js';
import { createCheckoutSession, retrieveCheckoutSession } from '../../services/paymongo.service.js';
import { logger } from '../../utils/logger.js';
import { formatCurrency } from '../../utils/helpers.js';
import { matchesAppointmentSearch, normalizeAppointmentSearchTerm } from './appointments.search.js';
import type { SortOrder } from 'mongoose';
import {
  evaluateSalesAssignmentEligibility,
  getOpenAvailabilitySession,
} from '../users/availability-session.service.js';
import type {
  RequestAppointmentInput,
  AgentCreateAppointmentInput,
  ConfirmAppointmentInput,
  ReassignAppointmentSalesInput,
  AppointmentQueueQuery,
  ConsultationAttendanceInput,
  RescheduleRequestInput,
  RescheduleCompleteInput,
  RecordOcularFeeInput,
  AvailableSlotsQuery,
  SubmitSiteDetailsInput,
  AgentCreateOcularInput,
  SubmitOcularLocationInput,
  AgentFinalizeOcularInput,
} from './appointments.validation.js';
import type { Types } from 'mongoose';

const TZ = 'Asia/Manila';

const APPOINTMENT_QUEUE_RECENT_DAYS = 14;
const APPOINTMENT_QUEUE_ACTIONABLE_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.REQUESTED,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.PREPARING,
  AppointmentStatus.ON_THE_WAY,
  AppointmentStatus.ARRIVED_AT_SITE,
  AppointmentStatus.IN_PROGRESS,
  AppointmentStatus.RESCHEDULE_REQUESTED,
  AppointmentStatus.READY_FOR_OCULAR,
];
const APPOINTMENT_QUEUE_RECENT_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.COMPLETED,
  AppointmentStatus.NO_SHOW,
  AppointmentStatus.CANCELLED,
];
const APPOINTMENT_REASSIGNABLE_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.REQUESTED,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.PREPARING,
  AppointmentStatus.ON_THE_WAY,
  AppointmentStatus.ARRIVED_AT_SITE,
  AppointmentStatus.IN_PROGRESS,
  AppointmentStatus.RESCHEDULE_REQUESTED,
];

const DERIVED_READY_FOR_OCULAR_FILTER = {
  type: AppointmentType.OFFICE,
  status: AppointmentStatus.COMPLETED,
  consultationReportSubmitted: true,
} as const;

function isReadyForOcularQueueItem(appointment: {
  type?: AppointmentType | string;
  status?: AppointmentStatus | string;
  consultationReportSubmitted?: boolean;
}) {
  return appointment.status === AppointmentStatus.READY_FOR_OCULAR
    || (
      appointment.type === AppointmentType.OFFICE
      && appointment.status === AppointmentStatus.COMPLETED
      && appointment.consultationReportSubmitted
    );
}

function appendAndFilter(
  filter: Record<string, unknown>,
  condition: Record<string, unknown>,
) {
  const existingAnd = Array.isArray(filter.$and)
    ? [...(filter.$and as Record<string, unknown>[])]
    : [];

  if (filter.$or) {
    existingAnd.push({ $or: filter.$or as Record<string, unknown>[] });
    delete filter.$or;
  }

  existingAnd.push(condition);
  filter.$and = existingAnd;
}

export interface AppointmentQueueSampleProject {
  projectId: string;
  title: string;
  serviceType?: string;
  status: string;
  path: string;
}

export interface AppointmentQueueActions {
  reviewReportPath?: string;
  projectPath?: string;
  createProjectPath?: string;
  scheduleOcularPath?: string;
  reassignPath?: string;
}

export interface AppointmentQueueItem {
  appointment: any;
  segment: 'upcoming' | 'recent';
  reportStatus?: string;
  actions: AppointmentQueueActions;
  sampleProjects: AppointmentQueueSampleProject[];
}

export interface AppointmentQueueResult {
  items: AppointmentQueueItem[];
  upcomingCount: number;
  recentCount: number;
  recentWindowDays: number;
  generatedAt: string;
}

function fullName(value: { firstName?: string; lastName?: string } | null | undefined): string | undefined {
  const first = value?.firstName?.trim() || '';
  const last = value?.lastName?.trim() || '';
  const joined = [first, last].filter(Boolean).join(' ');
  return joined || undefined;
}

function getSearchScope(actorRoles: Role[]): 'customer' | 'staff' {
  const isCustomerOnly = actorRoles.includes(Role.CUSTOMER)
    && !actorRoles.some((role) => [Role.ADMIN, Role.APPOINTMENT_AGENT, Role.SALES_STAFF].includes(role));
  return isCustomerOnly ? 'customer' : 'staff';
}

// ── Helpers ──

async function getConfigValue<T>(key: string, defaultVal: T): Promise<T> {
  const config = await Config.findOne({ key });
  return config ? (config.value as T) : defaultVal;
}

async function getLatestEligibleConsultationForOcular(customerId: string) {
  const consultation = await Appointment.findOne({
    customerId,
    type: AppointmentType.OFFICE,
    salesStaffId: { $exists: true },
    status: AppointmentStatus.COMPLETED,
  }).sort({ createdAt: -1 });

  if (!consultation) return null;

  const consultationReport = await VisitReport.findOne({
    appointmentId: consultation._id,
    visitType: 'consultation',
    status: { $in: [VisitReportStatus.SUBMITTED, VisitReportStatus.COMPLETED] },
  }).sort({ createdAt: -1 });

  if (!consultationReport) return null;

  return { consultation, consultationReport };
}

async function clearReadyForOcularStatus(
  customerId: string,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const readyConsultation = await Appointment.findOne({
    customerId,
    type: AppointmentType.OFFICE,
    status: AppointmentStatus.READY_FOR_OCULAR,
  }).sort({ updatedAt: -1, createdAt: -1 });

  if (!readyConsultation) return;

  appointmentStateMachine.assertTransition(
    readyConsultation.status,
    AppointmentStatus.COMPLETED,
  );
  readyConsultation.status = AppointmentStatus.COMPLETED;
  await readyConsultation.save();

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_UPDATED,
    actorId,
    targetType: 'appointment',
    targetId: readyConsultation._id,
    details: {
      statusFrom: AppointmentStatus.READY_FOR_OCULAR,
      statusTo: AppointmentStatus.COMPLETED,
      reason: 'ocular_created',
    },
    ipAddress: ip,
    userAgent: ua,
  });
}

function formatSlotTime(slotCode: string): string {
  const hour = parseInt(slotCode.split(':')[0]);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  return `${displayHour}:00 ${ampm}`;
}

function getConsultationWindow(date: string, slotCode: string) {
  const start = new Date(`${date}T${slotCode}:00+08:00`);
  return {
    start,
    graceEnd: addMinutes(start, 15),
    end: addMinutes(start, 60),
  };
}

function classifyArrival(appointment: { date: string; slotCode: string }, actualArrivalAt: Date) {
  const window = getConsultationWindow(appointment.date, appointment.slotCode);
  return {
    attendanceStatus: actualArrivalAt <= window.graceEnd
      ? AppointmentAttendanceStatus.ON_TIME
      : AppointmentAttendanceStatus.LATE_ARRIVAL,
    outsideWindow: actualArrivalAt > window.end,
  };
}

function assertAttendanceTransition(
  currentStatus: AppointmentAttendanceStatus,
  nextStatus: AppointmentAttendanceStatus,
  isAdminOverride = false,
) {
  if (isAdminOverride) return;

  const allowed: Record<AppointmentAttendanceStatus, AppointmentAttendanceStatus[]> = {
    [AppointmentAttendanceStatus.SCHEDULED]: [
      AppointmentAttendanceStatus.ON_TIME,
      AppointmentAttendanceStatus.LATE_ARRIVAL,
      AppointmentAttendanceStatus.NO_SHOW,
      AppointmentAttendanceStatus.RESCHEDULED,
    ],
    [AppointmentAttendanceStatus.ON_TIME]: [
      AppointmentAttendanceStatus.IN_PROGRESS,
      AppointmentAttendanceStatus.RESCHEDULED,
      AppointmentAttendanceStatus.CUSTOMER_DECLINED,
    ],
    [AppointmentAttendanceStatus.LATE_ARRIVAL]: [
      AppointmentAttendanceStatus.IN_PROGRESS,
      AppointmentAttendanceStatus.RESCHEDULED,
      AppointmentAttendanceStatus.CUSTOMER_DECLINED,
    ],
    [AppointmentAttendanceStatus.IN_PROGRESS]: [
      AppointmentAttendanceStatus.COMPLETED,
      AppointmentAttendanceStatus.CUSTOMER_DECLINED,
    ],
    [AppointmentAttendanceStatus.COMPLETED]: [],
    [AppointmentAttendanceStatus.NO_SHOW]: [
      AppointmentAttendanceStatus.RESCHEDULED,
    ],
    [AppointmentAttendanceStatus.RESCHEDULED]: [],
    [AppointmentAttendanceStatus.CUSTOMER_DECLINED]: [],
  };

  if (!allowed[currentStatus]?.includes(nextStatus)) {
    throw AppError.badRequest(
      `Invalid attendance transition: ${currentStatus} → ${nextStatus}`,
      ErrorCode.INVALID_TRANSITION,
      { currentStatus, attemptedStatus: nextStatus, allowedNextStatuses: allowed[currentStatus] || [] },
    );
  }
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
      {
        activeAppointmentId: active._id.toString(),
        activeAppointmentStatus: active.status,
        activeAppointmentType: active.type,
        activeAppointmentDate: active.date,
        activeAppointmentSlotCode: active.slotCode,
      },
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

  // Enforce 3-day minimum advance booking
  const minBookingDate = startOfDay(addDays(now, 3));
  if (isBefore(target, minBookingDate)) {
    throw AppError.badRequest('Appointments must be booked at least 3 days in advance');
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

async function assertSlotAvailable(dateStr: string, slotCode: string, type: string): Promise<void> {
  const blocked = await BlockedSlot.exists({ date: dateStr, slotCode, type });
  if (blocked) {
    throw AppError.conflict('This slot has been blocked by an administrator', ErrorCode.SLOT_LOCKED);
  }

  const booked = await Appointment.countDocuments({
    date: dateStr,
    slotCode,
    type,
    status: { $in: [AppointmentStatus.REQUESTED, AppointmentStatus.CONFIRMED] },
  });
  if (booked > 0) {
    throw AppError.conflict('This slot is no longer available', ErrorCode.SLOT_LOCKED);
  }
}

async function assertSalesAvailable(
  salesId: string,
  dateStr: string,
  slotCode: SlotCode | string,
  appointmentId?: string,
): Promise<void> {
  const salesUser = await User.findOne({
    _id: salesId,
    roles: Role.SALES_STAFF,
    isActive: true,
  }).select('availabilityStatus');

  if (!salesUser) {
    throw AppError.notFound('Sales staff not found');
  }

  const eligibility = await evaluateSalesAssignmentEligibility({
    salesStaffId: salesId,
    userAvailabilityStatus: salesUser.availabilityStatus,
    session: await getOpenAvailabilitySession(salesId),
    dateStr,
    slotCode,
    appointmentId,
  });

  if (!eligibility.assignmentEligible) {
    throw AppError.badRequest(
      eligibility.assignmentBlockedReason
        ? `Selected sales staff cannot be assigned: ${eligibility.assignmentBlockedReason}`
        : 'Selected sales staff is currently unavailable',
    );
  }
}

async function syncDraftOwnershipForReassignment(
  appointmentId: Types.ObjectId,
  salesStaffId: Types.ObjectId,
) {
  const [visitReportResult, projectResult] = await Promise.all([
    VisitReport.updateMany(
      {
        appointmentId,
        status: VisitReportStatus.DRAFT,
      },
      { $set: { salesStaffId } },
    ),
    Project.updateMany(
      {
        appointmentId,
        status: { $nin: [ProjectStatus.CANCELLED, ProjectStatus.COMPLETED] },
      },
      { $set: { salesStaffId } },
    ),
  ]);

  return {
    draftVisitReportsUpdated: visitReportResult.modifiedCount,
    projectsUpdated: projectResult.modifiedCount,
  };
}

interface OcularVisitComputation {
  latitude: number;
  longitude: number;
  formattedAddress: string;
  customerLocation: { lat: number; lng: number };
  distanceKm: number;
  ocularFee: number;
  ocularFeeBreakdown: {
    label: string;
    baseFee: number;
    baseCoveredKm: number;
    perKmRate: number;
    additionalDistanceKm: number;
    additionalFee: number;
    total: number;
    isWithinNCR: boolean;
  };
}

export async function resolveOcularVisitData(
  type: AppointmentType,
  formattedAddress: string | undefined,
  location: { lat: number; lng: number } | undefined,
): Promise<OcularVisitComputation | null> {
  if (type !== AppointmentType.OCULAR) return null;
  if (!location) {
    throw AppError.badRequest('Pinned map coordinates are required for ocular visits');
  }

  const feeResult = await computeOcularFee(location);
  let resolvedAddress = formattedAddress?.trim() ?? '';
  if (!resolvedAddress) {
    try {
      resolvedAddress = (await reverseGeocode(location)).formattedAddress;
    } catch {
      resolvedAddress = `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`;
    }
  }

  return {
    latitude: location.lat,
    longitude: location.lng,
    formattedAddress: resolvedAddress,
    customerLocation: location,
    distanceKm: feeResult.route.distanceKm,
    ocularFee: feeResult.fee.total,
    ocularFeeBreakdown: feeResult.fee,
  };
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

  // 1 booking per slot; also check admin/agent blocked slots
  const slots = await Promise.all(
    SLOT_CODES.map(async (slotCode) => {
      const booked = await Appointment.countDocuments({
        date,
        slotCode,
        type,
        status: { $in: [AppointmentStatus.REQUESTED, AppointmentStatus.CONFIRMED] },
      });
      const blocked = await BlockedSlot.exists({ date, slotCode, type });
      return {
        slotCode,
        time: formatSlotTime(slotCode),
        available: booked === 0 && !blocked,
        blocked: !!blocked,
      };
    }),
  );

  return { date, type, slots };
}

// ── Customer: Request Appointment ──

export async function requestAppointment(
  input: RequestAppointmentInput,
  customerId: string,
  userRoles: Role[],
  ip?: string,
  ua?: string,
) {
  if (!userRoles.includes(Role.CUSTOMER)) {
    throw AppError.forbidden('Only customers can request appointments from this endpoint');
  }

  // Customer self-booking is consultation-first only.
  if (input.type === AppointmentType.OCULAR) {
    throw AppError.badRequest(
      'Ocular visits cannot be booked directly by customers. Please book an office consultation first.',
      ErrorCode.VALIDATION_ERROR,
      {
        flow: 'customer_booking',
        reason: 'consultation_first_only',
        action: 'book_office_consultation_first',
      },
    );
  }

  await assertNoActiveAppointment(customerId);
  await assertDateAvailable(input.date);
  await assertSlotAvailable(input.date, input.slotCode, input.type);

  // Office-only: no ocular visit data needed
  const appointment = await Appointment.create({
    customerId,
    type: input.type,
    date: input.date,
    slotCode: input.slotCode,
    status: AppointmentStatus.REQUESTED,
    customerNotes: input.purpose,
    serviceTypes: input.serviceTypes,
    serviceTypeCustom: input.serviceTypeCustom,
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
  if (input.type !== AppointmentType.OFFICE) {
    throw AppError.badRequest(
      'Appointment agents can only create the first office consultation for a customer. Ocular scheduling is handled by sales staff after consultation.',
      ErrorCode.VALIDATION_ERROR,
      {
        flow: 'agent_create_appointment',
        reason: 'office_consultation_only',
        action: 'use_sales_staff_ocular_flow',
      },
    );
  }

  const customer = await User.findById(input.customerId);
  if (!customer || !customer.roles.includes(Role.CUSTOMER)) {
    throw AppError.notFound('Customer not found');
  }

  await assertNoActiveAppointment(input.customerId);
  await assertDateAvailable(input.date);
  await assertSlotAvailable(input.date, input.slotCode, input.type);

  const appointment = await Appointment.create({
    customerId: input.customerId,
    type: input.type,
    date: input.date,
    slotCode: input.slotCode,
    status: AppointmentStatus.REQUESTED,
    customerNotes: input.purpose,
    addressStructured: input.addressStructured,
    bookedBy: agentId,
  });

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_CREATED,
    actorId: agentId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: {
      type: input.type,
      date: input.date,
      slotCode: input.slotCode,
      customerId: input.customerId,
      createdByAgent: true,
    },
    ipAddress: ip,
    userAgent: ua,
  });

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

  // Block confirmation for non-NCR ocular appointments if the ocular fee hasn't been paid
  // Exception: if customer chose cash, the sales staff will collect it during the visit
  if (
    appointment.type === AppointmentType.OCULAR &&
    appointment.ocularFeeBreakdown &&
    !appointment.ocularFeeBreakdown.isWithinNCR &&
    !appointment.ocularFeePaid &&
    appointment.ocularFeePaymentChoice !== OcularFeePaymentChoice.CASH
  ) {
    throw AppError.badRequest(
      'Ocular fee must be paid before confirming this appointment. The location is outside Metro Manila.',
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Assign or re-assign sales staff
  const salesStaff = await User.findOne({
    _id: input.salesStaffId,
    roles: Role.SALES_STAFF,
    isActive: true,
  });
  if (!salesStaff) throw AppError.notFound('Sales staff not found');
  await assertSalesAvailable(
    input.salesStaffId,
    appointment.date,
    appointment.slotCode as SlotCode,
    appointment._id.toString(),
  );

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
    appointment.customerSiteDetails || undefined,
    appointment.serviceTypes,
    appointment.serviceTypes?.[0],
    appointment.serviceTypeCustom,
  );

  return appointment;
}

export async function reassignAppointmentSales(
  appointmentId: string,
  input: ReassignAppointmentSalesInput,
  actorId: string,
  actorRoles: Role[],
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (!APPOINTMENT_REASSIGNABLE_STATUSES.includes(appointment.status)) {
    throw AppError.badRequest('Sales reassignment is only allowed for active appointments');
  }

  const isAdminOrAgent = actorRoles.some((role) => role === Role.ADMIN || role === Role.APPOINTMENT_AGENT);
  const isAssignedSales = actorRoles.includes(Role.SALES_STAFF)
    && appointment.salesStaffId?.toString() === actorId;

  if (!isAdminOrAgent && !isAssignedSales) {
    throw AppError.forbidden('Only appointment agents, admins, or the assigned sales staff can reassign this appointment');
  }

  if (appointment.status === AppointmentStatus.REQUESTED && !appointment.salesStaffId) {
    throw AppError.badRequest('Use the confirm endpoint to assign sales staff for unconfirmed appointments');
  }

  const nextSalesStaff = await User.findOne({
    _id: input.salesStaffId,
    roles: Role.SALES_STAFF,
    isActive: true,
  });
  if (!nextSalesStaff) throw AppError.notFound('Sales staff not found');

  const previousSalesStaffId = appointment.salesStaffId?.toString();
  if (previousSalesStaffId === input.salesStaffId) {
    return appointment;
  }

  await assertSalesAvailable(
    input.salesStaffId,
    appointment.date,
    appointment.slotCode as SlotCode,
    appointment._id.toString(),
  );

  if (appointment.type === AppointmentType.OCULAR) {
    if (previousSalesStaffId) {
      await releaseSlotLock(appointment.date, appointment.slotCode as SlotCode, previousSalesStaffId);
    }
    await lockSlot(appointment.date, appointment.slotCode as SlotCode, input.salesStaffId, actorId);
    await confirmSlotLock(appointment.date, appointment.slotCode as SlotCode, input.salesStaffId, appointment._id);
  }

  appointment.salesStaffId = nextSalesStaff._id;
  await appointment.save();

  const ownershipSync = await syncDraftOwnershipForReassignment(appointment._id, nextSalesStaff._id);

  await AuditLog.create({
    action: AuditAction.SALES_ASSIGNED,
    actorId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: {
      reassigned: true,
      previousSalesStaffId: previousSalesStaffId || null,
      salesStaffId: input.salesStaffId,
      reason: input.reason || null,
      ...ownershipSync,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  await createAndSendNotification(
    input.salesStaffId,
    NotificationCategory.APPOINTMENT,
    'Appointment Reassigned',
    `You were assigned to an appointment on ${appointment.date} at ${formatSlotTime(appointment.slotCode)}.`,
    `/appointments/${appointment._id}`,
  );

  if (previousSalesStaffId) {
    await createAndSendNotification(
      previousSalesStaffId,
      NotificationCategory.APPOINTMENT,
      'Appointment Reassignment',
      `An appointment on ${appointment.date} at ${formatSlotTime(appointment.slotCode)} was reassigned to another sales staff member.`,
      `/appointments/${appointment._id}`,
    );
  }

  await createAndSendNotification(
    appointment.customerId,
    NotificationCategory.APPOINTMENT,
    'Appointment Team Update',
    `Your appointment on ${appointment.date} at ${formatSlotTime(appointment.slotCode)} has an updated assigned sales staff.`,
    `/appointments/${appointment._id}`,
  );

  return appointment;
}

// ── Customer: Submit Site Details ──

export async function submitSiteDetails(
  appointmentId: string,
  input: SubmitSiteDetailsInput,
  customerId: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  // Must belong to this customer
  if (appointment.customerId.toString() !== customerId) {
    throw AppError.forbidden('You do not own this appointment');
  }

  // Must be in REQUESTED status (not yet confirmed)
  if (appointment.status !== AppointmentStatus.REQUESTED) {
    throw AppError.badRequest('Site details can only be submitted for pending appointments');
  }

  // Must not already be submitted
  if (appointment.siteDetailsStatus === 'submitted') {
    throw AppError.badRequest('Site details have already been submitted for this appointment');
  }

  // Office appointments: photos & reference images are recommended but not mandatory
  // Customers can update them later from the site details page

  appointment.customerSiteDetails = input;
  appointment.siteDetailsStatus = 'submitted';
  await appointment.save();

  // Notify appointment agents that site details have been submitted
  await notifyRole(
    Role.APPOINTMENT_AGENT,
    NotificationCategory.APPOINTMENT,
    'Site Details Submitted',
    `Customer has submitted site details for ${appointment.type} appointment on ${appointment.date} at ${formatSlotTime(appointment.slotCode)}.`,
    `/appointments/${appointment._id}`,
  );

  return appointment;
}

// ── Customer: Skip Site Details (ocular only) ──

export async function skipSiteDetails(
  appointmentId: string,
  customerId: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.customerId.toString() !== customerId) {
    throw AppError.forbidden('You do not own this appointment');
  }

  if (appointment.type !== AppointmentType.OCULAR) {
    throw AppError.badRequest('Only ocular appointments can skip site details');
  }

  if (appointment.status !== AppointmentStatus.REQUESTED) {
    throw AppError.badRequest('Site details can only be skipped for pending appointments');
  }

  appointment.siteDetailsStatus = 'skipped';
  await appointment.save();

  return appointment;
}

// ── Agent: Create Ocular Appointment (from consultation context) ──

export async function agentCreateOcular(
  input: AgentCreateOcularInput,
  actorId: string,
  actorRoles: Role[],
  ip?: string,
  ua?: string,
) {
  if (!actorRoles.includes(Role.SALES_STAFF)) {
    throw AppError.forbidden(
      'Only sales staff can schedule ocular visits after consultation. Appointment agents should assign consultation first.',
      ErrorCode.FORBIDDEN,
      {
        flow: 'staff_direct_ocular',
        reason: 'only_sales_staff_can_schedule_ocular_after_consultation',
        action: 'assign_sales_staff_for_consultation_first',
      },
    );
  }

  const customer = await User.findById(input.customerId);
  if (!customer || !customer.roles.includes(Role.CUSTOMER)) {
    throw AppError.notFound('Customer not found');
  }

  await assertNoActiveAppointment(input.customerId);
  await assertDateAvailable(input.date);
  await assertSlotAvailable(input.date, input.slotCode, AppointmentType.OCULAR);

  const consultationContext = await getLatestEligibleConsultationForOcular(input.customerId);
  if (!consultationContext?.consultation.salesStaffId) {
    throw AppError.badRequest(
      'A completed consultation with submitted consultation details is required before scheduling an ocular visit',
      ErrorCode.VALIDATION_ERROR,
      {
        flow: 'staff_direct_ocular',
        reason: 'completed_consultation_with_report_required',
        action: 'complete_consultation_then_submit_consultation_report',
      },
    );
  }

  if (consultationContext.consultation.salesStaffId.toString() !== actorId) {
    throw AppError.forbidden(
      'Only the sales staff assigned in the completed consultation can schedule this ocular visit',
      ErrorCode.FORBIDDEN,
      {
        flow: 'staff_direct_ocular',
        reason: 'staff_assignment_mismatch',
        action: 'use_assigned_consultation_staff_account',
      },
    );
  }

  const preassignedSalesStaffId: string | undefined = actorId;

  // Create ocular WITHOUT location/fee — customer provides these later
  const appointment = await Appointment.create({
    customerId: input.customerId,
    type: AppointmentType.OCULAR,
    date: input.date,
    slotCode: input.slotCode,
    status: AppointmentStatus.REQUESTED,
    salesStaffId: preassignedSalesStaffId,
    customerNotes: input.visitReportId
      ? `Ocular follow-up from consultation report ${input.visitReportId}`
      : 'Ocular visit scheduled directly by sales staff',
    bookedBy: actorId,
  });

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_CREATED,
    actorId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: {
      type: AppointmentType.OCULAR,
      date: input.date,
      slotCode: input.slotCode,
      customerId: input.customerId,
      visitReportId: input.visitReportId,
      createdByAgent: false,
      createdBySalesStaffDirect: true,
      isOcularFollowUp: true,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  // Once an ocular follow-up is created, clear any ready-for-ocular marker
  // on the latest completed office consultation for this customer.
  await clearReadyForOcularStatus(input.customerId, actorId, ip, ua);

  // Notify customer to provide their location
  await createAndSendNotification(
    input.customerId,
    NotificationCategory.APPOINTMENT,
    'Ocular Visit Scheduled',
    `An ocular visit has been scheduled for ${input.date} at ${formatSlotTime(input.slotCode)}. Please provide your site address.`,
    `/appointments/${appointment._id}`,
  );

  if (preassignedSalesStaffId) {
    await createAndSendNotification(
      preassignedSalesStaffId,
      NotificationCategory.APPOINTMENT,
      'Direct Ocular Booking Created',
      `You scheduled an ocular visit for ${input.date} at ${formatSlotTime(input.slotCode)}. Waiting for customer location submission.`,
      `/appointments/${appointment._id}`,
    );
  }

  return appointment;
}

// ── Customer: Submit Ocular Location ──

export async function customerSubmitOcularLocation(
  appointmentId: string,
  input: SubmitOcularLocationInput,
  customerId: string,
  ip?: string,
  ua?: string,
) {
  let appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.customerId.toString() !== customerId) {
    throw AppError.forbidden('You do not own this appointment');
  }

  if (appointment.type === AppointmentType.OFFICE) {
    const isReadyForOcular =
      appointment.status === AppointmentStatus.READY_FOR_OCULAR
      || (appointment.status === AppointmentStatus.COMPLETED && appointment.consultationReportSubmitted);

    if (!isReadyForOcular) {
      throw AppError.badRequest('This consultation is not ready for ocular location submission');
    }

    const activeOcularStatuses = [
      AppointmentStatus.REQUESTED,
      AppointmentStatus.CONFIRMED,
      AppointmentStatus.PREPARING,
      AppointmentStatus.ON_THE_WAY,
      AppointmentStatus.ARRIVED_AT_SITE,
      AppointmentStatus.IN_PROGRESS,
      AppointmentStatus.RESCHEDULE_REQUESTED,
    ];

    const consultationReport = await VisitReport.findOne({
      appointmentId: appointment._id,
      visitType: 'consultation',
      consultationOutcome: 'schedule_ocular',
      recommendedOcularDate: { $exists: true, $ne: null },
      recommendedOcularSlot: { $exists: true, $ne: null },
      status: { $in: [VisitReportStatus.SUBMITTED, VisitReportStatus.COMPLETED] },
    }).sort({ updatedAt: -1, createdAt: -1 });

    if (!consultationReport?.recommendedOcularDate || !consultationReport.recommendedOcularSlot) {
      throw AppError.badRequest(
        'The ocular visit schedule is not ready yet. Please wait for sales to schedule the ocular visit date and time.',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const recommendedOcularDate = consultationReport.recommendedOcularDate.toISOString().split('T')[0];

    let ocularAppointment = await Appointment.findOne({
      customerId: appointment.customerId,
      type: AppointmentType.OCULAR,
      sourceConsultationAppointmentId: appointment._id,
      date: recommendedOcularDate,
      slotCode: consultationReport.recommendedOcularSlot,
      status: { $in: activeOcularStatuses },
    }).sort({ updatedAt: -1, createdAt: -1 });

    if (!ocularAppointment) {
      ocularAppointment = await Appointment.findOne({
        customerId: appointment.customerId,
        type: AppointmentType.OCULAR,
        sourceConsultationAppointmentId: appointment._id,
        status: { $in: activeOcularStatuses },
      }).sort({ updatedAt: -1, createdAt: -1 });

      if (ocularAppointment) {
        ocularAppointment.date = recommendedOcularDate;
        ocularAppointment.slotCode = consultationReport.recommendedOcularSlot as any;
      }
    }

    if (!ocularAppointment) {
      const serviceTypes = [
        ...new Set([
          ...(appointment.serviceTypes || []),
          ...(consultationReport.serviceType ? [consultationReport.serviceType] : []),
        ]),
      ].filter(Boolean);
      const salesStaffId = consultationReport.salesStaffId || appointment.salesStaffId;

      ocularAppointment = await Appointment.create({
        customerId: appointment.customerId,
        type: AppointmentType.OCULAR,
        date: recommendedOcularDate,
        slotCode: consultationReport.recommendedOcularSlot,
        status: AppointmentStatus.REQUESTED,
        salesStaffId,
        bookedBy: salesStaffId,
        sourceConsultationAppointmentId: appointment._id,
        sourceConsultationReportId: consultationReport._id,
        serviceTypes,
        serviceTypeCustom: consultationReport.serviceTypeCustom || appointment.serviceTypeCustom,
        customerSiteDetails: {
          serviceTypes,
          serviceTypeCustom: consultationReport.serviceTypeCustom || appointment.serviceTypeCustom,
        },
        customerNotes: `Ocular follow-up scheduled from consultation report ${consultationReport._id}`,
      });

      await AuditLog.create({
        action: AuditAction.APPOINTMENT_CREATED,
        actorId: customerId,
        targetType: 'appointment',
        targetId: ocularAppointment._id,
        details: {
          triggeredBy: 'customer_location_submission',
          reason: 'ready_for_ocular_consultation_repair',
          sourceAppointmentId: appointment._id,
          sourceVisitReportId: consultationReport._id,
        },
        ipAddress: ip,
        userAgent: ua,
      });
    }

    if (ocularAppointment) {
      const serviceTypes = [
        ...new Set([
          ...(appointment.serviceTypes || []),
          ...(consultationReport.serviceType ? [consultationReport.serviceType] : []),
        ]),
      ].filter(Boolean);
      ocularAppointment.sourceConsultationAppointmentId = appointment._id;
      ocularAppointment.sourceConsultationReportId = consultationReport._id;
      if (serviceTypes.length > 0) {
        ocularAppointment.serviceTypes = serviceTypes;
        ocularAppointment.customerSiteDetails = {
          ...(ocularAppointment.customerSiteDetails || {}),
          serviceTypes,
          serviceTypeCustom: consultationReport.serviceTypeCustom || appointment.serviceTypeCustom,
        };
      }
      await ocularAppointment.save();
    }

    appointment = ocularAppointment;
  }

  if (appointment.type !== AppointmentType.OCULAR) {
    throw AppError.badRequest('This is not an ocular appointment');
  }

  const latestRecommendedSchedule = await getRecommendedOcularScheduleForAppointment(appointment);
  if (latestRecommendedSchedule?.recommendedOcularDate && latestRecommendedSchedule.recommendedOcularSlot) {
    const recommendedOcularDate = latestRecommendedSchedule.recommendedOcularDate.toISOString().split('T')[0];
    if (appointment.date !== recommendedOcularDate) {
      appointment.date = recommendedOcularDate;
    }
    if (appointment.slotCode !== latestRecommendedSchedule.recommendedOcularSlot) {
      appointment.slotCode = latestRecommendedSchedule.recommendedOcularSlot as any;
    }
  }

  const locationSubmissionStatuses = [
    AppointmentStatus.REQUESTED,
    AppointmentStatus.CONFIRMED,
    AppointmentStatus.READY_FOR_OCULAR,
    AppointmentStatus.PREPARING,
  ];
  if (!locationSubmissionStatuses.includes(appointment.status)) {
    throw AppError.badRequest('Location can only be submitted before the ocular visit starts');
  }

  // Validate Philippines bounds
  const { lat, lng } = input.customerLocation;
  if (lat < 4.5 || lat > 21.5 || lng < 116.0 || lng > 127.0) {
    throw AppError.badRequest('Location must be within the Philippines');
  }

  // Compute fee and resolve address
  const ocularVisitData = await resolveOcularVisitData(
    AppointmentType.OCULAR,
    input.formattedAddress,
    input.customerLocation,
  );

  if (!ocularVisitData) {
    throw AppError.badRequest('Could not compute ocular visit data');
  }

  appointment.latitude = ocularVisitData.latitude;
  appointment.longitude = ocularVisitData.longitude;
  appointment.formattedAddress = ocularVisitData.formattedAddress;
  appointment.customerAddress = ocularVisitData.formattedAddress;
  appointment.customerLocation = ocularVisitData.customerLocation;
  appointment.distanceKm = ocularVisitData.distanceKm;
  appointment.ocularFee = ocularVisitData.ocularFee;
  appointment.ocularFeeBreakdown = ocularVisitData.ocularFeeBreakdown;
  if (input.addressStructured) appointment.addressStructured = input.addressStructured;

  // Determine fee status
  const isWithinNCR = ocularVisitData.ocularFeeBreakdown.isWithinNCR;
  if (!isWithinNCR && ocularVisitData.ocularFee > 0) {
    appointment.ocularFeeStatus = 'pending';
  }

  await appointment.save();

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_LOCATION_SUBMITTED,
    actorId: customerId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: {
      lat: input.customerLocation.lat,
      lng: input.customerLocation.lng,
      distanceKm: ocularVisitData.distanceKm,
      ocularFee: ocularVisitData.ocularFee,
      isWithinNCR,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  if (appointment.salesStaffId) {
    await createAndSendNotification(
      appointment.salesStaffId.toString(),
      NotificationCategory.APPOINTMENT,
      'Customer Location Submitted',
      `Customer submitted their location for ocular visit on ${appointment.date} at ${formatSlotTime(appointment.slotCode)}.`,
      `/appointments/${appointment._id}`,
    );
  }

  return appointment;
}

// ── Agent: Finalize Ocular Appointment ──

export async function agentFinalizeOcular(
  appointmentId: string,
  input: AgentFinalizeOcularInput,
  actorId: string,
  actorRoles: Role[],
  ip?: string,
  ua?: string,
) {
  if (!actorRoles.includes(Role.SALES_STAFF)) {
    throw AppError.forbidden(
      'Only sales staff can finalize ocular visits',
      ErrorCode.FORBIDDEN,
    );
  }

  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.type !== AppointmentType.OCULAR) {
    throw AppError.badRequest('This is not an ocular appointment');
  }

  appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.CONFIRMED);

  // Ensure customer has provided location
  if (!appointment.customerLocation && !appointment.latitude) {
    throw AppError.badRequest('Customer has not yet submitted their location');
  }

  // Ensure ocular fee is resolved (paid, within NCR, or cash will be collected on-site)
  const isWithinNCR = appointment.ocularFeeBreakdown?.isWithinNCR;
  const isCashOnSite = appointment.ocularFeeStatus === 'cash_pending';
  if (!isWithinNCR && !appointment.ocularFeePaid && !isCashOnSite) {
    throw AppError.badRequest(
      'Ocular fee must be paid before finalizing. The location is outside Metro Manila.',
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!appointment.salesStaffId) {
    throw AppError.badRequest(
      'This ocular visit has no assigned sales staff. Please re-schedule it through the assigned sales staff workflow.',
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (appointment.salesStaffId.toString() !== actorId) {
    throw AppError.forbidden(
      'Only the assigned sales staff can finalize this ocular visit',
      ErrorCode.FORBIDDEN,
    );
  }

  const resolvedSalesStaffId = actorId;

  const salesStaff = await User.findOne({
    _id: actorId,
    roles: Role.SALES_STAFF,
    isActive: true,
  });
  if (!salesStaff) throw AppError.notFound('Sales staff not found');

  await assertSalesAvailable(
    resolvedSalesStaffId,
    appointment.date,
    appointment.slotCode as SlotCode,
    appointment._id.toString(),
  );

  // Lock slot for ocular
  await lockSlot(appointment.date, appointment.slotCode as SlotCode, resolvedSalesStaffId, actorId);
  await confirmSlotLock(appointment.date, appointment.slotCode as SlotCode, resolvedSalesStaffId, appointment._id);

  appointment.status = AppointmentStatus.CONFIRMED;
  appointment.salesStaffId = salesStaff._id;
  appointment.confirmedBy = actorId as unknown as Types.ObjectId;
  if (input.internalNotes) appointment.internalNotes = input.internalNotes;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_CONFIRMED,
    actorId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { salesStaffId: resolvedSalesStaffId, finalizedOcular: true },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  const customerUser = await User.findById(appointment.customerId);
  if (customerUser) {
    await createAndSendNotification(
      appointment.customerId,
      NotificationCategory.APPOINTMENT,
      'Ocular Visit Confirmed',
      `Your ocular visit on ${appointment.date} at ${formatSlotTime(appointment.slotCode)} has been confirmed.`,
      `/appointments/${appointment._id}`,
    );

    await sendAppointmentConfirmedEmail(customerUser.email, {
      date: appointment.date,
      time: formatSlotTime(appointment.slotCode),
      type: 'Ocular Visit',
    });
  }

  // Notify sales staff
  await createAndSendNotification(
    resolvedSalesStaffId,
    NotificationCategory.APPOINTMENT,
    'Ocular Visit Assigned',
    `You have been assigned an ocular visit on ${appointment.date} at ${formatSlotTime(appointment.slotCode)}.`,
    `/appointments/${appointment._id}`,
  );

  const sourceConsultationAppointmentId = appointment.sourceConsultationAppointmentId;

  // Find the project from the exact source consultation, not any latest customer project.
  const consultationProject = sourceConsultationAppointmentId
    ? await Project.findOne({
      appointmentId: sourceConsultationAppointmentId,
      customerId: appointment.customerId,
      status: { $in: [ProjectStatus.DRAFT, ProjectStatus.SUBMITTED] },
    }).sort({ createdAt: -1 })
    : null;

  // Pre-populate ocular report with data from the consultation visit report
  let consultationSiteDetails: import('../../models/Appointment.js').ICustomerSiteDetails | undefined;
  if (sourceConsultationAppointmentId) {
    const consultationReports = await VisitReport.find({
      appointmentId: sourceConsultationAppointmentId,
      visitType: 'consultation',
      status: { $in: [VisitReportStatus.SUBMITTED, VisitReportStatus.COMPLETED] },
    }).sort({ createdAt: 1 }).lean();
    const consultationReport = consultationReports.at(-1);
    const serviceTypes = appointment.serviceTypes?.length
      ? appointment.serviceTypes
      : [...new Set(
        consultationReports
          .map((report) => report.serviceType)
          .filter((value): value is string => Boolean(value?.trim())),
      )];
    if (consultationReport) {
      consultationSiteDetails = {
        serviceTypes: serviceTypes.length ? serviceTypes : undefined,
        serviceTypeCustom: appointment.serviceTypeCustom || consultationReport.serviceTypeCustom,
        materials: consultationReport.materials,
        finishes: consultationReport.finishes,
        preferredDesign: consultationReport.preferredDesign,
        customerRequirements: consultationReport.customerRequirements,
        notes: consultationReport.notes,
      };
    }
  }

  // Auto-create VisitReport (DRAFT) for ocular, linked to existing consultation project
  await autoCreateVisitReport(
    appointment._id,
    appointment.customerId,
    salesStaff._id,
    'ocular',
    consultationSiteDetails,
    consultationSiteDetails?.serviceTypes || appointment.serviceTypes,
    consultationSiteDetails?.serviceTypes?.[0] || appointment.serviceTypes?.[0] || consultationProject?.serviceType,
    appointment.serviceTypeCustom || consultationSiteDetails?.serviceTypeCustom,
    consultationProject?._id,
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

  // If it's a consultation and the report is already submitted, move directly to READY_FOR_OCULAR.
  // Otherwise, move to COMPLETED.
  if (appointment.type === AppointmentType.OFFICE && appointment.consultationReportSubmitted) {
    appointment.status = AppointmentStatus.COMPLETED;
    appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.READY_FOR_OCULAR);
    appointment.status = AppointmentStatus.READY_FOR_OCULAR;
  } else {
    appointment.status = AppointmentStatus.COMPLETED;
  }

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

  // Notify customer
  await createAndSendNotification(
    appointment.customerId,
    NotificationCategory.APPOINTMENT,
    'Appointment Completed',
    `Your ${appointment.type} appointment on ${appointment.date} has been marked as completed.`,
    `/appointments/${appointment._id}`,
  );

  // Notify appointment agents
  await notifyRole(
    Role.APPOINTMENT_AGENT,
    NotificationCategory.APPOINTMENT,
    'Appointment Completed',
    `${appointment.type.charAt(0).toUpperCase() + appointment.type.slice(1)} appointment on ${appointment.date} at ${formatSlotTime(appointment.slotCode)} has been completed.`,
    `/appointments/${appointment._id}`,
  );

  return appointment;
}

// ── Update Visit Status (Transition-only progress updates) ──

export async function updateVisitStatus(
  appointmentId: string,
  newStatus:
    | AppointmentStatus.PREPARING
    | AppointmentStatus.ON_THE_WAY
    | AppointmentStatus.ARRIVED_AT_SITE
    | AppointmentStatus.IN_PROGRESS,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  if (![
    AppointmentStatus.PREPARING,
    AppointmentStatus.ON_THE_WAY,
    AppointmentStatus.ARRIVED_AT_SITE,
    AppointmentStatus.IN_PROGRESS,
  ].includes(newStatus)) {
    throw AppError.badRequest('Unsupported visit status transition target', ErrorCode.VALIDATION_ERROR);
  }

  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (
    appointment.type === AppointmentType.OCULAR
    && [
      AppointmentStatus.ON_THE_WAY,
      AppointmentStatus.ARRIVED_AT_SITE,
      AppointmentStatus.IN_PROGRESS,
    ].includes(newStatus)
    && !appointment.customerLocation
    && !appointment.latitude
  ) {
    throw AppError.badRequest(
      'Customer site location is required before starting the ocular visit.',
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (
    appointment.type === AppointmentType.OCULAR
    && [
      AppointmentStatus.ON_THE_WAY,
      AppointmentStatus.ARRIVED_AT_SITE,
      AppointmentStatus.IN_PROGRESS,
    ].includes(newStatus)
    && appointment.ocularFeeBreakdown
    && !appointment.ocularFeeBreakdown.isWithinNCR
    && !appointment.ocularFeePaid
    && appointment.ocularFeeStatus !== 'cash_pending'
  ) {
    throw AppError.badRequest(
      'Ocular fee must be paid before starting the visit. The location is outside Metro Manila.',
      ErrorCode.VALIDATION_ERROR,
    );
  }

  appointmentStateMachine.assertTransition(appointment.status, newStatus);

  appointment.status = newStatus;
  await appointment.save();

  const statusMeta: Record<
    AppointmentStatus.PREPARING | AppointmentStatus.ON_THE_WAY | AppointmentStatus.ARRIVED_AT_SITE | AppointmentStatus.IN_PROGRESS,
    { action: AuditAction; title: string; statusLabel: string }
  > = {
    [AppointmentStatus.PREPARING]: {
      action: AuditAction.APPOINTMENT_PREPARING,
      title: 'Staff Preparing',
      statusLabel: 'preparing for your visit',
    },
    [AppointmentStatus.ON_THE_WAY]: {
      action: AuditAction.APPOINTMENT_ON_THE_WAY,
      title: 'Staff On The Way',
      statusLabel: 'on the way to your location',
    },
    [AppointmentStatus.ARRIVED_AT_SITE]: {
      action: AuditAction.APPOINTMENT_ARRIVED_AT_SITE,
      title: 'Staff Arrived at Site',
      statusLabel: 'arrived at your site',
    },
    [AppointmentStatus.IN_PROGRESS]: {
      action: AuditAction.APPOINTMENT_IN_PROGRESS,
      title: 'Site Visit Started',
      statusLabel: 'now conducting your site visit',
    },
  };

  const meta = statusMeta[newStatus];

  await AuditLog.create({
    action: meta.action,
    actorId,
    targetType: 'appointment',
    targetId: appointment._id,
    ipAddress: ip,
    userAgent: ua,
  });

  await createAndSendNotification(
    appointment.customerId,
    NotificationCategory.APPOINTMENT,
    meta.title,
    `Your sales staff is ${meta.statusLabel} for your ${appointment.type} appointment on ${appointment.date}.`,
    `/appointments/${appointment._id}`,
  );

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

export async function updateConsultationAttendance(
  appointmentId: string,
  input: ConsultationAttendanceInput,
  actorId: string,
  actorRoles: Role[],
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.type !== AppointmentType.OFFICE) {
    throw AppError.badRequest('Consultation attendance is only available for office consultations');
  }

  const isAdmin = actorRoles.includes(Role.ADMIN);
  const isAssignedSales = actorRoles.includes(Role.SALES_STAFF)
    && appointment.salesStaffId?.toString() === actorId;

  if (!isAdmin && !isAssignedSales) {
    throw AppError.forbidden('Only the assigned sales staff or an admin can update consultation attendance');
  }

  const currentStatus = appointment.attendanceStatus || AppointmentAttendanceStatus.SCHEDULED;
  let nextStatus = currentStatus;
  const now = new Date();
  const changes: Record<string, unknown> = {
    action: input.action,
    previousAttendanceStatus: currentStatus,
  };
  let outsideWindow = false;

  if (input.action === 'check_in') {
    const arrivalAt = input.actualArrivalAt ? new Date(input.actualArrivalAt) : now;
    if (Number.isNaN(arrivalAt.getTime())) {
      throw AppError.badRequest('Invalid arrival time', ErrorCode.VALIDATION_ERROR);
    }
    const classification = classifyArrival(appointment, arrivalAt);
    nextStatus = classification.attendanceStatus;
    outsideWindow = classification.outsideWindow;
    appointment.actualArrivalAt = arrivalAt;
    changes.actualArrivalAt = arrivalAt;
    changes.outsideWindow = outsideWindow;
  } else if (input.action === 'start') {
    nextStatus = AppointmentAttendanceStatus.IN_PROGRESS;
    appointment.consultationStartedAt = now;
    changes.consultationStartedAt = now;
  } else if (input.action === 'complete') {
    nextStatus = AppointmentAttendanceStatus.COMPLETED;
    appointment.consultationCompletedAt = now;
    changes.consultationCompletedAt = now;
  } else if (input.action === 'no_show') {
    if (!input.notes?.trim()) {
      throw AppError.badRequest('No-show attendance requires notes', ErrorCode.VALIDATION_ERROR);
    }
    nextStatus = AppointmentAttendanceStatus.NO_SHOW;
    appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.NO_SHOW);
    appointment.status = AppointmentStatus.NO_SHOW;
    appointment.internalNotes = input.notes.trim();
    changes.appointmentStatus = AppointmentStatus.NO_SHOW;
  } else if (input.action === 'reschedule') {
    if (!input.notes?.trim()) {
      throw AppError.badRequest('Rescheduled attendance requires notes', ErrorCode.VALIDATION_ERROR);
    }
    nextStatus = AppointmentAttendanceStatus.RESCHEDULED;
    appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.RESCHEDULE_REQUESTED);
    appointment.status = AppointmentStatus.RESCHEDULE_REQUESTED;
    appointment.rescheduleReason = input.notes.trim();
    changes.appointmentStatus = AppointmentStatus.RESCHEDULE_REQUESTED;
  } else if (input.action === 'customer_declined') {
    if (!input.notes?.trim()) {
      throw AppError.badRequest('Customer declined attendance requires notes', ErrorCode.VALIDATION_ERROR);
    }
    nextStatus = AppointmentAttendanceStatus.CUSTOMER_DECLINED;
    appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.CANCELLED);
    appointment.status = AppointmentStatus.CANCELLED;
    appointment.cancellationReason = input.notes.trim();
    appointment.cancelledBy = actorId as unknown as Types.ObjectId;
    appointment.internalNotes = input.notes.trim();
    appointment.consultationCompletedAt = now;
    changes.appointmentStatus = AppointmentStatus.CANCELLED;
    changes.cancellationReason = input.notes.trim();
    changes.consultationCompletedAt = now;
  }

  const isOverride = currentStatus !== AppointmentAttendanceStatus.SCHEDULED
    && currentStatus !== nextStatus
    && isAdmin
    && Boolean(input.overrideReason?.trim());
  const needsOverrideReason = currentStatus !== AppointmentAttendanceStatus.SCHEDULED
    && currentStatus !== nextStatus
    && ![
      AppointmentAttendanceStatus.ON_TIME,
      AppointmentAttendanceStatus.LATE_ARRIVAL,
      AppointmentAttendanceStatus.IN_PROGRESS,
    ].includes(currentStatus);

  if (needsOverrideReason && !input.overrideReason?.trim()) {
    throw AppError.badRequest('Attendance override reason is required', ErrorCode.VALIDATION_ERROR);
  }

  assertAttendanceTransition(currentStatus, nextStatus, isOverride);

  appointment.attendanceStatus = nextStatus;
  if (input.notes?.trim()) appointment.attendanceNotes = input.notes.trim();
  if (input.overrideReason?.trim()) appointment.attendanceOverrideReason = input.overrideReason.trim();
  appointment.attendanceUpdatedBy = actorId as unknown as Types.ObjectId;
  appointment.attendanceUpdatedAt = now;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_ATTENDANCE_UPDATED,
    actorId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: {
      ...changes,
      attendanceStatus: nextStatus,
      notes: input.notes || undefined,
      overrideReason: input.overrideReason || undefined,
    },
    ipAddress: ip,
    userAgent: ua,
  });

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
  appointment.requestedRescheduleDate = input.newDate;
  appointment.requestedRescheduleSlot = input.newSlotCode;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_RESCHEDULE_REQUESTED,
    actorId: customerId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: {
      reason: input.reason,
      requestedDate: input.newDate,
      requestedSlot: input.newSlotCode,
      count: appointment.rescheduleCount,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify agents
  await notifyRole(
    Role.APPOINTMENT_AGENT,
    NotificationCategory.APPOINTMENT,
    'Reschedule Requested',
    `Reschedule requested for ${input.newDate || appointment.date}${input.newSlotCode ? ` at ${formatSlotTime(input.newSlotCode)}` : ''}. Reason: ${input.reason}`,
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
  await assertSlotAvailable(input.date, input.slotCode, appointment.type);

  const salesId = input.salesStaffId || appointment.salesStaffId?.toString();

  if (salesId) {
    await assertSalesAvailable(salesId, input.date, input.slotCode as SlotCode, appointment._id.toString());
  }

  if (appointment.type === AppointmentType.OCULAR) {
    if (!salesId) throw AppError.badRequest('Sales staff required for ocular appointments');
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
  appointment.attendanceStatus = AppointmentAttendanceStatus.SCHEDULED;
  appointment.actualArrivalAt = undefined;
  appointment.consultationStartedAt = undefined;
  appointment.consultationCompletedAt = undefined;
  appointment.attendanceNotes = undefined;
  appointment.attendanceOverrideReason = undefined;
  appointment.requestedRescheduleDate = undefined;
  appointment.requestedRescheduleSlot = undefined;
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
  appointment.cancellationReason = reason || undefined;
  (appointment as any).cancelledBy = actorId;
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

  // Notify appointment agents when customer cancels
  if (actorRole === Role.CUSTOMER) {
    await notifyRole(
      Role.APPOINTMENT_AGENT,
      NotificationCategory.APPOINTMENT,
      'Appointment Cancelled by Customer',
      `Customer cancelled their ${appointment.type} appointment on ${appointment.date} at ${formatSlotTime(appointment.slotCode)}.`,
      `/appointments/${appointment._id}`,
    );
  }

  // Clean up draft visit reports that were auto-created when the appointment was confirmed
  const deletedDrafts = await VisitReport.deleteMany({
    appointmentId: appointment._id,
    status: VisitReportStatus.DRAFT,
  });
  if (deletedDrafts.deletedCount > 0) {
    logger.info(
      `Deleted ${deletedDrafts.deletedCount} draft visit report(s) for cancelled appointment ${appointmentId}`,
    );
  }

  return appointment;
}

// ── Record Ocular Fee Payment ──

// ── Customer: Create PayMongo Checkout for Ocular Fee ──

export async function createOcularFeeCheckout(
  appointmentId: string,
  customerId: string,
  clientOrigin: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only pay for your own appointments');
  }

  if (appointment.type !== AppointmentType.OCULAR) {
    throw AppError.badRequest('Ocular fee only applies to ocular appointments');
  }

  if (appointment.ocularFeePaid) {
    throw AppError.badRequest('Ocular fee has already been verified');
  }

  const feeAmount = appointment.ocularFee ?? appointment.ocularFeeBreakdown?.total ?? 0;
  if (feeAmount <= 0) {
    throw AppError.badRequest('No ocular fee to pay');
  }

  // ⚠️ TESTING ONLY: Override fee to ₱1 for PayMongo test payments. Remove this line for production.
  const chargeAmount = 1; // TODO: change back to `feeAmount` for real payments

  // Always create a fresh checkout session so the success/cancel URLs reflect
  // the client's actual origin (avoids stale localhost URLs in dev)

  const session = await createCheckoutSession({
    amount: chargeAmount, // ⚠️ TESTING ONLY: using chargeAmount (₱1) instead of feeAmount
    description: `Ocular Visit Fee`,
    appointmentId: appointment._id.toString(),
    customerId,
    successUrl: `${clientOrigin}/appointments/${appointment._id}/pay-ocular-fee?status=success`,
    cancelUrl: `${clientOrigin}/appointments/${appointment._id}/pay-ocular-fee?status=cancelled`,
  });

  appointment.paymongoCheckoutSessionId = session.id;
  appointment.paymongoCheckoutUrl = session.attributes.checkout_url;
  appointment.ocularFeeStatus = 'pending';
  appointment.ocularFeePaymentMethod = PaymentMethod.QRPH;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_PROOF_SUBMITTED,
    actorId: customerId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { paymongoSessionId: session.id, ocularFee: feeAmount },
    ipAddress: ip,
    userAgent: ua,
  });

  return {
    appointment,
    checkoutUrl: session.attributes.checkout_url,
    sessionId: session.id,
  };
}

// ── Customer: Request to Pay Ocular Fee via Cash ──

export async function requestOcularCashPayment(
  appointmentId: string,
  customerId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only pay for your own appointments');
  }

  if (appointment.type !== AppointmentType.OCULAR) {
    throw AppError.badRequest('Ocular fee only applies to ocular appointments');
  }

  if (appointment.ocularFeePaid) {
    throw AppError.badRequest('Ocular fee has already been verified');
  }

  const feeAmount = appointment.ocularFee ?? appointment.ocularFeeBreakdown?.total ?? 0;
  if (feeAmount <= 0) {
    throw AppError.badRequest('No ocular fee to pay');
  }

  // Update status to cash_pending
  appointment.ocularFeeStatus = 'cash_pending';
  appointment.ocularFeePaymentMethod = 'cash' as any;
  appointment.ocularFeeDeclineReason = undefined;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_PROOF_SUBMITTED,
    actorId: customerId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { ocularFee: feeAmount, method: 'cash_request' },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify appointment agent and cashier
  const message = `Customer requested to pay ${formatCurrency(feeAmount)} ocular fee via cash for appointment on ${appointment.date}.`;
  
  await notifyRole(
    Role.APPOINTMENT_AGENT,
    NotificationCategory.PAYMENT,
    'Ocular Fee Cash Request',
    message,
    `/appointments/${appointment._id}`,
  );

  await notifyRole(
    Role.CASHIER,
    NotificationCategory.PAYMENT,
    'Ocular Fee Cash Request',
    message,
    `/appointments/${appointment._id}`,
  );

  return appointment;
}

// ⚠️ TESTING ONLY: Simulate payment without PayMongo. Remove for production.
export async function simulateOcularFeePayment(appointmentId: string, customerId: string) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');
  if (appointment.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only pay for your own appointments');
  }
  if (appointment.ocularFeePaid) {
    throw AppError.badRequest('Already paid');
  }
  appointment.ocularFeePaid = true;
  appointment.ocularFeeStatus = 'verified';
  appointment.ocularFeeDeclineReason = undefined;
  await appointment.save();
  return appointment;
}
// ⚠️ END TESTING ONLY

// ── Customer: Actively verify ocular fee payment via PayMongo API ──

export async function verifyOcularFeeCheckout(appointmentId: string, customerId: string) {
  const appointment = await Appointment.findById(appointmentId)
    .populate('customerId', 'firstName lastName email');
  if (!appointment) throw AppError.notFound('Appointment not found');
  if (appointment.customerId._id?.toString() !== customerId && appointment.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only verify your own appointments');
  }

  // Already verified
  if (appointment.ocularFeePaid && appointment.ocularFeeStatus === 'verified') {
    return { verified: true, appointment };
  }

  // No checkout session to check
  if (!appointment.paymongoCheckoutSessionId) {
    return { verified: false, appointment };
  }

  // Actively query PayMongo for the checkout session status
  try {
    const session = await retrieveCheckoutSession(appointment.paymongoCheckoutSessionId);
    const payments = session.attributes.payments;

    // Check if any payment succeeded
    const hasPaid = payments && payments.length > 0 && payments.some(
      (p: { attributes?: { status?: string } }) => p.attributes?.status === 'paid',
    );

    if (hasPaid) {
      // Mark as verified — same logic as webhook handler
      appointment.ocularFeePaid = true;
      appointment.ocularFeeStatus = 'verified';
      appointment.ocularFeeDeclineReason = undefined;
      await appointment.save();

      await AuditLog.create({
        action: AuditAction.PAYMENT_VERIFIED,
        actorId: appointment.customerId._id ?? appointment.customerId,
        targetType: 'appointment',
        targetId: appointment._id,
        details: { ocularFee: appointment.ocularFee, verifiedVia: 'paymongo_polling' },
      });

      await createAndSendNotification(
        appointment.customerId._id ?? appointment.customerId,
        NotificationCategory.PAYMENT,
        'Ocular Fee Payment Confirmed',
        `Your ocular fee payment of ₱${appointment.ocularFee?.toLocaleString()} has been confirmed via PayMongo. Your assigned sales staff can now finalize your ocular visit.`,
        `/appointments/${appointment._id}`,
      );

      if (appointment.salesStaffId) {
        await createAndSendNotification(
          appointment.salesStaffId.toString(),
          NotificationCategory.PAYMENT,
          'Ocular Fee Payment Received',
          `Customer has paid the ocular fee of ₱${appointment.ocularFee?.toLocaleString()} for appointment on ${appointment.date}. You can now finalize this ocular visit.`,
          `/appointments/${appointment._id}`,
        );
      }

      return { verified: true, appointment };
    }

    return { verified: false, appointment };
  } catch (err) {
    console.error('[Verify Ocular Fee] Polling failed:', err);
    return { verified: false, appointment };
  }
}

// ── Handle PayMongo Webhook: Payment Paid ──

export async function handlePaymongoPayment(checkoutSessionId: string) {
  const appointment = await Appointment.findOne({
    paymongoCheckoutSessionId: checkoutSessionId,
  }).populate('customerId', 'firstName lastName email');

  if (!appointment) {
    // Not an appointment payment — ignore
    return null;
  }

  if (appointment.ocularFeePaid) {
    // Already verified — idempotent
    return appointment;
  }

  appointment.ocularFeePaid = true;
  appointment.ocularFeeStatus = 'verified';
  appointment.ocularFeeDeclineReason = undefined;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_VERIFIED,
    actorId: appointment.customerId._id ?? appointment.customerId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { ocularFee: appointment.ocularFee, verifiedVia: 'paymongo_webhook' },
  });

  // Notify customer
  await createAndSendNotification(
    appointment.customerId._id ?? appointment.customerId,
    NotificationCategory.PAYMENT,
    'Ocular Fee Payment Confirmed',
    `Your ocular fee payment of ₱${appointment.ocularFee?.toLocaleString()} has been confirmed via PayMongo. Your assigned sales staff can now finalize your ocular visit.`,
    `/appointments/${appointment._id}`,
  );

  if (appointment.salesStaffId) {
    await createAndSendNotification(
      appointment.salesStaffId.toString(),
      NotificationCategory.APPOINTMENT,
      'Ocular Fee Paid — Ready to Finalize',
      `Ocular fee for appointment on ${appointment.date} has been paid via PayMongo. You can now finalize this ocular visit.`,
      `/appointments/${appointment._id}`,
    );
  }

  // Notify cashiers (for their records)
  await notifyRole(
    Role.CASHIER,
    NotificationCategory.PAYMENT,
    'Ocular Fee Auto-Verified',
    `Ocular fee payment for appointment on ${appointment.date} was automatically verified via PayMongo.`,
    `/ocular-fee-queue`,
  );

  return appointment;
}

export async function submitOcularFeeProof(
  appointmentId: string,
  input: { referenceNumber: string; proofKey: string },
  customerId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only submit proof for your own appointments');
  }

  if (appointment.type !== AppointmentType.OCULAR) {
    throw AppError.badRequest('Ocular fee only applies to ocular appointments');
  }

  if (appointment.ocularFeePaid) {
    throw AppError.badRequest('Ocular fee has already been verified');
  }

  if (appointment.ocularFeeStatus === 'proof_submitted') {
    throw AppError.badRequest('Proof has already been submitted. Please wait for cashier verification.');
  }

  appointment.ocularFeePaymentMethod = PaymentMethod.QRPH;
  appointment.ocularFeeReferenceNumber = input.referenceNumber;
  appointment.ocularFeeProofKey = input.proofKey;
  appointment.ocularFeeStatus = 'proof_submitted';
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_PROOF_SUBMITTED,
    actorId: customerId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { referenceNumber: input.referenceNumber, ocularFee: appointment.ocularFee },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify cashier role
  await notifyRole(
    Role.CASHIER,
    NotificationCategory.PAYMENT,
    'New Ocular Fee Payment',
    `A customer has submitted ocular fee payment proof for appointment on ${appointment.date}.`,
    `/ocular-fee-queue`,
  );

  return appointment;
}

// ── Cashier: Verify Ocular Fee ──

export async function verifyOcularFee(
  appointmentId: string,
  cashierId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId)
    .populate('customerId', 'firstName lastName email');
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.ocularFeeStatus !== 'proof_submitted') {
    throw AppError.badRequest('No proof submitted to verify');
  }

  appointment.ocularFeePaid = true;
  appointment.ocularFeeStatus = 'verified';
  appointment.ocularFeeVerifiedBy = cashierId as unknown as Types.ObjectId;
  appointment.ocularFeeDeclineReason = undefined;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_VERIFIED,
    actorId: cashierId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { ocularFee: appointment.ocularFee },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    appointment.customerId._id ?? appointment.customerId,
    NotificationCategory.PAYMENT,
    'Ocular Fee Verified',
    `Your ocular fee payment of ₱${appointment.ocularFee?.toLocaleString()} has been verified. Your assigned sales staff can now finalize your ocular visit.`,
    `/appointments/${appointment._id}`,
  );

  if (appointment.salesStaffId) {
    await createAndSendNotification(
      appointment.salesStaffId.toString(),
      NotificationCategory.APPOINTMENT,
      'Ocular Fee Verified — Ready to Finalize',
      `Ocular fee for appointment on ${appointment.date} has been verified. You can now finalize this ocular visit.`,
      `/appointments/${appointment._id}`,
    );
  }

  return appointment;
}

// ── Cashier: Decline Ocular Fee ──

export async function declineOcularFee(
  appointmentId: string,
  reason: string,
  cashierId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.ocularFeeStatus !== 'proof_submitted') {
    throw AppError.badRequest('No proof submitted to decline');
  }

  appointment.ocularFeeStatus = 'declined';
  appointment.ocularFeeDeclineReason = reason;
  appointment.ocularFeeProofKey = undefined;
  appointment.ocularFeeReferenceNumber = undefined;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_DECLINED,
    actorId: cashierId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { reason, ocularFee: appointment.ocularFee },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    appointment.customerId,
    NotificationCategory.PAYMENT,
    'Ocular Fee Payment Declined',
    `Your ocular fee payment was declined: ${reason}. Please re-submit a valid proof.`,
    `/appointments/${appointment._id}/pay-ocular-fee`,
  );

  return appointment;
}

// ── Cashier: List Pending Ocular Fees ──

export async function listPendingOcularFees() {
  const appointments = await Appointment.find({
    type: AppointmentType.OCULAR,
    'ocularFeeBreakdown.isWithinNCR': false,
    ocularFeeStatus: { $in: ['proof_submitted', 'pending', 'declined'] },
    status: { $ne: AppointmentStatus.CANCELLED },
  })
    .populate('customerId', 'firstName lastName email phone')
    .sort({ date: 1, slotCode: 1 });

  return appointments;
}

// ── Record Ocular Fee Payment (kept for agent/staff backward compat) ──

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
  appointment.ocularFeeStatus = 'verified';
  appointment.ocularFeeVerifiedBy = actorId as unknown as Types.ObjectId;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_VERIFIED,
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
    label: string;
    baseFee: number;
    baseCoveredKm: number;
    perKmRate: number;
    additionalDistanceKm: number;
    additionalFee: number;
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

  const appointmentObject: any = appointment.toObject();
  const consultationReport = await getRecommendedOcularScheduleForAppointment(appointment);
  const canonicalOcularAppointment = await getCanonicalUnpaidOcularAppointment(appointment);

  if (consultationReport?.recommendedOcularDate && consultationReport.recommendedOcularSlot) {
    appointmentObject.recommendedOcularDate = consultationReport.recommendedOcularDate;
    appointmentObject.recommendedOcularSlot = consultationReport.recommendedOcularSlot;
  }
  if (canonicalOcularAppointment?._id) {
    appointmentObject.canonicalAppointmentId = canonicalOcularAppointment._id;
  }

  return appointmentObject;
}

async function getRecommendedOcularScheduleForAppointment(appointment: any) {
  if (appointment.type === AppointmentType.OFFICE) {
    const activeOcular = await Appointment.findOne({
      customerId: appointment.customerId?._id || appointment.customerId,
      type: AppointmentType.OCULAR,
      sourceConsultationAppointmentId: appointment._id,
      status: {
        $in: [
          AppointmentStatus.REQUESTED,
          AppointmentStatus.CONFIRMED,
          AppointmentStatus.PREPARING,
          AppointmentStatus.ON_THE_WAY,
          AppointmentStatus.ARRIVED_AT_SITE,
          AppointmentStatus.IN_PROGRESS,
          AppointmentStatus.RESCHEDULE_REQUESTED,
          AppointmentStatus.READY_FOR_OCULAR,
        ],
      },
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .select('date slotCode')
      .lean();

    if (activeOcular?.date && activeOcular.slotCode) {
      return {
        recommendedOcularDate: new Date(`${activeOcular.date}T12:00:00.000Z`),
        recommendedOcularSlot: activeOcular.slotCode,
      };
    }

    return VisitReport.findOne({
      appointmentId: appointment._id,
      visitType: 'consultation',
      status: { $in: [VisitReportStatus.SUBMITTED, VisitReportStatus.COMPLETED] },
      recommendedOcularDate: { $exists: true, $ne: null },
      recommendedOcularSlot: { $exists: true, $ne: null },
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .select('recommendedOcularDate recommendedOcularSlot')
      .lean();
  }

  if (appointment.type === AppointmentType.OCULAR) {
    if (appointment.date && appointment.slotCode) {
      return {
        recommendedOcularDate: new Date(`${appointment.date}T12:00:00.000Z`),
        recommendedOcularSlot: appointment.slotCode,
      };
    }

    const sourceConsultationAppointmentId = appointment.sourceConsultationAppointmentId;
    if (sourceConsultationAppointmentId) {
      return VisitReport.findOne({
        appointmentId: sourceConsultationAppointmentId,
        visitType: 'consultation',
        consultationOutcome: 'schedule_ocular',
        status: { $in: [VisitReportStatus.SUBMITTED, VisitReportStatus.COMPLETED] },
        recommendedOcularDate: { $exists: true, $ne: null },
        recommendedOcularSlot: { $exists: true, $ne: null },
      })
        .sort({ updatedAt: -1, createdAt: -1 })
        .select('recommendedOcularDate recommendedOcularSlot')
        .lean();
    }

    return VisitReport.findOne({
      customerId: appointment.customerId?._id || appointment.customerId,
      visitType: 'consultation',
      consultationOutcome: 'schedule_ocular',
      status: { $in: [VisitReportStatus.SUBMITTED, VisitReportStatus.COMPLETED] },
      recommendedOcularDate: { $exists: true, $ne: null },
      recommendedOcularSlot: { $exists: true, $ne: null },
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .select('recommendedOcularDate recommendedOcularSlot')
      .lean();
  }

  return null;
}

async function getCanonicalUnpaidOcularAppointment(appointment: any) {
  if (appointment.type !== AppointmentType.OCULAR) return null;
  if (appointment.ocularFeePaid || !['pending', 'cash_pending', 'proof_submitted'].includes(String(appointment.ocularFeeStatus || ''))) {
    return null;
  }

  const currentId = String(appointment._id);
  const serviceTypes = [...(appointment.serviceTypes || [])].sort();
  const baseFilter: Record<string, unknown> = {
    customerId: appointment.customerId?._id || appointment.customerId,
    type: AppointmentType.OCULAR,
    _id: { $ne: appointment._id },
    status: { $nin: [AppointmentStatus.COMPLETED, AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] },
    ocularFeePaid: { $ne: true },
    ocularFeeStatus: { $in: ['pending', 'cash_pending', 'proof_submitted'] },
  };

  const possibleDuplicates = await Appointment.find(baseFilter)
    .sort({ updatedAt: -1, createdAt: -1 })
    .select('_id date slotCode serviceTypes formattedAddress customerAddress customerLocation updatedAt createdAt')
    .lean();

  const normalizeAddress = (value?: string) => (value || '').trim().toLowerCase();
  const appointmentAddress = normalizeAddress(appointment.formattedAddress || appointment.customerAddress);
  const appointmentLocation = appointment.customerLocation
    ? `${Number(appointment.customerLocation.lat).toFixed(4)},${Number(appointment.customerLocation.lng).toFixed(4)}`
    : '';

  const matches = possibleDuplicates.filter((candidate: any) => {
    const candidateServices = [...(candidate.serviceTypes || [])].sort();
    const servicesMatch = serviceTypes.length === 0
      || candidateServices.length === 0
      || serviceTypes.join('|') === candidateServices.join('|');
    const candidateAddress = normalizeAddress(candidate.formattedAddress || candidate.customerAddress);
    const candidateLocation = candidate.customerLocation
      ? `${Number(candidate.customerLocation.lat).toFixed(4)},${Number(candidate.customerLocation.lng).toFixed(4)}`
      : '';
    const locationMatch = Boolean(
      (appointmentAddress && candidateAddress && appointmentAddress === candidateAddress)
      || (appointmentLocation && candidateLocation && appointmentLocation === candidateLocation),
    );

    return servicesMatch && locationMatch;
  });

  const canonical = [appointment, ...matches].sort((a: any, b: any) => {
    const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
    if (aTime !== bTime) return bTime - aTime;
    return String(b._id).localeCompare(String(a._id));
  })[0];

  return String(canonical?._id || '') !== currentId ? canonical : null;
}

// ── Appointment Queue (Appointment Agent/Admin) ──

export async function listAppointmentQueue(
  query: AppointmentQueueQuery,
  actorId: string,
  actorRoles: Role[],
): Promise<AppointmentQueueResult> {
  const normalizedSearch = normalizeAppointmentSearchTerm(query.search);
  const searchScope = getSearchScope(actorRoles);
  if (
    actorRoles.includes(Role.CUSTOMER)
    && !actorRoles.some((role) => [Role.ADMIN, Role.APPOINTMENT_AGENT, Role.SALES_STAFF].includes(role))
  ) {
    throw AppError.forbidden('Queue view is only available to staff roles.');
  }

  const limit = query.limit ?? 120;
  const nowInManila = toZonedTime(new Date(), TZ);
  const todayStr = format(nowInManila, 'yyyy-MM-dd');
  const recentStartStr = format(addDays(nowInManila, -(APPOINTMENT_QUEUE_RECENT_DAYS - 1)), 'yyyy-MM-dd');

  const andFilters: Record<string, unknown>[] = [];

  if (
    actorRoles.includes(Role.SALES_STAFF)
    && !actorRoles.some((role) => [Role.ADMIN, Role.APPOINTMENT_AGENT].includes(role))
  ) {
    andFilters.push({ salesStaffId: actorId });
  }

  if (actorRoles.some((role) => [Role.ADMIN, Role.APPOINTMENT_AGENT].includes(role))) {
    andFilters.push({
      $or: [
        { type: { $ne: AppointmentType.OCULAR } },
        { type: AppointmentType.OCULAR, ocularFeeStatus: { $ne: 'pending' } },
      ],
    });
  }

  // If status/search is provided, don't restrict by the "Queue" window.
  // If not, we keep the default queue filter for a clean view.
  if (query.status === undefined && !normalizedSearch) {
    andFilters.push({
      $or: [
        { status: { $in: APPOINTMENT_QUEUE_ACTIONABLE_STATUSES } },
        {
          status: { $in: APPOINTMENT_QUEUE_RECENT_STATUSES },
          date: { $gte: recentStartStr, $lte: todayStr },
        },
      ],
    });
  }

  const requestedStatuses = query.status
    ?.split(',')
    .map((status) => status.trim())
    .filter(Boolean) || [];
  const isHistoricalStatusFilter = requestedStatuses.length > 0
    && requestedStatuses.every((status) => APPOINTMENT_QUEUE_RECENT_STATUSES.includes(status as AppointmentStatus));

  if (query.status) {
    const includesReadyForOcular = requestedStatuses.includes(AppointmentStatus.READY_FOR_OCULAR);
    const directStatuses = includesReadyForOcular
      ? requestedStatuses.filter((status) => status !== AppointmentStatus.READY_FOR_OCULAR)
      : requestedStatuses;

    if (includesReadyForOcular) {
      const statusFilters: Record<string, unknown>[] = [
        { status: AppointmentStatus.READY_FOR_OCULAR },
        DERIVED_READY_FOR_OCULAR_FILTER,
      ];

      if (directStatuses.length > 0) {
        statusFilters.push({ status: { $in: directStatuses } });
      }

      andFilters.push({ $or: statusFilters });
    } else if (directStatuses.length > 1) {
      andFilters.push({ status: { $in: directStatuses } });
    } else if (directStatuses.length === 1) {
      andFilters.push({ status: directStatuses[0] });
    } else {
      andFilters.push({ status: query.status });
    }
  }

  const queueFilter = andFilters.length === 1 ? andFilters[0] : { $and: andFilters };
  const fetchLimit = normalizedSearch ? 1000 : Math.min(Math.max(limit * 3, 180), 600);

  const appointments = await Appointment.find(queueFilter)
    .populate('customerId', 'firstName lastName email phone')
    .populate('salesStaffId', 'firstName lastName availabilityStatus availabilityNote')
    .sort({ date: 1, slotCode: 1, createdAt: 1 })
    .limit(fetchLimit);

  const appointmentIds = appointments.map((appointment) => appointment._id);
  const customerIds = Array.from(
    new Set(
      appointments
        .map((appointment: any) => (appointment.customerId?._id ?? appointment.customerId)?.toString?.())
        .filter((value): value is string => Boolean(value)),
    ),
  );

  const [linkedReports, customerProjects] = await Promise.all([
    appointmentIds.length
      ? VisitReport.find({
        appointmentId: { $in: appointmentIds },
        status: { $in: [VisitReportStatus.SUBMITTED, VisitReportStatus.COMPLETED] },
      })
        .select('_id appointmentId createdAt')
        .sort({ createdAt: -1 })
        .lean()
      : Promise.resolve([]),
    customerIds.length
      ? Project.find({
        customerId: { $in: customerIds },
        status: { $ne: ProjectStatus.CANCELLED },
      })
        .select('_id appointmentId customerId projectNumber title serviceType status createdAt')
        .sort({ createdAt: -1 })
        .lean()
      : Promise.resolve([]),
  ]);

  const reportByAppointmentId = new Map<string, string>();
  for (const report of linkedReports as Array<{ _id: unknown; appointmentId: unknown }>) {
    const appointmentId = String(report.appointmentId);
    if (!reportByAppointmentId.has(appointmentId)) {
      reportByAppointmentId.set(appointmentId, String(report._id));
    }
  }

  const projectsByCustomer = new Map<string, any[]>();
  const projectByAppointmentId = new Map<string, any>();
  for (const project of customerProjects as any[]) {
    const customerId = String(project.customerId);
    const appointmentId = project.appointmentId ? String(project.appointmentId) : undefined;

    const projectList = projectsByCustomer.get(customerId) || [];
    projectList.push(project);
    projectsByCustomer.set(customerId, projectList);

    if (appointmentId && !projectByAppointmentId.has(appointmentId)) {
      projectByAppointmentId.set(appointmentId, project);
    }
  }

  let queueItems: AppointmentQueueItem[] = appointments.map((appointment: any) => {
    const appointmentId = String(appointment._id);
    const customerId = String(appointment.customerId?._id ?? appointment.customerId ?? '');
    const linkedProject = projectByAppointmentId.get(appointmentId)
      || projectsByCustomer.get(customerId)?.[0];
    const customerSampleProjects = (projectsByCustomer.get(customerId) || []).slice(0, 2);

    const reportId = reportByAppointmentId.get(appointmentId);
    const hasPendingReport = linkedReports.some((r: any) => 
      String(r.appointmentId) === appointmentId && 
      [VisitReportStatus.DRAFT, VisitReportStatus.RETURNED].includes(r.status)
    );
    const currentReport = linkedReports.find((r: any) => String(r.appointmentId) === appointmentId);

    const isReadyForOcular = !isHistoricalStatusFilter && isReadyForOcularQueueItem(appointment);
    const isActionable = !isHistoricalStatusFilter
      && (
        APPOINTMENT_QUEUE_ACTIONABLE_STATUSES.includes(appointment.status)
        || isReadyForOcular
        || hasPendingReport
      );

    // Segment: Upcoming (Actionable) vs Recent/History (Everything else)
    const segment = isActionable ? 'upcoming' : 'recent';

    const actions: AppointmentQueueActions = {
      reviewReportPath: reportId ? `/visit-reports/${reportId}` : undefined,
      projectPath: linkedProject ? `/projects/${linkedProject._id}` : undefined,
      createProjectPath:
        appointment.type === AppointmentType.OFFICE
        && isReadyForOcular
        && customerId
          ? `/appointments/book?customerId=${customerId}&mode=ocular-followup&consultationId=${appointmentId}`
          : undefined,
      reassignPath: APPOINTMENT_REASSIGNABLE_STATUSES.includes(appointment.status)
        ? `/appointments/${appointmentId}/reassign`
        : undefined,
    };

    return {
      appointment,
      segment,
      reportStatus: currentReport?.status,
      actions,
      sampleProjects: customerSampleProjects.map((project: any) => ({
        projectId: String(project._id),
        title: project.title || project.serviceType || 'Project',
        serviceType: project.serviceType,
        status: project.status,
        path: `/projects/${project._id}`,
      })),
    };
  });

  if (normalizedSearch) {
    queueItems = queueItems.filter((item) => {
      const appointment = item.appointment as any;
      const customerId = String(appointment.customerId?._id ?? appointment.customerId ?? '');
      const linkedProjects = [
        ...(projectByAppointmentId.get(String(appointment._id)) ? [projectByAppointmentId.get(String(appointment._id))] : []),
        ...(projectsByCustomer.get(customerId) || []).slice(0, 3),
      ];

      return matchesAppointmentSearch(
        {
          type: appointment.type,
          status: appointment.status,
          consultationReportSubmitted: appointment.consultationReportSubmitted,
          date: appointment.date,
          slotCode: appointment.slotCode,
          customerNotes: appointment.customerNotes,
          internalNotes: appointment.internalNotes,
          formattedAddress: appointment.formattedAddress,
          customerAddress: appointment.customerAddress,
          serviceTypes: appointment.serviceTypes,
          serviceTypeCustom: appointment.serviceTypeCustom,
          customerSiteDetails: appointment.customerSiteDetails,
          customerName: fullName(appointment.customerId),
          salesStaffName: fullName(appointment.salesStaffId),
          linkedProjects: linkedProjects.map((project: any) => ({
            projectNumber: project.projectNumber,
            title: project.title,
            serviceType: project.serviceType,
          })),
        },
        normalizedSearch,
        searchScope,
      );
    });
  }

  const queueItemTimestamp = (value?: string | Date | null) => {
    if (!value) return 0;
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? 0 : parsed;
  };

  const prioritizeLatestActivity = query.status === undefined && !normalizedSearch;

  const sortUpcoming = (a: AppointmentQueueItem, b: AppointmentQueueItem) => {
    if (prioritizeLatestActivity) {
      const aTimestamp = queueItemTimestamp(a.appointment?.updatedAt) || queueItemTimestamp(a.appointment?.createdAt);
      const bTimestamp = queueItemTimestamp(b.appointment?.updatedAt) || queueItemTimestamp(b.appointment?.createdAt);
      if (aTimestamp !== bTimestamp) return bTimestamp - aTimestamp;
    }

    const aDate = a.appointment?.date || '';
    const bDate = b.appointment?.date || '';
    if (aDate !== bDate) return aDate < bDate ? -1 : 1;

    const aSlot = a.appointment?.slotCode || '';
    const bSlot = b.appointment?.slotCode || '';
    if (aSlot !== bSlot) return aSlot < bSlot ? -1 : 1;

    const aCreated = a.appointment?.createdAt ? new Date(a.appointment.createdAt).getTime() : 0;
    const bCreated = b.appointment?.createdAt ? new Date(b.appointment.createdAt).getTime() : 0;
    if (aCreated !== bCreated) return aCreated - bCreated;

    return String(a.appointment?._id).localeCompare(String(b.appointment?._id));
  };

  const sortDescendingByDateSlot = (a: AppointmentQueueItem, b: AppointmentQueueItem) => {
    const aDate = a.appointment?.date || '';
    const bDate = b.appointment?.date || '';
    if (aDate !== bDate) return aDate < bDate ? 1 : -1;

    const aSlot = a.appointment?.slotCode || '';
    const bSlot = b.appointment?.slotCode || '';
    if (aSlot !== bSlot) return aSlot < bSlot ? 1 : -1;

    return String(b.appointment?._id).localeCompare(String(a.appointment?._id));
  };

  const upcomingItems = queueItems
    .filter((item) => item.segment === 'upcoming')
    .sort(sortUpcoming);
  const recentItems = queueItems
    .filter((item) => item.segment === 'recent')
    .sort(sortDescendingByDateSlot);

  const orderedItems = [...upcomingItems, ...recentItems].slice(0, limit);

  return {
    items: orderedItems,
    upcomingCount: upcomingItems.length,
    recentCount: recentItems.length,
    recentWindowDays: APPOINTMENT_QUEUE_RECENT_DAYS,
    generatedAt: new Date().toISOString(),
  };
}

// ── List Appointments ──

const APPOINTMENT_HISTORY_STATUSES = new Set<string>([
  AppointmentStatus.COMPLETED,
  AppointmentStatus.CANCELLED,
  AppointmentStatus.NO_SHOW,
]);

export function defaultAppointmentSort(status?: string) {
  const statuses = status
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean) || [];

  const isHistoricalOnly = statuses.length > 0
    && statuses.every((value) => APPOINTMENT_HISTORY_STATUSES.has(value));

  return isHistoricalOnly
    ? { date: -1 as SortOrder, slotCode: -1 as SortOrder, createdAt: -1 as SortOrder }
    : { date: 1 as SortOrder, slotCode: 1 as SortOrder, createdAt: 1 as SortOrder };
}

export async function listAppointments(query: {
  status?: string;
  type?: string;
  date?: string;
  dateFrom?: string;
  dateTo?: string;
  customerId?: string;
  salesStaffId?: string;
  ocularFeeStatus?: string;
  search?: string;
  page?: string;
  limit?: string;
  sortBy?: string;
  sortOrder?: string;
}, actorId: string, actorRoles: Role[]) {
  const page = parseInt(query.page || '1');
  const limit = Math.min(parseInt(query.limit || '20'), 100);
  const filter: Record<string, unknown> = {};
  const normalizedSearch = normalizeAppointmentSearchTerm(query.search);
  const searchScope = getSearchScope(actorRoles);

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
  } else if (
    actorRoles.some(r => [Role.ADMIN, Role.APPOINTMENT_AGENT].includes(r))
  ) {
    // Hide ocular appointments whose fee hasn't been paid yet, but always show office appointments
    filter.$or = [
      { type: { $ne: 'ocular' } },
      { type: 'ocular', ocularFeeStatus: { $ne: 'pending' } },
    ];
  }

  if (query.status) {
    const statuses = query.status.split(',').map((status) => status.trim()).filter(Boolean);
    const includesReadyForOcular = statuses.includes(AppointmentStatus.READY_FOR_OCULAR);
    const directStatuses = includesReadyForOcular
      ? statuses.filter((status) => status !== AppointmentStatus.READY_FOR_OCULAR)
      : statuses;

    if (includesReadyForOcular) {
      const statusFilters: Record<string, unknown>[] = [
        { status: AppointmentStatus.READY_FOR_OCULAR },
        DERIVED_READY_FOR_OCULAR_FILTER,
      ];

      if (directStatuses.length > 0) {
        statusFilters.push({ status: { $in: directStatuses } });
      }

      appendAndFilter(filter, { $or: statusFilters });
    } else if (directStatuses.length > 1) {
      filter.status = { $in: directStatuses };
    } else if (directStatuses.length === 1) {
      filter.status = directStatuses[0];
    } else {
      filter.status = query.status;
    }
  }
  if (query.type) filter.type = query.type;
  if (query.date) filter.date = query.date;
  if (query.ocularFeeStatus) filter.ocularFeeStatus = query.ocularFeeStatus;
  if (query.customerId && !filter.customerId) filter.customerId = query.customerId;
  if (query.salesStaffId && !filter.salesStaffId) filter.salesStaffId = query.salesStaffId;

  if (query.dateFrom || query.dateTo) {
    filter.date = {};
    if (query.dateFrom) (filter.date as Record<string, string>).$gte = query.dateFrom;
    if (query.dateTo) (filter.date as Record<string, string>).$lte = query.dateTo;
  }

  const sortField = query.sortBy;
  const sortOrder: SortOrder = query.sortOrder === 'desc' ? -1 : 1;
  const sortSpec: Record<string, SortOrder> = sortField
    ? { [sortField]: sortOrder }
    : defaultAppointmentSort(query.status);

  if (!normalizedSearch) {
    const [appointments, total] = await Promise.all([
      Appointment.find(filter)
        .populate('customerId', 'firstName lastName email phone')
        .populate('salesStaffId', 'firstName lastName')
        .sort(sortSpec)
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

  const appointments = await Appointment.find(filter)
    .populate('customerId', 'firstName lastName email phone')
    .populate('salesStaffId', 'firstName lastName')
    .sort(sortSpec);

  const appointmentIds = appointments.map((appointment) => appointment._id);
  const customerIds = Array.from(
    new Set(
      appointments
        .map((appointment: any) => (appointment.customerId?._id ?? appointment.customerId)?.toString?.())
        .filter((value): value is string => Boolean(value)),
    ),
  );

  const relatedProjects = appointmentIds.length || customerIds.length
    ? await Project.find({
      $and: [
        { status: { $ne: ProjectStatus.CANCELLED } },
        {
          $or: [
            ...(appointmentIds.length ? [{ appointmentId: { $in: appointmentIds } }] : []),
            ...(customerIds.length ? [{ customerId: { $in: customerIds } }] : []),
          ],
        },
      ],
    })
      .select('_id appointmentId customerId projectNumber title serviceType createdAt')
      .sort({ createdAt: -1 })
      .lean()
    : [];

  const projectsByAppointmentId = new Map<string, any[]>();
  const projectsByCustomerId = new Map<string, any[]>();
  for (const project of relatedProjects as any[]) {
    const appointmentId = project.appointmentId ? String(project.appointmentId) : undefined;
    const customerId = String(project.customerId);

    if (appointmentId) {
      const appointmentProjects = projectsByAppointmentId.get(appointmentId) || [];
      appointmentProjects.push(project);
      projectsByAppointmentId.set(appointmentId, appointmentProjects);
    }

    const customerProjects = projectsByCustomerId.get(customerId) || [];
    customerProjects.push(project);
    projectsByCustomerId.set(customerId, customerProjects);
  }

  const filteredAppointments = appointments.filter((appointment: any) => {
    const appointmentId = String(appointment._id);
    const customerId = String(appointment.customerId?._id ?? appointment.customerId ?? '');
    const linkedProjects = [
      ...(projectsByAppointmentId.get(appointmentId) || []),
      ...(projectsByCustomerId.get(customerId) || []).slice(0, 3),
    ];

    return matchesAppointmentSearch(
      {
        type: appointment.type,
        status: appointment.status,
        consultationReportSubmitted: appointment.consultationReportSubmitted,
        date: appointment.date,
        slotCode: appointment.slotCode,
        customerNotes: appointment.customerNotes,
        internalNotes: appointment.internalNotes,
        formattedAddress: appointment.formattedAddress,
        customerAddress: appointment.customerAddress,
        serviceTypes: appointment.serviceTypes,
        serviceTypeCustom: appointment.serviceTypeCustom,
        customerSiteDetails: appointment.customerSiteDetails,
        customerName: fullName(appointment.customerId),
        salesStaffName: fullName(appointment.salesStaffId),
        linkedProjects: linkedProjects.map((project: any) => ({
          projectNumber: project.projectNumber,
          title: project.title,
          serviceType: project.serviceType,
        })),
      },
      normalizedSearch,
      searchScope,
    );
  });

  const total = filteredAppointments.length;
  const items = filteredAppointments.slice((page - 1) * limit, page * limit);

  return {
    items,
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
