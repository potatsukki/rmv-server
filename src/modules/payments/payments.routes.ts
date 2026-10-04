import { Router } from 'express';
import * as ctrl from './payments.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { Role } from '../../utils/constants.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { gcashTargetSchema, submitGcashSchema } from './gcash.validation.js';
import { getGcashContext, submitGcash, reviewGcash, selectCash } from './gcash.service.js';
import { listPendingPayments } from './payments.service.js';
import {
  createPaymentPlanSchema,
  updatePaymentPlanSchema,
  submitPaymentProofSchema,
  verifyPaymentSchema,
  declinePaymentSchema,
  recordCashPaymentSchema,
} from './payments.validation.js';

const router = Router();
router.get('/gcash/flagged', authenticate, authorize(Role.CASHIER), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await listPendingPayments(req.query as { page?: string; limit?: string }, true) });
}));
router.post('/gcash/cash', authenticate, authorize(Role.CUSTOMER), validate(gcashTargetSchema), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await selectCash(req.body, req.userId!) });
}));
router.get('/gcash/context', authenticate, authorize(Role.CUSTOMER), validate(gcashTargetSchema, 'query'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await getGcashContext(gcashTargetSchema.parse(req.query), req.userId!) });
}));
router.post('/gcash/submit', authenticate, authorize(Role.CUSTOMER), validate(submitGcashSchema), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await submitGcash(req.body, req.userId!) });
}));
router.post('/gcash/:id/approve', authenticate, authorize(Role.CASHIER), validate(verifyPaymentSchema), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await reviewGcash(req.params.id as string, req.userId!, req.userRoles!, 'paid', undefined, req.body.signatureKey) });
}));
router.post('/gcash/:id/reject', authenticate, authorize(Role.CASHIER), validate(declinePaymentSchema), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await reviewGcash(req.params.id as string, req.userId!, req.userRoles!, 'rejected', req.body.reason) });
}));

// ── Cashier: Payment Plan ──
router.post(
  '/plans',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  validate(createPaymentPlanSchema),
  ctrl.createPaymentPlan,
);

router.patch(
  '/plans/:id',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  validate(updatePaymentPlanSchema),
  ctrl.updatePaymentPlan,
);

// ── Customer: Submit Proof ──
router.post(
  '/submit-proof',
  authenticate,
  authorize(Role.CUSTOMER),
  validate(submitPaymentProofSchema),
  ctrl.submitPaymentProof,
);

// ── Customer: Create QRPH Checkout ──
router.post(
  '/stages/:stageId/checkout',
  authenticate,
  authorize(Role.CUSTOMER),
  ctrl.createStageCheckout,
);

router.post(
  '/stages/:stageId/request-cash',
  authenticate,
  authorize(Role.CUSTOMER),
  ctrl.requestStageCashPayment,
);

// ⚠️ DEV ONLY: Simulate Stage Payment ──
router.post(
  '/stages/:stageId/simulate',
  authenticate,
  ctrl.simulateStagePayment,
);

// ── Cashier: Record Cash Payment ──
router.post(
  '/record-cash',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  validate(recordCashPaymentSchema),
  ctrl.recordCashPayment,
);

// ── Cashier: Verify / Decline ──
router.post(
  '/:id/verify',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  validate(verifyPaymentSchema),
  ctrl.verifyPayment,
);

router.post(
  '/:id/decline',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  validate(declinePaymentSchema),
  ctrl.declinePayment,
);

// ── Customer: Payment History ──
router.get(
  '/my-history',
  authenticate,
  authorize(Role.CUSTOMER),
  ctrl.getMyPaymentHistory,
);

// ── Cashier: Pending Queue ──
router.get(
  '/pending',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  ctrl.listPendingPayments,
);

// ── Cashier: Overdue Payments Queue ──
router.get(
  '/overdue',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  ctrl.listOverduePayments,
);

// ── Read ──
router.get(
  '/plan/:projectId',
  authenticate,
  ctrl.getPaymentPlanByProject,
);

router.get(
  '/project/:projectId',
  authenticate,
  ctrl.listPaymentsByProject,
);

router.get(
  '/:id',
  authenticate,
  ctrl.getPaymentById,
);

router.get(
  '/:id/evidence-trail',
  authenticate,
  ctrl.getPaymentEvidenceTrail,
);

router.get(
  '/:id/receipt-url',
  authenticate,
  ctrl.getReceiptDownloadUrl,
);

export default router;
