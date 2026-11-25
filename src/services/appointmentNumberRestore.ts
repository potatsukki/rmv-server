import mongoose from 'mongoose';
import { Appointment, AuditLog, Notification } from '../models/index.js';
import { AuditAction } from '../utils/constants.js';

const APPOINTMENT_NUMBER = /^APT-(\d{4})(\d{2})(\d{2})-\d{4}$/;

export interface AppointmentNumberRestoreResult {
  appointmentId: string;
  /** The number the appointment has now (the one being replaced). */
  from?: string;
  /** The original number put back. */
  to: string;
  /** This appointment's notifications that show `from` (changed only when applied). */
  notifications: number;
  applied: boolean;
}

/** `number` exactly, not as the start of a longer number. */
function numberPattern(number: string) {
  return new RegExp(`${number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`, 'g');
}

/**
 * Puts back an appointment's original public number (APT-YYYYMMDD-NNNN), together with the same
 * number in this appointment's own notifications. Before the 2026-11-25 model fix, the automatic
 * consultation start could replace the number (QA: APT-20261125-0003 became APT-20261125-0006).
 * Nothing is written unless `apply` is true. The number counter is left alone, so the replaced
 * number is never handed out again.
 */
export async function restoreAppointmentNumber(
  appointmentId: string,
  number: string,
  { apply = false }: { apply?: boolean } = {},
): Promise<AppointmentNumberRestoreResult> {
  if (!mongoose.isValidObjectId(appointmentId)) throw new Error(`"${appointmentId}" is not a valid appointment id.`);
  const to = number.trim();
  const match = APPOINTMENT_NUMBER.exec(to);
  if (!match) throw new Error(`"${number}" is not an appointment number like APT-20261125-0003.`);

  const appointment = await Appointment.findById(appointmentId).select('appointmentNumber date').lean();
  if (!appointment) throw new Error(`No appointment has the id ${appointmentId}.`);
  const from = appointment.appointmentNumber || undefined;
  if (from === to) throw new Error(`Appointment ${appointmentId} already has ${to}. Nothing to change.`);
  const numberDate = `${match[1]}-${match[2]}-${match[3]}`;
  if (numberDate !== appointment.date) {
    throw new Error(`${to} is a number for ${numberDate}, but the appointment is on ${appointment.date}.`);
  }
  const holder = await Appointment.findOne({ appointmentNumber: to, _id: { $ne: appointment._id } }).select('_id').lean();
  if (holder) throw new Error(`${to} already belongs to another appointment (${String(holder._id)}).`);

  // Only this appointment's own notifications; another appointment's are never touched.
  const notifications = from
    ? (await Notification.find({ link: `/appointments/${String(appointment._id)}` }).select('title message').lean())
      .filter((notification) => numberPattern(from).test(`${notification.title}\n${notification.message}`))
    : [];

  if (apply) {
    // Saved only if the number is still the one checked above.
    const saved = await Appointment.updateOne(
      from ? { _id: appointment._id, appointmentNumber: from } : { _id: appointment._id },
      { $set: { appointmentNumber: to } },
      { timestamps: false },
    );
    if (saved.modifiedCount !== 1) throw new Error('The appointment changed while restoring. Nothing was saved; run it again.');

    for (const notification of notifications) {
      await Notification.updateOne(
        { _id: notification._id },
        {
          $set: {
            title: notification.title.replace(numberPattern(from!), to),
            message: notification.message.replace(numberPattern(from!), to),
          },
        },
        { timestamps: false },
      );
    }

    // Recorded as System (no human actor), like the other automatic steps.
    await AuditLog.create({
      action: AuditAction.APPOINTMENT_UPDATED,
      targetType: 'appointment',
      targetId: appointment._id,
      details: { action: 'appointment_number_restored', from: from ?? null, to, notificationsUpdated: notifications.length },
    });
  }

  return { appointmentId: String(appointment._id), from, to, notifications: notifications.length, applied: apply };
}
