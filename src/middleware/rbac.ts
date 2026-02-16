import { Request, Response, NextFunction } from 'express';
import { Role } from '../utils/constants.js';
import { AppError, ErrorCode } from '../utils/appError.js';

/**
 * RBAC middleware factory.
 * Checks if the authenticated user has at least one of the required roles.
 */
export const authorize = (...allowedRoles: Role[]) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user || !req.userRoles) {
      next(AppError.unauthorized('Authentication required'));
      return;
    }

    const hasRole = req.userRoles.some(role => allowedRoles.includes(role));
    if (!hasRole) {
      next(
        AppError.forbidden(
          `Access denied. Required roles: ${allowedRoles.join(', ')}`,
          ErrorCode.FORBIDDEN,
        ),
      );
      return;
    }

    next();
  };
};

/**
 * Check ownership — resource belongs to the requesting user.
 * Used in combination with authorize for fine-grained access.
 */
export const authorizeOwnerOrRoles = (
  getOwnerId: (req: Request) => string | undefined,
  ...allowedRoles: Role[]
) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user || !req.userRoles || !req.userId) {
      next(AppError.unauthorized('Authentication required'));
      return;
    }

    // Check if user is the owner
    const ownerId = getOwnerId(req);
    if (ownerId && ownerId === req.userId) {
      next();
      return;
    }

    // Check if user has a privileged role
    const hasRole = req.userRoles.some(role => allowedRoles.includes(role));
    if (hasRole) {
      next();
      return;
    }

    next(AppError.forbidden('Access denied'));
  };
};
