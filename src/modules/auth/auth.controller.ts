import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { env } from '../../config/env.js';
import { generateCsrfToken } from '../../middleware/csrf.js';
import * as authService from './auth.service.js';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAMESITE as 'lax' | 'strict' | 'none',
  domain: env.COOKIE_DOMAIN,
};

const CSRF_COOKIE_OPTIONS = {
  httpOnly: false,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAMESITE as 'lax' | 'strict' | 'none',
  domain: env.COOKIE_DOMAIN,
  path: '/',
};

export const register = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.register(
    req.body,
    req.ip,
    req.headers['user-agent'],
  );
  res.status(201).json({ success: true, data: result });
});

export const verifyEmail = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.verifyEmail(
    req.body,
    req.ip,
    req.headers['user-agent'],
  );
  res.json({ success: true, data: result });
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.login(
    req.body,
    req.ip,
    req.headers['user-agent'],
  );

  // Set tokens in httpOnly cookies
  res.cookie('accessToken', result.accessToken, {
    ...COOKIE_OPTIONS,
    maxAge: 15 * 60 * 1000, // 15 minutes
  });

  res.cookie('refreshToken', result.refreshToken, {
    ...COOKIE_OPTIONS,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/api/v1/auth', // Only sent for auth endpoints
  });

  // Set CSRF token
  const csrfToken = generateCsrfToken();
  res.clearCookie('csrfToken', { path: '/' });
  res.clearCookie('csrfToken', { domain: env.COOKIE_DOMAIN, path: '/' });
  res.cookie('csrfToken', csrfToken, {
    ...CSRF_COOKIE_OPTIONS,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  res.json({
    success: true,
    data: {
      user: result.user,
      csrfToken,
    },
  });
});

export const refreshToken = asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.refreshToken || req.body.refreshToken;
  if (!token) {
    res.status(400).json({ success: false, error: { message: 'Refresh token required' } });
    return;
  }

  const result = await authService.refreshAccessToken(token);

  res.cookie('accessToken', result.accessToken, {
    ...COOKIE_OPTIONS,
    maxAge: 15 * 60 * 1000,
  });

  res.json({ success: true, data: { message: 'Token refreshed' } });
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  const refreshTokenValue = req.cookies?.refreshToken;
  await authService.logout(
    req.userId!,
    refreshTokenValue,
    req.ip,
    req.headers['user-agent'],
  );

  res.clearCookie('accessToken', COOKIE_OPTIONS);
  res.clearCookie('refreshToken', { ...COOKIE_OPTIONS, path: '/api/v1/auth' });
  res.clearCookie('csrfToken', { path: '/' });
  res.clearCookie('csrfToken', { ...CSRF_COOKIE_OPTIONS });

  res.json({ success: true, data: { message: 'Logged out successfully' } });
});

export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.forgotPassword(req.body);
  res.json({ success: true, data: result });
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.resetPassword(
    req.body,
    req.ip,
    req.headers['user-agent'],
  );
  res.json({ success: true, data: result });
});

export const resendOtp = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.resendOtp(req.body);
  res.json({ success: true, data: result });
});

export const changePassword = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.changePassword(
    req.userId!,
    req.body,
    req.ip,
    req.headers['user-agent'],
  );
  res.json({ success: true, data: result });
});

export const me = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  res.json({
    success: true,
    data: {
      _id: user._id,
      id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      address: user.address,
      roles: user.roles,
      isEmailVerified: user.isEmailVerified,
      mustChangePassword: user.mustChangePassword,
      notificationPreferences: user.notificationPreferences,
    },
  });
});
