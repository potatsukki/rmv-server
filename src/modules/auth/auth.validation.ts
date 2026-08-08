import { z } from 'zod';

const phoneRegex = /^(09|\+639)\d{9}$/;
const nameRegex = /^[a-zA-Z\s'-]+$/;

const pinnedAddressSchema = z.object({
  id: z.string().max(80).trim().optional(),
  label: z.string().max(80).trim().optional(),
  street: z.string().max(200).trim().optional().or(z.literal('')),
  barangay: z.string().max(100).trim().optional().or(z.literal('')),
  city: z.string().min(1, 'City / municipality is required').max(100).trim(),
  province: z.string().max(100).trim().optional().or(z.literal('')),
  zip: z.string().max(10).trim().optional().or(z.literal('')),
  country: z.string().max(50).trim().optional().or(z.literal('')),
  addressType: z.enum(['personal', 'business']).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  formattedAddress: z.string().max(500).trim().optional().or(z.literal('')),
  isDefault: z.boolean().optional(),
});

export const registerSchema = z.object({
  email: z.string().email('Invalid email address').toLowerCase().trim(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Must contain at least one lowercase letter')
    .regex(/\d/, 'Must contain at least one digit')
    .regex(/[^A-Za-z0-9]/, 'Must contain at least one special character'),
  firstName: z.string().min(1).max(50).regex(nameRegex, 'Name contains invalid characters').trim(),
  lastName: z.string().min(1).max(50).regex(nameRegex, 'Name contains invalid characters').trim(),
  phone: z.string().regex(phoneRegex, 'Must be a valid PH mobile number (09XXXXXXXXX)').transform(v => v.startsWith('09') ? '+63' + v.slice(1) : v),
  addressData: pinnedAddressSchema.optional(),
});

export const verifyEmailSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  otp: z.string().length(6, 'OTP must be 6 digits'),
});

export const loginSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(1, 'Password is required'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
});

export const resetPasswordSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  otp: z.string().length(6),
  newPassword: z
    .string()
    .min(8)
    .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Must contain at least one lowercase letter')
    .regex(/\d/, 'Must contain at least one digit')
    .regex(/[^A-Za-z0-9]/, 'Must contain at least one special character'),
});

export const resendOtpSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  purpose: z.enum(['email_verification', 'password_reset', 'login_2fa', 'enable_2fa']),
});

export const verify2faSchema = z.object({
  tempToken: z.string().min(1, 'Temp token is required'),
  otp: z.string().length(6, 'OTP must be 6 digits'),
});

export const resend2faSchema = z.object({
  tempToken: z.string().min(1, 'Temp token is required'),
});

export const disable2faSchema = z.object({
  password: z.string().optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(8)
    .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Must contain at least one lowercase letter')
    .regex(/\d/, 'Must contain at least one digit')
    .regex(/[^A-Za-z0-9]/, 'Must contain at least one special character'),
});

// ── Google Auth Schemas ──
export const googleAuthSchema = z.object({
  idToken: z.string().min(1, 'Firebase ID token is required'),
});

export const googleCompleteSchema = z.object({
  idToken: z.string().min(1, 'Firebase ID token is required'),
  firstName: z.string().min(1).max(50).regex(nameRegex, 'Name contains invalid characters').trim(),
  lastName: z.string().min(1).max(50).regex(nameRegex, 'Name contains invalid characters').trim(),
  phone: z.string().regex(phoneRegex, 'Must be a valid PH mobile number (09XXXXXXXXX)').transform(v => v.startsWith('09') ? '+63' + v.slice(1) : v),
  addressData: pinnedAddressSchema.optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ResendOtpInput = z.infer<typeof resendOtpSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type Verify2faInput = z.infer<typeof verify2faSchema>;
export type Resend2faInput = z.infer<typeof resend2faSchema>;
export type Disable2faInput = z.infer<typeof disable2faSchema>;
export type GoogleAuthInput = z.infer<typeof googleAuthSchema>;
export type GoogleCompleteInput = z.infer<typeof googleCompleteSchema>;
