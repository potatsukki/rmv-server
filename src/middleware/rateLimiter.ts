import rateLimit from 'express-rate-limit';

/**
 * Rate limiters:
 * - Login: 15/min
 * - OTP: 5/min
 * - API: 300/min for mutating API calls
 * - Signed URL: 30/min
 */

export const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many login attempts. Please try again in 1 minute.',
    },
  },
});

/** Register page "email already registered" check: enough for typing, too low for bulk lookups. */
export const emailCheckLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many email checks. Please wait 1 minute.',
    },
  },
});

export const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many OTP requests. Please wait 1 minute.',
    },
  },
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  skip: (req) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests. Please slow down.',
    },
  },
});

export const signedUrlLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many upload requests. Please try again shortly.',
    },
  },
});
