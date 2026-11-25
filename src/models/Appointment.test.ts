import mongoose from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { generateAppointmentNumber } = vi.hoisted(() => ({ generateAppointmentNumber: vi.fn() }));
vi.mock('../utils/publicIdentifiers.js', () => ({ generateAppointmentNumber }));

import { Appointment } from './Appointment.js';
import { AppointmentStatus, AppointmentType } from '../utils/constants.js';

describe('Appointment number (APT-YYYYMMDD-NNNN)', () => {
  afterEach(() => vi.clearAllMocks());

  const booking = () => ({
    customerId: new mongoose.Types.ObjectId(),
    bookedBy: new mongoose.Types.ObjectId(),
    type: AppointmentType.OFFICE,
    date: '2026-11-25',
    slotCode: '09:00',
  });

  it('gives a new appointment a number for its date', async () => {
    generateAppointmentNumber.mockResolvedValueOnce('APT-20261125-0001');
    const appointment = new Appointment(booking());

    await appointment.validate();

    expect(generateAppointmentNumber).toHaveBeenCalledWith('2026-11-25');
    expect(appointment.appointmentNumber).toBe('APT-20261125-0001');
  });

  it('never renumbers a record loaded without its number (a field list), as the auto-start job loads it', async () => {
    const partial = Appointment.hydrate(
      { _id: new mongoose.Types.ObjectId(), date: '2026-11-25', status: AppointmentStatus.CONFIRMED },
      { date: 1, status: 1 },
    );
    partial.status = AppointmentStatus.COMPLETED;

    await partial.validate();

    expect(generateAppointmentNumber).not.toHaveBeenCalled();
    expect(partial.appointmentNumber).toBeUndefined();
    expect(partial.isModified('appointmentNumber')).toBe(false);
  });

  it('keeps the number of a fully loaded appointment', async () => {
    const full = Appointment.hydrate({ _id: new mongoose.Types.ObjectId(), ...booking(), appointmentNumber: 'APT-20261125-0003' });
    full.status = AppointmentStatus.COMPLETED;

    await full.validate();

    expect(generateAppointmentNumber).not.toHaveBeenCalled();
    expect(full.appointmentNumber).toBe('APT-20261125-0003');
  });
});
