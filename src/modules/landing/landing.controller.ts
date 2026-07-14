import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as landingService from './landing.service.js';

export const getLandingContent = asyncHandler(async (_req: Request, res: Response) => {
  const content = await landingService.getLandingPageContent();
  res.json({ success: true, data: content });
});
