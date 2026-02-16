import crypto from 'crypto';
import axios from 'axios';
import { env } from '../../config/env.js';
import { RouteCache, Config } from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import { logger } from '../../utils/logger.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Default fee config (overridable via Config model) ──
interface OcularFeeConfig {
  baseFee: number;
  baseKm: number;
  extraRatePerKm: number;
  maxDistanceKm: number;
}

const DEFAULT_FEE_CONFIG: OcularFeeConfig = {
  baseFee: 500,
  baseKm: 10,
  extraRatePerKm: 30,
  maxDistanceKm: 100,
};

async function getFeeConfig(): Promise<OcularFeeConfig> {
  const config = await Config.findOne({ key: 'ocular_fee_config' });
  if (config) return config.value as OcularFeeConfig;
  return DEFAULT_FEE_CONFIG;
}

// ── RMV Shop Location (Malabon, Philippines) ──
const SHOP_LOCATION = { lat: 14.6617, lng: 120.9567 };

function hashCoords(lat: number, lng: number): string {
  // Round to 4 decimal places for cache key stability (~11m precision)
  const rounded = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  return crypto.createHash('md5').update(rounded).digest('hex');
}

// ── OpenRouteService Directions API ──

interface DirectionsResult {
  distanceKm: number;
  durationMinutes: number;
  hasFerry: boolean;
  polyline?: string;
}

async function fetchDirections(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
): Promise<DirectionsResult> {
  try {
    // ORS expects [lng, lat] order
    const response = await axios.post(
      'https://api.openrouteservice.org/v2/directions/driving-car',
      {
        coordinates: [
          [origin.lng, origin.lat],
          [destination.lng, destination.lat],
        ],
      },
      {
        headers: {
          Authorization: env.ORS_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      },
    );

    const data = response.data;

    if (!data.routes?.length) {
      throw AppError.badRequest(
        'Unable to calculate route. Please verify the address.',
        ErrorCode.NO_ROUTE_FOUND,
      );
    }

    const route = data.routes[0];
    const summary = route.summary;

    // ORS flags ferry segments via way_types or step types
    const hasFerry = route.segments?.some((seg: any) =>
      seg.steps?.some((step: any) => step.type === 6 /* ferry */),
    ) ?? false;

    return {
      distanceKm: summary.distance / 1000,
      durationMinutes: Math.ceil(summary.duration / 60),
      hasFerry,
      polyline: route.geometry, // encoded polyline
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('OpenRouteService API error:', error);
    throw AppError.internal('Failed to compute route. Please try again later.');
  }
}

// ── Cached Route Computation ──

export async function computeRoute(customerLocation: { lat: number; lng: number }) {
  const originHash = hashCoords(SHOP_LOCATION.lat, SHOP_LOCATION.lng);
  const destHash = hashCoords(customerLocation.lat, customerLocation.lng);

  // Check cache
  const cached = await RouteCache.findOne({
    originHash,
    destinationHash: destHash,
    expiresAt: { $gt: new Date() },
  });

  if (cached) {
    return {
      distanceKm: cached.distanceKm,
      durationMinutes: cached.durationMinutes,
      hasFerry: cached.hasFerry,
      cached: true,
    };
  }

  // Fetch from OpenRouteService
  const result = await fetchDirections(SHOP_LOCATION, customerLocation);

  // Reject if ferry is required (sea crossing)
  if (result.hasFerry) {
    throw AppError.badRequest(
      'Unfortunately, we cannot service locations that require a sea/ferry crossing.',
      ErrorCode.FERRY_ROUTE_REJECTED,
    );
  }

  // Cache the result
  await RouteCache.create({
    originHash,
    destinationHash: destHash,
    distanceKm: result.distanceKm,
    durationMinutes: result.durationMinutes,
    hasFerry: result.hasFerry,
    polyline: result.polyline,
    expiresAt: new Date(Date.now() + CACHE_TTL_MS),
  });

  return {
    distanceKm: result.distanceKm,
    durationMinutes: result.durationMinutes,
    hasFerry: result.hasFerry,
    cached: false,
  };
}

// ── Compute Ocular Fee ──

export async function computeOcularFee(customerLocation: { lat: number; lng: number }) {
  const route = await computeRoute(customerLocation);
  const feeConfig = await getFeeConfig();

  if (route.distanceKm > feeConfig.maxDistanceKm) {
    throw AppError.badRequest(
      `Location is too far (${route.distanceKm.toFixed(1)} km). Maximum service distance is ${feeConfig.maxDistanceKm} km.`,
    );
  }

  const extraKm = Math.max(0, route.distanceKm - feeConfig.baseKm);
  const extraFee = Math.ceil(extraKm) * feeConfig.extraRatePerKm;
  const totalFee = feeConfig.baseFee + extraFee;

  // NCR = roughly within 30km of Metro Manila
  const isWithinNCR = route.distanceKm <= 30;

  return {
    route: {
      distanceKm: route.distanceKm,
      durationMinutes: route.durationMinutes,
    },
    fee: {
      base: feeConfig.baseFee,
      baseKm: feeConfig.baseKm,
      extraKm: Math.ceil(extraKm),
      extraRate: feeConfig.extraRatePerKm,
      extraFee,
      total: totalFee,
      isWithinNCR,
    },
  };
}

// ── Nominatim Address Search (OSM – free, no API key) ──

export async function placesAutocomplete(input: string, _sessionToken?: string) {
  try {
    const response = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: {
        q: input,
        format: 'json',
        addressdetails: 1,
        limit: 5,
        countrycodes: 'ph',
      },
      headers: {
        'User-Agent': 'RMV-Stainless-Steel-Fabrication/1.0',
      },
      timeout: 10000,
    });

    return (response.data as any[]).map((p: any) => ({
      placeId: p.place_id?.toString() ?? p.osm_id?.toString() ?? '',
      description: p.display_name,
    }));
  } catch (error) {
    logger.error('Nominatim search error:', error);
    throw AppError.internal('Failed to fetch address suggestions');
  }
}

// ── Nominatim Place Details (get coordinates from Nominatim place ID) ──

export async function placeDetails(placeId: string, _sessionToken?: string) {
  try {
    // Nominatim lookup by place_id or OSM id
    const response = await axios.get('https://nominatim.openstreetmap.org/details', {
      params: {
        place_id: placeId,
        format: 'json',
      },
      headers: {
        'User-Agent': 'RMV-Stainless-Steel-Fabrication/1.0',
      },
      timeout: 10000,
    });

    const data = response.data as any;

    if (!data || !data.centroid) {
      throw AppError.badRequest('Place not found');
    }

    return {
      formattedAddress: data.localname || data.names?.name || 'Unknown address',
      location: {
        lat: data.centroid.coordinates[1],
        lng: data.centroid.coordinates[0],
      },
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('Nominatim details error:', error);
    throw AppError.internal('Failed to fetch place details');
  }
}
