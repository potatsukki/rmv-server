import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../../config/env.js';
import { User, OtpToken, RefreshToken, AuditLog } from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import { Role, OtpPurpose, AuditAction } from '../../utils/constants.js';
import { generateOtp } from '../../utils/helpers.js';
import { sendOtpEmail, sendPasswordResetEmail } from '../notifications/email.service.js';
import type {
  RegisterInput,
  VerifyEmailInput,
  LoginInput,
  ForgotPasswordInput,
  ResetPasswordInput,
  ResendOtpInput,
  ChangePasswordInput,
} from './auth.validation.js';

// ── Token Generation ──
function generateAccessToken(userId: string, roles: Role[]): string {
  return jwt.sign({ userId, roles }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRY,
  } as jwt.SignOptions);
}

function generateRefreshToken(): string {
  return crypto.randomBytes(64).toString('hex');
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
  const { email, password, firstName, lastName, phone } = input;

  // Check existing
  const existing = await User.findOne({ email });
  if (existing) {
    throw AppError.conflict('Email already registered', ErrorCode.DUPLICATE_ENTRY);
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  const user = await User.create({
    email,
    password: hashedPassword,
    firstName,
    lastName,
    phone,
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

export async function verifyEmail(input: VerifyEmailInput, ip?: string, ua?: string) {
  const { email, otp } = input;

  await verifyOtp(email, otp, OtpPurpose.EMAIL_VERIFICATION);

  const user = await User.findOne({ email });
  if (!user) throw AppError.notFound('User not found');

  user.isEmailVerified = true;
  await user.save();

  await AuditLog.create({
    action: AuditAction.EMAIL_VERIFIED,
    actorId: user._id,
    actorEmail: email,
    targetType: 'user',
    targetId: user._id,
    ipAddress: ip,
    userAgent: ua,
  });

  return { message: 'Email verified successfully' };
}

export async function login(
  input: LoginInput,
  ip?: string,
  ua?: string,
) {
  const { email, password } = input;

  const user = await User.findOne({ email }).select('+password');
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

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
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

  // Generate tokens
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
    expiresAt: refreshExpiresAt,
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
  const user = await User.findOne({ email });
  if (!user) {
    // Don't reveal if email exists
    return { message: 'If the email exists, an OTP has been sent.' };
  }

  await createAndSendOtp(email, OtpPurpose.PASSWORD_RESET);
  return { message: 'If the email exists, an OTP has been sent.' };
}

export async function resetPassword(input: ResetPasswordInput, ip?: string, ua?: string) {
  const { email, otp, newPassword } = input;

  await verifyOtp(email, otp, OtpPurpose.PASSWORD_RESET);

  const user = await User.findOne({ email });
  if (!user) throw AppError.notFound('User not found');

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
