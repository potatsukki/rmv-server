import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appointmentFindById: vi.fn(),
  projectItems: [] as Array<{ _id: string; title?: string }>,
  getConfigValue: vi.fn(),
  computeRoute: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Appointment: {
    findById: (id: string) => ({ select: () => ({ lean: () => mocks.appointmentFindById(id) }) }),
  },
  ProjectItem: {
    find: () => ({ sort: () => ({ select: () => ({ lean: async () => mocks.projectItems }) }) }),
  },
}));
vi.mock('../config/config.service.js', () => ({ getConfigValue: mocks.getConfigValue }));
vi.mock('../maps/maps.service.js', () => ({ computeRoute: mocks.computeRoute }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import {
  calculateDeliveryFee, defaultDeliverySelection, estimateProjectDeliveryFee, tripCost,
} from './delivery-fee.service.js';
import { DEFAULT_DELIVERY_VEHICLE_RATES, describeDeliveryFee, deliveryVehicleRatesSchema } from './delivery-rates.js';
import { DeliveryType } from '../../utils/constants.js';

const RATES = [
  { key: 'l300', label: 'L300', baseFee: 800, baseCoveredKm: 10, perKmRate: 40 },
  { key: 'truck', label: 'Truck', baseFee: 1500, baseCoveredKm: 10, perKmRate: 70 },
];
const project = (deliveryType = DeliveryType.ON_SITE_INSTALLATION) => ({
  _id: 'project-1', deliveryType, ocularAppointmentId: 'ocular-1',
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.projectItems = [];
  mocks.getConfigValue.mockResolvedValue(RATES);
  mocks.appointmentFindById.mockResolvedValue({ customerLocation: { lat: 14.5, lng: 121.2 }, formattedAddress: 'Antipolo' });
  mocks.computeRoute.mockResolvedValue({ distanceKm: 25 });
});

describe('delivery fee formula', () => {
  it('charges the base fee within the covered km, then the rate per extra km', () => {
    expect(tripCost(RATES[0]!, 8)).toBe(800);
    expect(tripCost(RATES[0]!, 25)).toBe(800 + 15 * 40);
  });

  it('adds hauling trips and daily crew trips', () => {
    const defaults = defaultDeliverySelection(DeliveryType.ON_SITE_INSTALLATION, 3, RATES);
    const fee = calculateDeliveryFee(25, {}, RATES, defaults);
    // Hauling: 1 truck trip = 1500 + 15×70 = 2550. Crew: 3 days × (800 + 15×40) = 4200.
    expect(fee).toMatchObject({
      haulingVehicle: 'truck', haulingTrips: 1, hauling: 2550,
      crewVehicle: 'l300', crewDays: 3, crew: 4200,
      computedAmount: 6750,
    });
  });

  it('counts no crew days by default for shop-fabricated work', () => {
    const defaults = defaultDeliverySelection(DeliveryType.SHOP_FABRICATED, 10, RATES);
    expect(defaults).toMatchObject({ haulingTrips: 1, crewDays: 0 });
    expect(calculateDeliveryFee(25, {}, RATES, defaults).computedAmount).toBe(2550);
  });

  it('uses the engineer choices and clamps bad counts', () => {
    const defaults = defaultDeliverySelection(DeliveryType.ON_SITE_INSTALLATION, 3, RATES);
    const fee = calculateDeliveryFee(25, { haulingVehicle: 'l300', haulingTrips: 2, crewDays: -4 }, RATES, defaults);
    expect(fee).toMatchObject({ haulingVehicle: 'l300', haulingTrips: 2, hauling: 2800, crewDays: 0, crew: 0 });
  });

  it('falls back to the default vehicle for an unknown key', () => {
    const defaults = defaultDeliverySelection(DeliveryType.SHOP_FABRICATED, undefined, RATES);
    expect(calculateDeliveryFee(5, { haulingVehicle: 'jeep' }, RATES, defaults).haulingVehicle).toBe('truck');
  });
});

describe('delivery fee estimate', () => {
  it('computes the fee from the ocular site pin', async () => {
    const estimate = await estimateProjectDeliveryFee(project(), { workingDays: 3 });
    expect(mocks.computeRoute).toHaveBeenCalledWith({ lat: 14.5, lng: 121.2 });
    expect(estimate).toMatchObject({ available: true, siteAddress: 'Antipolo', breakdown: { distanceKm: 25, computedAmount: 6750 } });
  });

  it('asks for a manual amount when there is no site pin', async () => {
    mocks.appointmentFindById.mockResolvedValue({});
    const estimate = await estimateProjectDeliveryFee(project(), {});
    expect(estimate).toMatchObject({ available: false, reason: 'no_site_location' });
    expect(mocks.computeRoute).not.toHaveBeenCalled();
  });

  it('asks for a manual amount when the route lookup fails', async () => {
    mocks.computeRoute.mockRejectedValue(new Error('ORS down'));
    expect(await estimateProjectDeliveryFee(project(), {})).toMatchObject({ available: false, reason: 'route_unavailable' });
  });

  it('charges delivery once per project, on the first item', async () => {
    mocks.projectItems = [{ _id: 'item-1', title: 'Gate' }, { _id: 'item-2', title: 'Railing' }];
    expect(await estimateProjectDeliveryFee(project(), { projectItemId: 'item-2' }))
      .toMatchObject({ available: false, reason: 'charged_on_other_item', primaryItemTitle: 'Gate' });
    expect(await estimateProjectDeliveryFee(project(), { projectItemId: 'item-1' })).toMatchObject({ available: true });
  });

  it('uses the default rates when the stored config is invalid', async () => {
    mocks.getConfigValue.mockResolvedValue([{ key: 'bad' }]);
    const estimate = await estimateProjectDeliveryFee(project(), {});
    expect(estimate.vehicles).toEqual(DEFAULT_DELIVERY_VEHICLE_RATES);
  });
});

describe('delivery rates config and label', () => {
  it('rejects duplicate vehicle keys and negative rates', () => {
    expect(deliveryVehicleRatesSchema.safeParse([RATES[0], RATES[0]]).success).toBe(false);
    expect(deliveryVehicleRatesSchema.safeParse([{ ...RATES[0], perKmRate: -1 }]).success).toBe(false);
    expect(deliveryVehicleRatesSchema.safeParse(RATES).success).toBe(true);
  });

  it('describes the fee for the contract and the customer', () => {
    expect(describeDeliveryFee({
      distanceKm: 25, haulingVehicle: 'truck', haulingTrips: 1, crewVehicle: 'l300', crewDays: 3, ratesSnapshot: RATES,
    })).toBe('Delivery / Mobilization (25 km · Truck ×1 trip + crew 3 days)');
    expect(describeDeliveryFee(undefined)).toBe('Other Fees');
  });
});
