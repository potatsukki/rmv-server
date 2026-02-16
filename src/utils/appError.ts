// ── Error Codes ──
export enum ErrorCode {
  // Auth
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  TOKEN_INVALID = 'TOKEN_INVALID',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  ACCOUNT_DISABLED = 'ACCOUNT_DISABLED',
  ACCOUNT_EXPIRED = 'ACCOUNT_EXPIRED',
  EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED',
  MUST_CHANGE_PASSWORD = 'MUST_CHANGE_PASSWORD',

  // OTP
  OTP_EXPIRED = 'OTP_EXPIRED',
  OTP_INVALID = 'OTP_INVALID',
  OTP_MAX_ATTEMPTS = 'OTP_MAX_ATTEMPTS',
  OTP_COOLDOWN = 'OTP_COOLDOWN',
  OTP_LOCKED = 'OTP_LOCKED',

  // Validation
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  DUPLICATE_ENTRY = 'DUPLICATE_ENTRY',

  // Resources
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  GONE = 'GONE',

  // Booking
  SLOT_UNAVAILABLE = 'SLOT_UNAVAILABLE',
  SLOT_LOCKED = 'SLOT_LOCKED',
  BOOKING_LIMIT_REACHED = 'BOOKING_LIMIT_REACHED',
  HOLIDAY_BLOCKED = 'HOLIDAY_BLOCKED',

  // State machine
  INVALID_TRANSITION = 'INVALID_TRANSITION',

  // Payment
  PLAN_IMMUTABLE = 'PLAN_IMMUTABLE',
  IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT',
  MAX_REVISIONS_REACHED = 'MAX_REVISIONS_REACHED',

  // File
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  FILE_TYPE_NOT_ALLOWED = 'FILE_TYPE_NOT_ALLOWED',
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',

  // Maps
  NO_ROUTE_FOUND = 'NO_ROUTE_FOUND',
  FERRY_ROUTE_REJECTED = 'FERRY_ROUTE_REJECTED',

  // Rate limiting
  RATE_LIMITED = 'RATE_LIMITED',

  // Server
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  MAINTENANCE_MODE = 'MAINTENANCE_MODE',
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly isOperational: boolean;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    statusCode: number,
    code: ErrorCode,
    details?: Record<string, unknown>,
    isOperational = true,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    this.details = details;
    Object.setPrototypeOf(this, AppError.prototype);
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message: string, code = ErrorCode.VALIDATION_ERROR, details?: Record<string, unknown>) {
    return new AppError(message, 400, code, details);
  }

  static unauthorized(message = 'Unauthorized', code = ErrorCode.UNAUTHORIZED) {
    return new AppError(message, 401, code);
  }

  static forbidden(message = 'Forbidden', code = ErrorCode.FORBIDDEN) {
    return new AppError(message, 403, code);
  }

  static notFound(message = 'Resource not found') {
    return new AppError(message, 404, ErrorCode.NOT_FOUND);
  }

  static conflict(message: string, code = ErrorCode.CONFLICT, details?: Record<string, unknown>) {
    return new AppError(message, 409, code, details);
  }

  static tooMany(message = 'Too many requests') {
    return new AppError(message, 429, ErrorCode.RATE_LIMITED);
  }

  static internal(message = 'Internal server error') {
    return new AppError(message, 500, ErrorCode.INTERNAL_ERROR, undefined, false);
  }
}
