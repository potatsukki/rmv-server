import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { env } from '../config/env.js';
import { AppError, ErrorCode } from '../utils/appError.js';

/**
 * CSRF protection using double-submit cookie pattern.
 * On login, set a csrf token cookie.
 * Client must send the same token in X-CSRF-Token header.
 */
export const csrfProtection = (req: Request, _res: Response, next: NextFunction): void => {
  // Skip for safe methods
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method)) {
    next();
    return;
  }

  const cookieToken = req.cookies?.csrfToken;
  const headerToken = req.headers['x-csrf-token'];

  if (!cookieToken || !headerToken) {
    next(AppError.forbidden('CSRF token missing', ErrorCode.FORBIDDEN));
    return;
  }

  if (cookieToken !== headerToken) {
    next(AppError.forbidden('CSRF token mismatch', ErrorCode.FORBIDDEN));
    return;
  }

  next();
};

/**
 * Generate a CSRF token and set it as a cookie.
 */
export function generateCsrfToken(): string {
  return crypto.createHmac('sha256', env.CSRF_SECRET)
    .update(crypto.randomBytes(32))
    .digest('hex');
}
