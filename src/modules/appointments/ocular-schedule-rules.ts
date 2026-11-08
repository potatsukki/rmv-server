import { addDays, format, parse } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { AppError, ErrorCode } from '../../utils/appError.js';
import { OCULAR_MIN_DAYS_AFTER_CONSULTATION } from '../../utils/constants.js';

const TZ = 'Asia/Manila';

/**
 * Rejects an ocular date earlier than OCULAR_MIN_DAYS_AFTER_CONSULTATION days after the consultation.
 * The count starts from the day the consultation actually happened: an ocular is only scheduled once
 * the consultation is finished, so a consultation dated later than today was held today at the latest.
 */
export function assertOcularAfterConsultation(
  ocularDate: string,
  consultationDate?: string | null,
  now: Date = new Date(),
): void {
  if (!consultationDate) return;
  const scheduledDay = consultationDate.trim().slice(0, 10);
  const todayManila = format(toZonedTime(now, TZ), 'yyyy-MM-dd');
  const consultationDay = scheduledDay < todayManila ? scheduledDay : todayManila;
  const earliest = format(
    addDays(parse(consultationDay, 'yyyy-MM-dd', new Date()), OCULAR_MIN_DAYS_AFTER_CONSULTATION),
    'yyyy-MM-dd',
  );
  if (ocularDate.trim().slice(0, 10) < earliest) {
    throw AppError.badRequest(
      `The ocular visit must be at least ${OCULAR_MIN_DAYS_AFTER_CONSULTATION} days after the consultation (${consultationDay}). Choose ${earliest} or later.`,
      ErrorCode.VALIDATION_ERROR,
    );
  }
}
