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
/**
 * The same kind of lock on one customer's schedule (every date), so a consultation booking and an
 * ocular visit for the same customer can't both pass the customer checks when they arrive together.
 */
const CUSTOMER_SCHEDULE_LOCK_SLOT = 'customer-schedule';
const CUSTOMER_SCHEDULE_LOCK_DATE = 'all-dates';

export interface SalesDayLocks {
  /** `slotCode` is only set for locks other than a sales staff member's day. */
  held: Array<{ salesId: string; date: string; slotCode?: string }>;
}

async function acquireLock(
  locks: SalesDayLocks,
  key: { date: string; slotCode: string; salesId: string },
  lockedBy: string,
  busyMessage: string,
): Promise<void> {
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
      throw AppError.conflict(busyMessage, ErrorCode.SLOT_LOCKED);
    }
    throw error;
  }
  locks.held.push(key.slotCode === SALES_DAY_LOCK_SLOT ? { salesId: key.salesId, date: key.date } : key);
}

export async function acquireSalesDayLock(
  locks: SalesDayLocks | undefined,
  salesStaffId: string,
  dateStr: string,
  lockedBy: string,
): Promise<void> {
  if (!locks) return;
  if (locks.held.some((lock) => !lock.slotCode && lock.salesId === salesStaffId && lock.date === dateStr)) return;

  await acquireLock(
    locks,
    { date: dateStr, slotCode: SALES_DAY_LOCK_SLOT, salesId: salesStaffId },
    lockedBy,
    'Another booking for this sales staff on this date is being saved right now. Please try again in a moment.',
  );
}

/** Holds the customer's schedule until the request ends: one booking or reschedule at a time. */
export async function acquireCustomerScheduleLock(
  locks: SalesDayLocks | undefined,
  customerId: string,
  lockedBy: string,
): Promise<void> {
  if (!locks) return;
  if (locks.held.some((lock) => lock.slotCode === CUSTOMER_SCHEDULE_LOCK_SLOT && lock.salesId === customerId)) return;

  await acquireLock(
    locks,
    { date: CUSTOMER_SCHEDULE_LOCK_DATE, slotCode: CUSTOMER_SCHEDULE_LOCK_SLOT, salesId: customerId },
    lockedBy,
    'Another booking for this customer is being saved right now. Please try again in a moment.',
  );
}

/** Runs `fn` and always releases the sales-day and customer locks it took. */
export async function withSalesDayLocks<T>(fn: (locks: SalesDayLocks) => Promise<T>): Promise<T> {
  const locks: SalesDayLocks = { held: [] };
  try {
    return await fn(locks);
  } finally {
    for (const lock of locks.held) {
      await SlotLock.deleteOne({ date: lock.date, slotCode: lock.slotCode ?? SALES_DAY_LOCK_SLOT, salesId: lock.salesId })
        .catch(() => undefined);
    }
  }
}
