import { Router } from 'express';
import * as ctrl from './cash.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { Role } from '../../utils/constants.js';
import {
  recordCashCollectionSchema,
  receiveCashSchema,
  resolveDiscrepancySchema,
} from './cash.validation.js';

const router = Router();

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
