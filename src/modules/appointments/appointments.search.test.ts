import { describe, expect, it } from 'vitest';
import { matchesAppointmentSearch, normalizeAppointmentSearchTerm } from './appointments.search.js';

describe('appointments.search', () => {
  it('normalizes casing and repeated whitespace', () => {
    expect(normalizeAppointmentSearchTerm('  Carl   Ocular  ')).toBe('carl ocular');
  });

  it('matches customer-visible booking fields for customer scope', () => {
    const matched = matchesAppointmentSearch(
      {
        type: 'office',
        status: 'completed',
        consultationReportSubmitted: true,
        date: '2026-08-05',
        slotCode: '16:00',
        formattedAddress: 'Muntinlupa City',
        customerNotes: 'Kitchen cabinet consultation',
        serviceTypes: ['kitchen_cabinet'],
      },
      'august kitchen muntinlupa',
      'customer',
    );

    expect(matched).toBe(true);
  });

  it('matches the permanent appointment number for customer scope', () => {
    expect(matchesAppointmentSearch(
      {
        appointmentNumber: 'APT-20260927-0042',
        type: 'office',
        status: 'confirmed',
      },
      'apt 20260927 0042',
      'customer',
    )).toBe(true);
  });

  it('matches staff-only fields like customer name, sales staff, and project number', () => {
    const matched = matchesAppointmentSearch(
      {
        type: 'ocular',
        status: 'confirmed',
        date: '2026-04-30',
        slotCode: '15:00',
        customerName: 'Carl Johnson',
        salesStaffName: 'Jane Dela Cruz',
        linkedProjects: [
          { projectNumber: 'RMV-2026-00042', title: 'Kitchen Cabinet', serviceType: 'kitchen_cabinet' },
        ],
      },
      'carl rmv 2026 jane',
      'staff',
    );

    expect(matched).toBe(true);
  });

  it('matches the permanent customer number for staff scope', () => {
    expect(matchesAppointmentSearch(
      {
        appointmentNumber: 'APT-20260927-0042',
        customerNumber: 'CUS-2026-000125',
      },
      'cus 2026 000125',
      'staff',
    )).toBe(true);
  });

  it('does not treat completed consultation with submitted report as ready for ocular in search', () => {
    const matched = matchesAppointmentSearch(
      {
        type: 'office',
        status: 'completed',
        consultationReportSubmitted: true,
      },
      'ready ocular',
      'staff',
    );

    expect(matched).toBe(false);
  });

  it('still matches an explicit ready for ocular status', () => {
    expect(matchesAppointmentSearch(
      { type: 'office', status: 'ready_for_ocular' },
      'ready ocular',
      'staff',
    )).toBe(true);
  });

  it('does not use staff-only fields in customer scope', () => {
    const matched = matchesAppointmentSearch(
      {
        type: 'office',
        status: 'requested',
        customerName: 'Carl Johnson',
        linkedProjects: [{ projectNumber: 'RMV-2026-00042' }],
      },
      'rmv 2026',
      'customer',
    );

    expect(matched).toBe(false);
  });
});
