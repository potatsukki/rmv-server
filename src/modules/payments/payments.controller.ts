import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as paymentsService from './payments.service.js';
import { Payment } from '../../models/Payment.js';
import { reviewGcash } from './gcash.service.js';
import { PaymentMethod, Role } from '../../utils/constants.js';

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
  const existingPayment = await Payment.findById(req.params.id as string);
  if (existingPayment?.method === PaymentMethod.GCASH) {
    const result = await reviewGcash(req.params.id as string, req.userId!, req.userRoles!, 'paid', undefined, req.body.signatureKey);
    res.json({ success: true, data: result });
    return;
  }
  const result = await paymentsService.verifyPayment(
    (req.params.id as string),
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: result });
});

export const declinePayment = asyncHandler(async (req: Request, res: Response) => {
  const existingPayment = await Payment.findById(req.params.id as string);
  if (existingPayment?.method === PaymentMethod.GCASH) {
    const result = await reviewGcash(req.params.id as string, req.userId!, req.userRoles!, 'rejected', req.body.reason);
    res.json({ success: true, data: result });
    return;
  }
  const payment = await paymentsService.declinePayment((req.params.id as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: payment });
});

export const getMyPaymentHistory = asyncHandler(async (req: Request, res: Response) => {
  const history = await paymentsService.getMyPaymentHistory(req.userId!);
  res.json({ success: true, data: history });
});

export const getPaymentPlanByProject = asyncHandler(async (req: Request, res: Response) => {
  const plan = await paymentsService.getPaymentPlanByProject(
    (req.params.projectId as string),
    req.userId!,
    req.userRoles!,
    req.query.projectItemId as string | undefined,
  );
  res.json({ success: true, data: plan });
});

export const listPaymentsByProject = asyncHandler(async (req: Request, res: Response) => {
  const payments = await paymentsService.listPaymentsByProject(
    (req.params.projectId as string),
    req.userId!,
    req.userRoles!,
    req.query.projectItemId as string | undefined,
  );
  res.json({ success: true, data: payments });
});

export const listPendingPayments = asyncHandler(async (req: Request, res: Response) => {
  const result = await paymentsService.listPendingPayments(req.query as any);
  res.json({ success: true, data: req.userRoles!.includes(Role.CASHIER) ? result : result.filter((payment) => payment.method !== PaymentMethod.GCASH) });
});

export const getPaymentById = asyncHandler(async (req: Request, res: Response) => {
  const payment = await paymentsService.getPaymentById(
    (req.params.id as string),
    req.userId!,
    req.userRoles!,
  );
  res.json({ success: true, data: payment });
});

export const getPaymentEvidenceTrail = asyncHandler(async (req: Request, res: Response) => {
  const trail = await paymentsService.getPaymentEvidenceTrail(
    req.params.id as string,
    req.userId!,
    req.userRoles!,
  );
  res.json({ success: true, data: trail });
});

// ── Customer: Create QRPH Checkout for a Stage ──
export const createStageCheckout = asyncHandler(async (req: Request, res: Response) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const clientOrigin = req.headers.origin || req.headers.referer?.replace(/\/$/, '') || origin;
  const result = await paymentsService.createStageCheckout(
    req.params.stageId as string,
    req.userId!,
    clientOrigin as string,
  );
  res.json({ success: true, data: result });
});

// ── Customer: Request Cash Payment for a Stage ──
export const requestStageCashPayment = asyncHandler(async (req: Request, res: Response) => {
  const result = await paymentsService.requestStageCashPayment(
    req.params.stageId as string,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.status(201).json({ success: true, data: result });
});

// ⚠️ DEV ONLY: Simulate Stage Payment ──
export const simulateStagePayment = asyncHandler(async (req: Request, res: Response) => {
  const result = await paymentsService.simulateStagePayment(
    req.params.stageId as string,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: result });
});

// ── Cashier: Record Cash Payment ──
export const recordCashPayment = asyncHandler(async (req: Request, res: Response) => {
  const result = await paymentsService.recordCashPayment(
    req.body.stageId,
    req.body.amountPaid,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: result });
});

// ── Get Receipt Download URL ──
export const getReceiptDownloadUrl = asyncHandler(async (req: Request, res: Response) => {
  const result = await paymentsService.getReceiptDownloadUrl(
    req.params.id as string,
    req.userId!,
    req.userRoles!,
  );
  res.json({ success: true, data: result });
});

// ── Cashier: List Overdue Payments ──
export const listOverduePayments = asyncHandler(async (_req: Request, res: Response) => {
  const result = await paymentsService.listOverduePayments();
  res.json({ success: true, data: result });
});
