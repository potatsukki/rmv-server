import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as usersService from './users.service.js';

export const createUser = asyncHandler(async (req: Request, res: Response) => {
  const result = await usersService.createUser(req.body, req.userId!, req.ip, req.headers['user-agent']);
  res.status(201).json({ success: true, data: result });
});

export const listUsers = asyncHandler(async (req: Request, res: Response) => {
  const result = await usersService.listUsers(req.query as Record<string, string>);
  res.json({ success: true, data: result });
});

export const updateUser = asyncHandler(async (req: Request, res: Response) => {
  const result = await usersService.updateUser((req.params.id as string), req.body, req.userId!, req.ip, req.headers['user-agent']);
  res.json({ success: true, data: result });
});

export const disableUser = asyncHandler(async (req: Request, res: Response) => {
  const result = await usersService.disableUser((req.params.id as string), req.userId!, req.ip, req.headers['user-agent']);
  res.json({ success: true, data: result });
});

export const enableUser = asyncHandler(async (req: Request, res: Response) => {
  const result = await usersService.enableUser((req.params.id as string), req.userId!, req.ip, req.headers['user-agent']);
  res.json({ success: true, data: result });
});

export const updateProfile = asyncHandler(async (req: Request, res: Response) => {
  const result = await usersService.updateProfile(req.userId!, req.body);
  res.json({ success: true, data: result });
});

export const updateSalesAvailability = asyncHandler(async (req: Request, res: Response) => {
  const result = await usersService.updateSalesAvailability(req.body.salesStaffId, req.body.unavailableDates, req.userId!);
  res.json({ success: true, data: result });
});

export const getSalesAvailability = asyncHandler(async (req: Request, res: Response) => {
  const result = await usersService.getSalesAvailability((req.params.id as string));
  res.json({ success: true, data: result });
});

export const listSalesStaff = asyncHandler(async (req: Request, res: Response) => {
  const result = await usersService.listByRole('sales_staff');
  res.json({ success: true, data: result });
});

export const listCustomers = asyncHandler(async (req: Request, res: Response) => {
  const search = req.query.search as string | undefined;
  const result = await usersService.listByRole('customer', search);
  res.json({ success: true, data: result });
});
