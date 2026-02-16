import { z } from 'zod';

export const updateVisitReportSchema = z.object({
  visitType: z.enum(['ocular', 'consultation']).optional(),
  actualVisitDateTime: z.string().datetime().optional(),
  measurements: z.object({
    length: z.number().positive().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    area: z.number().positive().optional(),
    thickness: z.number().positive().optional(),
    unit: z.string().default('cm'),
    raw: z.string().max(2000).optional(),
  }).optional(),
  materials: z.string().max(1000).trim().optional(),
  finishes: z.string().max(500).trim().optional(),
  preferredDesign: z.string().max(1000).trim().optional(),
  customerRequirements: z.string().max(2000).trim().optional(),
  notes: z.string().max(3000).trim().optional(),
  photoKeys: z.array(z.string()).max(20).optional(),
  videoKeys: z.array(z.string()).max(5).optional(),
  sketchKeys: z.array(z.string()).max(10).optional(),
  referenceImageKeys: z.array(z.string()).max(10).optional(),
});

export const returnVisitReportSchema = z.object({
  reason: z.string().min(1).max(1000).trim(),
});

export type UpdateVisitReportInput = z.infer<typeof updateVisitReportSchema>;
export type ReturnVisitReportInput = z.infer<typeof returnVisitReportSchema>;
