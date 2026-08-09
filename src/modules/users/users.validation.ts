import { z } from 'zod';
import { Role, SLOT_CODES, StaffAvailabilityStatus } from '../../utils/constants.js';

const phoneRegex = /^\+639\d{9}$/;
const nameRegex = /^[a-zA-Z\s'-]+$/;

const savedAddressSchema = z.object({
  id: z.string().max(80).trim().optional(),
  label: z.string().max(80).trim().optional(),
  street: z.string().max(200).trim().optional().or(z.literal('')),
  barangay: z.string().max(100).trim().optional().or(z.literal('')),
  city: z.string().max(100).trim().optional().or(z.literal('')),
  province: z.string().max(100).trim().optional().or(z.literal('')),
  zip: z.string().max(10).trim().optional().or(z.literal('')),
  country: z.string().max(50).trim().optional().or(z.literal('')),
  addressType: z.enum(['personal', 'business']).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  formattedAddress: z.string().max(500).trim().optional().or(z.literal('')),
  isDefault: z.boolean().optional(),
});

export const createUserSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  firstName: z.string().min(1).max(50).regex(nameRegex, 'Name contains invalid characters').trim(),
  lastName: z.string().min(1).max(50).regex(nameRegex, 'Name contains invalid characters').trim(),
  phone: z.union([
    z.string().regex(phoneRegex, 'Must be a valid PH mobile (+63 9XX)'),
    z.literal(''),
  ]).optional().transform(v => v === '' ? undefined : v),
  roles: z.array(z.nativeEnum(Role)).min(1),
  password: z.string().min(8),
  expiresAt: z.string().datetime({ offset: true }).optional(), // ISO string for temp accounts
});

export const updateUserSchema = z.object({
  firstName: z.string().min(1).max(50).regex(nameRegex, 'Name contains invalid characters').trim().optional(),
  lastName: z.string().min(1).max(50).regex(nameRegex, 'Name contains invalid characters').trim().optional(),
  phone: z.string().regex(phoneRegex).optional(),
  roles: z.array(z.nativeEnum(Role)).min(1).optional(),
  password: z.string().min(8).optional(),
  isActive: z.boolean().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  availabilityStatus: z.nativeEnum(StaffAvailabilityStatus).optional(),
  availabilityNote: z.union([z.string().max(240).trim(), z.literal(''), z.null()]).optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      if (value === null || value === '') return null;
      return value;
    }),
  shiftStartAt: z.union([z.string().datetime({ offset: true }), z.literal(''), z.null()]).optional()
    .transform((value) => value === '' || value === null ? null : value),
  shiftEndAt: z.union([z.string().datetime({ offset: true }), z.literal(''), z.null()]).optional()
    .transform((value) => value === '' || value === null ? null : value),
}).superRefine((value, ctx) => {
  const isAvailable = value.availabilityStatus === StaffAvailabilityStatus.AVAILABLE;
  const hasShiftTimes = Boolean(value.shiftStartAt) || Boolean(value.shiftEndAt);

  if (isAvailable) {
    if (!value.shiftStartAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['shiftStartAt'],
        message: 'Shift start time is required when setting staff available',
      });
    }
    if (!value.shiftEndAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['shiftEndAt'],
        message: 'Shift end time is required when setting staff available',
      });
    }
  }

  if (hasShiftTimes && !isAvailable) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['availabilityStatus'],
      message: 'Shift times can only be provided when staff is available',
    });
  }

  if (value.shiftStartAt && value.shiftEndAt) {
    const start = new Date(value.shiftStartAt);
    const end = new Date(value.shiftEndAt);
    if (Number.isNaN(start.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['shiftStartAt'], message: 'Shift start time is invalid' });
    }
    if (Number.isNaN(end.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['shiftEndAt'], message: 'Shift end time is invalid' });
    }
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && start.getTime() >= end.getTime()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['shiftEndAt'], message: 'Shift end time must be after the shift start time' });
    }
  }
});

export const updateProfileSchema = z.object({
  firstName: z.string().min(1).max(50).regex(nameRegex, 'Name contains invalid characters').trim().optional(),
  lastName: z.string().min(1).max(50).regex(nameRegex, 'Name contains invalid characters').trim().optional(),
  phone: z.string().regex(phoneRegex).optional(),
  address: z.string().max(500).trim().optional(),
  addressData: savedAddressSchema.optional(),
  savedAddresses: z.array(savedAddressSchema).max(10).optional(),
  notificationPreferences: z.object({
    appointment: z.boolean().optional(),
    payment: z.boolean().optional(),
    blueprint: z.boolean().optional(),
    fabrication: z.boolean().optional(),
    project: z.boolean().optional(),
    emailNotifications: z.boolean().optional(),
  }).optional(),
  themePreference: z.enum(['light', 'dark', 'system']).optional(),
}).superRefine((data, ctx) => {
  // Note: Address fields are stripped server-side for non-customer roles.
  // This validation passes them through but the service layer handles role-based access.
});

export const updateOwnAvailabilitySchema = z.object({
  availabilityStatus: z.union([
    z.literal(StaffAvailabilityStatus.AVAILABLE),
    z.literal(StaffAvailabilityStatus.UNAVAILABLE),
  ]).optional(),
  availabilityNote: z.union([z.string().max(240).trim(), z.literal(''), z.null()]).optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      if (value === null || value === '') return null;
      return value;
    }),
  shiftStartAt: z.union([z.string().datetime({ offset: true }), z.literal(''), z.null()]).optional()
    .transform((value) => value === '' || value === null ? null : value),
  shiftEndAt: z.union([z.string().datetime({ offset: true }), z.literal(''), z.null()]).optional()
    .transform((value) => value === '' || value === null ? null : value),
}).superRefine((value, ctx) => {
  const isAvailable = value.availabilityStatus === StaffAvailabilityStatus.AVAILABLE;
  const hasShiftTimes = Boolean(value.shiftStartAt) || Boolean(value.shiftEndAt);

  if (isAvailable) {
    if (!value.shiftStartAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['shiftStartAt'],
        message: 'Shift start time is required when setting staff available',
      });
    }
    if (!value.shiftEndAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['shiftEndAt'],
        message: 'Shift end time is required when setting staff available',
      });
    }
  }

  if (hasShiftTimes && !isAvailable) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['availabilityStatus'],
      message: 'Shift times can only be provided when staff is available',
    });
  }

  if (value.shiftStartAt && value.shiftEndAt) {
    const start = new Date(value.shiftStartAt);
    const end = new Date(value.shiftEndAt);
    if (Number.isNaN(start.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['shiftStartAt'], message: 'Shift start time is invalid' });
    }
    if (Number.isNaN(end.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['shiftEndAt'], message: 'Shift end time is invalid' });
    }
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && start.getTime() >= end.getTime()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['shiftEndAt'], message: 'Shift end time must be after the shift start time' });
    }
  }
});

export const salesStaffLookupQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  slotCode: z.enum(SLOT_CODES).optional(),
  appointmentId: z.string().min(1).optional(),
  search: z.string().trim().optional(),
}).superRefine((value, ctx) => {
  if ((value.date && !value.slotCode) || (!value.date && value.slotCode)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: value.date ? ['slotCode'] : ['date'],
      message: 'Date and slot code must be provided together',
    });
  }
});

export const salesAvailabilitySchema = z.object({
  salesStaffId: z.string().min(1),
  unavailableDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  availabilityStatus: z.nativeEnum(StaffAvailabilityStatus).optional(),
  availabilityNote: z.union([z.string().max(240).trim(), z.literal(''), z.null()]).optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      if (value === null || value === '') return null;
      return value;
    }),
});

export const deleteAccountSchema = z.object({
  password: z.string().optional(),
  confirmation: z.literal('DELETE', { message: 'Type DELETE to confirm' }),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
export type UpdateOwnAvailabilityInput = z.infer<typeof updateOwnAvailabilitySchema>;
export type SalesStaffLookupQueryInput = z.infer<typeof salesStaffLookupQuerySchema>;
