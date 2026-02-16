import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as fabricationService from './fabrication.service.js';

export const createFabricationUpdate = asyncHandler(async (req: Request, res: Response) => {
  const update = await fabricationService.createFabricationUpdate(req.body, req.userId!, req.ip, req.get('user-agent'));
  res.status(201).json({ success: true, data: update });
});

export const listFabricationUpdates = asyncHandler(async (req: Request, res: Response) => {
  const updates = await fabricationService.listFabricationUpdates(
    (req.params.projectId as string),
    req.userId!,
    req.userRoles!,
  );
  res.json({ success: true, data: updates });
});

export const getLatestFabricationStatus = asyncHandler(async (req: Request, res: Response) => {
  const result = await fabricationService.getLatestFabricationStatus(
    (req.params.projectId as string),
    req.userId!,
    req.userRoles!,
  );
  res.json({ success: true, data: result });
});

export const getFabricationUpdateById = asyncHandler(async (req: Request, res: Response) => {
  const update = await fabricationService.getFabricationUpdateById(
    (req.params.id as string),
    req.userId!,
    req.userRoles!,
  );
  res.json({ success: true, data: update });
});
