import { Router } from 'express';
import * as ctrl from './projects.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { Role } from '../../utils/constants.js';
import {
  createProjectSchema,
  updateProjectSchema,
  updateProjectSiteAddressSchema,
  assignEngineersSchema,
  reassignProjectSalesSchema,
  assignFabricationSchema,
  transitionProjectSchema,
  uploadSignedContractSchema,
  reviewInitialDesignSchema,
  resubmitInitialDesignSchema,
  backfillInitialDesignSchema,
  selectPaymentPlanSchema,
  submitProjectReviewSchema,
  skipProjectReviewSchema,
} from './projects.validation.js';

const router = Router();

// ── CRUD ──
router.post(
  '/',
  authenticate,
  authorize(Role.SALES_STAFF, Role.ADMIN),
  validate(createProjectSchema),
  ctrl.createProject,
);

router.patch(
  '/:id',
  authenticate,
  authorize(Role.SALES_STAFF, Role.ENGINEER, Role.ADMIN),
  validate(updateProjectSchema),
  ctrl.updateProject,
);

router.patch(
  '/:id/site-address',
  authenticate,
  authorize(Role.FABRICATION_STAFF, Role.ADMIN),
  validate(updateProjectSiteAddressSchema),
  ctrl.updateProjectSiteAddress,
);

// ── Assignments ──
router.post(
  '/:id/assign-engineers',
  authenticate,
  authorize(Role.SALES_STAFF, Role.ENGINEER, Role.ADMIN),
  validate(assignEngineersSchema),
  ctrl.assignEngineers,
);

router.post(
  '/:id/reassign-sales',
  authenticate,
  authorize(Role.SALES_STAFF, Role.ADMIN),
  validate(reassignProjectSalesSchema),
  ctrl.reassignProjectSalesStaff,
);

router.post(
  '/:id/review-initial-design',
  authenticate,
  authorize(Role.ENGINEER, Role.ADMIN),
  validate(reviewInitialDesignSchema),
  ctrl.reviewInitialDesign,
);

router.post(
  '/:id/resubmit-initial-design',
  authenticate,
  authorize(Role.SALES_STAFF, Role.ADMIN),
  validate(resubmitInitialDesignSchema),
  ctrl.resubmitInitialDesign,
);

router.post(
  '/:id/backfill-initial-design',
  authenticate,
  authorize(Role.ADMIN),
  validate(backfillInitialDesignSchema),
  ctrl.backfillInitialDesign,
);

router.post(
  '/:id/assign-fabrication',
  authenticate,
  authorize(Role.ENGINEER, Role.ADMIN),
  validate(assignFabricationSchema),
  ctrl.assignFabricationStaff,
);

// ── Status Transition ──
router.post(
  '/:id/transition',
  authenticate,
  authorize(Role.SALES_STAFF, Role.ENGINEER, Role.ADMIN),
  validate(transitionProjectSchema),
  ctrl.transitionProject,
);

// ── Media ──
router.post(
  '/:id/media',
  authenticate,
  authorize(Role.SALES_STAFF, Role.ENGINEER, Role.ADMIN),
  ctrl.addMediaKeys,
);

router.delete(
  '/:id/media',
  authenticate,
  authorize(Role.SALES_STAFF, Role.ENGINEER, Role.ADMIN),
  ctrl.removeMediaKey,
);

// ── Contract ──
router.post(
  '/:id/generate-contract',
  authenticate,
  authorize(Role.CASHIER, Role.SALES_STAFF, Role.ADMIN),
  ctrl.generateContract,
);

router.post(
  '/:id/contract',
  authenticate,
  authorize(Role.SALES_STAFF, Role.ADMIN),
  validate(uploadSignedContractSchema),
  ctrl.uploadSignedContract,
);

router.post(
  '/:id/select-payment-plan',
  authenticate,
  authorize(Role.CUSTOMER),
  validate(selectPaymentPlanSchema),
  ctrl.selectPaymentPlan,
);

router.get(
  '/:id/contract-url',
  authenticate,
  ctrl.getContractDownloadUrl,
);

router.post(
  '/:id/sign-contract',
  authenticate,
  authorize(Role.CUSTOMER),
  ctrl.signContract,
);

router.post(
  '/:id/sign-contract-engineer',
  authenticate,
  authorize(Role.ENGINEER, Role.ADMIN),
  ctrl.signEngineerContract,
);

// ── Installation Confirmation ──
router.post(
  '/:id/confirm-installation',
  authenticate,
  authorize(Role.CUSTOMER, Role.ADMIN),
  ctrl.confirmInstallation,
);

router.post(
  '/:id/review',
  authenticate,
  authorize(Role.CUSTOMER, Role.ADMIN),
  validate(submitProjectReviewSchema),
  ctrl.submitProjectReview,
);

router.post(
  '/:id/review/skip',
  authenticate,
  authorize(Role.CUSTOMER, Role.ADMIN),
  validate(skipProjectReviewSchema),
  ctrl.skipProjectReview,
);

// ── Read ──
router.get(
  '/by-visit-report/:visitReportId',
  authenticate,
  ctrl.getProjectByVisitReportId,
);

router.post(
  '/repair-project-numbers',
  authenticate,
  authorize(Role.ADMIN),
  ctrl.repairMissingProjectNumbers,
);

router.get(
  '/',
  authenticate,
  ctrl.listProjects,
);

router.get(
  '/:id',
  authenticate,
  ctrl.getProjectById,
);

export default router;
