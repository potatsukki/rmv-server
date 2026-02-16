import { Request, Response, NextFunction } from 'express';
import { Config } from '../models/index.js';
import { AppError, ErrorCode } from '../utils/appError.js';
import { Role } from '../utils/constants.js';

/**
 * Maintenance mode middleware.
 * When maintenance is enabled, only Admin users can access the API.
 */
export const maintenanceGuard = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    const config = await Config.findOne({ key: 'maintenance_mode' });
    if (config?.value === true) {
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
  } catch {
    // If we can't check maintenance mode, let the request through
    next();
  }
};
