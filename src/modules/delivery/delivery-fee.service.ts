import { Appointment, ProjectItem } from '../../models/index.js';
import { DeliveryType } from '../../utils/constants.js';
import { logger } from '../../utils/logger.js';
import { getConfigValue } from '../config/config.service.js';
import { computeRoute } from '../maps/maps.service.js';
import {
  DEFAULT_DELIVERY_VEHICLE_RATES, DELIVERY_VEHICLE_RATES_KEY, deliveryVehicleRatesSchema,
  type DeliveryVehicleRate,
} from './delivery-rates.js';

export interface DeliveryFeeSelection {
  haulingVehicle?: string;
  haulingTrips?: number;
  crewVehicle?: string;
  crewDays?: number;
}

export interface DeliveryFeeBreakdown {
  distanceKm: number;
  haulingVehicle: string;
  haulingTrips: number;
  haulingTripCost: number;
  hauling: number;
  crewVehicle: string;
  crewDays: number;
  crewTripCost: number;
  crew: number;
  computedAmount: number;
  ratesSnapshot: DeliveryVehicleRate[];
}

interface ProjectLike {
  _id: unknown;
  deliveryType?: string;
  ocularAppointmentId?: unknown;
  appointmentId?: unknown;
}

const MAX_TRIPS = 50;
const MAX_CREW_DAYS = 365;

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function clampCount(value: unknown, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(parsed)));
}

export async function getDeliveryVehicleRates(): Promise<DeliveryVehicleRate[]> {
  const stored = await getConfigValue<unknown>(DELIVERY_VEHICLE_RATES_KEY, DEFAULT_DELIVERY_VEHICLE_RATES);
  const parsed = deliveryVehicleRatesSchema.safeParse(stored);
  if (!parsed.success) {
    logger.warn('Invalid delivery_vehicle_rates config, using defaults', { issues: parsed.error.issues });
    return DEFAULT_DELIVERY_VEHICLE_RATES;
  }
  return parsed.data;
}

/** One trip: base fee covers the first km, then a rate per extra km (one-way road distance). */
export function tripCost(rate: DeliveryVehicleRate, distanceKm: number) {
  return roundMoney(rate.baseFee + Math.max(0, distanceKm - rate.baseCoveredKm) * rate.perKmRate);
}

/**
 * Default trips and crew days: one hauling trip for every project; on-site installation also
 * counts a crew trip for each working day.
 */
export function defaultDeliverySelection(
  deliveryType: string | undefined,
  workingDays: number | undefined,
  rates: DeliveryVehicleRate[],
): Required<DeliveryFeeSelection> {
  const hauling = rates[rates.length - 1] ?? rates[0];
  const crew = rates[0];
  return {
    haulingVehicle: hauling?.key ?? '',
    haulingTrips: 1,
    crewVehicle: crew?.key ?? '',
    crewDays: deliveryType === DeliveryType.ON_SITE_INSTALLATION ? clampCount(workingDays, 0, MAX_CREW_DAYS) : 0,
  };
}

export function calculateDeliveryFee(
  distanceKm: number,
  selection: DeliveryFeeSelection,
  rates: DeliveryVehicleRate[],
  defaults: Required<DeliveryFeeSelection>,
): DeliveryFeeBreakdown {
  const findRate = (key: string | undefined, fallbackKey: string) =>
    rates.find((rate) => rate.key === key) ?? rates.find((rate) => rate.key === fallbackKey) ?? rates[0]!;

  const haulingRate = findRate(selection.haulingVehicle, defaults.haulingVehicle);
  const crewRate = findRate(selection.crewVehicle, defaults.crewVehicle);
  const haulingTrips = clampCount(selection.haulingTrips, defaults.haulingTrips, MAX_TRIPS);
  const crewDays = clampCount(selection.crewDays, defaults.crewDays, MAX_CREW_DAYS);
  const km = Number(distanceKm.toFixed(2));
  const haulingTripCost = tripCost(haulingRate, km);
  const crewTripCost = tripCost(crewRate, km);
  const hauling = roundMoney(haulingTrips * haulingTripCost);
  const crew = roundMoney(crewDays * crewTripCost);

  return {
    distanceKm: km,
    haulingVehicle: haulingRate.key,
    haulingTrips,
    haulingTripCost,
    hauling,
    crewVehicle: crewRate.key,
    crewDays,
    crewTripCost,
    crew,
    computedAmount: roundMoney(hauling + crew),
    ratesSnapshot: [haulingRate, crewRate].filter((rate, index, list) => list.findIndex((r) => r.key === rate.key) === index),
  };
}

/** The project site pin, taken from the ocular visit (or the source appointment). */
export async function resolveProjectSiteLocation(project: ProjectLike) {
  const appointmentIds = [project.ocularAppointmentId, project.appointmentId].filter(Boolean);
  for (const appointmentId of appointmentIds) {
    const appointment = await Appointment.findById(appointmentId)
      .select('customerLocation latitude longitude formattedAddress customerAddress')
      .lean();
    const lat = appointment?.customerLocation?.lat ?? appointment?.latitude;
    const lng = appointment?.customerLocation?.lng ?? appointment?.longitude;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return {
        lat: lat as number,
        lng: lng as number,
        address: appointment?.formattedAddress || appointment?.customerAddress || '',
      };
    }
  }
  return null;
}

/** Delivery is charged once per project, on its first item. */
export async function resolveDeliveryChargeItem(projectId: unknown, projectItemId?: string) {
  const items = await ProjectItem.find({ projectId: String(projectId) }).sort({ createdAt: 1 }).select('_id title').lean();
  if (items.length <= 1) return { chargedHere: true as const };
  const primary = items[0]!;
  if (projectItemId && String(primary._id) === projectItemId) return { chargedHere: true as const };
  return { chargedHere: false as const, primaryItemTitle: primary.title || 'Item 1' };
}

export type DeliveryFeeEstimate =
  | {
    available: true;
    siteAddress: string;
    defaults: Required<DeliveryFeeSelection>;
    breakdown: DeliveryFeeBreakdown;
    vehicles: DeliveryVehicleRate[];
  }
  | {
    available: false;
    reason: 'no_site_location' | 'route_unavailable' | 'charged_on_other_item';
    message: string;
    primaryItemTitle?: string;
    vehicles: DeliveryVehicleRate[];
  };

export async function estimateProjectDeliveryFee(
  project: ProjectLike,
  options: DeliveryFeeSelection & { projectItemId?: string; workingDays?: number },
): Promise<DeliveryFeeEstimate> {
  const vehicles = await getDeliveryVehicleRates();

  const chargeItem = await resolveDeliveryChargeItem(project._id, options.projectItemId);
  if (!chargeItem.chargedHere) {
    return {
      available: false,
      reason: 'charged_on_other_item',
      message: `Delivery / mobilization is charged once per project, on "${chargeItem.primaryItemTitle}".`,
      primaryItemTitle: chargeItem.primaryItemTitle,
      vehicles,
    };
  }

  const site = await resolveProjectSiteLocation(project);
  if (!site) {
    return {
      available: false,
      reason: 'no_site_location',
      message: 'No site location on file. Enter the delivery fee manually.',
      vehicles,
    };
  }

  let distanceKm: number;
  try {
    distanceKm = (await computeRoute({ lat: site.lat, lng: site.lng })).distanceKm;
  } catch (error) {
    logger.warn('Delivery fee route lookup failed', { projectId: String(project._id), error });
    return {
      available: false,
      reason: 'route_unavailable',
      message: 'Unable to compute the road distance right now. Enter the delivery fee manually or try again.',
      vehicles,
    };
  }

  const defaults = defaultDeliverySelection(project.deliveryType, options.workingDays, vehicles);
  return {
    available: true,
    siteAddress: site.address,
    defaults,
    breakdown: calculateDeliveryFee(distanceKm, options, vehicles, defaults),
    vehicles,
  };
}
