import { Router } from 'express';
import * as authController from './auth.controller.js';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { authLimiter, emailCheckLimiter, otpLimiter } from '../../middleware/rateLimiter.js';
import {
  emailAvailabilitySchema,
  registerSchema,
  verifyEmailSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  resendOtpSchema,
  changePasswordSchema,
  verify2faSchema,
  resend2faSchema,
  disable2faSchema,
  googleAuthSchema,
  googleCompleteSchema,
} from './auth.validation.js';

const router = Router();

// Public routes
router.get('/email-available', emailCheckLimiter, validate(emailAvailabilitySchema, 'query'), authController.emailAvailability);
router.post('/register', authLimiter, validate(registerSchema), authController.register);
router.post('/verify-email', otpLimiter, validate(verifyEmailSchema), authController.verifyEmail);
router.post('/login', authLimiter, validate(loginSchema), authController.login);
router.post('/forgot-password', otpLimiter, validate(forgotPasswordSchema), authController.forgotPassword);
router.post('/reset-password', otpLimiter, validate(resetPasswordSchema), authController.resetPassword);
router.post('/resend-otp', otpLimiter, validate(resendOtpSchema), authController.resendOtp);
router.post('/refresh-token', authController.refreshToken);

// Google auth (public)
router.post('/google', authLimiter, validate(googleAuthSchema), authController.googleAuth);
router.post('/google/complete', authLimiter, validate(googleCompleteSchema), authController.googleComplete);

// public 2FA verification (during login)
router.post('/verify-2fa', otpLimiter, validate(verify2faSchema), authController.verify2fa);
router.post('/resend-2fa', otpLimiter, validate(resend2faSchema), authController.resend2fa);

// Protected routes
router.post('/logout', authenticate, authController.logout);
router.post('/change-password', authenticate, validate(changePasswordSchema), authController.changePassword);
router.get('/me', authenticate, authController.me);

// Sessions & login history
router.get('/sessions', authenticate, authController.getSessions);
router.delete('/sessions/:id', authenticate, authController.revokeSession);
router.delete('/sessions', authenticate, authController.revokeAllSessions);
router.get('/login-history', authenticate, authController.getLoginHistory);

// 2FA management
router.post('/2fa/enable', authenticate, authController.enable2fa);
router.post('/2fa/confirm-enable', authenticate, otpLimiter, authController.confirmEnable2fa);
router.post('/2fa/disable', authenticate, validate(disable2faSchema), authController.disable2fa);

export default router;
