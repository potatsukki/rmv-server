import { AppointmentStatus } from '../../utils/constants.js';

// The UI shows four appointment statuses; the database keeps the detailed ones.
// Keep this mapping in sync with resolveAppointmentWorkflowStatus in rmv-web.
export const APPOINTMENT_STATUS_GROUPS = ['requested', 'assigned', 'confirmed', 'completed'] as const;
export type AppointmentStatusGroup = (typeof APPOINTMENT_STATUS_GROUPS)[number];

const NO_SALES_STAFF = { salesStaffId: null };
const HAS_SALES_STAFF = { salesStaffId: { $ne: null } };

export function isAppointmentStatusGroup(value: unknown): value is AppointmentStatusGroup {
  return typeof value === 'string' && (APPOINTMENT_STATUS_GROUPS as readonly string[]).includes(value);
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
      return {
        status: {
          $in: [
            AppointmentStatus.COMPLETED,
            AppointmentStatus.READY_FOR_OCULAR,
            AppointmentStatus.CANCELLED,
            AppointmentStatus.NO_SHOW,
          ],
        },
      };
  }
}
