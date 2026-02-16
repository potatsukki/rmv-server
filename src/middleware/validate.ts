import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { AppError, ErrorCode } from '../utils/appError.js';

/**
 * Validate request body, query, or params using a Zod schema.
 */
export const validate = (schema: ZodSchema, source: 'body' | 'query' | 'params' = 'body') => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const data = schema.parse(req[source]);
      // In Express 5, req.query and req.params are getter-only; only reassign body
      if (source === 'body') {
        req.body = data;
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const details = error.issues.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        }));
        next(
          AppError.badRequest('Validation failed', ErrorCode.VALIDATION_ERROR, {
            errors: details,
          }),
        );
        return;
      }
      next(error);
    }
  };
};

/**
 * Validate multiple sources at once.
 */
export const validateMultiple = (schemas: {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      if (schemas.query) {
        schemas.query.parse(req.query); // validate only; req.query is read-only in Express 5
      }
      if (schemas.params) {
        schemas.params.parse(req.params); // validate only; req.params is read-only in Express 5
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const details = error.issues.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        }));
        next(
          AppError.badRequest('Validation failed', ErrorCode.VALIDATION_ERROR, {
            errors: details,
          }),
        );
        return;
      }
      next(error);
    }
  };
};
