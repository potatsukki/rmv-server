import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point } from '@turf/helpers';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { env } from '../../config/env.js';
import { Config, RouteCache } from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import { logger } from '../../utils/logger.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface OcularSettings {
  shopLatitude: number;
  shopLongitude: number;
  baseCoveredKm: number;
  baseFee: number;
  perKmRate: number;
  maxDistanceKm: number;
  ncrPolygonFile: string;
}

interface LegacyOcularFeeConfig {
  baseFee?: number;
  baseKm?: number;
  extraRatePerKm?: number;
  maxDistanceKm?: number;
}

interface LatLng {
  lat: number;
  lng: number;
}

interface DirectionsResult {
  distanceKm: number;
  durationMinutes: number;
  polyline?: string;
}

const DEFAULT_SETTINGS: OcularSettings = {
  // Exact Plus Code: M3X3+RF4, Dahlia Ext, Quezon City, Metro Manila
  shopLatitude: 14.6995125,
  shopLongitude: 121.053703125,
  baseCoveredKm: 10,
  baseFee: 350,
  perKmRate: 60,
  maxDistanceKm: 100,
  ncrPolygonFile: 'src/modules/maps/data/ncr-boundary.json',
};

let cachedBoundaryPath: string | null = null;
let cachedBoundaryFeatures: Array<Feature<Polygon | MultiPolygon>> | null = null;

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function hashCoords(lat: number, lng: number): string {
  const rounded = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  return crypto.createHash('md5').update(rounded).digest('hex');
}

async function getOcularSettings(): Promise<OcularSettings> {
  const keys = [
    'shopLatitude',
    'shopLongitude',
    'baseCoveredKm',
    'baseFee',
    'perKmRate',
    'maxDistanceKm',
    'ncrPolygonFile',
    'ocular_fee_config', // legacy fallback
  ];

  const configs = await Config.find({ key: { $in: keys } }).lean();
  const byKey = new Map(configs.map((cfg) => [cfg.key, cfg.value]));

  const legacy = byKey.get('ocular_fee_config') as LegacyOcularFeeConfig | undefined;

  return {
    shopLatitude: toNumber(byKey.get('shopLatitude'), DEFAULT_SETTINGS.shopLatitude),
    shopLongitude: toNumber(byKey.get('shopLongitude'), DEFAULT_SETTINGS.shopLongitude),
    baseCoveredKm: toNumber(
      byKey.get('baseCoveredKm'),
      toNumber(legacy?.baseKm, DEFAULT_SETTINGS.baseCoveredKm),
    ),
    baseFee: toNumber(byKey.get('baseFee'), toNumber(legacy?.baseFee, DEFAULT_SETTINGS.baseFee)),
    perKmRate: toNumber(
      byKey.get('perKmRate'),
      toNumber(legacy?.extraRatePerKm, DEFAULT_SETTINGS.perKmRate),
    ),
    maxDistanceKm: toNumber(
      byKey.get('maxDistanceKm'),
      toNumber(legacy?.maxDistanceKm, DEFAULT_SETTINGS.maxDistanceKm),
    ),
    ncrPolygonFile: toString(byKey.get('ncrPolygonFile'), DEFAULT_SETTINGS.ncrPolygonFile),
  };
}

function extractPolygonFeatures(
  boundaryData: unknown,
): Array<Feature<Polygon | MultiPolygon>> {
  const parsed = boundaryData as {
    type?: string;
    features?: Array<Feature<Polygon | MultiPolygon>>;
    geometry?: { type?: string };
  };

  let features: Array<Feature<Polygon | MultiPolygon>> = [];
  if (parsed.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
    features = parsed.features.filter((feature) =>
      ['Polygon', 'MultiPolygon'].includes(feature?.geometry?.type ?? ''),
    );
  } else if (parsed.type === 'Feature' && ['Polygon', 'MultiPolygon'].includes(parsed.geometry?.type ?? '')) {
    features = [parsed as Feature<Polygon | MultiPolygon>];
  }

  return features;
}

async function loadBundledDefaultBoundaryFeatures(): Promise<
  Array<Feature<Polygon | MultiPolygon>>
> {
  const bundledBoundaryUrl = new URL('./data/ncr-boundary.json', import.meta.url);
  const bundledRaw = await fs.readFile(bundledBoundaryUrl, 'utf8');
  const bundledFeatures = extractPolygonFeatures(JSON.parse(bundledRaw) as unknown);
  if (!bundledFeatures.length) {
    throw AppError.internal('Failed to load NCR boundary data');
  }
  return bundledFeatures;
}

async function getNcrBoundaryFeatures(
  polygonFilePath: string,
): Promise<Array<Feature<Polygon | MultiPolygon>>> {
  const resolvedPath = path.isAbsolute(polygonFilePath)
    ? polygonFilePath
    : path.resolve(process.cwd(), polygonFilePath);

  if (cachedBoundaryPath === resolvedPath && cachedBoundaryFeatures) {
    return cachedBoundaryFeatures;
  }

  try {
    const raw = await fs.readFile(resolvedPath, 'utf8');
    const features = extractPolygonFeatures(JSON.parse(raw) as unknown);

    if (!features.length) {
      throw new Error('No polygon features found in boundary file');
    }

    cachedBoundaryPath = resolvedPath;
    cachedBoundaryFeatures = features;
    return features;
  } catch (error) {
    logger.warn('Failed to load configured NCR boundary polygon, using bundled default.', {
      polygonFilePath,
      error,
    });

    const fallbackFeatures = await loadBundledDefaultBoundaryFeatures();

    cachedBoundaryPath = '__bundled_default__';
    cachedBoundaryFeatures = fallbackFeatures;
    return fallbackFeatures;
  }
}

async function isWithinNcr(customerLocation: LatLng, polygonFilePath: string): Promise<boolean> {
  const boundaryFeatures = await getNcrBoundaryFeatures(polygonFilePath);
  const customerPoint = point([customerLocation.lng, customerLocation.lat]);
  return boundaryFeatures.some((feature) =>
    booleanPointInPolygon(customerPoint, feature as Feature<Polygon | MultiPolygon>),
  );
}

async function fetchDirections(origin: LatLng, destination: LatLng): Promise<DirectionsResult> {
  try {
    const response = await axios.post(
      'https://api.openrouteservice.org/v2/directions/driving-car',
      {
        coordinates: [
          [origin.lng, origin.lat],
          [destination.lng, destination.lat],
        ],
        // Avoid ferry routes instead of trying to infer them from step "type" values,
        // which are turn/roundabout codes (not ferry indicators).
        options: {
          avoid_features: ['ferries'],
        },
      },
      {
        headers: {
          Authorization: env.ORS_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      },
    );

    const data = response.data as {
      routes?: Array<{
        summary?: { distance: number; duration: number };
        geometry?: string;
      }>;
    };

    if (!data.routes?.length || !data.routes[0].summary) {
      throw AppError.badRequest(
        'Unable to calculate route. Please select a different location.',
        ErrorCode.NO_ROUTE_FOUND,
      );
    }

    const route = data.routes[0];
    const summary = route.summary;
    if (!summary) {
      throw AppError.badRequest(
        'Unable to calculate route. Please select a different location.',
        ErrorCode.NO_ROUTE_FOUND,
      );
    }
    return {
      distanceKm: summary.distance / 1000,
      durationMinutes: Math.ceil(summary.duration / 60),
      polyline: route.geometry,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('OpenRouteService API error', { error });
    throw AppError.internal('Failed to compute route. Please try again later.');
  }
}

async function computeRouteWithOrigin(origin: LatLng, customerLocation: LatLng) {
  const originHash = hashCoords(origin.lat, origin.lng);
  const destinationHash = hashCoords(customerLocation.lat, customerLocation.lng);

  const cached = await RouteCache.findOne({
    originHash,
    destinationHash,
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

  const result = await fetchDirections(origin, customerLocation);

  await RouteCache.create({
    originHash,
    destinationHash,
    distanceKm: result.distanceKm,
    durationMinutes: result.durationMinutes,
    hasFerry: false,
    polyline: result.polyline,
    expiresAt: new Date(Date.now() + CACHE_TTL_MS),
  });

  return {
    distanceKm: result.distanceKm,
    durationMinutes: result.durationMinutes,
    hasFerry: false,
    cached: false,
  };
}

export async function computeRoute(customerLocation: LatLng) {
  const settings = await getOcularSettings();
  const origin = { lat: settings.shopLatitude, lng: settings.shopLongitude };
  const route = await computeRouteWithOrigin(origin, customerLocation);

  return {
    ...route,
    distanceKm: Number(route.distanceKm.toFixed(2)),
    shopLocation: origin,
  };
}

export async function computeOcularFee(customerLocation: LatLng) {
  const settings = await getOcularSettings();
  const origin = { lat: settings.shopLatitude, lng: settings.shopLongitude };

  const [route, withinNcr] = await Promise.all([
    computeRouteWithOrigin(origin, customerLocation),
    isWithinNcr(customerLocation, settings.ncrPolygonFile),
  ]);

  const distanceKm = Number(route.distanceKm.toFixed(2));

  if (withinNcr) {
    return {
      route: {
        distanceKm,
        durationMinutes: route.durationMinutes,
      },
      fee: {
        label: 'FREE (within Metro Manila)',
        isWithinNCR: true,
        baseFee: 0,
        baseCoveredKm: settings.baseCoveredKm,
        perKmRate: settings.perKmRate,
        additionalDistanceKm: 0,
        additionalFee: 0,
        total: 0,
      },
      config: {
        shopLatitude: settings.shopLatitude,
        shopLongitude: settings.shopLongitude,
      },
    };
  }

  const additionalDistanceKmRaw = Math.max(0, distanceKm - settings.baseCoveredKm);
  const additionalDistanceKm = Number(additionalDistanceKmRaw.toFixed(2));
  const additionalFee = Math.round(additionalDistanceKmRaw * settings.perKmRate);
  const total = settings.baseFee + additionalFee;

  return {
    route: {
      distanceKm,
      durationMinutes: route.durationMinutes,
    },
    fee: {
      label: 'PAID (outside Metro Manila)',
      isWithinNCR: false,
      baseFee: settings.baseFee,
      baseCoveredKm: settings.baseCoveredKm,
      perKmRate: settings.perKmRate,
      additionalDistanceKm,
      additionalFee,
      total,
    },
    config: {
      shopLatitude: settings.shopLatitude,
      shopLongitude: settings.shopLongitude,
    },
  };
}

export async function reverseGeocode(location: LatLng) {
  try {
    const response = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: {
        lat: location.lat,
        lon: location.lng,
        format: 'jsonv2',
      },
      headers: {
        'User-Agent': 'RMV-Stainless-Steel-Fabrication/1.0',
      },
      timeout: 10000,
    });

    const data = response.data as { display_name?: string };
    if (!data.display_name) {
      throw AppError.badRequest('Unable to resolve address for this location');
    }

    return {
      formattedAddress: data.display_name,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('Nominatim reverse geocode error', { error });
    throw AppError.internal('Failed to resolve address for location');
  }
}

export async function placesAutocomplete(input: string, _sessionToken?: string) {
  try {
    const query = input.trim();
    if (!query) return [];

    const response = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: {
        q: query,
        format: 'jsonv2',
        addressdetails: 1,
        limit: 8,
        countrycodes: 'ph',
      },
      headers: {
        'User-Agent': 'RMV-Stainless-Steel-Fabrication/1.0',
      },
      timeout: 10000,
    });

    const places = response.data as Array<{
      place_id?: number;
      display_name?: string;
      lat?: string;
      lon?: string;
    }>;

    return places
      .map((place) => ({
        placeId: place.place_id?.toString() ?? '',
        description: place.display_name ?? '',
        formattedAddress: place.display_name ?? '',
        location: {
          lat: Number(place.lat),
          lng: Number(place.lon),
        },
      }))
      .filter(
        (place) =>
          place.placeId &&
          place.description &&
          Number.isFinite(place.location.lat) &&
          Number.isFinite(place.location.lng),
      );
  } catch (error) {
    logger.error('Nominatim search error', { error });
    throw AppError.internal('Failed to fetch address suggestions');
  }
}

export async function placeDetails(placeId: string, _sessionToken?: string) {
  try {
    const response = await axios.get('https://nominatim.openstreetmap.org/lookup', {
      params: {
        format: 'jsonv2',
        place_ids: placeId,
      },
      headers: {
        'User-Agent': 'RMV-Stainless-Steel-Fabrication/1.0',
      },
      timeout: 10000,
    });

    const places = response.data as Array<{
      display_name?: string;
      lat?: string;
      lon?: string;
    }>;

    const place = places[0];
    if (!place?.display_name || !place.lat || !place.lon) {
      throw AppError.badRequest('Place not found');
    }

    return {
      formattedAddress: place.display_name,
      location: {
        lat: Number(place.lat),
        lng: Number(place.lon),
      },
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('Nominatim place details error', { error });
    throw AppError.internal('Failed to fetch place details');
  }
}
