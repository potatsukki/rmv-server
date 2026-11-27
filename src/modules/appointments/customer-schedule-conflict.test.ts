import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appointmentFind: vi.fn(),
  projectFindOne: vi.fn(),
  projectFind: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Appointment: { find: mocks.appointmentFind },
  Project: { findOne: mocks.projectFindOne, find: mocks.projectFind },
  AvailabilitySession: {},
  SalesAvailability: {},
}));

import { AppointmentStatus, AppointmentType } from '../../utils/constants.js';
import { assertCustomerScheduleFree, findCustomerScheduleConflict, getCustomerBookedSlots } from './customer-schedule-conflict.js';

type Row = { _id: string; appointmentNumber?: string; type: AppointmentType; date: string; slotCode: string; status: AppointmentStatus };

/** The customer's appointments the database returns for the requested date. */
function customerHas(rows: Row[], projectNumber?: string) {
  mocks.appointmentFind.mockReturnValue({ select: () => ({ sort: () => ({ lean: async () => rows }) }) });
  mocks.projectFindOne.mockReturnValue({ select: () => ({ lean: async () => (projectNumber ? { projectNumber } : null) }) });
  mocks.projectFind.mockReturnValue({ select: () => ({ lean: async () => (projectNumber && rows[0] ? [{ projectNumber, ocularAppointmentId: rows[0]._id }] : []) }) });
}

const consultation: Row = {
  _id: 'consultation-1', appointmentNumber: 'APT-20261118-0004', type: AppointmentType.OFFICE,
  date: '2026-11-18', slotCode: '09:00', status: AppointmentStatus.CONFIRMED,
};
const ocular: Row = {
  _id: 'ocular-1', appointmentNumber: 'APT-20261118-0002', type: AppointmentType.OCULAR,
  date: '2026-11-18', slotCode: '09:00', status: AppointmentStatus.COMPLETED,
};

describe('customer schedule conflict', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an ocular visit at the same start time as the customer\'s consultation, whoever the staff are', async () => {
    customerHas([consultation]);

    await expect(assertCustomerScheduleFree({
      customerId: 'customer-1', date: '2026-11-18', slotCode: '09:00', incomingType: AppointmentType.OCULAR, audience: 'staff',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CUSTOMER_SCHEDULE_CONFLICT',
      message: 'This customer already has a consultation on Nov 18, 2026, 9:00 AM to 10:00 AM (APT-20261118-0004 · Confirmed). '
        + 'An ocular visit on Nov 18, 2026 at 9:00 AM would overlap it. Choose a different date or time.',
      details: {
        conflictAppointmentId: 'consultation-1',
        conflictAppointmentNumber: 'APT-20261118-0004',
        conflictAppointmentType: AppointmentType.OFFICE,
        conflictAppointmentStatus: AppointmentStatus.CONFIRMED,
        conflictDate: '2026-11-18',
        conflictSlotCode: '09:00',
        requestedDate: '2026-11-18',
        requestedSlotCode: '09:00',
      },
    });
  });

  it('tells the customer which ocular visit and project is in the way of their consultation booking', async () => {
    customerHas([ocular], 'PRJ-2026-00101');

    await expect(assertCustomerScheduleFree({
      customerId: 'customer-1', date: '2026-11-18', slotCode: '09:00', incomingType: AppointmentType.OFFICE,
    })).rejects.toMatchObject({
      message: 'You already have an ocular visit on Nov 18, 2026, 9:00 AM to 10:00 AM (APT-20261118-0002 · Completed · PRJ-2026-00101). '
        + 'A consultation on Nov 18, 2026 at 9:00 AM would overlap it. Please choose a different date or time.',
      details: expect.objectContaining({ conflictProjectNumber: 'PRJ-2026-00101' }),
    });
  });

  it('treats each appointment as one hour: a partial overlap blocks, the next free hour does not', async () => {
    // A visit recorded at 9:30 runs to 10:30.
    customerHas([{ ...consultation, slotCode: '09:30' }]);

    for (const slotCode of ['09:00', '10:00']) {
      await expect(assertCustomerScheduleFree({
        customerId: 'customer-1', date: '2026-11-18', slotCode, incomingType: AppointmentType.OCULAR, audience: 'staff',
      })).rejects.toThrow('9:30 AM to 10:30 AM');
    }
    await expect(findCustomerScheduleConflict('customer-1', '2026-11-18', '11:00')).resolves.toBeNull();

    // Back-to-back hours do not overlap.
    customerHas([consultation]);
    await expect(findCustomerScheduleConflict('customer-1', '2026-11-18', '10:00')).resolves.toBeNull();
  });

  // A finished appointment gives the time back (user decision 2026-11-27, "kung declined or completed
  // dapat balik na to sa vacant"): cancelled, no-show, completed (incl. Customer Declined and an
  // office No Show, both stored as completed) and a consultation finished as Ready for Ocular.
  const freedTimeFilter = {
    status: { $nin: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW, AppointmentStatus.COMPLETED, AppointmentStatus.READY_FOR_OCULAR] },
  };

  it('only looks at this customer on this date; cancelled, no-show and finished appointments never block', async () => {
    customerHas([]);

    await expect(assertCustomerScheduleFree({
      customerId: 'customer-1', date: '2026-11-18', slotCode: '09:00', incomingType: AppointmentType.OFFICE,
    })).resolves.toBeUndefined();

    expect(mocks.appointmentFind).toHaveBeenCalledExactlyOnceWith({
      customerId: 'customer-1',
      date: '2026-11-18',
      ...freedTimeFilter,
    });
    expect(mocks.projectFindOne).not.toHaveBeenCalled();
  });

  it('leaves the appointment being moved out of the comparison', async () => {
    customerHas([]);

    await findCustomerScheduleConflict('customer-1', '2026-11-18', '09:00', ['appointment-being-moved']);

    expect(mocks.appointmentFind).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      _id: { $nin: ['appointment-being-moved'] },
    }));
  });

  it('marks exact and partial overlaps once per customer/date, while leaving adjacent slots free', async () => {
    customerHas([{ ...consultation, slotCode: '09:30', status: AppointmentStatus.REQUESTED }]);
    const booked = await getCustomerBookedSlots('customer-1', '2026-11-18', ['09:00', '10:00', '11:00']);
    expect([...booked.keys()]).toEqual(['09:00', '10:00']);
    expect(mocks.appointmentFind).toHaveBeenCalledExactlyOnceWith({
      customerId: 'customer-1', date: '2026-11-18',
      ...freedTimeFilter,
    });
    expect(mocks.projectFindOne).not.toHaveBeenCalled();
  });

  it('leaves finished appointments out of the query, so their hours are vacant again', async () => {
    customerHas([]);
    expect([...(await getCustomerBookedSlots('customer-1', '2026-11-18', ['09:00', '10:00'])).keys()]).toEqual([]);
    const filter = mocks.appointmentFind.mock.calls[0]![0] as { status: { $nin: string[] } };
    for (const finished of [AppointmentStatus.COMPLETED, AppointmentStatus.READY_FOR_OCULAR]) {
      expect(filter.status.$nin).toContain(finished);
    }
    for (const upcoming of [AppointmentStatus.REQUESTED, AppointmentStatus.CONFIRMED, AppointmentStatus.IN_PROGRESS]) {
      expect(filter.status.$nin).not.toContain(upcoming);
    }
  });

  // User request 2026-11-27: the customer can click their own "Already booked" slot and see it.
  it("names the customer's own appointment (and its project) behind each booked slot", async () => {
    customerHas([{ ...ocular, status: AppointmentStatus.CONFIRMED }], 'PRJ-2026-00101');
    const booked = await getCustomerBookedSlots('customer-1', '2026-11-18', ['09:00', '10:00']);
    expect(booked.get('09:00')).toEqual({
      appointmentId: 'ocular-1', appointmentNumber: 'APT-20261118-0002', type: AppointmentType.OCULAR,
      date: '2026-11-18', slotCode: '09:00', status: AppointmentStatus.CONFIRMED, attendanceStatus: undefined,
      salesStaffAssigned: false, projectNumber: 'PRJ-2026-00101',
    });
    expect(booked.has('10:00')).toBe(false);
  });
});
