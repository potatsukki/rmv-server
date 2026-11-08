import { addDays, format, parse } from 'date-fns';
import { AppError, ErrorCode } from '../../utils/appError.js';
import { OCULAR_MIN_DAYS_AFTER_CONSULTATION } from '../../utils/constants.js';

/** Rejects an ocular date earlier than OCULAR_MIN_DAYS_AFTER_CONSULTATION days after the consultation. */
export function assertOcularAfterConsultation(ocularDate: string, consultationDate?: string | null): void {
  if (!consultationDate) return;
  const consultationDay = consultationDate.trim().slice(0, 10);
  const earliest = format(
    addDays(parse(consultationDay, 'yyyy-MM-dd', new Date()), OCULAR_MIN_DAYS_AFTER_CONSULTATION),
    'yyyy-MM-dd',
  );
  if (ocularDate.trim().slice(0, 10) < earliest) {
    throw AppError.badRequest(
      `The ocular visit must be at least ${OCULAR_MIN_DAYS_AFTER_CONSULTATION} days after the consultation on ${consultationDay}. Choose ${earliest} or later.`,
      ErrorCode.VALIDATION_ERROR,
    );
  }
}
