import { z } from 'zod';

export const updateConfigSchema = z.object({
  value: z.unknown(),
  description: z.string().max(200).trim().optional(),
});

export const createHolidaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  name: z.string().min(1).max(100).trim(),
});

export const maintenanceToggleSchema = z.object({
  enabled: z.boolean(),
});

export type UpdateConfigInput = z.infer<typeof updateConfigSchema>;
export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;
