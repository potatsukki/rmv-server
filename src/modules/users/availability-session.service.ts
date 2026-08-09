import type { Types } from 'mongoose';
import {
  Appointment,
  AvailabilitySession,
  SalesAvailability,
  type IAvailabilitySession,
} from '../../models/index.js';
import {
  AppointmentStatus,
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
const FINAL_APPOINTMENT_STATUSES = [
  AppointmentStatus.COMPLETED,
  AppointmentStatus.CANCELLED,
  AppointmentStatus.NO_SHOW,
];
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

  if (userOverrideStatus && (!session || session.closedAt)) {
    summary.availabilitySetupRequired = false;
    return summary;
  }

  if (!session || session.closedAt) {
    summary.availabilitySetupRequired = true;
    summary.availabilityStatus = undefined;
    summary.availabilityNote = undefined;
    return summary;
  }

  summary.availabilityStatus = session.availabilityStatus;
  summary.availabilityNote = session.availabilityNote ?? undefined;

  if (userOverrideStatus) {
    summary.availabilityStatus = userOverrideStatus;
    summary.activeShift = undefined;
    summary.expiredShift = undefined;
    summary.availabilitySetupRequired = false;
    return summary;
  }

  if (session.availabilityStatus === StaffAvailabilityStatus.AVAILABLE) {
    const shiftState = toShiftState(session, now);
    if (!shiftState) {
      summary.availabilitySetupRequired = true;
      return summary;
    }

    if (shiftState.shiftEndAt && shiftState.shiftEndAt.getTime() < now.getTime()) {
      summary.expiredShift = shiftState;
      summary.activeShift = undefined;
      summary.availabilitySetupRequired = true;
      return summary;
    }

    summary.activeShift = shiftState;
    return summary;
  }

  summary.activeShift = undefined;
  summary.expiredShift = undefined;
  summary.availabilitySetupRequired = false;
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
  appointmentId?: string;
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
    const effectiveStatus = userOverrideStatus ?? session?.availabilityStatus ?? userAvailabilityStatus;
    if (effectiveStatus === StaffAvailabilityStatus.UNAVAILABLE) {
      return { assignmentEligible: false, assignmentBlockedReason: 'Unavailable' };
    }
    if (effectiveStatus === StaffAvailabilityStatus.ON_LEAVE) {
      return { assignmentEligible: false, assignmentBlockedReason: 'On leave' };
    }

    if (!session || session.closedAt) {
      return { assignmentEligible: false, assignmentBlockedReason: 'Setup required' };
    }

    const targetDateTime = getSlotDateTime(dateStr, slotCode);
    if (!doesShiftCoverDateTime(session, targetDateTime)) {
      return { assignmentEligible: false, assignmentBlockedReason: 'Off shift' };
    }

    const adminAvailability = await SalesAvailability.findOne({ salesStaffId }).select('unavailableDates');
    if (adminAvailability?.unavailableDates.includes(dateStr)) {
      return { assignmentEligible: false, assignmentBlockedReason: 'Blocked on this date' };
    }
  }

  const conflictFilter: Record<string, unknown> = {
    salesStaffId,
    date: dateStr,
    slotCode,
    status: { $nin: FINAL_APPOINTMENT_STATUSES },
  };
  if (appointmentId) {
    conflictFilter._id = { $ne: appointmentId };
  }

  const conflictingAppointment = await Appointment.exists(conflictFilter);
  if (conflictingAppointment) {
    return { assignmentEligible: false, assignmentBlockedReason: 'Booked in another appointment' };
  }

  return { assignmentEligible: true };
}
