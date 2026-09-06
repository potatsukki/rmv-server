import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { Appointment } from '../../models/index.js';
import {
  AppointmentAttendanceStatus,
  AppointmentStatus,
  AppointmentType,
} from '../../utils/constants.js';

const TIME_ZONE = 'Asia/Manila';
const CONSULTATION_DURATION_MS = 60 * 60 * 1000;
const AUTOMATABLE_ATTENDANCE_STATUSES = [
  AppointmentAttendanceStatus.SCHEDULED,
  AppointmentAttendanceStatus.ON_TIME,
  AppointmentAttendanceStatus.LATE_ARRIVAL,
  AppointmentAttendanceStatus.IN_PROGRESS,
];
const AUTOMATABLE_APPOINTMENT_STATUSES = [
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.COMPLETED,
  AppointmentStatus.READY_FOR_OCULAR,
];

type ConsultationAppointment = {
  _id: unknown;
  type: AppointmentType | string;
  status: AppointmentStatus | string;
  date: string;
  slotCode: string;
  attendanceStatus?: AppointmentAttendanceStatus;
  consultationStartedAt?: Date;
  consultationCompletedAt?: Date;
  attendanceUpdatedAt?: Date;
  save: () => Promise<unknown>;
};

export function getConsultationAttendanceWindow(date: string, slotCode: string) {
  const start = new Date(`${date}T${slotCode}:00+08:00`);
  return {
    start,
    end: new Date(start.getTime() + CONSULTATION_DURATION_MS),
  };
}

export async function synchronizeConsultationAttendanceByTime(
  appointment: ConsultationAppointment,
  now = new Date(),
): Promise<boolean> {
  const currentStatus = appointment.attendanceStatus || AppointmentAttendanceStatus.SCHEDULED;
  if (
    appointment.type !== AppointmentType.OFFICE
    || !AUTOMATABLE_APPOINTMENT_STATUSES.includes(appointment.status as AppointmentStatus)
    || !AUTOMATABLE_ATTENDANCE_STATUSES.includes(currentStatus)
  ) {
    return false;
  }

  const window = getConsultationAttendanceWindow(appointment.date, appointment.slotCode);
  if (Number.isNaN(window.start.getTime())) return false;

  if (now >= window.end) {
    appointment.attendanceStatus = AppointmentAttendanceStatus.COMPLETED;
    appointment.consultationStartedAt ||= window.start;
    appointment.consultationCompletedAt = window.end;
  } else if (now >= window.start && currentStatus !== AppointmentAttendanceStatus.IN_PROGRESS) {
    appointment.attendanceStatus = AppointmentAttendanceStatus.IN_PROGRESS;
    appointment.consultationStartedAt ||= window.start;
  } else {
    return false;
  }

  appointment.attendanceUpdatedAt = now;
  await appointment.save();
  return true;
}

export async function processAutomatedConsultationAttendance(
  now = new Date(),
  onError: (message: string, error: unknown) => void = console.error,
): Promise<number> {
  const localDate = format(toZonedTime(now, TIME_ZONE), 'yyyy-MM-dd');
  const appointments = await Appointment.find({
    type: AppointmentType.OFFICE,
    status: { $in: AUTOMATABLE_APPOINTMENT_STATUSES },
    date: { $lte: localDate },
    attendanceStatus: { $in: AUTOMATABLE_ATTENDANCE_STATUSES },
  }).select(
    'type status date slotCode attendanceStatus consultationStartedAt consultationCompletedAt attendanceUpdatedAt',
  );

  let updatedCount = 0;
  for (const appointment of appointments) {
    try {
      if (await synchronizeConsultationAttendanceByTime(appointment, now)) {
        updatedCount += 1;
      }
    } catch (error) {
      onError(
        `Failed to automate consultation attendance for appointment ${appointment._id.toString()}:`,
        error,
      );
    }
  }

  return updatedCount;
}
