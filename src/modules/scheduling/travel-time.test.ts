import { describe, expect, it } from 'vitest';
import { SLOT_CODES } from '../../utils/constants.js';
import { describeOcularSchedule, describeOcularSchedulesBySlot } from './travel-time.js';

describe('describeOcularSchedule (the schedule every screen shows)', () => {
  it('the QA site, 48 min / 41 km at 10:00: prep 7:45, leave 8:00, measure 10:00–11:30, back 1:30 PM', () => {
    expect(describeOcularSchedule('10:00', { travelDurationMinutes: 48, distanceKm: 41 })).toEqual({
      travelMinutes: 48,
      roundedTravelMinutes: 60,
      travelLabel: '1 hr',
      distanceKm: 41,
      trafficMinutes: 60,
      nearShop: false,
      prepMinutes: 15,
      siteMinutes: 90,
      prepFrom: '7:45 AM',
      leaveAt: '8:00 AM',
      onSiteStart: '10:00 AM',
      onSiteEnd: '11:30 AM',
      backAt: '1:30 PM',
      endsAfterWorkday: false,
    });
  });

  it('a site near the shop (10 min / 3 km at 1 PM) gets no traffic allowance', () => {
    expect(describeOcularSchedule('13:00', { travelDurationMinutes: 10, distanceKm: 3 })).toMatchObject({
      travelLabel: '30 min', nearShop: true, trafficMinutes: 0, prepFrom: '12:15 PM', leaveAt: '12:30 PM', backAt: '3:00 PM',
    });
  });

  it('warns (does not block) when the staff gets back after 5:00 PM', () => {
    // 4 PM, far site: back 7:30 PM.
    expect(describeOcularSchedule('16:00', { travelDurationMinutes: 45, distanceKm: 18 }))
      .toMatchObject({ backAt: '7:30 PM', endsAfterWorkday: true });
    // 1 PM near site: back exactly 3:00 PM.
    expect(describeOcularSchedule('13:00', { travelDurationMinutes: 10, distanceKm: 3 })?.endsAfterWorkday).toBe(false);
  });

  it('is null without a route (no site pin) or without a slot', () => {
    expect(describeOcularSchedule('10:00', {})).toBeNull();
    expect(describeOcularSchedule('10:00', null)).toBeNull();
    expect(describeOcularSchedule(undefined, { travelDurationMinutes: 30, distanceKm: 10 })).toBeNull();
  });
});

describe('describeOcularSchedulesBySlot (Schedule Ocular dialog, before a time is picked)', () => {
  it('gives the schedule for every bookable slot', () => {
    const schedules = describeOcularSchedulesBySlot({ travelDurationMinutes: 48, distanceKm: 41 });

    expect(Object.keys(schedules)).toEqual([...SLOT_CODES]);
    expect(schedules['10:00']).toMatchObject({ leaveAt: '8:00 AM', backAt: '1:30 PM' });
    expect(schedules['16:00']?.endsAfterWorkday).toBe(true);
  });

  it('is empty without a route', () => {
    expect(describeOcularSchedulesBySlot(undefined)).toEqual({});
  });
});
