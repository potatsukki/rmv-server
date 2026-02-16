import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as paymentsService from './payments.service.js';

export const createPaymentPlan = asyncHandler(async (req: Request, res: Response) => {
  const plan = await paymentsService.createPaymentPlan(req.body, req.userId!, req.ip, req.get('user-agent'));
  res.status(201).json({ success: true, data: plan });
});

export const updatePaymentPlan = asyncHandler(async (req: Request, res: Response) => {
  const plan = await paymentsService.updatePaymentPlan((req.params.id as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: plan });
});

export const submitPaymentProof = asyncHandler(async (req: Request, res: Response) => {
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  const payment = await paymentsService.submitPaymentProof(req.body, req.userId!, idempotencyKey, req.ip, req.get('user-agent'));
  res.status(201).json({ success: true, data: payment });
});

export const verifyPayment = asyncHandler(async (req: Request, res: Response) => {
  const result = await paymentsService.verifyPayment((req.params.id as string), req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: result });
});

export const declinePayment = asyncHandler(async (req: Request, res: Response) => {
  const payment = await paymentsService.declinePayment((req.params.id as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: payment });
});

export const getPaymentPlanByProject = asyncHandler(async (req: Request, res: Response) => {
  const plan = await paymentsService.getPaymentPlanByProject(
    (req.params.projectId as string),
    req.userId!,
    req.userRoles!,
  );
  res.json({ success: true, data: plan });
});

export const listPaymentsByProject = asyncHandler(async (req: Request, res: Response) => {
  const payments = await paymentsService.listPaymentsByProject(
    (req.params.projectId as string),
    req.userId!,
    req.userRoles!,
  );
  res.json({ success: true, data: payments });
});

export const listPendingPayments = asyncHandler(async (req: Request, res: Response) => {
  const result = await paymentsService.listPendingPayments(req.query as any);
  res.json({ success: true, data: result });
});

export const getPaymentById = asyncHandler(async (req: Request, res: Response) => {
  const payment = await paymentsService.getPaymentById(
    (req.params.id as string),
    req.userId!,
    req.userRoles!,
  );
  res.json({ success: true, data: payment });
});
