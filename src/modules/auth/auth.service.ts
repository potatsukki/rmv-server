import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../../config/env.js';
import { User, OtpToken, RefreshToken, AuditLog, LoginHistory } from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import { Role, OtpPurpose, AuditAction } from '../../utils/constants.js';
import { generateOtp } from '../../utils/helpers.js';
import { sendOtpEmail, sendPasswordResetEmail, send2faEmail } from '../notifications/email.service.js';
import { logger } from '../../utils/logger.js';
import { parseDevice } from '../../utils/deviceInfo.js';
import type { ClientHints } from '../../utils/deviceInfo.js';
import type {
  RegisterInput,
  VerifyEmailInput,
  LoginInput,
  ForgotPasswordInput,
  ResetPasswordInput,
  ResendOtpInput,
  ChangePasswordInput,
  Verify2faInput,
  Resend2faInput,
  Disable2faInput,
  GoogleAuthInput,
  GoogleCompleteInput,
} from './auth.validation.js';
import type { Types } from 'mongoose';
import { verifyFirebaseIdToken } from '../../config/firebase.js';
import { hasLocalPassword, isGoogleOnlyAccount, isInternalManagedAccount } from './auth.account-policy.js';
import { normalizeSavedAddresses, normalizeUserAddress } from '../../utils/userAddresses.js';

// ── Token Generation ──
function generateAccessToken(userId: string, roles: Role[]): string {
  return jwt.sign({ userId, roles }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRY,
  } as jwt.SignOptions);
}

function generateRefreshToken(): string {
  return crypto.randomBytes(64).toString('hex');
}

function generateTempToken(userId: string): string {
  return jwt.sign({ userId, purpose: '2fa' }, env.JWT_ACCESS_SECRET, {
    expiresIn: '5m',
  } as jwt.SignOptions);
}

function verifyTempToken(token: string): { userId: string } {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as { userId: string; purpose: string };
    if (payload.purpose !== '2fa') throw new Error('Invalid token purpose');
    return { userId: payload.userId };
  } catch {
    throw AppError.unauthorized('Invalid or expired verification token', ErrorCode.TOKEN_EXPIRED);
  }
}

// ── OTP Helpers ──
const OTP_EXPIRY_MS = 3 * 60 * 1000; // 3 minutes
const OTP_COOLDOWN_MS = 30 * 1000; // 30 seconds
const OTP_MAX_ATTEMPTS = 3;
const OTP_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

async function createAndSendOtp(email: string, purpose: OtpPurpose): Promise<void> {
  // Invalidate previous OTPs for this email+purpose
  await OtpToken.updateMany(
    { email, purpose, isUsed: false },
    { isUsed: true },
  );

  // Check cooldown
  const recent = await OtpToken.findOne({ email, purpose }).sort({ createdAt: -1 });
  if (recent && Date.now() - recent.lastSentAt.getTime() < OTP_COOLDOWN_MS) {
    throw AppError.tooMany('Please wait before requesting another OTP');
  }

  // Check lockout
  if (recent?.lockedUntil && new Date() < recent.lockedUntil) {
    throw new AppError(
      'Account temporarily locked due to too many failed attempts',
      423,
      ErrorCode.OTP_LOCKED,
    );
  }

  const otp = generateOtp(6);
  const hashedOtp = await bcrypt.hash(otp, 10);

  await OtpToken.create({
    email,
    otp: hashedOtp,
    purpose,
    expiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
    lastSentAt: new Date(),
  });

  // Send email
  if (purpose === OtpPurpose.EMAIL_VERIFICATION) {
    await sendOtpEmail(email, otp);
  } else if (purpose === OtpPurpose.LOGIN_2FA || purpose === OtpPurpose.ENABLE_2FA) {
    void send2faEmail(email, otp).catch((error) => {
      logger.error('Failed to send 2FA email in background:', error);
    });
  } else {
    await sendPasswordResetEmail(email, otp);
  }
}

async function verifyOtp(email: string, otp: string, purpose: OtpPurpose): Promise<void> {
  const otpRecord = await OtpToken.findOne({
    email,
    purpose,
    isUsed: false,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });

  if (!otpRecord) {
    throw AppError.badRequest('OTP expired or not found', ErrorCode.OTP_EXPIRED);
  }

  // Check lockout
  if (otpRecord.lockedUntil && new Date() < otpRecord.lockedUntil) {
    throw new AppError(
      'Account locked due to too many failed attempts. Try again later.',
      423,
      ErrorCode.OTP_LOCKED,
    );
  }

  // Check attempts
  if (otpRecord.attempts >= OTP_MAX_ATTEMPTS) {
    otpRecord.lockedUntil = new Date(Date.now() + OTP_LOCKOUT_MS);
    await otpRecord.save();
    throw AppError.badRequest(
      'Maximum OTP attempts exceeded. Please request a new OTP.',
      ErrorCode.OTP_MAX_ATTEMPTS,
    );
  }

  const isValid = await bcrypt.compare(otp, otpRecord.otp);
  if (!isValid) {
    otpRecord.attempts += 1;
    await otpRecord.save();
    throw AppError.badRequest(
      `Invalid OTP. ${OTP_MAX_ATTEMPTS - otpRecord.attempts} attempts remaining.`,
      ErrorCode.OTP_INVALID,
    );
  }

  // Mark as used
  otpRecord.isUsed = true;
  await otpRecord.save();
}

// ── Service Methods ──

export async function register(input: RegisterInput, ip?: string, ua?: string) {
  const { email, password, firstName, lastName, phone, addressData } = input;
  const defaultAddress = addressData ? normalizeUserAddress({ ...addressData, isDefault: true }, 'Primary address') : null;
  const savedAddresses = defaultAddress ? normalizeSavedAddresses([defaultAddress], defaultAddress) : [];

  // Check existing
  const existing = await User.findOne({ email });
  if (existing) {
    if (!existing.isEmailVerified) {
      await createAndSendOtp(email, OtpPurpose.EMAIL_VERIFICATION);
      return { message: 'Registration already exists but email is not verified. A new verification code has been sent.' };
    }

    throw AppError.conflict('Email already registered', ErrorCode.DUPLICATE_ENTRY);
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  const user = await User.create({
    email,
    password: hashedPassword,
    firstName,
    lastName,
    phone,
    address: defaultAddress?.formattedAddress,
    addressData: defaultAddress || undefined,
    savedAddresses,
    roles: [Role.CUSTOMER],
    isEmailVerified: false,
  });

  // Send OTP
  await createAndSendOtp(email, OtpPurpose.EMAIL_VERIFICATION);

  await AuditLog.create({
    action: AuditAction.USER_CREATED,
    actorId: user._id,
    actorEmail: email,
    targetType: 'user',
    targetId: user._id,
    ipAddress: ip,
    userAgent: ua,
  });

  return { message: 'Registration successful. Please verify your email.' };
}

export async function verifyEmail(input: VerifyEmailInput, ip?: string, ua?: string, hints?: ClientHints) {
  const { email, otp } = input;

  await verifyOtp(email, otp, OtpPurpose.EMAIL_VERIFICATION);

  const user = await User.findOne({ email });
  if (!user) throw AppError.notFound('User not found');

  user.isEmailVerified = true;
  await user.save();

  // Generate tokens so the user is auto-logged-in
  const accessToken = generateAccessToken(user._id.toString(), user.roles as Role[]);
  const refreshTokenValue = generateRefreshToken();

  const refreshExpiryDays = parseInt(env.JWT_REFRESH_EXPIRY) || 7;
  const refreshExpiresAt = new Date(Date.now() + refreshExpiryDays * 24 * 60 * 60 * 1000);

  await RefreshToken.create({
    userId: user._id,
    token: refreshTokenValue,
    userAgent: ua,
    ipAddress: ip,
    clientHints: hints,
    expiresAt: refreshExpiresAt,
  });

  await AuditLog.create({
    action: AuditAction.EMAIL_VERIFIED,
    actorId: user._id,
    actorEmail: email,
    targetType: 'user',
    targetId: user._id,
    ipAddress: ip,
    userAgent: ua,
  });

  return {
    message: 'Email verified successfully',
    accessToken,
    refreshToken: refreshTokenValue,
    user: {
      id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      roles: user.roles,
    },
  };
}

export async function login(
  input: LoginInput,
  ip?: string,
  ua?: string,
  hints?: ClientHints,
) {
  const { email, password } = input;
  const deviceInfo = parseDevice(ua, ip, hints);

  const user = await User.findOne({ email }).select('+password +provider +firebaseUid');
  if (!user) {
    // Log failed attempt
    await AuditLog.create({
      action: AuditAction.LOGIN_FAILED,
      actorEmail: email,
      details: { reason: 'User not found' },
      ipAddress: ip,
      userAgent: ua,
    });
    throw AppError.unauthorized('Invalid email or password', ErrorCode.INVALID_CREDENTIALS);
  }

  if (!user.isActive) {
    throw AppError.forbidden('Account is disabled', ErrorCode.ACCOUNT_DISABLED);
  }

  if (!user.isEmailVerified) {
    throw AppError.forbidden('Please verify your email first', ErrorCode.EMAIL_NOT_VERIFIED);
  }

  // Check temp account expiry
  if (user.expiresAt && new Date() > user.expiresAt) {
    throw AppError.forbidden('Account has expired', ErrorCode.ACCOUNT_EXPIRED);
  }

  if (isGoogleOnlyAccount(user)) {
    throw AppError.forbidden(
      'This account uses Google sign-in. Please continue with Google.',
      ErrorCode.FORBIDDEN,
    );
  }

  if (!hasLocalPassword(user)) {
    throw AppError.unauthorized('Invalid email or password', ErrorCode.INVALID_CREDENTIALS);
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    // Record failed login
    await LoginHistory.record({
      userId: user._id,
      ipAddress: ip || '',
      userAgent: ua || '',
      browser: deviceInfo.browser,
      os: deviceInfo.os,
      device: deviceInfo.device,
      location: deviceInfo.location,
      status: 'failed',
      failReason: 'Wrong password',
    });

    await AuditLog.create({
      action: AuditAction.LOGIN_FAILED,
      actorId: user._id,
      actorEmail: email,
      details: { reason: 'Wrong password' },
      ipAddress: ip,
      userAgent: ua,
    });
    throw AppError.unauthorized('Invalid email or password', ErrorCode.INVALID_CREDENTIALS);
  }

  // ── 2FA Check ──
  if (user.twoFactorEnabled) {
    // Send 2FA OTP and return temp token (no cookies yet)
    await createAndSendOtp(email, OtpPurpose.LOGIN_2FA);
    const tempToken = generateTempToken(user._id.toString());

    return {
      requires2FA: true,
      tempToken,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
      },
    };
  }

  // ── Normal login (no 2FA) ──
  const accessToken = generateAccessToken(user._id.toString(), user.roles as Role[]);
  const refreshTokenValue = generateRefreshToken();

  // Calculate refresh expiry
  const refreshExpiryDays = parseInt(env.JWT_REFRESH_EXPIRY) || 7;
  const refreshExpiresAt = new Date(Date.now() + refreshExpiryDays * 24 * 60 * 60 * 1000);

  await RefreshToken.create({
    userId: user._id,
    token: refreshTokenValue,
    userAgent: ua,
    ipAddress: ip,
    clientHints: hints,
    expiresAt: refreshExpiresAt,
  });

  // Record successful login
  await LoginHistory.record({
    userId: user._id,
    ipAddress: ip || '',
    userAgent: ua || '',
    browser: deviceInfo.browser,
    os: deviceInfo.os,
    device: deviceInfo.device,
    location: deviceInfo.location,
    status: 'success',
  });

  await AuditLog.create({
    action: AuditAction.LOGIN,
    actorId: user._id,
    actorEmail: email,
    targetType: 'user',
    targetId: user._id,
    ipAddress: ip,
    userAgent: ua,
  });

  return {
    requires2FA: false,
    accessToken,
    refreshToken: refreshTokenValue,
    user: {
      id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      roles: user.roles,
      mustChangePassword: user.mustChangePassword,
    },
  };
}

export async function refreshAccessToken(refreshTokenValue: string) {
  const tokenDoc = await RefreshToken.findOne({ token: refreshTokenValue });
  if (!tokenDoc) {
    throw AppError.unauthorized('Invalid refresh token', ErrorCode.TOKEN_INVALID);
  }

  if (new Date() > tokenDoc.expiresAt) {
    await RefreshToken.deleteOne({ _id: tokenDoc._id });
    throw AppError.unauthorized('Refresh token expired', ErrorCode.TOKEN_EXPIRED);
  }

  const user = await User.findById(tokenDoc.userId);
  if (!user || !user.isActive) {
    throw AppError.unauthorized('User not found or disabled', ErrorCode.TOKEN_INVALID);
  }

  const accessToken = generateAccessToken(user._id.toString(), user.roles as Role[]);

  return { accessToken };
}

export async function logout(userId: string, refreshTokenValue?: string, ip?: string, ua?: string) {
  if (refreshTokenValue) {
    await RefreshToken.deleteOne({ token: refreshTokenValue, userId });
  } else {
    // Delete all sessions for this user
    await RefreshToken.deleteMany({ userId });
  }

  await AuditLog.create({
    action: AuditAction.LOGOUT,
    actorId: userId as unknown as import('mongoose').Types.ObjectId,
    targetType: 'user',
    ipAddress: ip,
    userAgent: ua,
  });

  return { message: 'Logged out successfully' };
}

export async function forgotPassword(input: ForgotPasswordInput) {
  const { email } = input;
  const user = await User.findOne({ email }).select('+password +provider +firebaseUid roles');
  if (!user) {
    // Don't reveal if email exists
    return { message: 'If the email exists, an OTP has been sent.' };
  }

  if (isInternalManagedAccount(user)) {
    throw AppError.badRequest(
      'You cannot reset this password here. Please contact your administrator.',
      ErrorCode.VALIDATION_ERROR,
      { accountType: 'internal' },
    );
  }

  if (isGoogleOnlyAccount(user)) {
    throw AppError.badRequest(
      'This account uses Google sign-in. Please continue with Google.',
      ErrorCode.VALIDATION_ERROR,
      { authProvider: 'google' },
    );
  }

  await createAndSendOtp(email, OtpPurpose.PASSWORD_RESET);
  return { message: 'If the email exists, an OTP has been sent.' };
}

export async function resetPassword(input: ResetPasswordInput, ip?: string, ua?: string) {
  const { email, otp, newPassword } = input;

  const user = await User.findOne({ email }).select('+password +provider +firebaseUid roles');
  if (!user) throw AppError.notFound('User not found');

  if (isInternalManagedAccount(user)) {
    throw AppError.badRequest(
      'You cannot reset this password here. Please contact your administrator.',
      ErrorCode.VALIDATION_ERROR,
      { accountType: 'internal' },
    );
  }

  if (isGoogleOnlyAccount(user)) {
    throw AppError.badRequest(
      'This account uses Google sign-in. Please continue with Google.',
      ErrorCode.VALIDATION_ERROR,
      { authProvider: 'google' },
    );
  }

  await verifyOtp(email, otp, OtpPurpose.PASSWORD_RESET);

  user.password = await bcrypt.hash(newPassword, 12);
  user.mustChangePassword = false;
  await user.save();

  // Invalidate all refresh tokens (force re-login)
  await RefreshToken.deleteMany({ userId: user._id });

  await AuditLog.create({
    action: AuditAction.PASSWORD_RESET,
    actorId: user._id,
    actorEmail: email,
    targetType: 'user',
    targetId: user._id,
    ipAddress: ip,
    userAgent: ua,
  });

  return { message: 'Password reset successfully. Please login.' };
}

export async function resendOtp(input: ResendOtpInput) {
  const { email, purpose } = input;
  const user = await User.findOne({ email });
  if (!user) {
    return { message: 'If the email exists, an OTP has been sent.' };
  }

  await createAndSendOtp(email, purpose as OtpPurpose);
  return { message: 'OTP sent successfully.' };
}

export async function changePassword(userId: string, input: ChangePasswordInput, ip?: string, ua?: string) {
  const { currentPassword, newPassword } = input;

  const user = await User.findById(userId).select('+password');
  if (!user) throw AppError.notFound('User not found');

  const isMatch = await bcrypt.compare(currentPassword, user.password);
  if (!isMatch) {
    throw AppError.badRequest('Current password is incorrect', ErrorCode.INVALID_CREDENTIALS);
  }

  user.password = await bcrypt.hash(newPassword, 12);
  user.mustChangePassword = false;
  await user.save();

  await AuditLog.create({
    action: AuditAction.PASSWORD_CHANGED,
    actorId: user._id,
    targetType: 'user',
    targetId: user._id,
    ipAddress: ip,
    userAgent: ua,
  });

  return { message: 'Password changed successfully' };
}

// ── 2FA Verification (after login) ──

export async function verify2fa(input: Verify2faInput, ip?: string, ua?: string, hints?: ClientHints) {
  const { tempToken, otp } = input;
  const { userId } = verifyTempToken(tempToken);

  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('User not found');

  await verifyOtp(user.email, otp, OtpPurpose.LOGIN_2FA);

  const deviceInfo = parseDevice(ua, ip, hints);

  // Now issue full tokens
  const accessToken = generateAccessToken(user._id.toString(), user.roles as Role[]);
  const refreshTokenValue = generateRefreshToken();

  const refreshExpiryDays = parseInt(env.JWT_REFRESH_EXPIRY) || 7;
  const refreshExpiresAt = new Date(Date.now() + refreshExpiryDays * 24 * 60 * 60 * 1000);

  await RefreshToken.create({
    userId: user._id,
    token: refreshTokenValue,
    userAgent: ua,
    ipAddress: ip,
    clientHints: hints,
    expiresAt: refreshExpiresAt,
  });

  // Record successful login (after 2FA)
  await LoginHistory.record({
    userId: user._id,
    ipAddress: ip || '',
    userAgent: ua || '',
    browser: deviceInfo.browser,
    os: deviceInfo.os,
    device: deviceInfo.device,
    location: deviceInfo.location,
    status: 'success',
  });

  await AuditLog.create({
    action: AuditAction.LOGIN,
    actorId: user._id,
    actorEmail: user.email,
    targetType: 'user',
    targetId: user._id,
    details: { via: '2fa' },
    ipAddress: ip,
    userAgent: ua,
  });

  return {
    accessToken,
    refreshToken: refreshTokenValue,
    user: {
      id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      roles: user.roles,
      mustChangePassword: user.mustChangePassword,
    },
  };
}

export async function resend2fa(input: Resend2faInput) {
  const { tempToken } = input;
  const { userId } = verifyTempToken(tempToken);

  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('User not found');

  await createAndSendOtp(user.email, OtpPurpose.LOGIN_2FA);
  return { message: 'Verification code resent.' };
}

// ── 2FA Enable / Disable ──

export async function enable2fa(userId: string) {
  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('User not found');

  if (user.twoFactorEnabled) {
    throw AppError.badRequest('Two-factor authentication is already enabled');
  }

  // Send verification OTP to confirm email is working
  await createAndSendOtp(user.email, OtpPurpose.ENABLE_2FA);
  return { message: 'Verification code sent to your email.' };
}

export async function confirmEnable2fa(userId: string, otp: string, ip?: string, ua?: string) {
  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('User not found');

  await verifyOtp(user.email, otp, OtpPurpose.ENABLE_2FA);

  user.twoFactorEnabled = true;
  await user.save();

  await AuditLog.create({
    action: AuditAction.TWO_FA_ENABLED,
    actorId: user._id,
    actorEmail: user.email,
    targetType: 'user',
    targetId: user._id,
    ipAddress: ip,
    userAgent: ua,
  });

  return { message: 'Two-factor authentication enabled successfully.' };
}

export async function disable2fa(userId: string, input: Disable2faInput, ip?: string, ua?: string) {
  const { password } = input;

  const user = await User.findById(userId).select('+password +provider +firebaseUid');
  if (!user) throw AppError.notFound('User not found');

  if (!user.twoFactorEnabled) {
    throw AppError.badRequest('Two-factor authentication is not enabled');
  }

  // Google-linked accounts are already identity-verified by bearer token.
  const isGoogleLinkedAccount = user.provider === 'google' || Boolean(user.firebaseUid);
  if (!isGoogleLinkedAccount) {
    if (!password) throw AppError.badRequest('Password is required', ErrorCode.VALIDATION_ERROR);
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      throw AppError.badRequest('Incorrect password', ErrorCode.INVALID_CREDENTIALS);
    }
  }

  user.twoFactorEnabled = false;
  await user.save();

  await AuditLog.create({
    action: AuditAction.TWO_FA_DISABLED,
    actorId: user._id,
    actorEmail: user.email,
    targetType: 'user',
    targetId: user._id,
    ipAddress: ip,
    userAgent: ua,
  });

  return { message: 'Two-factor authentication disabled.' };
}

// ── Sessions & Login History ──

export async function getSessions(userId: string, currentRefreshToken?: string) {
  const sessions = await RefreshToken.find({ userId })
    .sort({ createdAt: -1 })
    .lean();

  return sessions.map((s) => {
    const deviceInfo = parseDevice(s.userAgent, s.ipAddress, (s as any).clientHints);
    return {
      _id: s._id,
      browser: deviceInfo.browser,
      os: deviceInfo.os,
      device: deviceInfo.device,
      location: deviceInfo.location,
      ipAddress: s.ipAddress || '',
      isCurrent: s.token === currentRefreshToken,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
    };
  });
}

export async function revokeSession(userId: string, sessionId: string, currentRefreshToken?: string, ip?: string, ua?: string) {
  const session = await RefreshToken.findOne({ _id: sessionId, userId });
  if (!session) throw AppError.notFound('Session not found');

  if (session.token === currentRefreshToken) {
    throw AppError.badRequest('Cannot revoke your current session. Use logout instead.');
  }

  await RefreshToken.deleteOne({ _id: sessionId });

  await AuditLog.create({
    action: AuditAction.SESSION_REVOKED,
    actorId: userId as unknown as Types.ObjectId,
    targetType: 'session',
    targetId: session._id,
    ipAddress: ip,
    userAgent: ua,
  });

  return { message: 'Session revoked.' };
}

export async function revokeAllOtherSessions(userId: string, currentRefreshToken?: string, ip?: string, ua?: string) {
  const query: Record<string, unknown> = { userId };
  if (currentRefreshToken) {
    query.token = { $ne: currentRefreshToken };
  }

  const result = await RefreshToken.deleteMany(query);

  await AuditLog.create({
    action: AuditAction.ALL_SESSIONS_REVOKED,
    actorId: userId as unknown as Types.ObjectId,
    targetType: 'user',
    details: { count: result.deletedCount },
    ipAddress: ip,
    userAgent: ua,
  });

  return { message: `${result.deletedCount} session(s) revoked.` };
}

export async function getLoginHistory(userId: string) {
  const history = await LoginHistory.find({ userId })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  return history;
}

// ── Google Auth ──

function getFirebaseTokenMetadata(idToken: string) {
  try {
    const [, encodedPayload] = idToken.split('.');
    if (!encodedPayload) return undefined;
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as {
      aud?: string;
      iss?: string;
      iat?: number;
      exp?: number;
    };
    return {
      audience: payload.aud,
      issuer: payload.iss,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    };
  } catch {
    return undefined;
  }
}

async function verifyGoogleIdToken(idToken: string) {
  try {
    return await verifyFirebaseIdToken(idToken);
  } catch (error: unknown) {
    const firebaseError = error as { code?: string; message?: string };
    logger.warn('Google ID token verification failed', {
      code: firebaseError.code ?? 'unknown',
      message: firebaseError.message ?? 'Unknown Firebase verification error',
      token: getFirebaseTokenMetadata(idToken),
    });

    if (firebaseError.code === 'auth/id-token-expired') {
      throw AppError.unauthorized(
        'Your Google sign-in session expired. Please try again.',
        ErrorCode.TOKEN_EXPIRED,
      );
    }

    throw AppError.unauthorized(
      'We could not verify your Google sign-in. Please try again.',
      ErrorCode.TOKEN_INVALID,
    );
  }
}

export async function googleAuth(input: GoogleAuthInput, ip?: string, ua?: string, hints?: ClientHints) {
  const { idToken } = input;

  // Verify Firebase ID token
  const decoded = await verifyGoogleIdToken(idToken);

  const email = decoded.email?.toLowerCase();
  if (!email) throw AppError.badRequest('Google account has no email');

  const firebaseUid = decoded.uid;

  // 1. Check if user already exists by firebaseUid
  let user = await User.findOne({ firebaseUid });
  if (user) {
    // Existing Google user → just log them in
    if (!user.isActive) throw AppError.forbidden('Your account has been disabled. Contact support.', ErrorCode.ACCOUNT_DISABLED);

    // Check 2FA
    if (user.twoFactorEnabled) {
      return issueGoogle2fa(user);
    }

    return issueGoogleLogin(user, ip, ua, hints);
  }

  // 2. Check if a user with the same email exists (local user)
  user = await User.findOne({ email });
  if (user) {
    if (!user.isActive) throw AppError.forbidden('Your account has been disabled. Contact support.', ErrorCode.ACCOUNT_DISABLED);

    // Link the Google account to the existing local user
    user.firebaseUid = firebaseUid;
    user.provider = user.provider === 'google' ? 'google' : 'local'; // keep 'local' if they already had a password
    if (decoded.picture && !user.photoURL) {
      user.photoURL = decoded.picture;
    }
    if (!user.isEmailVerified) {
      user.isEmailVerified = true; // Google email is verified
    }
    await user.save();

    // Check 2FA
    if (user.twoFactorEnabled) {
      return issueGoogle2fa(user);
    }

    return issueGoogleLogin(user, ip, ua, hints);
  }

  // 3. New user → needs to complete profile
  return {
    needsProfile: true,
    email,
    firebaseUid,
    googleName: decoded.name || '',
    googlePhoto: decoded.picture || '',
  };
}

export async function googleComplete(input: GoogleCompleteInput, ip?: string, ua?: string, hints?: ClientHints) {
  const { idToken, firstName, lastName, phone, addressData } = input;
  const defaultAddress = addressData
    ? normalizeUserAddress({ ...addressData, isDefault: true }, 'Primary address')
    : null;
  const savedAddresses = defaultAddress ? normalizeSavedAddresses([defaultAddress], defaultAddress) : [];

  // Re-verify Firebase ID token
  const decoded = await verifyGoogleIdToken(idToken);

  const email = decoded.email?.toLowerCase();
  if (!email) throw AppError.badRequest('Google account has no email');

  const firebaseUid = decoded.uid;

  // Make sure user doesn't already exist
  const existing = await User.findOne({ $or: [{ firebaseUid }, { email }] });
  if (existing) {
    // If they somehow already registered, just log them in
    if (!existing.isActive) throw AppError.forbidden('Your account has been disabled. Contact support.', ErrorCode.ACCOUNT_DISABLED);
    
    // Link firebase UID if not yet linked
    if (!existing.firebaseUid) {
      existing.firebaseUid = firebaseUid;
      await existing.save();
    }
    
    return issueGoogleLogin(existing, ip, ua, hints);
  }

  // Create new user with Google provider (no password needed)
  const newUser = await User.create({
    email,
    firstName,
    lastName,
    phone,
    address: defaultAddress?.formattedAddress,
    addressData: defaultAddress || undefined,
    savedAddresses,
    provider: 'google',
    firebaseUid,
    photoURL: decoded.picture || undefined,
    isEmailVerified: true, // Google accounts are verified
    roles: [Role.CUSTOMER],
    isActive: true,
    mustChangePassword: false,
  });

  await AuditLog.create({
    action: AuditAction.USER_CREATED,
    actorId: newUser._id,
    actorEmail: email,
    targetType: 'user',
    targetId: newUser._id,
    details: { provider: 'google' },
    ipAddress: ip,
    userAgent: ua,
  });

  return issueGoogleLogin(newUser, ip, ua, hints);
}

async function issueGoogle2fa(user: InstanceType<typeof User>) {
  await createAndSendOtp(user.email, OtpPurpose.LOGIN_2FA);
  const tempToken = generateTempToken(user._id.toString());

  return {
    requires2FA: true,
    tempToken,
    user: {
      id: user._id,
      email: user.email,
      firstName: user.firstName,
    },
  };
}

async function issueGoogleLogin(user: InstanceType<typeof User>, ip?: string, ua?: string, hints?: ClientHints) {
  const deviceInfo = parseDevice(ua, ip, hints);
  const accessToken = generateAccessToken(user._id.toString(), user.roles as Role[]);
  const refreshTokenValue = generateRefreshToken();

  const refreshExpiryDays = parseInt(env.JWT_REFRESH_EXPIRY) || 7;
  const refreshExpiresAt = new Date(Date.now() + refreshExpiryDays * 24 * 60 * 60 * 1000);

  await RefreshToken.create({
    userId: user._id,
    token: refreshTokenValue,
    userAgent: ua,
    ipAddress: ip,
    clientHints: hints,
    expiresAt: refreshExpiresAt,
  });

  await LoginHistory.record({
    userId: user._id,
    ipAddress: ip || '',
    userAgent: ua || '',
    browser: deviceInfo.browser,
    os: deviceInfo.os,
    device: deviceInfo.device,
    location: deviceInfo.location,
    status: 'success',
  });

  await AuditLog.create({
    action: AuditAction.LOGIN,
    actorId: user._id,
    actorEmail: user.email,
    targetType: 'user',
    targetId: user._id,
    details: { provider: 'google' },
    ipAddress: ip,
    userAgent: ua,
  });

  return {
    accessToken,
    refreshToken: refreshTokenValue,
    user: {
      id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      roles: user.roles,
      mustChangePassword: false,
      provider: user.provider,
      firebaseUid: user.firebaseUid,
    },
  };
}
