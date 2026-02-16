import { Request, Response, NextFunction } from 'express';
import { IdempotencyKey } from '../models/index.js';
import { AppError, ErrorCode } from '../utils/appError.js';

/**
 * Idempotency middleware.
 * Client sends `Idempotency-Key` header (UUID v4).
 * If key already processed, return cached response.
 * Otherwise, intercept response to cache it.
 */
export const idempotent = () => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.headers['idempotency-key'] as string | undefined;

    if (!key) {
      next(
        AppError.badRequest('Idempotency-Key header is required', ErrorCode.VALIDATION_ERROR),
      );
      return;
    }

    if (!req.userId) {
      next(AppError.unauthorized());
      return;
    }

    // Check if key already exists
    const existing = await IdempotencyKey.findOne({ key, userId: req.userId });
    if (existing && existing.responseStatus) {
      res.status(existing.responseStatus).json(existing.responseBody);
      return;
    }

    // Intercept the response to cache it
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      // Save idempotency key with response (fire and forget)
      IdempotencyKey.create({
        key,
        userId: req.userId,
        endpoint: `${req.method} ${req.originalUrl}`,
        responseStatus: res.statusCode,
        responseBody: body as Record<string, unknown>,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
      }).catch(() => {
        // Duplicate key — another request processed first, that's fine
      });

      return originalJson(body);
    };

    next();
  };
};
