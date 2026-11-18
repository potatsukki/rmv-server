import { z } from 'zod';

/** Config key for the per-vehicle delivery / mobilization rates (editable by admin). */
export const DELIVERY_VEHICLE_RATES_KEY = 'delivery_vehicle_rates';

export const deliveryVehicleRateSchema = z.object({
  key: z.string().trim().min(1).max(40).regex(/^[a-z0-9_-]+$/, 'Use lowercase letters, numbers, - or _'),
  label: z.string().trim().min(1).max(80),
  baseFee: z.coerce.number().min(0),
  baseCoveredKm: z.coerce.number().min(0),
  perKmRate: z.coerce.number().min(0),
});

export const deliveryVehicleRatesSchema = z.array(deliveryVehicleRateSchema)
  .min(1, 'Add at least one vehicle')
  .max(10)
  .refine((rates) => new Set(rates.map((rate) => rate.key)).size === rates.length, 'Vehicle keys must be unique');

export type DeliveryVehicleRate = z.infer<typeof deliveryVehicleRateSchema>;

interface DeliveryFeeSummaryInput {
  distanceKm?: number | null;
  haulingVehicle?: string;
  haulingTrips?: number;
  crewVehicle?: string;
  crewDays?: number;
  ratesSnapshot?: Array<{ key?: string; label?: string }>;
}

/** e.g. "Delivery / Mobilization (18.4 km · Truck ×1 trip + crew 3 days)" for the contract and customer view. */
export function describeDeliveryFee(fee?: DeliveryFeeSummaryInput | null) {
  if (!fee) return 'Other Fees';
  const label = (key?: string) => fee.ratesSnapshot?.find((rate) => rate.key === key)?.label || key || '';
  const parts: string[] = [];
  if (fee.haulingTrips) parts.push(`${label(fee.haulingVehicle)} ×${fee.haulingTrips} trip${fee.haulingTrips === 1 ? '' : 's'}`.trim());
  if (fee.crewDays) parts.push(`crew ${fee.crewDays} day${fee.crewDays === 1 ? '' : 's'}`);
  const distance = typeof fee.distanceKm === 'number' ? `${fee.distanceKm} km` : '';
  const detail = [distance, parts.join(' + ')].filter(Boolean).join(' · ');
  return detail ? `Delivery / Mobilization (${detail})` : 'Delivery / Mobilization';
}

/** Placeholder rates until RMV sets the real ones in Settings. */
export const DEFAULT_DELIVERY_VEHICLE_RATES: DeliveryVehicleRate[] = [
  { key: 'l300', label: 'L300 / Light Van', baseFee: 800, baseCoveredKm: 10, perKmRate: 40 },
  { key: 'truck', label: 'Truck (Elf / 6-Wheeler)', baseFee: 1500, baseCoveredKm: 10, perKmRate: 70 },
];
