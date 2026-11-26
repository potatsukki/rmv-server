import type { Types } from 'mongoose';
import { Appointment, Project } from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import { AppointmentAttendanceStatus, AppointmentStatus, AppointmentType, ProjectStatus } from '../../utils/constants.js';
import { APPOINTMENT_SLOT_MINUTES, slotsOverlap } from '../users/availability-session.service.js';

/**
 * A customer attends their own consultation and ocular visit, so the two can never overlap,
 * whichever sales staff take them. This is separate from the sales staff rules: an ocular visit
 * takes the STAFF member's whole day (travel), but the customer only has to be there for the
 * visit's own time slot (APPOINTMENT_SLOT_MINUTES from its start, on its Asia/Manila date).
 *
 * Only a cancelled or no-show appointment gives its time back. A completed one keeps its slot, so
 * completing early still prevents the customer from double-booking that time.
 */
export const CUSTOMER_TIME_FREEING_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.CANCELLED,
  AppointmentStatus.NO_SHOW,
];

/**
 * An office consultation closed as No Show is stored as completed with attendanceStatus no_show
 * (an ocular visit uses status no_show), so it gives its time back too (user decision 2026-11-27).
 */
const OFFICE_NO_SHOW = { status: AppointmentStatus.COMPLETED, attendanceStatus: AppointmentAttendanceStatus.NO_SHOW };

type ConflictingAppointment = {
  _id: Types.ObjectId;
  appointmentNumber?: string;
  type?: AppointmentType | string;
  date: string;
  slotCode: string;
  status?: AppointmentStatus | string;
};

function formatDay(dateStr: string) {
  const [year = 0, month = 1, day = 1] = dateStr.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function formatMinutes(totalMinutes: number) {
  const hour = Math.floor(totalMinutes / 60) % 24;
  const minute = totalMinutes % 60;
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function slotStart(slotCode: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(slotCode ?? '').trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

function formatTime(slotCode: string) {
  const start = slotStart(slotCode);
  return start === undefined ? slotCode : formatMinutes(start);
}

function formatTimeRange(slotCode: string) {
  const start = slotStart(slotCode);
  return start === undefined
    ? slotCode
    : `${formatMinutes(start)} to ${formatMinutes(start + APPOINTMENT_SLOT_MINUTES)}`;
}

/** "an ocular visit" / "a consultation". */
const kindLabel = (type?: AppointmentType | string) => (type === AppointmentType.OCULAR ? 'an ocular visit' : 'a consultation');

/**
 * Customer appointments that reserve time on this date. An appointment being moved is passed
 * in `excludeAppointmentIds` so it is never compared with itself.
 */
async function getCustomerAppointmentsOnDate(
  customerId: string,
  dateStr: string,
  excludeAppointmentIds: string[] = [],
): Promise<ConflictingAppointment[]> {
  const filter: Record<string, unknown> = {
    customerId,
    date: dateStr,
    status: { $nin: CUSTOMER_TIME_FREEING_STATUSES },
    $nor: [OFFICE_NO_SHOW],
  };
  if (excludeAppointmentIds.length) filter._id = { $nin: excludeAppointmentIds };
  const sameDay = await Appointment.find(filter)
    .select('appointmentNumber type date slotCode status')
    .sort({ slotCode: 1 })
    .lean();
  return sameDay as ConflictingAppointment[];
}

export async function findCustomerScheduleConflict(
  customerId: string,
  dateStr: string,
  slotCode: string,
  excludeAppointmentIds: string[] = [],
): Promise<ConflictingAppointment | null> {
  const sameDay = await getCustomerAppointmentsOnDate(customerId, dateStr, excludeAppointmentIds);
  return sameDay.find((appointment) => slotsOverlap(appointment.slotCode, slotCode)) ?? null;
}

/** Marks the same overlaps the submission guard rejects, with one query for the entire day. */
export async function getCustomerBookedSlots(customerId: string, dateStr: string, slotCodes: readonly string[]) {
  const sameDay = await getCustomerAppointmentsOnDate(customerId, dateStr);
  return new Set(slotCodes.filter((slotCode) => sameDay.some((appointment) => slotsOverlap(appointment.slotCode, slotCode))));
}

/**
 * Rejects a consultation or ocular visit that would overlap another appointment of the same
 * customer. The error names the appointment in the way and the date and time to change.
 */
export async function assertCustomerScheduleFree(input: {
  customerId: string;
  date: string;
  slotCode: string;
  /** The appointment being booked or moved. */
  incomingType: AppointmentType | string;
  /** The appointment being moved (and, for a follow-up ocular, its own consultation). */
  excludeAppointmentIds?: string[];
  /** Who sees the error: the customer ("You already have…") or staff acting for them. */
  audience?: 'customer' | 'staff';
}): Promise<void> {
  const conflict = await findCustomerScheduleConflict(
    input.customerId,
    input.date,
    input.slotCode,
    input.excludeAppointmentIds,
  );
  if (!conflict) return;

  // Name the project too: a project's ocular visit is not listed on the Appointments page.
  const owningProject = await Project.findOne({
    $or: [{ ocularAppointmentId: conflict._id }, { appointmentId: conflict._id }],
    status: { $ne: ProjectStatus.CANCELLED },
  }).select('projectNumber').lean();
  const statusLabel = String(conflict.status || '').replace(/_/g, ' ');
  const detail = [
    conflict.appointmentNumber,
    statusLabel && statusLabel.charAt(0).toUpperCase() + statusLabel.slice(1),
    owningProject?.projectNumber,
  ].filter(Boolean).join(' · ');
  const existing = `${kindLabel(conflict.type)} on ${formatDay(conflict.date)}, ${formatTimeRange(conflict.slotCode)}${detail ? ` (${detail})` : ''}`;
  const incomingKind = kindLabel(input.incomingType);
  const requested = `${incomingKind.charAt(0).toUpperCase()}${incomingKind.slice(1)} on ${formatDay(input.date)} at ${formatTime(input.slotCode)} would overlap it.`;
  const message = input.audience === 'staff'
    ? `This customer already has ${existing}. ${requested} Choose a different date or time.`
    : `You already have ${existing}. ${requested} Please choose a different date or time.`;

  throw AppError.conflict(message, ErrorCode.CUSTOMER_SCHEDULE_CONFLICT, {
    conflictAppointmentId: String(conflict._id),
    conflictAppointmentNumber: conflict.appointmentNumber,
    conflictAppointmentType: conflict.type,
    conflictAppointmentStatus: conflict.status,
    conflictDate: conflict.date,
    conflictSlotCode: conflict.slotCode,
    conflictProjectNumber: owningProject?.projectNumber,
    requestedDate: input.date,
    requestedSlotCode: input.slotCode,
  });
}
