import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { env } from '../../config/env.js';
import { generateCsrfToken } from '../../middleware/csrf.js';
import { extractClientHints } from '../../utils/deviceInfo.js';
import * as authService from './auth.service.js';
import { getRefreshTokenFromRequest } from './auth.tokens.js';
import {
  buildAvailabilityStateSummary,
  getOpenAvailabilitySession,
} from '../users/availability-session.service.js';

const cookieDomainOptions = env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {};

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAMESITE as 'lax' | 'strict' | 'none',
  ...cookieDomainOptions,
};

const CSRF_COOKIE_OPTIONS = {
  httpOnly: false,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAMESITE as 'lax' | 'strict' | 'none',
  path: '/',
  ...cookieDomainOptions,
};

/** Set refresh + CSRF cookies and store tokens in res.locals.
 *  Access token is returned in JSON body (stored in sessionStorage per-tab). */
function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  // Refresh token is NOT set as a cookie — it is returned in JSON and stored per-tab.
  res.clearCookie('refreshToken', { path: '/api/v1/auth' });
  res.clearCookie('refreshToken', { ...COOKIE_OPTIONS, path: '/api/v1/auth' });
  const csrfToken = generateCsrfToken();
  res.clearCookie('csrfToken', { path: '/' });
  if (env.COOKIE_DOMAIN) {
    res.clearCookie('csrfToken', { domain: env.COOKIE_DOMAIN, path: '/' });
  }
  res.cookie('csrfToken', csrfToken, {
    ...CSRF_COOKIE_OPTIONS,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.locals.csrfToken = csrfToken;
  res.locals.accessToken = accessToken;
  res.locals.refreshToken = refreshToken;
}

export const register = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.register(
    req.body,
    req.ip,
    req.headers['user-agent'],
  );
  res.status(201).json({ success: true, data: result });
});

/** Helper: extract client hints from request headers */
function getHints(req: Request) {
  return extractClientHints(req.headers as Record<string, string | string[] | undefined>);
}

export const verifyEmail = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.verifyEmail(
    req.body,
    req.ip,
    req.headers['user-agent'],
    getHints(req),
  );

  setAuthCookies(res, result.accessToken, result.refreshToken);

  res.json({ success: true, data: { message: result.message, user: result.user, accessToken: res.locals.accessToken, refreshToken: res.locals.refreshToken } });
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.login(
    req.body,
    req.ip,
    req.headers['user-agent'],
    getHints(req),
  );

  // 2FA required — return temp token without setting auth cookies
  if ('requires2FA' in result && result.requires2FA) {
    res.json({
      success: true,
      data: {
        requires2FA: true,
        tempToken: result.tempToken,
        user: result.user,
      },
    });
    return;
  }

  // Normal login — set auth cookies
  setAuthCookies(res, (result as { accessToken: string; refreshToken: string }).accessToken, (result as { accessToken: string; refreshToken: string }).refreshToken);

  res.json({
    success: true,
    data: {
      user: result.user,
      csrfToken: res.locals.csrfToken,
      accessToken: res.locals.accessToken,
      refreshToken: res.locals.refreshToken,
    },
  });
});

export const refreshToken = asyncHandler(async (req: Request, res: Response) => {
  const token = getRefreshTokenFromRequest(req);
  if (!token) {
    res.status(400).json({ success: false, error: { message: 'Refresh token required' } });
    return;
  }

  const result = await authService.refreshAccessToken(token);

  // Access token returned in body for sessionStorage — not set as cookie
  res.json({ success: true, data: { message: 'Token refreshed', accessToken: result.accessToken } });
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  const refreshTokenValue = getRefreshTokenFromRequest(req);
  await authService.logout(
    req.userId!,
    refreshTokenValue,
    req.ip,
    req.headers['user-agent'],
  );

  res.clearCookie('refreshToken', { ...COOKIE_OPTIONS, path: '/api/v1/auth' });
  res.clearCookie('csrfToken', { path: '/' });
  res.clearCookie('csrfToken', { ...CSRF_COOKIE_OPTIONS });
  // accessToken is in sessionStorage — cleared client-side

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
  const session = await getOpenAvailabilitySession(user._id);
  const availabilitySummary = buildAvailabilityStateSummary(user, session);
  res.json({
    success: true,
    data: {
      _id: user._id,
      id: user._id,
      email: user.email,
      customerNumber: user.customerNumber,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      address: user.address,
      addressData: (user as any).addressData,
      roles: user.roles,
      isEmailVerified: user.isEmailVerified,
      mustChangePassword: user.mustChangePassword,
      notificationPreferences: user.notificationPreferences,
      twoFactorEnabled: user.twoFactorEnabled,
      provider: user.provider || 'local',
      firebaseUid: user.firebaseUid,
      photoURL: user.photoURL,
      availabilityStatus: availabilitySummary.availabilityStatus,
      availabilityNote: availabilitySummary.availabilityNote,
      availabilityUpdatedAt: availabilitySummary.availabilityUpdatedAt,
      activeShift: availabilitySummary.activeShift,
      expiredShift: availabilitySummary.expiredShift,
      availabilitySetupRequired: availabilitySummary.availabilitySetupRequired,
      createdAt: user.createdAt,
    },
  });
});

// ── 2FA Verification (login flow) ──

export const verify2fa = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.verify2fa(
    req.body,
    req.ip,
    req.headers['user-agent'],
    getHints(req),
  );

  setAuthCookies(res, result.accessToken, result.refreshToken);

  res.json({
    success: true,
    data: {
      user: result.user,
      csrfToken: res.locals.csrfToken,
      accessToken: res.locals.accessToken,
      refreshToken: res.locals.refreshToken,
    },
  });
});

export const resend2fa = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.resend2fa(req.body);
  res.json({ success: true, data: result });
});

// ── 2FA Enable / Disable ──

export const enable2fa = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.enable2fa(req.userId!);
  res.json({ success: true, data: result });
});

export const confirmEnable2fa = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.confirmEnable2fa(
    req.userId!,
    req.body.otp,
    req.ip,
    req.headers['user-agent'],
  );
  res.json({ success: true, data: result });
});

export const disable2fa = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.disable2fa(
    req.userId!,
    req.body,
    req.ip,
    req.headers['user-agent'],
  );
  res.json({ success: true, data: result });
});

// ── Sessions & Login History ──

export const getSessions = asyncHandler(async (req: Request, res: Response) => {
  const sessions = await authService.getSessions(
    req.userId!,
    getRefreshTokenFromRequest(req),
  );
  res.json({ success: true, data: sessions });
});

export const revokeSession = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.revokeSession(
    req.userId!,
    req.params.id as string,
    getRefreshTokenFromRequest(req),
    req.ip,
    req.headers['user-agent'] as string | undefined,
  );
  res.json({ success: true, data: result });
});

export const revokeAllSessions = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.revokeAllOtherSessions(
    req.userId!,
    getRefreshTokenFromRequest(req),
    req.ip,
    req.headers['user-agent'] as string | undefined,
  );
  res.json({ success: true, data: result });
});

export const getLoginHistory = asyncHandler(async (req: Request, res: Response) => {
  const history = await authService.getLoginHistory(req.userId!);
  res.json({ success: true, data: history });
});

// ── Google Auth ──

export const googleAuth = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.googleAuth(
    req.body,
    req.ip,
    req.headers['user-agent'],
    getHints(req),
  );

  // New user needs to complete profile
  if ('needsProfile' in result && result.needsProfile) {
    res.json({
      success: true,
      data: {
        needsProfile: true,
        email: result.email,
        googleName: result.googleName,
        googlePhoto: result.googlePhoto,
      },
    });
    return;
  }

  // 2FA required — return temp token (no cookies yet)
  if ('requires2FA' in result && result.requires2FA) {
    res.json({
      success: true,
      data: {
        requires2FA: true,
        tempToken: (result as { tempToken: string }).tempToken,
        user: (result as { user: unknown }).user,
      },
    });
    return;
  }

  // Existing user → set cookies and return user
  const loginResult = result as { accessToken: string; refreshToken: string; user: unknown };
  setAuthCookies(res, loginResult.accessToken, loginResult.refreshToken);

  res.json({
    success: true,
    data: {
      user: loginResult.user,
      csrfToken: res.locals.csrfToken,
      accessToken: res.locals.accessToken,
      refreshToken: res.locals.refreshToken,
    },
  });
});

export const googleComplete = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.googleComplete(
    req.body,
    req.ip,
    req.headers['user-agent'],
    getHints(req),
  );

  setAuthCookies(res, result.accessToken, result.refreshToken);

  res.json({
    success: true,
    data: {
      user: result.user,
      csrfToken: res.locals.csrfToken,
      accessToken: res.locals.accessToken,
      refreshToken: res.locals.refreshToken,
    },
  });
});
