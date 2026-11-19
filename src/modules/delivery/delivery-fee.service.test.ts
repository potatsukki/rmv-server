import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectItems: [] as Array<{ _id: string; title?: string }>,
}));

vi.mock('../../models/index.js', () => ({
  ProjectItem: {
    find: () => ({ sort: () => ({ select: () => ({ lean: async () => mocks.projectItems }) }) }),
  },
}));

import { getDeliveryChargeInfo } from './delivery-fee.service.js';
import { THIRD_PARTY_DELIVERY_LABEL, describeDeliveryFee, deliveryVehicleRatesSchema } from './delivery-rates.js';

const RATES = [
  { key: 'l300', label: 'L300', baseFee: 800, baseCoveredKm: 10, perKmRate: 40 },
  { key: 'truck', label: 'Truck', baseFee: 1500, baseCoveredKm: 10, perKmRate: 70 },
];

beforeEach(() => {
  mocks.projectItems = [];
});

describe('third-party delivery fee item', () => {
  it('charges a single-item project on that item', async () => {
    mocks.projectItems = [{ _id: 'item-1', title: 'Railing' }];
    expect(await getDeliveryChargeInfo('project-1', 'item-1')).toEqual({ chargedHere: true });
  });

  it('charges a multi-item project once, on the first item', async () => {
    mocks.projectItems = [{ _id: 'item-1', title: 'Railing' }, { _id: 'item-2', title: 'Gate' }];
    expect(await getDeliveryChargeInfo('project-1', 'item-1')).toEqual({ chargedHere: true });
    expect(await getDeliveryChargeInfo('project-1', 'item-2')).toMatchObject({
      chargedHere: false,
      primaryItemTitle: 'Railing',
      message: expect.stringContaining('"Railing"'),
    });
  });
});

describe('delivery rates config and label', () => {
  it('rejects duplicate vehicle keys and negative rates', () => {
    expect(deliveryVehicleRatesSchema.safeParse([RATES[0], RATES[0]]).success).toBe(false);
    expect(deliveryVehicleRatesSchema.safeParse([{ ...RATES[0], perKmRate: -1 }]).success).toBe(false);
    expect(deliveryVehicleRatesSchema.safeParse(RATES).success).toBe(true);
  });

  it('labels a manual third-party fee and keeps the old label for auto-computed fees', () => {
    expect(describeDeliveryFee({ distanceKm: null, haulingTrips: 0, crewDays: 0, ratesSnapshot: [] }))
      .toBe(THIRD_PARTY_DELIVERY_LABEL);
    expect(describeDeliveryFee({
      distanceKm: 25, haulingVehicle: 'truck', haulingTrips: 1, crewVehicle: 'l300', crewDays: 3, ratesSnapshot: RATES,
    })).toBe('Delivery / Mobilization (25 km · Truck ×1 trip + crew 3 days)');
    expect(describeDeliveryFee(undefined)).toBe('Other Fees');
  });
});
