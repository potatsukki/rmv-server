import { z } from 'zod';
import { BlueprintComponent } from '../../utils/constants.js';

export const uploadBlueprintSchema = z.object({
  projectId: z.string().min(1),
  blueprintKey: z.string().min(1),
  costingKey: z.string().min(1),
  quotation: z.object({
    materials: z.number().min(0),
    labor: z.number().min(0),
    fees: z.number().min(0),
    total: z.number().min(0),
    breakdown: z.string().max(5000).optional(),
    estimatedDuration: z.string().max(200).optional(),
    engineerNotes: z.string().max(3000).optional(),
  }).optional(),
});

export const revisionUploadSchema = z.object({
  blueprintKey: z.string().min(1),
  costingKey: z.string().min(1),
});

export const approveBlueprintSchema = z.object({
  component: z.nativeEnum(BlueprintComponent),
});

export const requestRevisionSchema = z.object({
  notes: z.string().min(1).max(2000).trim(),
  refKeys: z.array(z.string()).max(5).default([]),
});

export type UploadBlueprintInput = z.infer<typeof uploadBlueprintSchema>;
export type RevisionUploadInput = z.infer<typeof revisionUploadSchema>;
export type ApproveBlueprintInput = z.infer<typeof approveBlueprintSchema>;
export type RequestRevisionInput = z.infer<typeof requestRevisionSchema>;
