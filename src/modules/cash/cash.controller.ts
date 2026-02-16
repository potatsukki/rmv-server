import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as cashService from './cash.service.js';

export const recordCashCollection = asyncHandler(async (req: Request, res: Response) => {
  const collection = await cashService.recordCashCollection(req.body, req.userId!, req.ip, req.get('user-agent'));
  res.status(201).json({ success: true, data: collection });
});

export const receiveCash = asyncHandler(async (req: Request, res: Response) => {
  const result = await cashService.receiveCash((req.params.id as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: result });
});

export const resolveDiscrepancy = asyncHandler(async (req: Request, res: Response) => {
  const discrepancy = await cashService.resolveDiscrepancy((req.params.id as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: discrepancy });
});

export const listCashCollections = asyncHandler(async (req: Request, res: Response) => {
  const result = await cashService.listCashCollections(req.query as any, req.userId!, req.userRoles!);
  res.json({ success: true, data: result });
});

export const listDiscrepancies = asyncHandler(async (req: Request, res: Response) => {
  const result = await cashService.listDiscrepancies(req.query as any);
  res.json({ success: true, data: result });
});
