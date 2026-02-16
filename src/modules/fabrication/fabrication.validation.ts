import { z } from 'zod';
import { FabricationStatus } from '../../utils/constants.js';

export const createFabricationUpdateSchema = z.object({
  projectId: z.string().min(1),
  status: z.nativeEnum(FabricationStatus),
  notes: z.string().min(1).max(2000).trim(),
  photoKeys: z.array(z.string().min(1)).max(10).optional(),
});

export type CreateFabricationUpdateInput = z.infer<typeof createFabricationUpdateSchema>;
