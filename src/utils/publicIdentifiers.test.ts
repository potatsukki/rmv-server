import { describe, expect, it, vi } from 'vitest';

const { customerCounter, appointmentCounter } = vi.hoisted(() => ({
  customerCounter: vi.fn(),
  appointmentCounter: vi.fn(),
}));

vi.mock('../models/Config.js', () => ({
  CustomerNumberCounter: { findOneAndUpdate: customerCounter },
  AppointmentNumberCounter: { findOneAndUpdate: appointmentCounter },
}));

import {
  formatAppointmentNumber,
  formatCustomerNumber,
  generateAppointmentNumber,
  generateCustomerNumber,
} from './publicIdentifiers.js';

describe('public identifiers', () => {
  it('formats customer and appointment numbers for people to read', () => {
    expect(formatCustomerNumber(2026, 1)).toBe('CUS-2026-000001');
    expect(formatAppointmentNumber('2026-09-27', 42)).toBe('APT-20260927-0042');
  });

  it('uses atomic counters for new identifiers', async () => {
    customerCounter.mockResolvedValueOnce({ lastSeq: 12 });
    appointmentCounter.mockResolvedValueOnce({ lastSeq: 7 });

    await expect(generateCustomerNumber(2026)).resolves.toBe('CUS-2026-000012');
    await expect(generateAppointmentNumber('2026-09-27')).resolves.toBe('APT-20260927-0007');

    expect(customerCounter).toHaveBeenCalledWith(
      { year: 2026 },
      { $inc: { lastSeq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    expect(appointmentCounter).toHaveBeenCalledWith(
      { date: '2026-09-27' },
      { $inc: { lastSeq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
  });
});
