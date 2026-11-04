import { Request, Response, NextFunction } from 'express';
import { Config } from '../models/index.js';
import { AppError, ErrorCode } from '../utils/appError.js';
import { Role } from '../utils/constants.js';

const AUTHENTICATION_PATHS = [
  '/auth/login',
  '/auth/google',
  '/auth/verify-2fa',
  '/auth/resend-2fa',
] as const;

/**
 * Maintenance mode middleware.
 * When maintenance is enabled, only Admin users can access the API.
 */
export const maintenanceGuard = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  const path = req.path.replace(/\/+$/, '');
  const isHealthCheck = (req.method === 'GET' || req.method === 'HEAD')
    && path.endsWith('/health');
  const isAuthenticationRequest = req.method === 'POST'
    && AUTHENTICATION_PATHS.some((authPath) => path.endsWith(authPath));
  if (isHealthCheck || isAuthenticationRequest) {
    next();
    return;
  }

  try {
    const [mode, scheduledAt] = await Promise.all([
      Config.findOne({ key: 'maintenance_mode' }),
      Config.findOne({ key: 'maintenance_scheduled_at' }),
    ]);

    const isMaintenance = mode?.value === true;
    const isScheduledReached = scheduledAt?.value && new Date() >= new Date(scheduledAt.value as string);

    if (isMaintenance || isScheduledReached) {
      // Allow admin users through
      if (req.userRoles?.includes(Role.ADMIN)) {
        next();
        return;
      }

      next(
        new AppError(
          'System is under maintenance. Please try again later.',
          503,
          ErrorCode.MAINTENANCE_MODE,
        ),
      );
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
};
