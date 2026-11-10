import { SlotLock } from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';

/**
 * Short-lived lock on one sales staff member's day, so two bookings saved at the same moment
 * can't both pass the "one appointment per day" check. It reuses SlotLock's unique
 * {date, slotCode, salesId} index with a reserved slot code, and is removed when the request ends
 * (or expires on its own if the server stops mid-request).
 */
const SALES_DAY_LOCK_SLOT = 'sales-day';
const SALES_DAY_LOCK_TTL_MS = 60_000;

export interface SalesDayLocks {
  held: Array<{ salesId: string; date: string }>;
}

export async function acquireSalesDayLock(
  locks: SalesDayLocks | undefined,
  salesStaffId: string,
  dateStr: string,
  lockedBy: string,
): Promise<void> {
  if (!locks) return;
  if (locks.held.some((lock) => lock.salesId === salesStaffId && lock.date === dateStr)) return;

  const key = { date: dateStr, slotCode: SALES_DAY_LOCK_SLOT, salesId: salesStaffId };
  // A lock left behind by a crashed request no longer counts once it has expired.
  await SlotLock.deleteOne({ ...key, expiresAt: { $lte: new Date() } });
  try {
    await SlotLock.create({
      ...key,
      lockedBy,
      confirmed: false,
      expiresAt: new Date(Date.now() + SALES_DAY_LOCK_TTL_MS),
    });
  } catch (error: unknown) {
    if ((error as { code?: number }).code === 11000) {
      throw AppError.conflict(
        'Another booking for this sales staff on this date is being saved right now. Please try again in a moment.',
        ErrorCode.SLOT_LOCKED,
      );
    }
    throw error;
  }
  locks.held.push({ salesId: salesStaffId, date: dateStr });
}

/** Runs `fn` and always releases the day locks it took. */
export async function withSalesDayLocks<T>(fn: (locks: SalesDayLocks) => Promise<T>): Promise<T> {
  const locks: SalesDayLocks = { held: [] };
  try {
    return await fn(locks);
  } finally {
    for (const lock of locks.held) {
      await SlotLock.deleteOne({ date: lock.date, slotCode: SALES_DAY_LOCK_SLOT, salesId: lock.salesId })
        .catch(() => undefined);
    }
  }
}
