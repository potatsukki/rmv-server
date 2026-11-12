import { format, parse, isAfter, isBefore, startOfDay, addMinutes, addDays } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import {
  Appointment, SlotLock, User, AuditLog, Holiday, SalesAvailability, Config, BlockedSlot,
  VisitReport, VisitReportStatus, Project, AppointmentQueueCounter,
} from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import {
  AppointmentStatus, AppointmentType, AppointmentAttendanceStatus, Role, AuditAction, MIN_BOOKING_LEAD_DAYS,
  NotificationCategory, PaymentMethod, ProjectStatus, SLOT_CODES, StaffAvailabilityStatus, type SlotCode,
} from '../../utils/constants.js';
import { appointmentStateMachine } from '../../utils/stateMachine.js';
import {
  createAndSendNotification, emitRoleEvent, notifyBookingAgentAppointmentSuccessful, notifyBookingAgents, notifyRole,
  notifyRoleExcept, notifyUsers,
} from '../notifications/socket.service.js';
import { describeAppointmentForNotification, formatNotificationDate } from '../../utils/notification-format.js';
import { sendAppointmentConfirmedEmail } from '../notifications/email.service.js';
import { autoCreateDraft as autoCreateVisitReport } from '../visit-reports/visit-reports.service.js';
import { assertOcularLocationAccepted, computeOcularFee, reverseGeocode } from '../maps/maps.service.js';
import { createCheckoutSession, retrieveCheckoutSession } from '../../services/paymongo.service.js';
import { logger } from '../../utils/logger.js';
import { formatCurrency } from '../../utils/helpers.js';
import { matchesAppointmentSearch, normalizeAppointmentSearchTerm } from './appointments.search.js';
import type { SortOrder } from 'mongoose';
import {
  buildAvailabilityStateSummary,
  evaluateSalesAssignmentEligibility,
  getOpenAvailabilitySession,
  getOpenAvailabilitySessionsByUserIds,
  SALES_ACTIVE_ASSIGNMENT_STATUSES,
  SALES_SLOT_FREEING_STATUSES,
  slotsOverlap,
} from '../users/availability-session.service.js';
import { synchronizeConsultationAttendanceByTime } from './consultation-attendance-automation.js';
import { acquireSalesDayLock, withSalesDayLocks, type SalesDayLocks } from './sales-day-lock.js';
import type {
  RequestAppointmentInput,
  AgentCreateAppointmentInput,
  ConfirmAppointmentInput,
  ReassignAppointmentSalesInput,
  SalesAppointmentDecisionInput,
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
import { buildAppointmentStatusGroupFilter } from './appointment-status-groups.js';
import { assertOcularAfterConsultation } from './ocular-schedule-rules.js';
import { assertAppointmentDayReached } from './appointment-date-guards.js';
import { getActivityHistory } from '../reports/activity-history.js';
import type { Types } from 'mongoose';

const TZ = 'Asia/Manila';
const ESTIMATED_CONSULTATION_MINUTES = 30;

export async function assertBookingReadyForGcashApproval(appointment: import('../../models/Appointment.js').IAppointment) {
  if (appointment.status === AppointmentStatus.CONFIRMED) return;
  if (appointment.status !== AppointmentStatus.REQUESTED) throw AppError.badRequest('Booking schedule must be resolved before payment approval');
  appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.CONFIRMED);
  if (!appointment.salesStaffId) throw AppError.badRequest('Booking has no assigned sales staff');
  if (appointment.date < format(toZonedTime(new Date(), TZ), 'yyyy-MM-dd')) throw AppError.badRequest('Booking date has passed. Resolve the schedule before approval.');
  await assertSlotAvailable(appointment.date, appointment.slotCode, appointment.type, appointment._id.toString());
  await assertSalesAvailable(appointment.salesStaffId.toString(), appointment.date, appointment.slotCode, appointment.type, appointment._id.toString());
}

function formatQueueNumber(sequence: number) {
  return `Q-${String(sequence).padStart(3, '0')}`;
}

async function nextDailyQueueSequence(date: string) {
  try {
    const counter = await AppointmentQueueCounter.findOneAndUpdate(
      { date },
      { $inc: { lastSeq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    return counter.lastSeq;
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
    const counter = await AppointmentQueueCounter.findOneAndUpdate(
      { date },
      { $inc: { lastSeq: 1 } },
      { new: true },
    );
    if (!counter) throw error;
    return counter.lastSeq;
  }
}

async function issueQueueNumber(appointment: any, issuedAt: Date) {
  if (appointment.queueNumber) return;
  const queueDate = format(toZonedTime(issuedAt, TZ), 'yyyy-MM-dd');
  const sequence = await nextDailyQueueSequence(queueDate);
  appointment.queueDate = queueDate;
  appointment.queueSequence = sequence;
  appointment.queueNumber = formatQueueNumber(sequence);
  appointment.queueIssuedAt = issuedAt;
}

const APPOINTMENT_QUEUE_RECENT_DAYS = 14;
const APPOINTMENT_QUEUE_ACTIONABLE_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.REQUESTED,
  AppointmentStatus.ASSIGNED,
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
  AppointmentStatus.ASSIGNED,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.PREPARING,
  AppointmentStatus.ON_THE_WAY,
  AppointmentStatus.ARRIVED_AT_SITE,
  AppointmentStatus.IN_PROGRESS,
  AppointmentStatus.RESCHEDULE_REQUESTED,
];

// Matches the window the customer "Reschedule" button is shown in on the frontend.
const RESCHEDULABLE_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.REQUESTED,
  AppointmentStatus.ASSIGNED,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.PREPARING,
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

/**
 * Ocular visits a project scheduled. They belong to the project (Projects tab), so the
 * Appointments page leaves them out when it asks with excludeProjectOculars=true.
 *
 * With ownerSalesStaffId, only that staff member's own projects count: an ocular visit another
 * project handed to them has no project page of theirs to open it from, so it stays listed.
 */
async function getProjectOcularAppointmentIds(ownerSalesStaffId?: string): Promise<unknown[]> {
  const ids = await Project.distinct('ocularAppointmentId', {
    status: { $ne: ProjectStatus.CANCELLED },
    ocularAppointmentId: { $exists: true, $ne: null },
    ...(ownerSalesStaffId ? { salesStaffId: ownerSalesStaffId } : {}),
  });
  return ids.filter(Boolean);
}

/** The viewer's ID when they are sales staff only (no admin or agent role), otherwise undefined. */
function salesOnlyActorId(actorId: string, actorRoles: Role[]): string | undefined {
  return actorRoles.includes(Role.SALES_STAFF)
    && !actorRoles.some((role) => [Role.ADMIN, Role.APPOINTMENT_AGENT].includes(role))
    ? actorId
    : undefined;
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

interface SelectedDesignSnapshot {
  selectedDesignTemplateId?: string;
  selectedDesignTemplateName?: string;
  selectedDesignTemplateImageUrl?: string;
}

function firstSelectedDesignValue(
  sources: Array<SelectedDesignSnapshot | null | undefined>,
  field: keyof SelectedDesignSnapshot,
) {
  return sources
    .map((source) => source?.[field])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function selectedDesignSnapshot(
  ...sources: Array<SelectedDesignSnapshot | null | undefined>
): SelectedDesignSnapshot {
  return {
    selectedDesignTemplateId: firstSelectedDesignValue(sources, 'selectedDesignTemplateId'),
    selectedDesignTemplateName: firstSelectedDesignValue(sources, 'selectedDesignTemplateName'),
    selectedDesignTemplateImageUrl: firstSelectedDesignValue(sources, 'selectedDesignTemplateImageUrl'),
  };
}

function syncSelectedDesign(
  target: SelectedDesignSnapshot,
  source: SelectedDesignSnapshot,
): boolean {
  let changed = false;

  if (source.selectedDesignTemplateId && target.selectedDesignTemplateId !== source.selectedDesignTemplateId) {
    target.selectedDesignTemplateId = source.selectedDesignTemplateId;
    changed = true;
  }
  if (source.selectedDesignTemplateName && target.selectedDesignTemplateName !== source.selectedDesignTemplateName) {
    target.selectedDesignTemplateName = source.selectedDesignTemplateName;
    changed = true;
  }
  if (
    source.selectedDesignTemplateImageUrl
    && target.selectedDesignTemplateImageUrl !== source.selectedDesignTemplateImageUrl
  ) {
    target.selectedDesignTemplateImageUrl = source.selectedDesignTemplateImageUrl;
    changed = true;
  }

  return changed;
}

// ── Helpers ──

async function getConfigValue<T>(key: string, defaultVal: T): Promise<T> {
  const config = await Config.findOne({ key });
  return config ? (config.value as T) : defaultVal;
}

// Completed appointments whose consultation did not actually lead anywhere.
const CLOSED_WITHOUT_CONSULTATION_ATTENDANCE = [
  AppointmentAttendanceStatus.NO_SHOW,
  AppointmentAttendanceStatus.CUSTOMER_DECLINED,
];

async function getLatestEligibleConsultationForOcular(customerId: string) {
  const consultation = await Appointment.findOne({
    customerId,
    type: AppointmentType.OFFICE,
    salesStaffId: { $exists: true },
    status: AppointmentStatus.COMPLETED,
    attendanceStatus: { $nin: CLOSED_WITHOUT_CONSULTATION_ATTENDANCE },
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

async function assertNoActiveAppointment(
  customerId: string,
  excludeAppointmentIds: string[] = [],
  /** Who sees the error: the customer ("You already have…") or staff acting for them. */
  options: { audience?: 'customer' | 'staff' } = {},
): Promise<void> {
  // Every not-yet-finished status counts, including an ocular visit already under way, so a
  // customer never holds a consultation and an ocular visit at the same time.
  const filter: Record<string, unknown> = {
    customerId,
    status: { $in: SALES_ACTIVE_ASSIGNMENT_STATUSES },
  };
  if (excludeAppointmentIds.length) filter._id = { $nin: excludeAppointmentIds };
  const active = await Appointment.findOne(filter);
  if (active) {
    // Name the blocking appointment: a project's ocular visit is not listed on the Appointments page.
    const owningProject = await Project.findOne({
      $or: [{ ocularAppointmentId: active._id }, { appointmentId: active._id }],
      status: { $ne: ProjectStatus.CANCELLED },
    }).select('projectNumber').lean();
    const kind = active.type === AppointmentType.OCULAR ? 'ocular visit' : 'consultation';
    const when = active.date
      ? `${formatAppointmentDate(active.date)}${active.slotCode ? `, ${formatSlotTime(active.slotCode)}` : ''}`
      : '';
    const statusLabel = String(active.status || '').replace(/_/g, ' ');
    const detail = [
      active.appointmentNumber,
      when,
      statusLabel && statusLabel.charAt(0).toUpperCase() + statusLabel.slice(1),
      owningProject?.projectNumber,
    ].filter(Boolean).join(' · ');
    const message = options.audience === 'staff'
      ? `This customer already has an active ${kind}${detail ? ` (${detail})` : ''}. Complete or cancel it first.`
      : `You already have an active appointment${detail ? ` (${detail})` : ''}. Please complete or cancel it first.`;
    throw AppError.conflict(
      message,
      ErrorCode.DUPLICATE_ENTRY,
      {
        activeAppointmentId: active._id.toString(),
        activeAppointmentNumber: active.appointmentNumber,
        activeAppointmentStatus: active.status,
        activeAppointmentType: active.type,
        activeAppointmentDate: active.date,
        activeAppointmentSlotCode: active.slotCode,
        activeProjectNumber: owningProject?.projectNumber,
      },
    );
  }
}

function formatAppointmentDate(dateStr: string) {
  const [year = 0, month = 1, day = 1] = dateStr.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

/** Consultation date behind an ocular appointment, when it came from one. */
async function getSourceConsultationDate(appointment: {
  type?: AppointmentType | string;
  sourceConsultationAppointmentId?: unknown;
}): Promise<string | undefined> {
  if (appointment.type !== AppointmentType.OCULAR || !appointment.sourceConsultationAppointmentId) return undefined;
  const consultation = await Appointment.findById(appointment.sourceConsultationAppointmentId).select('date').lean();
  return consultation?.date;
}

export async function prepareProjectOcularSchedule(input: {
  customerId: string;
  date: string;
  slotCode: SlotCode;
  salesStaffId?: string;
  /** Date of the consultation this ocular follows; the ocular must be 3+ days after it. */
  consultationDate?: string;
  /** Holds the staff member's day until the caller has saved the ocular appointment. */
  locks?: SalesDayLocks;
  lockedBy?: string;
}): Promise<string> {
  assertOcularAfterConsultation(input.date, input.consultationDate);
  await assertNoActiveAppointment(input.customerId, [], { audience: 'staff' });
  await assertDateAvailable(input.date);
  const freeSalesStaffIds = await assertSlotAvailable(input.date, input.slotCode, AppointmentType.OCULAR);
  const salesStaffId = input.salesStaffId || freeSalesStaffIds[0];
  if (!salesStaffId) throw AppError.badRequest('No sales staff available for this ocular visit');
  await acquireSalesDayLock(input.locks, salesStaffId, input.date, input.lockedBy || salesStaffId);
  await assertSalesAvailable(salesStaffId, input.date, input.slotCode, AppointmentType.OCULAR);
  return salesStaffId;
}

/**
 * The same checks for an ocular visit that a consultation report schedules (or moves): a real
 * slot on an open date, and a sales staff member with no other appointment at that time. The source
 * consultation and the ocular visit being moved never block themselves.
 */
export async function assertConsultationOcularSchedule(input: {
  customerId: string;
  salesStaffId: string;
  date: string;
  slotCode: string;
  consultationAppointmentId: string;
  existingOcularId?: string;
  /** Holds the staff member's day until the caller has saved the ocular appointment. */
  locks?: SalesDayLocks;
}): Promise<void> {
  if (!(SLOT_CODES as readonly string[]).includes(input.slotCode)) {
    throw AppError.badRequest('Choose a valid ocular visit time.', ErrorCode.VALIDATION_ERROR);
  }
  await assertNoActiveAppointment(
    input.customerId,
    [input.consultationAppointmentId, input.existingOcularId].filter((id): id is string => Boolean(id)),
    { audience: 'staff' },
  );
  await assertDateAvailable(input.date);
  await assertSlotAvailable(input.date, input.slotCode, AppointmentType.OCULAR, input.existingOcularId);
  await acquireSalesDayLock(input.locks, input.salesStaffId, input.date, input.salesStaffId);
  await assertSalesAvailable(input.salesStaffId, input.date, input.slotCode, AppointmentType.OCULAR, input.existingOcularId);
}

async function assertDateAvailable(dateStr: string): Promise<void> {
  // Check it's not in the past
  const now = toZonedTime(new Date(), TZ);
  const target = parse(dateStr, 'yyyy-MM-dd', new Date());
  if (isBefore(target, startOfDay(now))) {
    throw AppError.badRequest('Cannot book appointments in the past');
  }

  // Enforce the minimum advance booking
  const minBookingDate = startOfDay(addDays(now, MIN_BOOKING_LEAD_DAYS));
  if (isBefore(target, minBookingDate)) {
    throw AppError.badRequest(`Appointments must be booked at least ${MIN_BOOKING_LEAD_DAYS} days in advance`);
  }

  // Bookings are open every day of the week; only holidays are blocked.
  // Check it's not a holiday
  const holiday = await Holiday.findOne({ date: dateStr });
  if (holiday) {
    throw AppError.badRequest(`${dateStr} is a holiday: ${holiday.name}`);
  }
}

async function getSlotAvailability(
  dateStr: string,
  slotCode: string,
  appointmentId?: string,
  /** Only count this sales staff (e.g. the project's own staff scheduling its ocular visit). */
  onlySalesStaffId?: string,
) {
  // Sales staff are available by default unless an admin marked them Unavailable or On Leave.
  const salesStaff = await User.find({
    roles: Role.SALES_STAFF,
    isActive: true,
    availabilityStatus: { $nin: [StaffAvailabilityStatus.UNAVAILABLE, StaffAvailabilityStatus.ON_LEAVE] },
    ...(onlySalesStaffId ? { _id: onlySalesStaffId } : {}),
  }).select('_id roles availabilityStatus').lean();

  const sessionsByUserId = await getOpenAvailabilitySessionsByUserIds(
    salesStaff.map((staff) => staff._id),
  );
  const isSlotCountEligible = (staff: { _id: Types.ObjectId | string; roles?: Array<Role | string>; availabilityStatus?: StaffAvailabilityStatus }) => {
    const summary = buildAvailabilityStateSummary(
      {
        roles: staff.roles,
        availabilityStatus: staff.availabilityStatus,
      },
      sessionsByUserId.get(staff._id.toString()),
    );

    return summary.availabilityStatus === StaffAvailabilityStatus.AVAILABLE
      && !summary.availabilitySetupRequired;
  };

  const salesStaffIds = salesStaff
    .filter(isSlotCountEligible)
    .map((staff) => staff._id.toString());
  if (salesStaffIds.length === 0) return { available: false, remaining: 0 };

  const unavailable = await SalesAvailability.find({
    salesStaffId: { $in: salesStaffIds },
    unavailableDates: dateStr,
  }).select('salesStaffId').lean();
  const unavailableIds = new Set(unavailable.map((entry) => entry.salesStaffId.toString()));
  const eligibleIds = new Set(salesStaffIds.filter((id) => !unavailableIds.has(id)));
  if (eligibleIds.size === 0) return { available: false, remaining: 0 };

  // A sales staff member is taken only for slots that overlap one of their appointments on this
  // date (office consultation or ocular visit); other slots that day stay open. Cancelled,
  // completed and no-show appointments free their slot. Every unassigned request in an
  // overlapping slot will need a staff member of its own, so it uses one up too.
  const appointmentFilter: Record<string, unknown> = {
    date: dateStr,
    status: { $nin: SALES_SLOT_FREEING_STATUSES },
  };
  if (appointmentId) appointmentFilter._id = { $ne: appointmentId };

  const sameDayAppointments = await Appointment.find(appointmentFilter)
    .select('salesStaffId slotCode')
    .lean();
  const scheduledAppointments = sameDayAppointments
    .filter((appointment) => slotsOverlap(appointment.slotCode, slotCode));
  const assignedStaffIds = new Set(
    scheduledAppointments
      .map((appointment) => appointment.salesStaffId?.toString())
      .filter((id): id is string => Boolean(id && eligibleIds.has(id))),
  );
  // Unassigned requests compete for the whole pool, not for one specific staff member.
  const awaitingAssignment = onlySalesStaffId
    ? 0
    : scheduledAppointments.filter((appointment) => !appointment.salesStaffId).length;
  const remaining = Math.max(0, eligibleIds.size - assignedStaffIds.size - awaitingAssignment);

  return { available: remaining > 0, remaining, salesStaffIds: [...eligibleIds].filter((id) => !assignedStaffIds.has(id)) };
}

async function assertSlotAvailable(
  dateStr: string,
  slotCode: string,
  type: string,
  appointmentId?: string,
): Promise<string[]> {
  const blocked = await BlockedSlot.exists({ date: dateStr, slotCode, type });
  if (blocked) {
    throw AppError.conflict('This slot has been blocked by an administrator', ErrorCode.SLOT_LOCKED);
  }

  const capacity = await getSlotAvailability(dateStr, slotCode, appointmentId);
  if (!capacity.available) {
    throw AppError.conflict(
      'No sales staff is available for this date and time. Please choose another schedule.',
      ErrorCode.SLOT_LOCKED,
    );
  }
  return capacity.salesStaffIds || [];
}

async function assertSalesAvailable(
  salesId: string,
  dateStr: string,
  slotCode: SlotCode | string,
  appointmentType: AppointmentType,
  /** The appointment being assigned or moved, so it never blocks itself. */
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
    appointmentType,
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
  /** Estimated one-way drive from the RMV shop, in minutes. */
  travelDurationMinutes: number;
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
    travelDurationMinutes: feeResult.route.durationMinutes,
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
  const { date, type, salesStaffId } = query;
  await assertDateAvailable(date);

  // A sales staff member is free in every slot that doesn't overlap one of their appointments;
  // also check admin/agent blocked slots. With salesStaffId, only that staff member counts.
  const slots = await Promise.all(
    SLOT_CODES.map(async (slotCode) => {
      const blocked = await BlockedSlot.exists({ date, slotCode, type });
      const capacity = blocked
        ? { available: false, remaining: 0 }
        : await getSlotAvailability(date, slotCode, undefined, salesStaffId);
      return {
        slotCode,
        time: formatSlotTime(slotCode),
        available: capacity.available && !blocked,
        remaining: capacity.remaining,
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

  const primarySelectedDesign = input.selectedDesignTemplates?.[0];

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
    selectedDesignTemplateId: input.selectedDesignTemplateId || primarySelectedDesign?.id,
    selectedDesignTemplateName: input.selectedDesignTemplateName || primarySelectedDesign?.name,
    selectedDesignTemplateImageUrl: input.selectedDesignTemplateImageUrl || primarySelectedDesign?.imageUrl,
    selectedDesignTemplates: input.selectedDesignTemplates,
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

  await assertNoActiveAppointment(input.customerId, [], { audience: 'staff' });
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

// ── Agent: Assign Appointment for Sales Review ──

export async function confirmAppointment(
  appointmentId: string,
  input: ConfirmAppointmentInput,
  agentId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await reassignAppointmentSales(
    appointmentId,
    { salesStaffId: input.salesStaffId, reason: input.internalNotes },
    agentId,
    [Role.APPOINTMENT_AGENT],
    ip,
    ua,
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
  return withSalesDayLocks((locks) => reassignAppointmentSalesLocked(appointmentId, input, actorId, actorRoles, locks, ip, ua));
}

async function reassignAppointmentSalesLocked(
  appointmentId: string,
  input: ReassignAppointmentSalesInput,
  actorId: string,
  actorRoles: Role[],
  locks: SalesDayLocks,
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

  // A sales staff member takes one appointment per day; other dates don't block them.
  await acquireSalesDayLock(locks, input.salesStaffId, appointment.date, actorId);
  await assertSalesAvailable(
    input.salesStaffId,
    appointment.date,
    appointment.slotCode as SlotCode,
    appointment.type,
    appointment._id.toString(),
  );

  if (appointment.type === AppointmentType.OCULAR && appointment.status !== AppointmentStatus.REQUESTED) {
    if (previousSalesStaffId) {
      await releaseSlotLock(appointment.date, appointment.slotCode as SlotCode, previousSalesStaffId);
    }
    await lockSlot(appointment.date, appointment.slotCode as SlotCode, input.salesStaffId, actorId);
    await confirmSlotLock(appointment.date, appointment.slotCode as SlotCode, input.salesStaffId, appointment._id);
  }

  const wasRequested = appointment.status === AppointmentStatus.REQUESTED;
  // Office flow: Requested -> Confirmed. The agent's assignment confirms the appointment;
  // the sales staff no longer accepts or declines it. Older "assigned" records still
  // waiting for acceptance are confirmed the same way when they are reassigned.
  const confirmsOnAssignment = appointment.type === AppointmentType.OFFICE
    && (wasRequested || appointment.status === AppointmentStatus.ASSIGNED);
  const isFirstAssignment = wasRequested && appointment.type === AppointmentType.OFFICE;

  appointment.salesStaffId = nextSalesStaff._id;
  if (confirmsOnAssignment) {
    appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.CONFIRMED);
    appointment.status = AppointmentStatus.CONFIRMED;
    appointment.assignedBy = actorId as unknown as Types.ObjectId;
    appointment.confirmedBy = actorId as unknown as Types.ObjectId;
  }
  await appointment.save();

  const ownershipSync = wasRequested || confirmsOnAssignment
    ? { draftVisitReportsUpdated: 0, projectsUpdated: 0 }
    : await syncDraftOwnershipForReassignment(appointment._id, nextSalesStaff._id);

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
      status: appointment.status,
      ...ownershipSync,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  const isNewAssignment = confirmsOnAssignment || wasRequested;
  // Staff messages name the appointment, customer and schedule, so two notices never read the same.
  const reference = await describeAppointmentForNotification(appointment);
  const when = formatNotificationDate(appointment.date, appointment.slotCode);
  const customerRef = [appointment.appointmentNumber, when].filter(Boolean).join(' on ');
  await createAndSendNotification(
    input.salesStaffId,
    NotificationCategory.APPOINTMENT,
    isNewAssignment ? 'New Appointment Assigned' : 'Appointment Reassigned',
    confirmsOnAssignment
      ? `You have been assigned to ${reference}. It is now confirmed on your schedule.`
      : `You were assigned to ${reference}.`,
    `/appointments/${appointment._id}`,
  );

  if (previousSalesStaffId) {
    const nextSalesStaffName = fullName(nextSalesStaff) || 'the newly assigned sales staff';
    await createAndSendNotification(
      previousSalesStaffId,
      NotificationCategory.APPOINTMENT,
      'Appointment Reassignment',
      `You have been replaced by ${nextSalesStaffName} for ${reference}. You no longer have access to this customer appointment.`,
      `/appointments/${appointment._id}`,
    );
  }

  if (isFirstAssignment) {
    await createAndSendNotification(
      appointment.customerId,
      NotificationCategory.APPOINTMENT,
      'Appointment Confirmed',
      `Your appointment ${customerRef} has been confirmed and a sales staff member has been assigned to you.`,
      `/appointments/${appointment._id}`,
    );
  } else if (!wasRequested) {
    await createAndSendNotification(
      appointment.customerId,
      NotificationCategory.APPOINTMENT,
      'Appointment Team Update',
      `Your appointment ${customerRef} has an updated assigned sales staff.`,
      `/appointments/${appointment._id}`,
    );
  }

  // The agent who booked it hears about the assignment when someone else (e.g. admin) made it.
  await notifyBookingAgents(
    appointment,
    NotificationCategory.APPOINTMENT,
    isNewAssignment ? 'Sales Staff Assigned' : 'Sales Staff Changed',
    `${fullName(nextSalesStaff) || 'A sales staff member'} is now assigned to ${reference}.`,
    `/appointments/${appointment._id}`,
    actorId,
  );

  if (confirmsOnAssignment) {
    await autoCreateVisitReport(
      appointment._id,
      appointment.customerId,
      appointment.salesStaffId!,
      'consultation',
      appointment.customerSiteDetails || undefined,
      appointment.serviceTypes,
      appointment.serviceTypes?.[0],
      appointment.serviceTypeCustom,
    );
  }

  return appointment;
}

// ── Sales Staff: Review Assigned Appointment ──
// New assignments are confirmed by the agent directly. This only lets the assigned
// sales staff confirm older "assigned" records created before that change; declining
// is no longer allowed.

export async function reviewAssignedAppointment(
  appointmentId: string,
  input: SalesAppointmentDecisionInput,
  salesStaffId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.type !== AppointmentType.OFFICE) {
    throw AppError.badRequest('Ocular appointments are confirmed through the ocular finalization flow');
  }

  if (appointment.salesStaffId?.toString() !== salesStaffId) {
    throw AppError.forbidden('Only the assigned sales staff can review this appointment');
  }
  if (appointment.status !== AppointmentStatus.ASSIGNED) {
    throw AppError.badRequest('This appointment is not waiting for your confirmation');
  }

  if (input.decision !== 'accept') {
    throw AppError.badRequest('Assigned appointments can no longer be declined. Ask the appointment agent to transfer it if needed.');
  }

  await assertSalesAvailable(
    salesStaffId,
    appointment.date,
    appointment.slotCode as SlotCode,
    appointment.type,
    appointment._id.toString(),
  );
  appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.CONFIRMED);

  appointment.status = AppointmentStatus.CONFIRMED;
  appointment.confirmedBy = salesStaffId as unknown as Types.ObjectId;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_CONFIRMED,
    actorId: salesStaffId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { action: 'sales_assignment_accepted', salesStaffId },
    ipAddress: ip,
    userAgent: ua,
  });

  await createAndSendNotification(
    appointment.customerId,
    NotificationCategory.APPOINTMENT,
    'Appointment Confirmed',
    `Your appointment on ${appointment.date} at ${formatSlotTime(appointment.slotCode)} has been confirmed.`,
    `/appointments/${appointment._id}`,
  );
  await notifyRole(
    Role.APPOINTMENT_AGENT,
    NotificationCategory.APPOINTMENT,
    'Sales Staff Confirmed Appointment',
    `The assigned sales staff confirmed the appointment on ${appointment.date} at ${formatSlotTime(appointment.slotCode)}.`,
    `/appointments/${appointment._id}`,
  );

  await autoCreateVisitReport(
    appointment._id,
    appointment.customerId,
    appointment.salesStaffId!,
    'consultation',
    appointment.customerSiteDetails || undefined,
    appointment.serviceTypes,
    appointment.serviceTypes?.[0],
    appointment.serviceTypeCustom,
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

  // Customers can finish the custom brief before or shortly after staff confirmation.
  if (![AppointmentStatus.REQUESTED, AppointmentStatus.ASSIGNED, AppointmentStatus.CONFIRMED].includes(appointment.status)) {
    throw AppError.badRequest('Site details can only be submitted before the consultation begins');
  }

  if (
    appointment.consultationStartedAt
    || [
      AppointmentAttendanceStatus.IN_PROGRESS,
      AppointmentAttendanceStatus.COMPLETED,
    ].includes(appointment.attendanceStatus as AppointmentAttendanceStatus)
  ) {
    throw AppError.badRequest('Site details can only be submitted before the consultation begins');
  }

  // Must not already be submitted
  if (appointment.siteDetailsStatus === 'submitted') {
    throw AppError.badRequest('Site details have already been submitted for this appointment');
  }

  // Office appointment photos and reference images are recommended, not mandatory.

  appointment.customerSiteDetails = input;
  appointment.siteDetailsStatus = 'submitted';
  await appointment.save();

  if (appointment.status === AppointmentStatus.CONFIRMED && appointment.salesStaffId) {
    await autoCreateVisitReport(
      appointment._id,
      appointment.customerId,
      appointment.salesStaffId,
      'consultation',
      input,
      input.serviceTypes || appointment.serviceTypes,
      (input.serviceTypes || appointment.serviceTypes)?.[0],
      input.serviceTypeCustom || appointment.serviceTypeCustom,
    );
  }

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

  await assertNoActiveAppointment(input.customerId, [], { audience: 'staff' });
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
  // The ocular visit takes the sales staff's whole day, so they must be free that date.
  await assertSalesAvailable(actorId, input.date, input.slotCode, AppointmentType.OCULAR);
  const sourceConsultation = consultationContext.consultation;
  const sourceConsultationReport = consultationContext.consultationReport;
  const serviceTypes = [...new Set([
    ...(sourceConsultation.serviceTypes || []),
    ...(sourceConsultationReport.serviceType ? [sourceConsultationReport.serviceType] : []),
  ].filter(Boolean))];
  const selectedDesign = selectedDesignSnapshot(sourceConsultationReport, sourceConsultation);

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
    sourceConsultationAppointmentId: sourceConsultation._id,
    sourceConsultationReportId: sourceConsultationReport._id,
    serviceTypes,
    serviceTypeCustom: sourceConsultationReport.serviceTypeCustom || sourceConsultation.serviceTypeCustom,
    ...selectedDesign,
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
  // Reject sites outside mainland Luzon before any ocular appointment is created or changed.
  await assertOcularLocationAccepted(input.customerLocation);

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
    const selectedDesign = selectedDesignSnapshot(consultationReport, appointment);

    let ocularAppointment = await Appointment.findOne({
      customerId: appointment.customerId,
      type: AppointmentType.OCULAR,
      sourceConsultationAppointmentId: appointment._id,
      date: recommendedOcularDate,
      slotCode: consultationReport.recommendedOcularSlot,
      status: { $in: activeOcularStatuses },
    }).sort({ updatedAt: -1, createdAt: -1 });

    if (!ocularAppointment) {
      // An existing ocular visit keeps its own schedule: it may have been rescheduled since the
      // consultation, and moving it back here would skip the sales staff's schedule checks.
      ocularAppointment = await Appointment.findOne({
        customerId: appointment.customerId,
        type: AppointmentType.OCULAR,
        sourceConsultationAppointmentId: appointment._id,
        status: { $in: activeOcularStatuses },
      }).sort({ updatedAt: -1, createdAt: -1 });
    }

    if (!ocularAppointment) {
      const serviceTypes = [
        ...new Set([
          ...(appointment.serviceTypes || []),
          ...(consultationReport.serviceType ? [consultationReport.serviceType] : []),
        ]),
      ].filter(Boolean);
      const salesStaffId = consultationReport.salesStaffId || appointment.salesStaffId;
      if (salesStaffId) {
        // One appointment per sales staff per day: the recommended day must still be free.
        try {
          await assertSalesAvailable(
            salesStaffId.toString(),
            recommendedOcularDate,
            consultationReport.recommendedOcularSlot,
            AppointmentType.OCULAR,
          );
        } catch {
          throw AppError.badRequest(
            'The recommended ocular visit schedule is no longer available. Please wait for your sales staff to set a new schedule.',
            ErrorCode.VALIDATION_ERROR,
          );
        }
      }

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
        ...selectedDesign,
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
      syncSelectedDesign(ocularAppointment, selectedDesign);
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

  if (appointment.ocularFeeStatus === 'proof_submitted' || appointment.ocularFeePaid) throw AppError.conflict('Location cannot change while payment is being verified or already paid');

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
  appointment.travelDurationMinutes = ocularVisitData.travelDurationMinutes;
  appointment.ocularFee = ocularVisitData.ocularFee;
  appointment.ocularFeeBreakdown = ocularVisitData.ocularFeeBreakdown;
  if (input.addressStructured) appointment.addressStructured = input.addressStructured;

  // Determine fee status
  const isWithinNCR = ocularVisitData.ocularFeeBreakdown.isWithinNCR;
  if (!isWithinNCR && ocularVisitData.ocularFee > 0) {
    appointment.ocularFeeStatus = 'pending';
    appointment.paymentStatus = 'unpaid';
    appointment.bookingStatus = 'pending_payment';
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
    appointment.type,
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

  await completePaidOcularBooking(appointment);
  return appointment;
}

export async function completePaidOcularBooking(appointment: import('../../models/Appointment.js').IAppointment) {
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
    appointment.salesStaffId!,
    NotificationCategory.APPOINTMENT,
    'Ocular Visit Assigned',
    `You have been assigned an ocular visit on ${appointment.date} at ${formatSlotTime(appointment.slotCode)}.`,
    `/appointments/${appointment._id}`,
  );

  const sourceConsultationAppointmentId = appointment.sourceConsultationAppointmentId;

  // Find the project from the exact source consultation, not any latest customer project.
  const consultationProject = await Project.findOne({
      ...(sourceConsultationAppointmentId
        ? { appointmentId: sourceConsultationAppointmentId }
        : { ocularAppointmentId: appointment._id }),
      customerId: appointment.customerId,
      status: { $in: [ProjectStatus.DRAFT, ProjectStatus.SUBMITTED] },
    }).sort({ createdAt: -1 });

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
    appointment.salesStaffId!,
    'ocular',
    consultationSiteDetails,
    consultationSiteDetails?.serviceTypes || appointment.serviceTypes,
    consultationSiteDetails?.serviceTypes?.[0] || appointment.serviceTypes?.[0] || consultationProject?.serviceType,
    appointment.serviceTypeCustom || consultationSiteDetails?.serviceTypeCustom,
    consultationProject?._id,
  );

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
  if (appointment.salesStaffId?.toString() !== actorId) {
    throw AppError.forbidden('Only the currently assigned sales staff can complete this appointment');
  }
  assertAppointmentDayReached(appointment.date, 'complete this appointment');

  appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.COMPLETED);
  const statusBeforeComplete = appointment.status;

  // Completing a consultation does not select the project's ocular workflow.
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
    details: { fromStatus: statusBeforeComplete, toStatus: AppointmentStatus.COMPLETED, type: appointment.type },
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

  await notifyBookingAgentAppointmentSuccessful(appointment);

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
  if (appointment.salesStaffId?.toString() !== actorId) {
    throw AppError.forbidden('Only the currently assigned sales staff can update this appointment');
  }
  assertAppointmentDayReached(appointment.date, 'start this visit');

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
  const statusBeforeStep = appointment.status;

  // Arriving at the site starts the visit; there is no separate "Start Site Visit" step.
  appointment.status = newStatus === AppointmentStatus.ARRIVED_AT_SITE ? AppointmentStatus.IN_PROGRESS : newStatus;
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
      statusLabel: 'at your site and has started the visit',
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
    details: { fromStatus: statusBeforeStep, toStatus: appointment.status, step: newStatus },
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

// ── Customer: acknowledge the ocular fee is non-refundable (required before paying online) ──

export async function recordOcularFeeNonRefundableAck(appointmentId: string, customerId: string) {
  // Only the first acknowledgment is kept; a missing/foreign booking is rejected later by the payment itself.
  await Appointment.updateOne(
    { _id: appointmentId, customerId, ocularFeeNonRefundableAckAt: { $exists: false } },
    { $set: { ocularFeeNonRefundableAckAt: new Date() } },
  );
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
  if (appointment.salesStaffId?.toString() !== actorId) {
    throw AppError.forbidden('Only the currently assigned sales staff can update this appointment');
  }

  const statusBeforeNoShow = appointment.status;
  if (appointment.type === AppointmentType.OFFICE) {
    // Office consultations close as completed; attendanceStatus keeps the no-show outcome.
    appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.COMPLETED);
    appointment.status = AppointmentStatus.COMPLETED;
    appointment.attendanceStatus = AppointmentAttendanceStatus.NO_SHOW;
    appointment.attendanceUpdatedAt = new Date();
    appointment.attendanceUpdatedBy = actorId as unknown as Types.ObjectId;
    appointment.consultationCompletedAt = new Date();
  } else {
    appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.NO_SHOW);
    appointment.status = AppointmentStatus.NO_SHOW;
  }
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
    details: { fromStatus: statusBeforeNoShow, toStatus: appointment.status, type: appointment.type, notes: internalNotes || undefined },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    appointment.customerId,
    NotificationCategory.APPOINTMENT,
    'Appointment Marked as No-Show',
    `Your appointment ${appointment.appointmentNumber ? `${appointment.appointmentNumber} ` : ''}on ${formatNotificationDate(appointment.date, appointment.slotCode)} was marked as a no-show.`,
    `/appointments/${appointment._id}`,
  );
  // ...and the agent who booked it, so the schedule can be followed up.
  await notifyBookingAgents(
    appointment,
    NotificationCategory.APPOINTMENT,
    'Appointment No-Show',
    `${await describeAppointmentForNotification(appointment)} was marked as a no-show by the sales staff.`,
    `/appointments/${appointment._id}`,
    actorId,
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
  assertAppointmentDayReached(appointment.date, 'update consultation attendance');

  await synchronizeConsultationAttendanceByTime(appointment);
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
  } else if (input.action === 'no_show') {
    if (!input.notes?.trim()) {
      throw AppError.badRequest('No-show attendance requires notes', ErrorCode.VALIDATION_ERROR);
    }
    nextStatus = AppointmentAttendanceStatus.NO_SHOW;
    // The appointment closes as completed; attendanceStatus keeps the no-show outcome.
    appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.COMPLETED);
    appointment.status = AppointmentStatus.COMPLETED;
    appointment.internalNotes = input.notes.trim();
    appointment.consultationCompletedAt = now;
    changes.appointmentStatus = AppointmentStatus.COMPLETED;
  } else if (input.action === 'customer_declined') {
    if (!input.notes?.trim()) {
      throw AppError.badRequest('Customer declined attendance requires notes', ErrorCode.VALIDATION_ERROR);
    }
    nextStatus = AppointmentAttendanceStatus.CUSTOMER_DECLINED;
    // The consultation took place, so it stays on record as completed; the
    // customer_declined attendance status stops the report/project workflow.
    appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.COMPLETED);
    appointment.status = AppointmentStatus.COMPLETED;
    appointment.internalNotes = input.notes.trim();
    appointment.consultationCompletedAt = now;
    changes.appointmentStatus = AppointmentStatus.COMPLETED;
    changes.declineReason = input.notes.trim();
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

  if (input.action === 'check_in') {
    await issueQueueNumber(appointment, appointment.actualArrivalAt || now);
    changes.queueNumber = appointment.queueNumber;
  }

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

  if (input.action === 'check_in' && appointment.queueNumber) {
    await createAndSendNotification(
      appointment.customerId,
      NotificationCategory.APPOINTMENT,
      `Queue Number ${appointment.queueNumber}`,
      `You are checked in for today's consultation. Your queue number is ${appointment.queueNumber}.`,
      `/appointments/${appointment._id}`,
    );
  }

  // Outcomes that close the consultation reach everyone affected, never the person who recorded them.
  if (input.action === 'no_show' || input.action === 'customer_declined') {
    const reference = await describeAppointmentForNotification(appointment);
    const link = `/appointments/${appointment._id}`;
    if (input.action === 'no_show') {
      await notifyUsers(
        [appointment.customerId],
        NotificationCategory.APPOINTMENT,
        'Consultation Marked as No-Show',
        `Your consultation ${appointment.appointmentNumber ? `${appointment.appointmentNumber} ` : ''}on ${formatNotificationDate(appointment.date, appointment.slotCode)} was marked as a no-show. Book a new consultation when you are ready.`,
        link,
        { excludeUserId: actorId },
      );
    }
    await notifyBookingAgents(
      appointment,
      NotificationCategory.APPOINTMENT,
      input.action === 'no_show' ? 'Consultation No-Show' : 'Customer Declined Consultation',
      input.action === 'no_show'
        ? `${reference} was marked as a no-show by the sales staff.`
        : `The customer declined to proceed: ${reference}.${input.notes ? ` Notes: ${input.notes}` : ''}`,
      link,
      actorId,
    );
    if (appointment.salesStaffId && appointment.salesStaffId.toString() !== actorId) {
      await createAndSendNotification(
        appointment.salesStaffId,
        NotificationCategory.APPOINTMENT,
        input.action === 'no_show' ? 'Consultation No-Show' : 'Customer Declined Consultation',
        `${reference} was closed as ${input.action === 'no_show' ? 'a no-show' : 'customer declined'}.`,
        link,
      );
    }
  }

  return appointment;
}

export async function getCustomerQueueStatus(customerId: string) {
  const today = format(toZonedTime(new Date(), TZ), 'yyyy-MM-dd');
  const waitingStatuses = [
    AppointmentAttendanceStatus.ON_TIME,
    AppointmentAttendanceStatus.LATE_ARRIVAL,
  ];
  const activeStatuses = [...waitingStatuses, AppointmentAttendanceStatus.IN_PROGRESS];

  const appointment = await Appointment.findOne({
    customerId,
    type: AppointmentType.OFFICE,
    queueDate: today,
    queueNumber: { $exists: true },
    attendanceStatus: { $in: activeStatuses },
  }).sort({ queueSequence: 1 });

  if (!appointment?.queueNumber || !appointment.queueSequence) return null;

  const isServing = appointment.attendanceStatus === AppointmentAttendanceStatus.IN_PROGRESS;
  const [aheadCount, nowServing] = await Promise.all([
    isServing
      ? Promise.resolve(0)
      : Appointment.countDocuments({
        type: AppointmentType.OFFICE,
        queueDate: today,
        queueSequence: { $lt: appointment.queueSequence },
        attendanceStatus: { $in: activeStatuses },
      }),
    Appointment.findOne({
      type: AppointmentType.OFFICE,
      queueDate: today,
      attendanceStatus: AppointmentAttendanceStatus.IN_PROGRESS,
      queueNumber: { $exists: true },
    }).sort({ queueSequence: 1 }).select('queueNumber'),
  ]);

  return {
    appointmentId: appointment._id.toString(),
    queueNumber: appointment.queueNumber,
    queueDate: appointment.queueDate,
    status: isServing ? 'serving' : 'waiting',
    position: isServing ? 0 : aheadCount + 1,
    aheadCount,
    nowServing: nowServing?.queueNumber || null,
    estimatedWaitMinutes: isServing ? 0 : aheadCount * ESTIMATED_CONSULTATION_MINUTES,
    issuedAt: appointment.queueIssuedAt,
    updatedAt: appointment.attendanceUpdatedAt || appointment.updatedAt,
  };
}

// ── Customer: Request Reschedule ──

export async function requestReschedule(
  appointmentId: string,
  input: RescheduleRequestInput,
  actorId: string,
  actorRoles: Role[],
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  // Only the appointment agent (and admin) can reschedule — this keeps a reschedule
  // to one owner instead of customers and sales staff moving dates independently.
  const isAgentOrAdmin = actorRoles.some((role) => role === Role.APPOINTMENT_AGENT || role === Role.ADMIN);
  if (!isAgentOrAdmin) {
    throw AppError.forbidden('Only an appointment agent or admin can reschedule this appointment');
  }

  if (!RESCHEDULABLE_STATUSES.includes(appointment.status)) {
    throw AppError.badRequest('This appointment can no longer be rescheduled');
  }

  if (appointment.rescheduleCount >= appointment.maxReschedules) {
    throw AppError.badRequest(
      `Maximum reschedule limit (${appointment.maxReschedules}) reached`,
      ErrorCode.BOOKING_LIMIT_REACHED,
    );
  }

  const oldDate = appointment.date;
  const oldSlot = appointment.slotCode;

  assertOcularAfterConsultation(input.newDate, await getSourceConsultationDate(appointment));
  await assertDateAvailable(input.newDate);
  await assertSlotAvailable(input.newDate, input.newSlotCode, appointment.type, appointment._id.toString());

  // Reschedules the same assigned sales staff into the new slot — rescheduling is a
  // date/time change only, it doesn't need a fresh sales assignment or agent review.
  if (appointment.salesStaffId) {
    const salesStaffId = appointment.salesStaffId.toString();
    await assertSalesAvailable(
      salesStaffId,
      input.newDate,
      input.newSlotCode as SlotCode,
      appointment.type,
      appointment._id.toString(),
    );
    if (appointment.type === AppointmentType.OCULAR) {
      await releaseSlotLock(oldDate, oldSlot as SlotCode, salesStaffId);
      await lockSlot(input.newDate, input.newSlotCode as SlotCode, salesStaffId, actorId);
      await confirmSlotLock(input.newDate, input.newSlotCode as SlotCode, salesStaffId, appointment._id);
    }
  }

  appointment.date = input.newDate;
  appointment.slotCode = input.newSlotCode as SlotCode;
  appointment.rescheduleCount += 1;
  appointment.rescheduleReason = input.reason;
  appointment.previousStatusBeforeReschedule = undefined;
  appointment.requestedRescheduleDate = undefined;
  appointment.requestedRescheduleSlotCode = undefined;
  if (appointment.type === AppointmentType.OFFICE) {
    appointment.attendanceStatus = AppointmentAttendanceStatus.SCHEDULED;
    appointment.actualArrivalAt = undefined;
    appointment.consultationStartedAt = undefined;
    appointment.consultationCompletedAt = undefined;
    appointment.attendanceNotes = undefined;
    appointment.attendanceOverrideReason = undefined;
  }
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_RESCHEDULED,
    actorId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: {
      oldDate,
      oldSlot,
      newDate: input.newDate,
      newSlot: input.newSlotCode,
      rescheduleCount: appointment.rescheduleCount,
      reason: input.reason,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  const newSlotLabel = `${input.newDate} at ${formatSlotTime(input.newSlotCode)}`;
  await createAndSendNotification(
    appointment.customerId,
    NotificationCategory.APPOINTMENT,
    'Appointment Rescheduled',
    `Your appointment has been rescheduled to ${newSlotLabel}. Reason: ${input.reason}`,
    `/appointments/${appointment._id}`,
  );
  if (appointment.salesStaffId) {
    await createAndSendNotification(
      appointment.salesStaffId.toString(),
      NotificationCategory.APPOINTMENT,
      'Appointment Rescheduled',
      `The appointment team rescheduled the appointment to ${newSlotLabel}. Reason: ${input.reason}`,
      `/appointments/${appointment._id}`,
    );
  }

  return appointment;
}

export async function rejectReschedule(
  appointmentId: string,
  agentId: string,
  ip?: string,
  ua?: string,
  reason?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.status !== AppointmentStatus.RESCHEDULE_REQUESTED) {
    throw AppError.badRequest('Appointment is not pending reschedule');
  }

  const previousStatus = appointment.previousStatusBeforeReschedule || AppointmentStatus.CONFIRMED;
  appointmentStateMachine.assertTransition(appointment.status, previousStatus);
  const requestedDate = appointment.requestedRescheduleDate || appointment.date;
  const requestedSlotCode = appointment.requestedRescheduleSlotCode || appointment.slotCode;

  appointment.status = previousStatus;
  appointment.rescheduleReason = undefined;
  appointment.previousStatusBeforeReschedule = undefined;
  appointment.requestedRescheduleDate = undefined;
  appointment.requestedRescheduleSlotCode = undefined;
  await appointment.save();

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_UPDATED,
    actorId: agentId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: {
      action: 'reschedule_rejected',
      requestedDate,
      requestedSlotCode,
      reason: reason || null,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  await createAndSendNotification(
    appointment.customerId,
    NotificationCategory.APPOINTMENT,
    'Reschedule Request Declined',
    `Your reschedule request for ${requestedDate} at ${formatSlotTime(requestedSlotCode)} was declined. Your appointment remains on ${appointment.date} at ${formatSlotTime(appointment.slotCode)}.${reason ? ` Reason: ${reason}` : ''}`,
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

  assertOcularAfterConsultation(input.date, await getSourceConsultationDate(appointment));
  await assertDateAvailable(input.date);
  await assertSlotAvailable(input.date, input.slotCode, appointment.type, appointment._id.toString());

  // Reschedule acceptance updates the customer schedule first. The appointment
  // agent then assigns an available sales staff member for review.
  if (appointment.type === AppointmentType.OCULAR) {
    // Release the previous staff member's old slot. The newly selected staff
    // member will receive a lock when the agent assigns them after acceptance.
    if (appointment.salesStaffId) {
      await releaseSlotLock(appointment.date, appointment.slotCode as SlotCode, appointment.salesStaffId.toString());
    }
  }

  const oldDate = appointment.date;
  const oldSlot = appointment.slotCode;

  appointment.date = input.date;
  appointment.slotCode = input.slotCode as SlotCode;
  appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.REQUESTED);
  appointment.status = AppointmentStatus.REQUESTED;
  appointment.attendanceStatus = AppointmentAttendanceStatus.SCHEDULED;
  appointment.actualArrivalAt = undefined;
  appointment.consultationStartedAt = undefined;
  appointment.consultationCompletedAt = undefined;
  appointment.attendanceNotes = undefined;
  appointment.attendanceOverrideReason = undefined;
  appointment.rescheduleReason = undefined;
  appointment.previousStatusBeforeReschedule = undefined;
  appointment.requestedRescheduleDate = undefined;
  appointment.requestedRescheduleSlotCode = undefined;
  appointment.rescheduleCount += 1;
  appointment.salesStaffId = undefined;
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
      salesAssignmentPending: true,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    appointment.customerId,
    NotificationCategory.APPOINTMENT,
    'Reschedule Accepted',
    `Your appointment has been rescheduled to ${input.date} at ${formatSlotTime(input.slotCode)}. We are assigning an available sales staff member for review.`,
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
  if (appointment.ocularFeeStatus === 'proof_submitted') throw AppError.conflict('A payment is awaiting verification');

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
  if (appointment.ocularFeeStatus === 'proof_submitted') throw AppError.conflict('A payment is awaiting verification');
  if (appointment.ocularFeePaymentMethod === PaymentMethod.GCASH) throw AppError.badRequest('GCash payments must be reviewed in the cashier payment verification queue');

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
  if (process.env.NODE_ENV !== 'development') throw AppError.forbidden('Payment simulation is only available in development');
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');
  if (appointment.ocularFeePaymentMethod === PaymentMethod.GCASH) throw AppError.badRequest('GCash payments must be reviewed in the cashier payment verification queue');
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
    .populate('customerId', 'customerNumber firstName lastName email');
  if (!appointment) throw AppError.notFound('Appointment not found');
  if (appointment.ocularFeePaymentMethod === PaymentMethod.GCASH) throw AppError.badRequest('GCash payments must be reviewed in the cashier payment verification queue');
  if (appointment.customerId._id?.toString() !== customerId && appointment.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only verify your own appointments');
  }

  // Already verified, or already waiting for the cashier
  if (appointment.ocularFeePaid && appointment.ocularFeeStatus === 'verified') {
    return { verified: true, awaitingVerification: false, appointment };
  }
  if (appointment.ocularFeeStatus === 'proof_submitted' && appointment.ocularFeePaymentMethod === PaymentMethod.QRPH) {
    return { verified: false, awaitingVerification: true, appointment };
  }

  // No checkout session to check
  if (!appointment.paymongoCheckoutSessionId) {
    return { verified: false, awaitingVerification: false, appointment };
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
      await markOcularFeePaidViaPaymongo(appointment);
      return { verified: false, awaitingVerification: true, appointment };
    }

    return { verified: false, awaitingVerification: false, appointment };
  } catch (err) {
    console.error('[Verify Ocular Fee] Polling failed:', err);
    return { verified: false, awaitingVerification: false, appointment };
  }
}

// A QR Ph payment confirmed by PayMongo still goes to the cashier, who verifies it in the
// Ocular Fees queue (same rule as project stage payments). Safe to call more than once.
async function markOcularFeePaidViaPaymongo(appointment: import('../../models/Appointment.js').IAppointment) {
  if (appointment.ocularFeePaid || appointment.ocularFeeStatus === 'proof_submitted') return;

  appointment.ocularFeeStatus = 'proof_submitted';
  appointment.ocularFeePaymentMethod = PaymentMethod.QRPH;
  appointment.ocularFeeDeclineReason = undefined;
  await appointment.save();

  const customerId = (appointment.customerId as unknown as { _id?: Types.ObjectId })._id ?? appointment.customerId;
  const amount = formatCurrency(appointment.ocularFee ?? appointment.ocularFeeBreakdown?.total ?? 0);
  await AuditLog.create({
    action: AuditAction.PAYMENT_PROOF_SUBMITTED,
    actorId: customerId,
    targetType: 'appointment',
    targetId: appointment._id,
    details: { ocularFee: appointment.ocularFee, method: PaymentMethod.QRPH, via: 'paymongo' },
  });

  await createAndSendNotification(
    customerId.toString(),
    NotificationCategory.PAYMENT,
    'Ocular Fee Payment Received',
    `We received your QR Ph payment of ${amount}. The cashier will verify it shortly.`,
    `/appointments/${appointment._id}/pay-ocular-fee`,
  );
  await notifyRole(
    Role.CASHIER,
    NotificationCategory.PAYMENT,
    'Ocular Fee Paid via QR Ph',
    `${appointment.appointmentNumber || 'A booking'} paid ${amount} through PayMongo QR Ph. Verify it in Ocular Fees.`,
    '/payments?tab=ocular-fees',
  );
  emitRoleEvent(Role.CASHIER, 'payments:queue-updated', { type: 'ocular_fee_qrph_paid', appointmentId: appointment._id.toString() });
}

// ── Handle PayMongo Webhook: Payment Paid ──

export async function handlePaymongoPayment(checkoutSessionId: string) {
  const appointment = await Appointment.findOne({
    paymongoCheckoutSessionId: checkoutSessionId,
  }).populate('customerId', 'customerNumber firstName lastName email');

  if (!appointment) {
    // Not an appointment payment — ignore
    return null;
  }

  if (appointment.ocularFeePaymentMethod === PaymentMethod.GCASH) return appointment;
  await markOcularFeePaidViaPaymongo(appointment);

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
  if (appointment.ocularFeePaymentMethod === PaymentMethod.GCASH) throw AppError.badRequest('GCash payments must be reviewed in the cashier payment verification queue');

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
    .populate('customerId', 'customerNumber firstName lastName email');
  if (!appointment) throw AppError.notFound('Appointment not found');
  if (appointment.ocularFeePaymentMethod === PaymentMethod.GCASH) throw AppError.badRequest('GCash payments must be reviewed in the cashier payment verification queue');

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
  if (appointment.ocularFeePaymentMethod === PaymentMethod.GCASH) throw AppError.badRequest('GCash payments must be reviewed in the cashier payment verification queue');

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
    ocularFeePaymentMethod: { $ne: PaymentMethod.GCASH },
    type: AppointmentType.OCULAR,
    ocularFee: { $gt: 0 },
    ocularFeeStatus: { $in: ['proof_submitted', 'pending', 'declined', 'cash_pending'] },
    status: { $ne: AppointmentStatus.CANCELLED },
  })
    .populate('customerId', 'customerNumber firstName lastName email phone')
    .sort({ date: 1, slotCode: 1 });

  return appointments;
}

// ── Record Ocular Fee Payment (kept for agent/staff backward compat) ──

export async function recordOcularFee(
  appointmentId: string,
  input: RecordOcularFeeInput,
  actorId: string,
  actorRoles: Role[],
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');
  if (appointment.ocularFeePaymentMethod === PaymentMethod.GCASH) throw AppError.badRequest('GCash payments must be reviewed in the cashier payment verification queue');

  if (input.paymentMethod === PaymentMethod.GCASH) throw AppError.badRequest('GCash payments require customer submission and cashier verification');
  if (appointment.paymentStatus && !actorRoles.includes(Role.CASHIER)) throw AppError.forbidden('Only a cashier can record this cash payment');
  if (appointment.paymentStatus && input.paymentMethod === PaymentMethod.CASH) {
    const { recordBookingCash } = await import('../payments/gcash.service.js');
    await recordBookingCash(appointmentId, actorId, actorRoles);
    return Appointment.findById(appointmentId);
  }
  const isAgent = actorRoles.some((role) => [Role.ADMIN, Role.APPOINTMENT_AGENT, Role.CASHIER].includes(role));
  if (!isAgent && appointment.salesStaffId?.toString() !== actorId) {
    throw AppError.forbidden('Only the currently assigned sales staff can update this appointment');
  }

  if (appointment.type !== AppointmentType.OCULAR) {
    throw AppError.badRequest('Ocular fee only applies to ocular appointments');
  }

  if (appointment.ocularFeePaid) {
    throw AppError.badRequest('Ocular fee has already been recorded');
  }

  appointment.ocularFeePaymentMethod = input.paymentMethod;
  appointment.ocularFeePaid = true;
  appointment.ocularFeeStatus = 'verified';
  if (appointment.paymentStatus) appointment.paymentStatus = 'paid';
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

  // The customer gets confirmation of the payment, the cashiers keep their records, and the
  // sales staff knows the visit is cleared (each skipping whoever recorded it).
  const amount = formatCurrency(appointment.ocularFee || 0);
  const reference = await describeAppointmentForNotification(appointment);
  const link = `/appointments/${appointment._id}`;
  await notifyUsers(
    [appointment.customerId],
    NotificationCategory.PAYMENT,
    'Ocular Fee Payment Recorded',
    `Your ${amount} ocular fee payment (${input.paymentMethod}) for ${appointment.appointmentNumber || 'your ocular visit'} has been recorded.`,
    link,
    { excludeUserId: actorId },
  );
  await notifyRoleExcept(
    Role.CASHIER,
    NotificationCategory.PAYMENT,
    'Ocular Fee Recorded',
    `${amount} ocular fee (${input.paymentMethod}) was recorded for ${reference}.`,
    link,
    actorId,
  );
  await notifyUsers(
    [appointment.salesStaffId],
    NotificationCategory.PAYMENT,
    'Ocular Fee Paid',
    `The ${amount} ocular fee for ${reference} is paid.`,
    link,
    { excludeUserId: actorId },
  );

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

  const previousFee = appointment.ocularFee;
  appointment.ocularFee = fee;
  appointment.ocularFeeBreakdown = breakdown;
  await appointment.save();

  // Tell the customer when their ocular fee is set or changes.
  if (previousFee !== fee) {
    await createAndSendNotification(
      appointment.customerId,
      NotificationCategory.PAYMENT,
      fee > 0 ? 'Ocular Fee Updated' : 'No Ocular Fee',
      fee > 0
        ? `The ocular fee for ${appointment.appointmentNumber || 'your ocular visit'} is ${formatCurrency(fee)} (${breakdown.label}).`
        : `No ocular fee is required for ${appointment.appointmentNumber || 'your ocular visit'}.`,
      `/appointments/${appointment._id}`,
    );
  }

  return appointment;
}

// ── Get Appointment by ID ──

export async function getAppointmentById(appointmentId: string, actorId: string, actorRoles: Role[]) {
  const appointment = await Appointment.findById(appointmentId)
    .populate('customerId', 'customerNumber firstName lastName email phone')
    .populate('salesStaffId', 'firstName lastName email phone')
    .populate('bookedBy', 'firstName lastName')
    .populate('confirmedBy', 'firstName lastName');

  if (!appointment) throw AppError.notFound('Appointment not found');

  const isPrivilegedStaff = actorRoles.some((role) => [Role.ADMIN, Role.APPOINTMENT_AGENT].includes(role));
  if (
    actorRoles.includes(Role.SALES_STAFF)
    && !isPrivilegedStaff
    && appointment.salesStaffId?._id?.toString() !== actorId
  ) {
    // The project's own sales staff can still view an ocular visit another staff member takes.
    const ownsOcularProject = appointment.type === AppointmentType.OCULAR
      && await Project.exists({
        ocularAppointmentId: appointment._id,
        salesStaffId: actorId,
        status: { $ne: ProjectStatus.CANCELLED },
      });
    if (!ownsOcularProject) throw AppError.forbidden('This appointment is no longer assigned to you');
  }

  // Customers can only view their own
  if (
    actorRoles.includes(Role.CUSTOMER) &&
    !actorRoles.some(r => [Role.ADMIN, Role.APPOINTMENT_AGENT, Role.SALES_STAFF].includes(r))
  ) {
    if (appointment.customerId._id?.toString() !== actorId) {
      throw AppError.forbidden('Access denied');
    }
  }

  await synchronizeConsultationAttendanceByTime(appointment);

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
  // An ocular scheduled from a project belongs to that project; the page links back to it.
  if (appointment.type === AppointmentType.OCULAR) {
    const linkedProject = await Project.findOne({
      ocularAppointmentId: appointment._id,
      status: { $ne: ProjectStatus.CANCELLED },
    })
      .select('_id projectNumber title')
      .lean();
    if (linkedProject) {
      appointmentObject.linkedProject = {
        _id: String(linkedProject._id),
        projectNumber: linkedProject.projectNumber,
        title: linkedProject.title,
      };
    }
  }

  return appointmentObject;
}

/**
 * Every recorded step of one appointment and its visit reports (who did what, and when).
 * Staff only; a sales staff member sees only appointments assigned to them.
 */
export async function getAppointmentHistory(appointmentId: string, actorId: string, actorRoles: Role[]) {
  const appointment = await Appointment.findById(appointmentId).select('salesStaffId').lean();
  if (!appointment) throw AppError.notFound('Appointment not found');
  const isPrivilegedStaff = actorRoles.some((role) => [Role.ADMIN, Role.APPOINTMENT_AGENT, Role.CASHIER].includes(role));
  if (!isPrivilegedStaff && appointment.salesStaffId?.toString() !== actorId) {
    throw AppError.forbidden('This appointment is no longer assigned to you');
  }

  const reports = await VisitReport.find({ appointmentId: appointment._id }).select('_id').lean();
  return getActivityHistory([
    { targetType: 'appointment', ids: [appointment._id] },
    { targetType: 'visit_report', ids: reports.map((report) => report._id) },
  ]);
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

  if (query.excludeProjectOculars === 'true') {
    const projectOcularIds = await getProjectOcularAppointmentIds(salesOnlyActorId(actorId, actorRoles));
    if (projectOcularIds.length) andFilters.push({ _id: { $nin: projectOcularIds } });
  }

  // If status/search is provided, don't restrict by the "Queue" window.
  // If not, we keep the default queue filter for a clean view.
  const statusGroupFilter = buildAppointmentStatusGroupFilter(query.statusGroup);
  if (query.status === undefined && !statusGroupFilter && !normalizedSearch) {
    andFilters.push({
      $or: [
        { status: { $in: APPOINTMENT_QUEUE_ACTIONABLE_STATUSES } },
        {
          // No upper bound: an ocular finished before its scheduled date is still recent activity.
          status: { $in: APPOINTMENT_QUEUE_RECENT_STATUSES },
          date: { $gte: recentStartStr },
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
  // The Completed tab is history: list everything newest first instead of pinning
  // finished consultations to the top as actionable items.
  const isHistoricalView = isHistoricalStatusFilter || query.statusGroup === 'completed';

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
  if (statusGroupFilter) andFilters.push(statusGroupFilter);

  const queueFilter = andFilters.length === 1 ? andFilters[0] : { $and: andFilters };
  const fetchLimit = normalizedSearch ? 1000 : Math.min(Math.max(limit * 3, 180), 600);

  const appointments = await Appointment.find(queueFilter)
    .populate('customerId', 'customerNumber firstName lastName email phone')
    .populate('salesStaffId', 'firstName lastName availabilityStatus availabilityNote')
    // History is fetched newest first so the fetch limit drops the oldest records, not the newest.
    .sort(isHistoricalView
      ? { date: -1, slotCode: -1, createdAt: -1 }
      : { date: 1, slotCode: 1, createdAt: 1 })
    .limit(fetchLimit);

  const appointmentIds = appointments.map((appointment) => appointment._id);
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
    appointmentIds.length
      ? Project.find({
        // An ocular scheduled from a project links back through ocularAppointmentId.
        $or: [
          { appointmentId: { $in: appointmentIds } },
          { ocularAppointmentId: { $in: appointmentIds } },
        ],
        status: { $ne: ProjectStatus.CANCELLED },
      })
        .select('_id appointmentId ocularAppointmentId customerId projectNumber title serviceType status createdAt')
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

  const projectByAppointmentId = new Map<string, any>();
  for (const project of customerProjects as any[]) {
    for (const linkedId of [project.appointmentId, project.ocularAppointmentId]) {
      const appointmentId = linkedId ? String(linkedId) : undefined;
      if (appointmentId && !projectByAppointmentId.has(appointmentId)) {
        projectByAppointmentId.set(appointmentId, project);
      }
    }
  }

  let queueItems: AppointmentQueueItem[] = appointments.map((appointment: any) => {
    const appointmentId = String(appointment._id);
    const customerId = String(appointment.customerId?._id ?? appointment.customerId ?? '');
    const linkedProject = projectByAppointmentId.get(appointmentId);
    const customerSampleProjects = linkedProject ? [linkedProject] : [];

    const reportId = reportByAppointmentId.get(appointmentId);
    const hasPendingReport = linkedReports.some((r: any) => 
      String(r.appointmentId) === appointmentId && 
      [VisitReportStatus.DRAFT, VisitReportStatus.RETURNED].includes(r.status)
    );
    const currentReport = linkedReports.find((r: any) => String(r.appointmentId) === appointmentId);

    const isReadyForOcular = !isHistoricalView && isReadyForOcularQueueItem(appointment);
    const isActionable = !isHistoricalView
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
        appointment.status === AppointmentStatus.COMPLETED
        && !linkedProject
        && customerId
        && actorRoles.some((role) => [Role.SALES_STAFF, Role.ADMIN].includes(role))
          ? `/projects/create?customerId=${customerId}&appointmentId=${appointmentId}`
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
      const linkedProjects = [
        ...(projectByAppointmentId.get(String(appointment._id)) ? [projectByAppointmentId.get(String(appointment._id))] : []),
      ];

      return matchesAppointmentSearch(
        {
          type: appointment.type,
          appointmentNumber: appointment.appointmentNumber,
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
          customerNumber: appointment.customerId?.customerNumber,
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

  const prioritizeLatestActivity = query.status === undefined && !statusGroupFilter && !normalizedSearch;

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

export function defaultAppointmentSort(status?: string, statusGroup?: string) {
  const statuses = status
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean) || [];

  // History is listed newest first, so a capped page drops the oldest records, not the newest.
  const isHistoricalOnly = statusGroup === 'completed' || (
    statuses.length > 0
    && statuses.every((value) => APPOINTMENT_HISTORY_STATUSES.has(value))
  );

  return isHistoricalOnly
    ? { date: -1 as SortOrder, slotCode: -1 as SortOrder, createdAt: -1 as SortOrder }
    : { date: 1 as SortOrder, slotCode: 1 as SortOrder, createdAt: 1 as SortOrder };
}

export async function listAppointments(query: {
  status?: string;
  /** One of the four statuses the UI shows (requested, assigned, confirmed, completed). */
  statusGroup?: string;
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
  withoutProject?: string;
  /** 'true' leaves out ocular visits a project scheduled (they are shown under Projects). */
  excludeProjectOculars?: string;
  /** 'true' also lists unpaid ocular visits to admins and agents (the Ocular tab: they still hold a staff slot). */
  includeFeePending?: string;
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
    && query.includeFeePending !== 'true'
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
    // No-show consultations now close as completed with attendanceStatus no_show.
    const includesNoShow = statuses.includes(AppointmentStatus.NO_SHOW);
    const directStatuses = statuses.filter(
      (status) => status !== AppointmentStatus.READY_FOR_OCULAR && status !== AppointmentStatus.NO_SHOW,
    );

    if (includesReadyForOcular || includesNoShow) {
      const statusFilters: Record<string, unknown>[] = [];
      if (includesReadyForOcular) {
        statusFilters.push({ status: AppointmentStatus.READY_FOR_OCULAR }, DERIVED_READY_FOR_OCULAR_FILTER);
      }
      if (includesNoShow) {
        statusFilters.push(
          { status: AppointmentStatus.NO_SHOW },
          { attendanceStatus: AppointmentAttendanceStatus.NO_SHOW },
        );
      }

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
  const statusGroupFilter = buildAppointmentStatusGroupFilter(query.statusGroup);
  if (statusGroupFilter) appendAndFilter(filter, statusGroupFilter);
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

  // Create Project only offers appointments that no project uses yet.
  if (query.withoutProject === 'true') {
    const projectFilter = {
      status: { $ne: ProjectStatus.CANCELLED },
      ...(filter.customerId ? { customerId: filter.customerId } : {}),
    };
    const [sourceIds, ocularIds] = await Promise.all([
      Project.distinct('appointmentId', projectFilter),
      Project.distinct('ocularAppointmentId', projectFilter),
    ]);
    appendAndFilter(filter, { _id: { $nin: [...sourceIds, ...ocularIds].filter(Boolean) } });
    // No-show and customer-declined consultations are recorded as completed but must not start a project.
    appendAndFilter(filter, { attendanceStatus: { $nin: CLOSED_WITHOUT_CONSULTATION_ATTENDANCE } });
  }

  if (query.excludeProjectOculars === 'true') {
    const projectOcularIds = await getProjectOcularAppointmentIds(salesOnlyActorId(actorId, actorRoles));
    if (projectOcularIds.length) appendAndFilter(filter, { _id: { $nin: projectOcularIds } });
  }

  const sortField = query.sortBy;
  const sortOrder: SortOrder = query.sortOrder === 'desc' ? -1 : 1;
  const sortSpec: Record<string, SortOrder> = sortField
    ? { [sortField]: sortOrder }
    : defaultAppointmentSort(query.status, query.statusGroup);

  if (!normalizedSearch) {
    const [appointments, total] = await Promise.all([
      Appointment.find(filter)
        .populate('customerId', 'customerNumber firstName lastName email phone')
        .populate('salesStaffId', 'firstName lastName')
        .sort(sortSpec)
        .skip((page - 1) * limit)
        .limit(limit),
      Appointment.countDocuments(filter),
    ]);

    return {
      items: query.type === AppointmentType.OCULAR ? await withOcularProjects(appointments) : appointments,
      total,
      hasMore: page * limit < total,
    };
  }

  const appointments = await Appointment.find(filter)
    .populate('customerId', 'customerNumber firstName lastName email phone')
    .populate('salesStaffId', 'firstName lastName')
    .sort(sortSpec);

  const appointmentIds = appointments.map((appointment) => appointment._id);
  const relatedProjects = appointmentIds.length
    ? await Project.find({
      status: { $ne: ProjectStatus.CANCELLED },
      $or: [
        { appointmentId: { $in: appointmentIds } },
        { ocularAppointmentId: { $in: appointmentIds } },
      ],
    })
      .select('_id appointmentId ocularAppointmentId customerId projectNumber title serviceType createdAt')
      .sort({ createdAt: -1 })
      .lean()
    : [];

  const projectsByAppointmentId = new Map<string, any[]>();
  for (const project of relatedProjects as any[]) {
    // A project is found by its consultation and by the ocular visit it scheduled.
    const linkedIds = new Set(
      [project.appointmentId, project.ocularAppointmentId].filter(Boolean).map(String),
    );
    for (const appointmentId of linkedIds) {
      const appointmentProjects = projectsByAppointmentId.get(appointmentId) || [];
      appointmentProjects.push(project);
      projectsByAppointmentId.set(appointmentId, appointmentProjects);
    }
  }

  const filteredAppointments = appointments.filter((appointment: any) => {
    const appointmentId = String(appointment._id);
    const linkedProjects = projectsByAppointmentId.get(appointmentId) || [];

    return matchesAppointmentSearch(
      {
        type: appointment.type,
        appointmentNumber: appointment.appointmentNumber,
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
        customerNumber: appointment.customerId?.customerNumber,
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
  const pageItems = filteredAppointments.slice((page - 1) * limit, page * limit);

  return {
    items: query.type === AppointmentType.OCULAR ? await withOcularProjects(pageItems) : pageItems,
    total,
    hasMore: page * limit < total,
  };
}

/** Adds the project that scheduled each ocular visit (Ocular tab), so the list can show its project number. */
async function withOcularProjects<T extends { _id: Types.ObjectId; toObject?: () => object }>(appointments: T[]) {
  if (!appointments.length) return [];
  const projects = await Project.find({
    status: { $ne: ProjectStatus.CANCELLED },
    ocularAppointmentId: { $in: appointments.map((appointment) => appointment._id) },
  })
    .select('_id projectNumber ocularAppointmentId')
    .lean();
  const projectByAppointmentId = new Map(projects.map((project) => [String(project.ocularAppointmentId), project]));

  return appointments.map((appointment) => {
    const project = projectByAppointmentId.get(String(appointment._id));
    return {
      ...(typeof appointment.toObject === 'function' ? appointment.toObject() : appointment),
      ocularProject: project ? { _id: String(project._id), projectNumber: project.projectNumber } : undefined,
    };
  });
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
