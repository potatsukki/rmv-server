import { z } from 'zod';
import { Role } from '../../utils/constants.js';

const phoneRegex = /^\+639\d{9}$/;

export const createUserSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  firstName: z.string().min(1).max(50).trim(),
  lastName: z.string().min(1).max(50).trim(),
  phone: z.union([
    z.string().regex(phoneRegex, 'Must be a valid PH mobile (+63 9XX)'),
    z.literal(''),
  ]).optional().transform(v => v === '' ? undefined : v),
  roles: z.array(z.nativeEnum(Role)).min(1),
  password: z.string().min(8),
  expiresAt: z.string().datetime().optional(), // ISO string for temp accounts
});

export const updateUserSchema = z.object({
  firstName: z.string().min(1).max(50).trim().optional(),
  lastName: z.string().min(1).max(50).trim().optional(),
  phone: z.string().regex(phoneRegex).optional(),
  roles: z.array(z.nativeEnum(Role)).min(1).optional(),
  isActive: z.boolean().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

export const updateProfileSchema = z.object({
  firstName: z.string().min(1).max(50).trim().optional(),
  lastName: z.string().min(1).max(50).trim().optional(),
  phone: z.string().regex(phoneRegex).optional(),
  address: z.string().max(500).trim().optional(),
  notificationPreferences: z.object({
    appointment: z.boolean().optional(),
    payment: z.boolean().optional(),
    blueprint: z.boolean().optional(),
    fabrication: z.boolean().optional(),
  }).optional(),
});

export const salesAvailabilitySchema = z.object({
  salesStaffId: z.string().min(1),
  unavailableDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
