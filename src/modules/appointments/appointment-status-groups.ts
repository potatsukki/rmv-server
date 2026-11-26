import { AppointmentAttendanceStatus, AppointmentStatus } from '../../utils/constants.js';

// The UI shows five appointment statuses; the database keeps the detailed ones.
// Keep this mapping in sync with resolveAppointmentWorkflowStatus in rmv-web.
export const APPOINTMENT_STATUS_GROUPS = ['requested', 'assigned', 'confirmed', 'completed', 'no_show'] as const;
export type AppointmentStatusGroup = (typeof APPOINTMENT_STATUS_GROUPS)[number];

const NO_SALES_STAFF = { salesStaffId: null };
const HAS_SALES_STAFF = { salesStaffId: { $ne: null } };

export function isAppointmentStatusGroup(value: unknown): value is AppointmentStatusGroup {
  return typeof value === 'string' && (APPOINTMENT_STATUS_GROUPS as readonly string[]).includes(value);
}

/** Groups of finished appointments: their lists are history, newest first. */
export function isHistoryStatusGroup(value: unknown): boolean {
  return value === 'completed' || value === 'no_show';
}

export function buildAppointmentStatusGroupFilter(group: unknown): Record<string, unknown> | null {
  if (!isAppointmentStatusGroup(group)) return null;

  switch (group) {
    case 'requested':
      return {
        status: { $in: [AppointmentStatus.REQUESTED, AppointmentStatus.RESCHEDULE_REQUESTED] },
        ...NO_SALES_STAFF,
      };
    case 'assigned':
      return {
        $or: [
          { status: AppointmentStatus.ASSIGNED },
          { status: AppointmentStatus.REQUESTED, ...HAS_SALES_STAFF },
        ],
      };
    case 'confirmed':
      return {
        $or: [
          {
            status: {
              $in: [
                AppointmentStatus.CONFIRMED,
                AppointmentStatus.PREPARING,
                AppointmentStatus.ON_THE_WAY,
                AppointmentStatus.ARRIVED_AT_SITE,
                AppointmentStatus.IN_PROGRESS,
              ],
            },
          },
          { status: AppointmentStatus.RESCHEDULE_REQUESTED, ...HAS_SALES_STAFF },
        ],
      };
    case 'completed':
      // No Show appointments have their own group, even when they closed as completed.
      return {
        $or: [
          { status: { $in: [AppointmentStatus.READY_FOR_OCULAR, AppointmentStatus.CANCELLED] } },
          { status: AppointmentStatus.COMPLETED, attendanceStatus: { $ne: AppointmentAttendanceStatus.NO_SHOW } },
        ],
      };
    case 'no_show':
      // Ocular visits close as no_show; office consultations close as completed with attendanceStatus no_show.
      return {
        $or: [
          { status: AppointmentStatus.NO_SHOW },
          { status: AppointmentStatus.COMPLETED, attendanceStatus: AppointmentAttendanceStatus.NO_SHOW },
        ],
      };
  }
}
