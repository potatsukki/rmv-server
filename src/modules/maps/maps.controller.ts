import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as mapsService from './maps.service.js';

// ── Compute Ocular Fee ──
export const computeOcularFee = asyncHandler(async (req: Request, res: Response) => {
  const { lat, lng } = req.body;
  const result = await mapsService.computeOcularFee({ lat, lng });
  res.json({ success: true, data: result });
});

// ── Compute Route (distance only) ──
export const computeRoute = asyncHandler(async (req: Request, res: Response) => {
  const { lat, lng } = req.body;
  const result = await mapsService.computeRoute({ lat, lng });
  res.json({ success: true, data: result });
});

// ── Places Autocomplete ──
export const placesAutocomplete = asyncHandler(async (req: Request, res: Response) => {
  const { input, sessionToken } = req.query as { input: string; sessionToken?: string };
  const predictions = await mapsService.placesAutocomplete(input, sessionToken);
  res.json({ success: true, data: predictions });
});

// ── Place Details ──
export const placeDetails = asyncHandler(async (req: Request, res: Response) => {
  const { placeId, sessionToken } = req.query as { placeId: string; sessionToken?: string };
  const details = await mapsService.placeDetails(placeId, sessionToken);
  res.json({ success: true, data: details });
});
