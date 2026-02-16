import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as configService from './config.service.js';

export const listConfigs = asyncHandler(async (req: Request, res: Response) => {
  const configs = await configService.listConfigs();
  res.json({ success: true, data: configs });
});

export const getConfig = asyncHandler(async (req: Request, res: Response) => {
  const config = await configService.getConfig((req.params.key as string));
  res.json({ success: true, data: config });
});

export const upsertConfig = asyncHandler(async (req: Request, res: Response) => {
  const config = await configService.upsertConfig((req.params.key as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: config });
});

export const listHolidays = asyncHandler(async (req: Request, res: Response) => {
  const holidays = await configService.listHolidays(req.query.year as string);
  res.json({ success: true, data: holidays });
});

export const createHoliday = asyncHandler(async (req: Request, res: Response) => {
  const holiday = await configService.createHoliday(req.body, req.userId!, req.ip, req.get('user-agent'));
  res.status(201).json({ success: true, data: holiday });
});

export const deleteHoliday = asyncHandler(async (req: Request, res: Response) => {
  await configService.deleteHoliday((req.params.id as string), req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, message: 'Holiday deleted' });
});

export const toggleMaintenance = asyncHandler(async (req: Request, res: Response) => {
  const result = await configService.toggleMaintenance(req.body.enabled, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: result });
});
