import { beforeEach, describe, expect, it, vi } from 'vitest';

const { slots } = vi.hoisted(() => ({ slots: vi.fn() }));
vi.mock('./appointments.service.js', () => ({ getAvailableSlots: slots }));
vi.mock('../../services/sales-notes.service.js', () => ({ updateAppointmentSalesNotes: vi.fn() }));

import { getAvailableSlots } from './appointments.controller.js';
import { Role } from '../../utils/constants.js';

beforeEach(() => { vi.clearAllMocks(); slots.mockResolvedValue({ slots: [] }); });

async function invoke(roles: Role[], query: Record<string, string>) {
  const res = { set: vi.fn(), json: vi.fn() };
  const next = vi.fn();
  getAvailableSlots({ userId: 'signed-in-customer', userRoles: roles, query } as never, res as never, next);
  await vi.waitFor(() => expect(res.json.mock.calls.length + next.mock.calls.length).toBeGreaterThan(0));
  expect(next).not.toHaveBeenCalled();
}

describe('customer slot reservation identity', () => {
  it('uses the authenticated customer and ignores a supplied customer identity', async () => {
    await invoke([Role.CUSTOMER], {
      date: '2026-11-26', type: 'office', flow: 'customer_booking',
      customerId: 'another-customer', salesStaffId: 'another-staff',
    });
    expect(slots).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-11-26', flow: 'customer_booking' }), 'signed-in-customer');
    expect(slots.mock.calls[0]?.[0]).not.toHaveProperty('salesStaffId');
  });

  it('keeps staff availability separate from customer reservation flags', async () => {
    await invoke([Role.ADMIN], { date: '2026-11-26', type: 'office', flow: 'customer_booking', salesStaffId: 'staff-1' });
    expect(slots).toHaveBeenCalledWith({ date: '2026-11-26', type: 'office', salesStaffId: 'staff-1' }, undefined);
  });
});
