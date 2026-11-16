import type { Types } from 'mongoose';
import { Appointment, Project } from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import { AppointmentStatus, AppointmentType, ProjectStatus } from '../../utils/constants.js';
import { APPOINTMENT_SLOT_MINUTES, slotsOverlap } from '../users/availability-session.service.js';

/**
 * A customer attends their own consultation and ocular visit, so the two can never overlap,
 * whichever sales staff take them. This is separate from the sales staff rules: an ocular visit
 * takes the STAFF member's whole day (travel), but the customer only has to be there for the
 * visit's own time slot (APPOINTMENT_SLOT_MINUTES from its start, on its Asia/Manila date).
 *
 * Only a cancelled or no-show appointment gives its time back. A completed one keeps it: under the
 * normal rules an appointment is completed on its own day, which is always before any date that can
 * still be booked (bookings need MIN_BOOKING_LEAD_DAYS notice), so this never blocks a real booking.
 * It only matters when an appointment was marked Completed BEFORE its scheduled day; its record
 * still shows that date and time, and a second appointment there would read as a double booking.
 */
export const CUSTOMER_TIME_FREEING_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.CANCELLED,
  AppointmentStatus.NO_SHOW,
];

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
 * The customer's other appointment that overlaps this date and time slot, if any. An appointment
 * being moved is passed in `excludeAppointmentIds` so it is never compared with itself.
 */
export async function findCustomerScheduleConflict(
  customerId: string,
  dateStr: string,
  slotCode: string,
  excludeAppointmentIds: string[] = [],
): Promise<ConflictingAppointment | null> {
  const filter: Record<string, unknown> = {
    customerId,
    date: dateStr,
    status: { $nin: CUSTOMER_TIME_FREEING_STATUSES },
  };
  if (excludeAppointmentIds.length) filter._id = { $nin: excludeAppointmentIds };
  const sameDay = await Appointment.find(filter)
    .select('appointmentNumber type date slotCode status')
    .sort({ slotCode: 1 })
    .lean();
  return (sameDay as ConflictingAppointment[]).find((appointment) => slotsOverlap(appointment.slotCode, slotCode)) ?? null;
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
