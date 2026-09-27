import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appointmentFind: vi.fn(),
  appointmentUpdateOne: vi.fn(),
  appointmentCounterUpdate: vi.fn(),
  customerCounterUpdate: vi.fn(),
  generateAppointmentNumber: vi.fn(),
  generateCustomerNumber: vi.fn(),
  userFind: vi.fn(),
  userUpdateOne: vi.fn(),
}));

vi.mock('../models/Appointment.js', () => ({
  Appointment: {
    find: mocks.appointmentFind,
    updateOne: mocks.appointmentUpdateOne,
  },
}));

vi.mock('../models/Config.js', () => ({
  AppointmentNumberCounter: { findOneAndUpdate: mocks.appointmentCounterUpdate },
  CustomerNumberCounter: { findOneAndUpdate: mocks.customerCounterUpdate },
}));

vi.mock('../models/User.js', () => ({
  User: {
    find: mocks.userFind,
    updateOne: mocks.userUpdateOne,
  },
}));

vi.mock('../utils/publicIdentifiers.js', () => ({
  generateAppointmentNumber: mocks.generateAppointmentNumber,
  generateCustomerNumber: mocks.generateCustomerNumber,
}));

import { backfillPublicIdentifiers } from './publicIdentifierBackfill.js';

function queryReturning<T>(value: T) {
  const query = {
    lean: vi.fn().mockResolvedValue(value),
    select: vi.fn(),
    sort: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.sort.mockReturnValue(query);
  return query;
}

describe('public identifier backfill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does no counter work when every legacy record is already numbered', async () => {
    mocks.userFind.mockReturnValueOnce(queryReturning([]));
    mocks.appointmentFind.mockReturnValueOnce(queryReturning([]));

    await expect(backfillPublicIdentifiers()).resolves.toEqual({ customers: 0, appointments: 0 });
    expect(mocks.customerCounterUpdate).not.toHaveBeenCalled();
    expect(mocks.appointmentCounterUpdate).not.toHaveBeenCalled();
  });

  it('synchronizes counters and assigns IDs to missing legacy records', async () => {
    mocks.userFind
      .mockReturnValueOnce(queryReturning([{ _id: 'customer-1', createdAt: new Date('2024-06-01T00:00:00Z') }]))
      .mockReturnValueOnce(queryReturning([{ customerNumber: 'CUS-2024-000009' }]));
    mocks.appointmentFind
      .mockReturnValueOnce(queryReturning([{ _id: 'appointment-1', date: '2026-09-27' }]))
      .mockReturnValueOnce(queryReturning([{ appointmentNumber: 'APT-20260927-0042' }]));
    mocks.generateCustomerNumber.mockResolvedValue('CUS-2024-000010');
    mocks.generateAppointmentNumber.mockResolvedValue('APT-20260927-0043');
    mocks.userUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mocks.appointmentUpdateOne.mockResolvedValue({ modifiedCount: 1 });

    await expect(backfillPublicIdentifiers()).resolves.toEqual({ customers: 1, appointments: 1 });

    expect(mocks.customerCounterUpdate).toHaveBeenCalledWith(
      { year: 2024 },
      { $max: { lastSeq: 9 } },
      { upsert: true, setDefaultsOnInsert: true },
    );
    expect(mocks.appointmentCounterUpdate).toHaveBeenCalledWith(
      { date: '2026-09-27' },
      { $max: { lastSeq: 42 } },
      { upsert: true, setDefaultsOnInsert: true },
    );
    expect(mocks.generateCustomerNumber).toHaveBeenCalledWith(2024);
    expect(mocks.generateAppointmentNumber).toHaveBeenCalledWith('2026-09-27');
    expect(mocks.userUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'customer-1' }),
      { $set: { customerNumber: 'CUS-2024-000010' } },
    );
    expect(mocks.appointmentUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'appointment-1' }),
      { $set: { appointmentNumber: 'APT-20260927-0043' } },
    );
  });
});
