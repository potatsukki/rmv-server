import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User, IUser } from '../models/index.js';
import { AppError, ErrorCode } from '../utils/appError.js';
import { Role } from '../utils/constants.js';

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      user?: IUser;
      userId?: string;
      userRoles?: Role[];
    }
  }
}

interface JwtPayload {
  userId: string;
  roles: Role[];
  iat: number;
  exp: number;
}

/**
 * Authenticate user via access token (httpOnly cookie or Authorization header).
 */
export const authenticate = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    let token: string | undefined;

    // 1. Check httpOnly cookie
    if (req.cookies?.accessToken) {
      token = req.cookies.accessToken;
    }
    // 2. Check Authorization header
    else if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      throw AppError.unauthorized('Access token required', ErrorCode.TOKEN_INVALID);
    }

    // Verify token
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;

    // Load user
    const user = await User.findById(decoded.userId);
    if (!user) {
      throw AppError.unauthorized('User not found', ErrorCode.TOKEN_INVALID);
    }

    if (!user.isActive) {
      throw AppError.forbidden('Account is disabled', ErrorCode.ACCOUNT_DISABLED);
    }

    if (user.deletedAt) {
      throw AppError.unauthorized('Account has been deleted', ErrorCode.TOKEN_INVALID);
    }

    // Check temporary account expiry
    if (user.expiresAt && new Date() > user.expiresAt) {
      throw AppError.forbidden('Account has expired', ErrorCode.ACCOUNT_EXPIRED);
    }

    // Check if must change password (allow only limited endpoints)
    if (user.mustChangePassword) {
      const allowedPaths = ['/change-password', '/logout', '/me', '/csrf-token'];
      const currentPath = req.path;
      if (!allowedPaths.some(p => currentPath.endsWith(p))) {
        throw AppError.forbidden('Password change required', ErrorCode.MUST_CHANGE_PASSWORD);
      }
    }

    req.user = user;
    req.userId = user._id.toString();
    req.userRoles = user.roles as Role[];
    next();
  } catch (error) {
    if (error instanceof AppError) {
      next(error);
      return;
    }
    if (error instanceof jwt.TokenExpiredError) {
      next(AppError.unauthorized('Access token expired', ErrorCode.TOKEN_EXPIRED));
      return;
    }
    if (error instanceof jwt.JsonWebTokenError) {
      next(AppError.unauthorized('Invalid access token', ErrorCode.TOKEN_INVALID));
      return;
    }
    next(error);
  }
};

/**
 * Optional authentication — sets req.user if token present, but doesn't block.
 */
export const optionalAuth = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    let token: string | undefined;

    if (req.cookies?.accessToken) {
      token = req.cookies.accessToken;
    } else if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (token) {
      const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;
      const user = await User.findById(decoded.userId);
      if (user && user.isActive && !user.deletedAt) {
        req.user = user;
        req.userId = user._id.toString();
        req.userRoles = user.roles as Role[];
      }
    }
    next();
  } catch {
    // Silently continue without auth
    next();
  }
};
