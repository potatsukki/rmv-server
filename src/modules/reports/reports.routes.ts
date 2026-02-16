import { Router } from 'express';
import * as ctrl from './reports.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize } from '../../middleware/rbac.js';
import { Role } from '../../utils/constants.js';

const router = Router();

// Dashboard summary is available to all authenticated users
router.get(
  '/dashboard',
  authenticate,
  ctrl.getDashboardSummary,
);

router.get(
  '/revenue',
  authenticate,
  authorize(Role.ADMIN, Role.CASHIER),
  ctrl.getRevenueReport,
);

router.get(
  '/payment-stages',
  authenticate,
  authorize(Role.ADMIN, Role.CASHIER),
  ctrl.getPaymentStageReport,
);

router.get(
  '/outstanding',
  authenticate,
  authorize(Role.ADMIN, Role.CASHIER),
  ctrl.getOutstandingReport,
);

router.get(
  '/pipeline',
  authenticate,
  authorize(Role.ADMIN),
  ctrl.getProjectPipelineReport,
);

router.get(
  '/workload',
  authenticate,
  authorize(Role.ADMIN),
  ctrl.getWorkloadReport,
);

router.get(
  '/conversion',
  authenticate,
  authorize(Role.ADMIN),
  ctrl.getConversionReport,
);

export default router;
