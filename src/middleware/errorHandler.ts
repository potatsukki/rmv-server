import { Request, Response, NextFunction } from 'express';
import { AppError, ErrorCode } from '../utils/appError.js';
import { logger } from '../utils/logger.js';

export const errorHandler = (
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  // AppError (operational)
  if (err instanceof AppError) {
    if (!err.isOperational) {
      logger.error('Non-operational AppError:', {
        message: err.message,
        code: err.code,
        stack: err.stack,
      });
    }

    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    res.status(400).json({
      success: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Validation error',
        details: err.message,
      },
    });
    return;
  }

  // Mongoose duplicate key
  if (err.name === 'MongoServerError' && (err as unknown as { code: number }).code === 11000) {
    res.status(409).json({
      success: false,
      error: {
        code: ErrorCode.DUPLICATE_ENTRY,
        message: 'Duplicate entry',
      },
    });
    return;
  }

  // Mongoose cast error (invalid ObjectId)
  if (err.name === 'CastError') {
    res.status(400).json({
      success: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid ID format',
      },
    });
    return;
  }

  // Unknown error
  logger.error('Unhandled error:', {
    name: err.name,
    message: err.message,
    stack: err.stack,
  });

  res.status(500).json({
    success: false,
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
    },
  });
};
