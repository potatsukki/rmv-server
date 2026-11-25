import { Router } from 'express';
import * as ctrl from './cash.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { Role } from '../../utils/constants.js';
import {
  onsiteCashSchema,
  recordCashCollectionSchema,
  receiveCashSchema,
  resolveDiscrepancySchema,
} from './cash.validation.js';

const router = Router();

// ── Sales Staff: cash taken during the ocular visit (paid at once; the cashier receives it later) ──
router.post(
  '/onsite/ocular-fee/:appointmentId',
  authenticate,
  authorize(Role.SALES_STAFF),
  validate(onsiteCashSchema),
  ctrl.collectOcularFeeOnSite,
);

router.post(
  '/onsite/design-fee/:projectId',
  authenticate,
  authorize(Role.SALES_STAFF),
  validate(onsiteCashSchema),
  ctrl.collectDesignFeeOnSite,
);

// ── Sales Staff: Record ──
router.post(
  '/collections',
  authenticate,
  authorize(Role.SALES_STAFF),
  validate(recordCashCollectionSchema),
  ctrl.recordCashCollection,
);

// ── Cashier: Receive ──
router.post(
  '/collections/:id/receive',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  validate(receiveCashSchema),
  ctrl.receiveCash,
);

// ── Admin: Resolve Discrepancy ──
router.post(
  '/discrepancies/:id/resolve',
  authenticate,
  authorize(Role.ADMIN),
  validate(resolveDiscrepancySchema),
  ctrl.resolveDiscrepancy,
);

// ── Read ──
router.get(
  '/pending-appointments',
  authenticate,
  authorize(Role.SALES_STAFF, Role.CASHIER, Role.ADMIN),
  ctrl.listPendingCashAppointments,
);

router.get(
  '/collections',
  authenticate,
  authorize(Role.SALES_STAFF, Role.CASHIER, Role.ADMIN),
  ctrl.listCashCollections,
);

router.get(
  '/discrepancies',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  ctrl.listDiscrepancies,
);

export default router;
