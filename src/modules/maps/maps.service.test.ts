import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  configFind: vi.fn(),
  routeCacheFindOne: vi.fn(),
  routeCacheCreate: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    post: mocks.post,
    isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean } | null)?.isAxiosError),
  },
}));
vi.mock('../../config/env.js', () => ({ env: { ORS_API_KEY: 'test-key' } }));
vi.mock('../../models/index.js', () => ({
  Config: { find: () => ({ lean: mocks.configFind }) },
  RouteCache: { findOne: mocks.routeCacheFindOne, create: mocks.routeCacheCreate },
}));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { assertOcularLocationAccepted, computeOcularFee, MAINLAND_LUZON_ONLY_MESSAGE } from './maps.service.js';
import { ErrorCode } from '../../utils/appError.js';

const BATANGAS = { lat: 13.7565, lng: 121.0583 };
const CEBU = { lat: 10.3157, lng: 123.8854 };
const MINDORO = { lat: 13.4117, lng: 121.18 };

const orsRoute = (distanceKm: number) => ({
  data: { routes: [{ summary: { distance: distanceKm * 1000, duration: distanceKm * 90 } }] },
});
const orsError = (code: number) => Object.assign(new Error('ORS error'), {
  isAxiosError: true,
  response: { status: 404, data: { error: { code, message: 'Route could not be found' } } },
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.configFind.mockResolvedValue([]);
  mocks.routeCacheFindOne.mockResolvedValue(null);
  mocks.routeCacheCreate.mockResolvedValue({});
});

describe('ocular fee policy', () => {
  it('charges ₱350 for the first 6 km outside Metro Manila', async () => {
    mocks.post.mockResolvedValueOnce(orsRoute(5));
    const result = await computeOcularFee(BATANGAS);
    expect(result.fee).toMatchObject({ isWithinNCR: false, baseFee: 350, baseCoveredKm: 6, total: 350 });
    expect(result.fee.tollNote).toContain('Toll fees are shouldered by RMV');
  });

  it('adds ₱60 for each kilometer beyond 6 km', async () => {
    mocks.post.mockResolvedValueOnce(orsRoute(10));
    const result = await computeOcularFee(BATANGAS);
    expect(result.fee).toMatchObject({ additionalDistanceKm: 4, additionalFee: 240, total: 590 });
  });
});

describe('mainland Luzon only', () => {
  it('rejects Visayas and Mindanao pins without calling the routing service', async () => {
    await expect(assertOcularLocationAccepted(CEBU)).rejects.toMatchObject({
      message: MAINLAND_LUZON_ONLY_MESSAGE,
      code: ErrorCode.FERRY_ROUTE_REJECTED,
    });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('rejects islands that cannot be reached by road without a ferry', async () => {
    mocks.post.mockRejectedValueOnce(orsError(2009));
    await expect(assertOcularLocationAccepted(MINDORO)).rejects.toMatchObject({
      message: MAINLAND_LUZON_ONLY_MESSAGE,
      code: ErrorCode.FERRY_ROUTE_REJECTED,
    });
  });

  it('asks to move a pin that is not near any road', async () => {
    mocks.post.mockRejectedValueOnce(orsError(2010));
    await expect(assertOcularLocationAccepted(BATANGAS)).rejects.toMatchObject({ code: ErrorCode.NO_ROUTE_FOUND });
  });

  it('keeps routing-service outages as a server error, not a rejection', async () => {
    mocks.post.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(assertOcularLocationAccepted(BATANGAS)).rejects.toMatchObject({ statusCode: 500 });
  });

  it('accepts a mainland Luzon site reachable by road', async () => {
    mocks.post.mockResolvedValueOnce(orsRoute(110));
    await expect(assertOcularLocationAccepted(BATANGAS)).resolves.toBeUndefined();
    expect(mocks.routeCacheCreate).toHaveBeenCalledTimes(1);
  });
});
