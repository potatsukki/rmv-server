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
