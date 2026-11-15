import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { AppError, ErrorCode } from '../../utils/appError.js';

const TZ = 'Asia/Manila';

// ⚠️  TEMPORARY BYPASS (2026-11-09): check-in, visit progress, report submission and completion
//     are allowed before the appointment day. Set back to `false` to enforce
//     "You can … starting on <date>, the day of the appointment." again.
export const APPOINTMENT_DAY_CHECK_BYPASSED = true;

/**
 * Visits happen on their scheduled day: check-in, visit progress, report submission, and
 * completion are blocked until the appointment date arrives (Manila time).
 * Skipped while APPOINTMENT_DAY_CHECK_BYPASSED is on, unless `enforce` is passed.
 */
export function assertAppointmentDayReached(
  appointmentDate: string | undefined | null,
  action: string,
  now: Date = new Date(),
  enforce: boolean = !APPOINTMENT_DAY_CHECK_BYPASSED,
): void {
  if (!enforce || !appointmentDate) return;
  const day = appointmentDate.trim().slice(0, 10);
  const todayManila = format(toZonedTime(now, TZ), 'yyyy-MM-dd');
  if (todayManila < day) {
    throw AppError.badRequest(
      `You can ${action} starting on ${day}, the day of the appointment.`,
      ErrorCode.VALIDATION_ERROR,
    );
  }
}

/** A customer is a no-show once this many minutes have passed since the scheduled time. */
export const NO_SHOW_GRACE_MINUTES = 15;

function formatManilaTime(date: Date): string {
  return format(toZonedTime(date, TZ), 'h:mm a');
}

/**
 * A no-show is recorded on the appointment date itself, once the grace period after the
 * scheduled time has passed (Manila time): never before the customer could be late, and never
 * on another day. Always enforced; APPOINTMENT_DAY_CHECK_BYPASSED does not apply here.
 */
export function assertNoShowAllowed(
  appointmentDate: string | undefined | null,
  slotCode: string | undefined | null,
  now: Date = new Date(),
): void {
  const day = String(appointmentDate ?? '').trim().slice(0, 10);
  const start = new Date(`${day}T${String(slotCode ?? '').trim()}:00+08:00`);
  if (Number.isNaN(start.getTime())) {
    throw AppError.badRequest('This appointment has no scheduled date and time.', ErrorCode.VALIDATION_ERROR);
  }
  const opensAt = new Date(start.getTime() + NO_SHOW_GRACE_MINUTES * 60 * 1000);
  const todayManila = format(toZonedTime(now, TZ), 'yyyy-MM-dd');

  if (todayManila !== day) {
    throw AppError.badRequest(
      todayManila < day
        ? `A no-show can only be recorded on the appointment date (${day}), from ${formatManilaTime(opensAt)}.`
        : `A no-show can only be recorded on the appointment date (${day}). That day has passed.`,
      ErrorCode.VALIDATION_ERROR,
    );
  }
  if (now < opensAt) {
    throw AppError.badRequest(
      `A no-show can be recorded from ${formatManilaTime(opensAt)}, ${NO_SHOW_GRACE_MINUTES} minutes after the scheduled time.`,
      ErrorCode.VALIDATION_ERROR,
    );
  }
}
