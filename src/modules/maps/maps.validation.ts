import { z } from 'zod';

export const coordinateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const autocompleteQuerySchema = z.object({
  input: z.string().min(1).max(200),
  sessionToken: z.string().optional(),
});

export const placeDetailsQuerySchema = z.object({
  placeId: z.string().min(1),
  sessionToken: z.string().optional(),
});
