import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { AppError, ErrorCode } from '../../utils/appError.js';

const TZ = 'Asia/Manila';

/**
 * Visits happen on their scheduled day: check-in, visit progress, report submission, and
 * completion are blocked until the appointment date arrives (Manila time).
 */
export function assertAppointmentDayReached(
  appointmentDate: string | undefined | null,
  action: string,
  now: Date = new Date(),
): void {
  if (!appointmentDate) return;
  const day = appointmentDate.trim().slice(0, 10);
  const todayManila = format(toZonedTime(now, TZ), 'yyyy-MM-dd');
  if (todayManila < day) {
    throw AppError.badRequest(
      `You can ${action} starting on ${day}, the day of the appointment.`,
      ErrorCode.VALIDATION_ERROR,
    );
  }
}
