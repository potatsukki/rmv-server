import type { Types } from 'mongoose';
import {
  Appointment,
  AvailabilitySession,
  SalesAvailability,
  type IAvailabilitySession,
} from '../../models/index.js';
import {
  AppointmentStatus,
  AppointmentType,
  Role,
  type SlotCode,
  StaffAvailabilityStatus,
} from '../../utils/constants.js';

export const INTERNAL_AVAILABILITY_ROLES: Role[] = [
  Role.APPOINTMENT_AGENT,
  Role.SALES_STAFF,
  Role.ENGINEER,
  Role.CASHIER,
  Role.ADMIN,
  Role.FABRICATION_STAFF,
];

const INTERNAL_AVAILABILITY_ROLE_SET = new Set<Role>(INTERNAL_AVAILABILITY_ROLES);
// A sales staff member can't hold two appointments (office consultation or ocular visit) whose
// time slots overlap on the same date. Other slots that day stay open, and an appointment on
// another date never blocks. Cancelled, completed and no-show appointments free their slot.
export const SALES_SLOT_FREEING_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.CANCELLED,
  AppointmentStatus.COMPLETED,
  AppointmentStatus.NO_SHOW,
];

/** Every appointment slot (SLOT_CODES) is one hour long. */
export const APPOINTMENT_SLOT_MINUTES = 60;

function slotStartMinutes(slotCode: string | undefined | null): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(slotCode ?? '').trim());
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** True when two slots on the same date overlap in time ([start, start + 60 min)). */
export function slotsOverlap(a: string | undefined | null, b: string | undefined | null): boolean {
  const startA = slotStartMinutes(a);
  const startB = slotStartMinutes(b);
  if (startA === undefined || startB === undefined) return Boolean(a) && a === b;
  return startA < startB + APPOINTMENT_SLOT_MINUTES && startB < startA + APPOINTMENT_SLOT_MINUTES;
}

function formatSlotLabel(slotCode: string) {
  const start = slotStartMinutes(slotCode);
  if (start === undefined) return slotCode;
  const hour = Math.floor(start / 60);
  const minute = start % 60;
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}

// Appointments still waiting on their sales staff (any date). Used for the customer's
// "one active appointment" rule, not for the per-slot staff rule above.
export const SALES_ACTIVE_ASSIGNMENT_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.REQUESTED,
  AppointmentStatus.ASSIGNED,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.PREPARING,
  AppointmentStatus.ON_THE_WAY,
  AppointmentStatus.ARRIVED_AT_SITE,
  AppointmentStatus.IN_PROGRESS,
  AppointmentStatus.RESCHEDULE_REQUESTED,
];

/**
 * The staff member's other appointment on this date (YYYY-MM-DD) whose time overlaps this slot,
 * if any; cancelled, completed and no-show appointments don't count.
 */
export async function findActiveSalesAssignment(
  salesStaffId: string,
  excludeAppointmentId: string | undefined,
  dateStr: string,
  slotCode: string,
) {
  const filter: Record<string, unknown> = {
    salesStaffId,
    date: dateStr,
    status: { $nin: SALES_SLOT_FREEING_STATUSES },
  };
  if (excludeAppointmentId) filter._id = { $ne: excludeAppointmentId };
  const sameDay = await Appointment.find(filter).select('appointmentNumber date slotCode type status').lean();
  return sameDay.find((appointment) => slotsOverlap(appointment.slotCode, slotCode)) ?? null;
}

function formatAppointmentDay(dateStr: string) {
  const [year = 0, month = 1, day = 1] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}
const PH_TIMEZONE_OFFSET = '+08:00';

export interface AvailabilityShiftState {
  sessionId: string;
  shiftStartAt: Date;
  shiftEndAt?: Date;
  isCurrent: boolean;
  reminderSentAt?: Date;
}

export interface AvailabilityStateSummary {
  availabilityStatus?: StaffAvailabilityStatus;
  availabilityNote?: string;
  availabilityUpdatedAt?: Date;
  activeShift?: AvailabilityShiftState;
  expiredShift?: AvailabilityShiftState;
  availabilitySetupRequired: boolean;
}

export interface SalesAssignmentEligibility {
  assignmentEligible: boolean;
  assignmentBlockedReason?: string;
}

export function hasInternalAvailabilityRole(roles: Array<Role | string> = []): boolean {
  return roles.some((role) => INTERNAL_AVAILABILITY_ROLE_SET.has(role as Role));
}

export function getSlotDateTime(dateStr: string, slotCode: string): Date {
  // Ensure we only have the YYYY-MM-DD part and it's clean
  const pureDate = dateStr.trim().slice(0, 10);
  const pureSlot = slotCode.trim();
  
  // Construct a date string that forces the Philippines timezone
  const isoString = `${pureDate}T${pureSlot}:00${PH_TIMEZONE_OFFSET}`;
  const date = new Date(isoString);
  
  // If parsing failed, fall back to a safer method
  if (isNaN(date.getTime())) {
    console.error(`[Availability] Failed to parse date: "${isoString}" from dateStr="${dateStr}", slotCode="${slotCode}"`);
  }
  
  return date;
}

export function isAvailabilityShiftExpired(
  session: Pick<IAvailabilitySession, 'availabilityStatus' | 'shiftEndAt' | 'closedAt'> | null | undefined,
  now = new Date(),
): boolean {
  return Boolean(
    session
      && !session.closedAt
      && session.availabilityStatus === StaffAvailabilityStatus.AVAILABLE
      && session.shiftEndAt
      && session.shiftEndAt.getTime() < now.getTime(),
  );
}

export function doesShiftCoverDateTime(
  session: Pick<IAvailabilitySession, 'availabilityStatus' | 'shiftStartAt' | 'shiftEndAt' | 'closedAt'> | null | undefined,
  targetDateTime: Date,
): boolean {
  if (!session || session.closedAt || isNaN(targetDateTime.getTime())) {
    return false;
  }

  const shiftStart = session.shiftStartAt instanceof Date ? session.shiftStartAt : new Date(session.shiftStartAt as any);
  const shiftEnd = session.shiftEndAt instanceof Date ? session.shiftEndAt : new Date(session.shiftEndAt as any);

  // Employee time-in sessions intentionally have no shift end until time-out.
  // For this mode, being actively timed in means assignable.
  if (!session.shiftEndAt) {
    return (
      session.availabilityStatus === StaffAvailabilityStatus.AVAILABLE
      && !isNaN(shiftStart.getTime())
    );
  }

  if (isNaN(shiftStart.getTime()) || isNaN(shiftEnd.getTime())) {
    return false;
  }

  return (
    session.availabilityStatus === StaffAvailabilityStatus.AVAILABLE &&
    shiftStart.getTime() <= targetDateTime.getTime() &&
    shiftEnd.getTime() >= targetDateTime.getTime()
  );
}

function toShiftState(
  session: Pick<IAvailabilitySession, '_id' | 'shiftStartAt' | 'shiftEndAt' | 'reminderSentAt'>,
  now = new Date(),
): AvailabilityShiftState | undefined {
  if (!session.shiftStartAt) return undefined;
  return {
    sessionId: session._id.toString(),
    shiftStartAt: session.shiftStartAt,
    shiftEndAt: session.shiftEndAt,
    isCurrent:
      session.shiftStartAt.getTime() <= now.getTime()
      && (!session.shiftEndAt || session.shiftEndAt.getTime() >= now.getTime()),
    reminderSentAt: session.reminderSentAt,
  };
}

export function buildAvailabilityStateSummary(
  user: {
    roles?: Array<Role | string>;
    availabilityStatus?: StaffAvailabilityStatus;
    availabilityNote?: string;
    availabilityUpdatedAt?: Date;
  },
  session?: Pick<
    IAvailabilitySession,
    '_id' | 'availabilityStatus' | 'availabilityNote' | 'shiftStartAt' | 'shiftEndAt' | 'closedAt' | 'reminderSentAt'
  > | null,
  now = new Date(),
): AvailabilityStateSummary {
  const userOverrideStatus =
    user.availabilityStatus === StaffAvailabilityStatus.UNAVAILABLE
    || user.availabilityStatus === StaffAvailabilityStatus.ON_LEAVE
      ? user.availabilityStatus
      : undefined;
  const summary: AvailabilityStateSummary = {
    availabilityStatus: userOverrideStatus ?? session?.availabilityStatus ?? user.availabilityStatus,
    availabilityNote: session?.availabilityNote ?? user.availabilityNote,
    availabilityUpdatedAt: user.availabilityUpdatedAt,
    availabilitySetupRequired: false,
  };

  if (!hasInternalAvailabilityRole(user.roles)) {
    return summary;
  }

  // Staff no longer time in: anyone an admin has not marked Unavailable or On Leave is
  // available by default. Shifts are kept for display only and never require setup.
  const openSession = session && !session.closedAt ? session : null;

  if (userOverrideStatus) {
    summary.availabilityStatus = userOverrideStatus;
    if (openSession) summary.availabilityNote = openSession.availabilityNote ?? undefined;
    return summary;
  }

  if (!openSession) {
    summary.availabilityStatus = StaffAvailabilityStatus.AVAILABLE;
    summary.availabilityNote = undefined;
    return summary;
  }

  summary.availabilityStatus = openSession.availabilityStatus;
  summary.availabilityNote = openSession.availabilityNote ?? undefined;

  if (openSession.availabilityStatus === StaffAvailabilityStatus.AVAILABLE) {
    const shiftState = toShiftState(openSession, now);
    if (shiftState?.shiftEndAt && shiftState.shiftEndAt.getTime() < now.getTime()) {
      summary.expiredShift = shiftState;
    } else if (shiftState) {
      summary.activeShift = shiftState;
    }
  }

  return summary;
}

export async function getOpenAvailabilitySession(
  userId: string | Types.ObjectId,
): Promise<IAvailabilitySession | null> {
  return AvailabilitySession.findOne({
    userId,
    closedAt: { $exists: false },
  }).sort({ updatedAt: -1 });
}

export async function getOpenAvailabilitySessionsByUserIds(
  userIds: Array<string | Types.ObjectId>,
): Promise<Map<string, IAvailabilitySession>> {
  if (userIds.length === 0) return new Map();

  const sessions = await AvailabilitySession.find({
    userId: { $in: userIds },
    closedAt: { $exists: false },
  }).sort({ updatedAt: -1 });

  const mapped = new Map<string, IAvailabilitySession>();
  for (const session of sessions) {
    const key = session.userId.toString();
    if (!mapped.has(key)) {
      mapped.set(key, session);
    }
  }

  return mapped;
}

export async function evaluateSalesAssignmentEligibility(input: {
  salesStaffId: string;
  userAvailabilityStatus?: StaffAvailabilityStatus;
  session?: IAvailabilitySession | null;
  dateStr: string;
  slotCode: SlotCode | string;
  /** The appointment being assigned or moved, so it never blocks itself. */
  appointmentId?: string;
  appointmentType?: AppointmentType;
}): Promise<SalesAssignmentEligibility> {
  const {
    salesStaffId,
    userAvailabilityStatus,
    session,
    dateStr,
    slotCode,
    appointmentId,
  } = input;

  // ⚠️  TESTING BYPASS – set to `true` to skip shift/availability checks.
  //     Remember to set back to `false` before deploying to production!
  const DEV_BYPASS_ELIGIBILITY = false;

  if (!DEV_BYPASS_ELIGIBILITY) {
    const userOverrideStatus =
      userAvailabilityStatus === StaffAvailabilityStatus.UNAVAILABLE
      || userAvailabilityStatus === StaffAvailabilityStatus.ON_LEAVE
        ? userAvailabilityStatus
        : undefined;
    // Available by default: only an admin's Unavailable / On Leave (or a blocked date) stops
    // assignment. There is no time-in, so a missing or ended shift no longer blocks it.
    const openSessionStatus = session && !session.closedAt ? session.availabilityStatus : undefined;
    const effectiveStatus = userOverrideStatus ?? openSessionStatus ?? userAvailabilityStatus;
    if (effectiveStatus === StaffAvailabilityStatus.UNAVAILABLE) {
      return { assignmentEligible: false, assignmentBlockedReason: 'Unavailable' };
    }
    if (effectiveStatus === StaffAvailabilityStatus.ON_LEAVE) {
      return { assignmentEligible: false, assignmentBlockedReason: 'On leave' };
    }

    const adminAvailability = await SalesAvailability.findOne({ salesStaffId }).select('unavailableDates');
    if (adminAvailability?.unavailableDates.includes(dateStr)) {
      return { assignmentEligible: false, assignmentBlockedReason: 'Blocked on this date' };
    }
  }

  // Only another consultation or ocular visit whose time overlaps this slot on the same date
  // blocks; the staff stays assignable to the other slots that day.
  const activeAssignment = await findActiveSalesAssignment(salesStaffId, appointmentId, dateStr, slotCode);
  if (activeAssignment) {
    const when = `${formatSlotLabel(activeAssignment.slotCode || slotCode)}, ${formatAppointmentDay(dateStr)}`;
    return {
      assignmentEligible: false,
      assignmentBlockedReason: activeAssignment.appointmentNumber
        ? `Already has an appointment at this time (${when} · ${activeAssignment.appointmentNumber})`
        : `Already has an appointment at this time (${when})`,
    };
  }

  return { assignmentEligible: true };
}
