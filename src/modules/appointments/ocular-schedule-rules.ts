import { addDays, format, parse } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { AppError, ErrorCode } from '../../utils/appError.js';
import { OCULAR_MIN_DAYS_AFTER_CONSULTATION } from '../../utils/constants.js';

const TZ = 'Asia/Manila';

/** The Manila calendar day (yyyy-MM-dd) of an appointment date or timestamp. */
function toManilaDay(value: string | Date): string {
  if (value instanceof Date) return formatInTimeZone(value, TZ, 'yyyy-MM-dd');
  const trimmed = value.trim();
  // A full timestamp ("2026-11-12T16:00:00Z") is converted; a plain date is already a Manila day.
  return trimmed.length > 10 ? formatInTimeZone(new Date(trimmed), TZ, 'yyyy-MM-dd') : trimmed.slice(0, 10);
}

function readableDay(day: string): string {
  return format(parse(day, 'yyyy-MM-dd', new Date()), 'MMM d, yyyy');
}

/** Earliest allowed ocular date (yyyy-MM-dd): OCULAR_MIN_DAYS_AFTER_CONSULTATION days after the booked consultation date. */
export function earliestOcularDate(consultationDate: string | Date): string {
  return format(
    addDays(parse(toManilaDay(consultationDate), 'yyyy-MM-dd', new Date()), OCULAR_MIN_DAYS_AFTER_CONSULTATION),
    'yyyy-MM-dd',
  );
}

/**
 * Rejects an ocular date earlier than OCULAR_MIN_DAYS_AFTER_CONSULTATION days after the consultation.
 * The count starts from the consultation's booked date (Asia/Manila), even if the consultation was
 * finished early, so the ocular can never land on or right after the consultation's own day.
 */
export function assertOcularAfterConsultation(
  ocularDate: string,
  consultationDate?: string | Date | null,
): void {
  if (!consultationDate) return;
  const consultationDay = toManilaDay(consultationDate);
  const earliest = earliestOcularDate(consultationDay);
  if (toManilaDay(ocularDate) < earliest) {
    throw AppError.badRequest(
      `The ocular visit must be at least ${OCULAR_MIN_DAYS_AFTER_CONSULTATION} days after the consultation on ${readableDay(consultationDay)}. Choose ${readableDay(earliest)} or later.`,
      ErrorCode.VALIDATION_ERROR,
    );
  }
}
