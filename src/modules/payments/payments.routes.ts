import { Router } from 'express';
import * as ctrl from './payments.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { Role } from '../../utils/constants.js';
import {
  createPaymentPlanSchema,
  updatePaymentPlanSchema,
  submitPaymentProofSchema,
  verifyPaymentSchema,
  declinePaymentSchema,
} from './payments.validation.js';

const router = Router();

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

// ── Cashier: Verify / Decline ──
router.post(
  '/:id/verify',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  ctrl.verifyPayment,
);

router.post(
  '/:id/decline',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  validate(declinePaymentSchema),
  ctrl.declinePayment,
);

// ── Cashier: Pending Queue ──
router.get(
  '/pending',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  ctrl.listPendingPayments,
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

export default router;
