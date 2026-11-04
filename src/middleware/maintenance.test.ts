import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConfigFindOne } = vi.hoisted(() => ({
  mockConfigFindOne: vi.fn(),
}));

vi.mock('../models/index.js', () => ({
  Config: {
    findOne: mockConfigFindOne,
  },
}));

import type { NextFunction, Request, Response } from 'express';
import { maintenanceGuard } from './maintenance.js';
import { ErrorCode } from '../utils/appError.js';
import { Role } from '../utils/constants.js';

describe('maintenanceGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows authentication requests through while maintenance is enabled', async () => {
    const next = vi.fn<NextFunction>();

    await maintenanceGuard(
      { method: 'POST', path: '/api/v1/auth/login' } as Request,
      {} as Response,
      next,
    );

    expect(next).toHaveBeenCalledWith();
    expect(mockConfigFindOne).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD'])('allows %s health checks through during maintenance', async (method) => {
    const next = vi.fn<NextFunction>();

    await maintenanceGuard(
      { method, path: '/api/v1/health' } as Request,
      {} as Response,
      next,
    );

    expect(next).toHaveBeenCalledWith();
    expect(mockConfigFindOne).not.toHaveBeenCalled();
  });

  it('allows authenticated admins through while maintenance is enabled', async () => {
    mockConfigFindOne
      .mockResolvedValueOnce({ value: true })
      .mockResolvedValueOnce({ value: null });
    const next = vi.fn<NextFunction>();

    await maintenanceGuard(
      { path: '/api/v1/projects', userRoles: [Role.ADMIN] } as unknown as Request,
      {} as Response,
      next,
    );

    expect(next).toHaveBeenCalledWith();
  });

  it('blocks non-admin API requests while maintenance is enabled', async () => {
    mockConfigFindOne
      .mockResolvedValueOnce({ value: true })
      .mockResolvedValueOnce({ value: null });
    const next = vi.fn<NextFunction>();

    await maintenanceGuard(
      { path: '/api/v1/projects', userRoles: [Role.CUSTOMER] } as unknown as Request,
      {} as Response,
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 503,
      code: ErrorCode.MAINTENANCE_MODE,
    }));
  });

  it('forwards config lookup errors instead of silently bypassing maintenance', async () => {
    const error = new Error('Config lookup failed');
    mockConfigFindOne.mockRejectedValue(error);
    const next = vi.fn<NextFunction>();

    await maintenanceGuard(
      { path: '/api/v1/projects' } as Request,
      {} as Response,
      next,
    );

    expect(next).toHaveBeenCalledWith(error);
  });
});
