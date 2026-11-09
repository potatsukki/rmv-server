import { User } from '../models/index.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-12" + "10:00" → "Nov 12, 2026 at 10:00 AM" (no time zone math: both are Manila values). */
export function formatNotificationDate(date?: string, slotCode?: string): string {
  if (!date) return '';
  const [year, month, day] = date.slice(0, 10).split('-').map(Number);
  const dayText = year && month && day ? `${MONTHS[month - 1]} ${day}, ${year}` : date;
  if (!slotCode) return dayText;
  const [hourText, minuteText = '00'] = slotCode.split(':');
  const hour = Number(hourText);
  if (Number.isNaN(hour)) return `${dayText} at ${slotCode}`;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  return `${dayText} at ${hour % 12 || 12}:${minuteText.padStart(2, '0')} ${suffix}`;
}

function nameOf(user: unknown): string | undefined {
  if (!user || typeof user !== 'object') return undefined;
  const { firstName, lastName } = user as { firstName?: string; lastName?: string };
  const name = [firstName, lastName].filter(Boolean).join(' ').trim();
  return name || undefined;
}

/**
 * "APT-20261112-0002 · Juana Quinto · Nov 12, 2026 at 10:00 AM", so two notifications about
 * different appointments never read the same.
 */
export async function describeAppointmentForNotification(appointment: {
  appointmentNumber?: string;
  customerId?: unknown;
  date?: string;
  slotCode?: string;
}): Promise<string> {
  let customerName = nameOf(appointment.customerId);
  if (!customerName && appointment.customerId) {
    try {
      const customer = await User.findById(appointment.customerId).select('firstName lastName').lean();
      customerName = nameOf(customer);
    } catch {
      customerName = undefined;
    }
  }
  return [appointment.appointmentNumber, customerName, formatNotificationDate(appointment.date, appointment.slotCode)]
    .filter(Boolean)
    .join(' · ');
}
